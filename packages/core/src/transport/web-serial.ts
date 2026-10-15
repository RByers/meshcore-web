import {
  MAX_FRAME_SIZE,
  SERIAL_MARKER_DEVICE_TO_HOST,
  SERIAL_MARKER_HOST_TO_DEVICE,
  SerialDeframer,
  encodeSerialFrame,
} from '../framing/serial-framer.js';
import { BaseTransport, checkFrameSize } from './base.js';
import type { FrameTransport, TransportInfo } from './transport.js';
import { TransportError, toError } from './transport.js';
import type { SerialLike, SerialPortFilter, SerialPortLike } from './web-api-types.js';

export interface WebSerialTransportOptions {
  /** `navigator.serial` (injected; core never touches `navigator`). Needed only if no `port`. */
  serial?: SerialLike;
  /** A port already chosen by the user. If omitted, `connect()` calls `serial.requestPort()`. */
  port?: SerialPortLike;
  /** Default 115200 (firmware `main.cpp`, meshcore.js). */
  baudRate?: number;
  /** Default 176 (firmware MAX_FRAME_SIZE). */
  maxFrameLength?: number;
  /**
   * Accept host→device `'<'` frames on receive too (meshcore.js does). Default false: a
   * loopback/echo of our own frames is then ignored instead of being read as a response.
   */
  acceptBothMarkers?: boolean;
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0');

/**
 * Companion link over Web Serial (USB CDC / UART), framed per companion-protocol.md §1.1.
 *
 * Reading: a loop reads `port.readable` and feeds a `SerialDeframer`. Chrome replaces
 * `port.readable` with a fresh stream after non-fatal errors (framing/parity/overrun/break), so
 * the loop re-acquires a reader; when `readable` becomes null (fatal, e.g. unplugged) the link
 * is treated as lost. Writing: writes are serialized; each acquires the writer, writes one
 * framed frame, and releases the lock, so `port.close()` never finds the writable locked.
 */
export class WebSerialTransport extends BaseTransport implements FrameTransport {
  readonly kind = 'serial' as const;
  readonly #serial: SerialLike | undefined;
  #port: SerialPortLike | undefined;
  readonly #baudRate: number;
  readonly #max: number;
  readonly #deframer: SerialDeframer;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #readLoop: Promise<void> | undefined;
  #writeChain: Promise<void> = Promise.resolve();
  #closing: Promise<void> | undefined;
  readonly #onPortDisconnect = (): void => {
    void this.#shutdown(new TransportError('serial device disconnected'), false);
  };

  constructor(options: WebSerialTransportOptions = {}) {
    super();
    this.#serial = options.serial;
    this.#port = options.port;
    this.#baudRate = options.baudRate ?? 115200;
    this.#max = options.maxFrameLength ?? MAX_FRAME_SIZE;
    this.#deframer = new SerialDeframer({
      maxFrameLength: this.#max,
      markers: options.acceptBothMarkers
        ? [SERIAL_MARKER_DEVICE_TO_HOST, SERIAL_MARKER_HOST_TO_DEVICE]
        : [SERIAL_MARKER_DEVICE_TO_HOST],
    });
  }

  /** Shows the browser's port picker. Must be called from a user gesture. */
  static requestPort(serial: SerialLike, filters?: SerialPortFilter[]): Promise<SerialPortLike> {
    return serial.requestPort(filters && filters.length > 0 ? { filters } : undefined);
  }

  get port(): SerialPortLike | undefined {
    return this.#port;
  }

  get info(): TransportInfo {
    const i = this.#port?.getInfo();
    if (i?.usbVendorId !== undefined) {
      const ids = `${hex4(i.usbVendorId)}:${hex4(i.usbProductId ?? 0)}`;
      return { kind: 'serial', name: `USB serial ${ids}`, detail: `${this.#baudRate} baud` };
    }
    return { kind: 'serial', name: 'Serial port', detail: `${this.#baudRate} baud` };
  }

  async connect(): Promise<void> {
    if (this.state === 'connected') return;
    if (this.state === 'connecting') throw new TransportError('connect already in progress');
    this.setState('connecting');
    try {
      if (!this.#port) {
        if (!this.#serial) throw new TransportError('no serial port and no Serial object to request one');
        this.#port = await WebSerialTransport.requestPort(this.#serial);
      }
      await this.#port.open({ baudRate: this.#baudRate });
    } catch (err) {
      this.setState('disconnected');
      throw err instanceof TransportError ? err : new TransportError('failed to open serial port', { cause: err });
    }
    const port = this.#port;
    port.addEventListener('disconnect', this.#onPortDisconnect);
    this.#deframer.reset();
    this.#writeChain = Promise.resolve();
    this.#readLoop = this.#runReadLoop(port);
    this.setState('connected');
  }

  disconnect(): Promise<void> {
    return this.#shutdown(undefined, false);
  }

  send(frame: Uint8Array): Promise<void> {
    try {
      this.assertConnected();
      if (this.#closing) throw new TransportError('serial transport is disconnecting');
      checkFrameSize(frame, this.#max);
    } catch (err) {
      return Promise.reject(err);
    }
    const bytes = encodeSerialFrame(frame, { maxFrameLength: this.#max });
    const port = this.#port!;
    const p = this.#writeChain.then(async () => {
      const writable = port.writable;
      if (!writable || this.state !== 'connected') throw new TransportError('serial port is not writable');
      const writer = writable.getWriter();
      try {
        await writer.write(bytes);
      } finally {
        writer.releaseLock();
      }
    });
    this.#writeChain = p.catch(() => undefined);
    return p;
  }

  async #runReadLoop(port: SerialPortLike): Promise<void> {
    while (!this.#closing && port.readable) {
      const reader = port.readable.getReader();
      this.#reader = reader;
      let ended = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            ended = true;
            break;
          }
          if (value) for (const frame of this.#deframer.push(value)) this.emitSafe('frame', frame);
        }
      } catch (err) {
        // Non-fatal errors leave a new `port.readable`; fatal ones null it (loop exits below).
        if (!this.#closing) this.emitSafe('error', new TransportError('serial read error', { cause: toError(err) }));
      } finally {
        this.#reader = undefined;
        reader.releaseLock();
      }
      if (ended) break;
    }
    if (!this.#closing) void this.#shutdown(new TransportError('serial port closed unexpectedly'), true);
  }

  /** Single teardown path for both requested and unexpected disconnects. Idempotent. */
  #shutdown(reason: Error | undefined, fromReadLoop: boolean): Promise<void> {
    if (this.#closing) return this.#closing;
    if (this.state === 'disconnected') return Promise.resolve();
    const port = this.#port;
    this.#closing = (async () => {
      // 1. Cancel the reader: resolves the pending read() with done, then the loop releases the lock.
      try {
        await this.#reader?.cancel();
      } catch {
        // already errored / released
      }
      if (!fromReadLoop) await this.#readLoop;
      // 2. Let queued writes finish (they fail fast if the port is gone).
      await this.#writeChain;
      // 3. Close the port; rejects if a stream is still locked or the device is gone.
      if (port) {
        port.removeEventListener('disconnect', this.#onPortDisconnect);
        try {
          await port.close();
        } catch {
          // Unplugged ports may refuse to close; nothing more we can do.
        }
      }
      this.#readLoop = undefined;
      this.#deframer.reset();
      this.setState('disconnected');
      if (reason) this.emitSafe('error', reason);
    })().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }
}
