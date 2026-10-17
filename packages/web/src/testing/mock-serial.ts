/**
 * A faithful-enough mock of Web Serial (`Serial`, `SerialPort`) for browser tests. The "device"
 * end deframes host bytes (`'<'` frames) and hands each frame to `onFrameFromHost`; frames pushed
 * with `pushFrameToHost` are framed with `'>'` and delivered through a real `ReadableStream`.
 *
 * Mirrors Chrome/spec behaviour that matters to transports:
 * - `readable` / `writable` are null until `open()` and after `close()`; `readable` is recreated
 *   lazily after its previous stream was cancelled, and is null after a fatal error (unplug).
 * - `open()` on an open port and `close()` with a locked stream reject (InvalidStateError /
 *   TypeError), so tests catch cleanup-order bugs.
 * - `unplug()` errors the streams with NetworkError and fires `disconnect` on the port and on
 *   the `Serial` object.
 */
import {
  SERIAL_MARKER_DEVICE_TO_HOST,
  SERIAL_MARKER_HOST_TO_DEVICE,
  SerialDeframer,
  encodeSerialFrame,
} from '@meshcore-web/core/framing';
import type {
  SerialLike,
  SerialOpenOptions,
  SerialPortInfo,
  SerialPortLike,
  SerialPortRequestOptions,
} from '@meshcore-web/core/transport';

export interface MockSerialDevice {
  /** Frame (code + body) to send to the host, wrapped in a `'>'` header. */
  pushFrameToHost(frame: Uint8Array): void;
  /** Raw bytes to the host (noise, partial frames…). */
  pushBytesToHost(bytes: Uint8Array): void;
}

export interface MockSerialOptions {
  /** Device-side handler: called (on a microtask) for every complete host→device frame. */
  onFrameFromHost?: (frame: Uint8Array, device: MockSerialDevice) => void | Promise<void>;
  /**
   * Split every host-bound write into chunks of this many bytes (each a separate stream read),
   * to exercise deframing across arbitrary boundaries. Default: whole writes.
   */
  chunkSize?: number;
  info?: SerialPortInfo;
}

export class MockSerialPort extends EventTarget implements SerialPortLike {
  openOptions: SerialOpenOptions | undefined;
  /** Raw bytes the host wrote, in order. */
  readonly bytesFromHost: number[] = [];
  /** Deframed host→device frames. */
  readonly framesFromHost: Uint8Array[] = [];
  openCount = 0;
  closeCount = 0;

  #open = false;
  #fatal = false;
  #readable: ReadableStream<Uint8Array> | null = null;
  #readController: ReadableStreamDefaultController<Uint8Array> | undefined;
  #writable: WritableStream<Uint8Array> | null = null;
  #writeController: WritableStreamDefaultController | undefined;
  /** True while the host's reader is parked waiting for data (queue drained). */
  #readerWaiting = false;
  #readerIdleWaiters: Array<() => void> = [];
  /** Bytes pushed while no stream exists (as an OS buffer would hold them). */
  readonly #pending: Uint8Array[] = [];
  readonly #deframer = new SerialDeframer({ markers: [SERIAL_MARKER_HOST_TO_DEVICE] });
  readonly #options: MockSerialOptions;
  readonly #device: MockSerialDevice;

  constructor(options: MockSerialOptions, device: MockSerialDevice) {
    super();
    this.#options = options;
    this.#device = device;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get readable(): ReadableStream<Uint8Array> | null {
    if (!this.#open || this.#fatal) return null;
    if (!this.#readable) {
      this.#readable = new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            this.#readController = controller;
          },
          // With highWaterMark 0, pull() fires exactly when the host awaits read() on an empty queue.
          pull: () => {
            this.#readerWaiting = true;
            for (const w of this.#readerIdleWaiters.splice(0)) w();
          },
          cancel: () => {
            this.#readable = null;
            this.#readController = undefined;
            this.#readerWaiting = false;
          },
        },
        { highWaterMark: 0 },
      );
      for (const chunk of this.#pending.splice(0)) this.#readController!.enqueue(chunk);
    }
    return this.#readable;
  }

  get writable(): WritableStream<Uint8Array> | null {
    if (!this.#open || this.#fatal) return null;
    if (!this.#writable) {
      this.#writable = new WritableStream<Uint8Array>({
        start: (controller) => {
          this.#writeController = controller;
        },
        write: (chunk) => this.#onHostBytes(chunk),
        close: () => {
          this.#writable = null;
        },
        abort: () => {
          this.#writable = null;
        },
      });
    }
    return this.#writable;
  }

  async open(options: SerialOpenOptions): Promise<void> {
    if (this.#open) throw new DOMException('The port is already open.', 'InvalidStateError');
    if (this.#fatal) throw new DOMException('The device has been lost.', 'NetworkError');
    this.openOptions = options;
    this.#open = true;
    this.openCount++;
    this.#deframer.reset();
  }

  async close(): Promise<void> {
    if (!this.#open) throw new DOMException('The port is already closed.', 'InvalidStateError');
    // Spec: close() cancels readable / aborts writable; both reject on a locked stream.
    if (this.#readable?.locked || this.#writable?.locked) {
      throw new TypeError('Cannot close a port with a locked stream.');
    }
    await this.#readable?.cancel();
    await this.#writable?.abort();
    this.#readable = null;
    this.#writable = null;
    this.#readController = undefined;
    this.#writeController = undefined;
    this.#pending.length = 0;
    this.#open = false;
    this.closeCount++;
  }

  getInfo(): SerialPortInfo {
    return { ...(this.#options.info ?? {}) };
  }

  /** Device → host raw bytes. Ignored unless the port is open (like a real UART). */
  deliverToHost(bytes: Uint8Array): void {
    if (!this.#open || this.#fatal) return;
    const size = this.#options.chunkSize && this.#options.chunkSize > 0 ? this.#options.chunkSize : bytes.length;
    for (let off = 0; off < bytes.length; off += size) {
      const chunk = bytes.slice(off, off + size);
      if (this.#readController) {
        this.#readerWaiting = false;
        this.#readController.enqueue(chunk);
      } else this.#pending.push(chunk);
    }
  }

  /** Resolves once the host's read loop has consumed every byte delivered so far and is waiting for more. */
  whenReaderIdle(): Promise<void> {
    if (this.#readerWaiting) return Promise.resolve();
    return new Promise((r) => this.#readerIdleWaiters.push(r));
  }

  /** Simulates unplugging the device. */
  unplug(): void {
    if (this.#fatal) return;
    this.#fatal = true;
    const lost = new DOMException('The device has been lost.', 'NetworkError');
    this.#readController?.error(lost);
    this.#writeController?.error(lost);
    this.#readController = undefined;
    this.#writeController = undefined;
    this.#readable = null;
    this.#writable = null;
    this.#open = false;
    this.dispatchEvent(new Event('disconnect'));
  }

  #onHostBytes(chunk: Uint8Array): void {
    this.bytesFromHost.push(...chunk);
    for (const frame of this.#deframer.push(chunk)) {
      this.framesFromHost.push(frame);
      const handler = this.#options.onFrameFromHost;
      if (handler) queueMicrotask(() => void handler(frame, this.#device));
    }
  }
}

export class MockSerial extends EventTarget implements SerialLike {
  readonly ports: MockSerialPort[] = [];
  lastRequestOptions: SerialPortRequestOptions | undefined;
  /** When true, `requestPort` rejects like a user dismissing the chooser. */
  cancelChooser = false;

  async requestPort(options?: SerialPortRequestOptions): Promise<MockSerialPort> {
    this.lastRequestOptions = options;
    const port = this.ports[0];
    if (this.cancelChooser || !port) throw new DOMException('No port selected by the user.', 'NotFoundError');
    return port;
  }

  async getPorts(): Promise<MockSerialPort[]> {
    return [...this.ports];
  }
}

export interface MockSerialHandle extends MockSerialDevice {
  serial: MockSerial;
  port: MockSerialPort;
  /** Frames the host has sent so far. */
  framesFromHost: Uint8Array[];
  unplug(): void;
}

export function createMockSerial(options: MockSerialOptions = {}): MockSerialHandle {
  const serial = new MockSerial();
  const device: MockSerialDevice = {
    pushFrameToHost: (frame) => port.deliverToHost(encodeSerialFrame(frame, { marker: SERIAL_MARKER_DEVICE_TO_HOST })),
    pushBytesToHost: (bytes) => port.deliverToHost(bytes),
  };
  const port = new MockSerialPort(options, device);
  serial.ports.push(port);
  return {
    ...device,
    serial,
    port,
    framesFromHost: port.framesFromHost,
    unplug: () => {
      port.unplug();
      serial.dispatchEvent(new Event('disconnect'));
    },
  };
}
