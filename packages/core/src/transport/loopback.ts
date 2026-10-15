import { MAX_FRAME_SIZE } from '../framing/serial-framer.js';
import { BaseTransport, checkFrameSize } from './base.js';
import type { FrameTransport, TransportInfo } from './transport.js';

export interface LoopbackOptions {
  /** One-way delivery delay in ms. 0 (default) delivers on a microtask. */
  latencyMs?: number;
  /** Max frame size enforced on `send`; default 176 (firmware MAX_FRAME_SIZE). */
  maxFrameLength?: number;
  /** Display names for the two ends. */
  names?: [string, string];
}

/**
 * One end of an in-process link. Frames are copied and delivered asynchronously, in order,
 * to the peer's `frame` event. A frame sent while the peer is not connected is dropped, as on
 * a real link. Each end connects and disconnects independently.
 */
export class LoopbackEndpoint extends BaseTransport implements FrameTransport {
  readonly kind = 'loopback' as const;
  peer: LoopbackEndpoint | undefined;
  readonly #name: string;
  readonly #latencyMs: number;
  readonly #max: number;
  /** Bumped on disconnect so in-flight deliveries from a previous session are dropped. */
  #epoch = 0;

  constructor(name: string, options: LoopbackOptions = {}) {
    super();
    this.#name = name;
    this.#latencyMs = options.latencyMs ?? 0;
    this.#max = options.maxFrameLength ?? MAX_FRAME_SIZE;
  }

  get info(): TransportInfo {
    return { kind: 'loopback', name: this.#name };
  }

  async connect(): Promise<void> {
    if (this.state === 'connected') return;
    this.setState('connecting');
    this.setState('connected');
  }

  async disconnect(): Promise<void> {
    this.#epoch++;
    this.setState('disconnected');
  }

  async send(frame: Uint8Array): Promise<void> {
    this.assertConnected();
    checkFrameSize(frame, this.#max);
    const peer = this.peer;
    if (!peer) return;
    peer.#enqueue(frame.slice(), this.#latencyMs);
  }

  #enqueue(frame: Uint8Array, latencyMs: number): void {
    // Equal delays keep FIFO order for both microtasks and timers.
    const epoch = this.#epoch;
    const deliver = (): void => {
      if (epoch === this.#epoch && this.state === 'connected') this.emitSafe('frame', frame);
    };
    if (latencyMs > 0) setTimeout(deliver, latencyMs);
    else queueMicrotask(deliver);
  }
}

/** Two transports wired to each other: whatever one sends, the other receives. */
export function createLoopbackPair(options: LoopbackOptions = {}): [LoopbackEndpoint, LoopbackEndpoint] {
  const [na, nb] = options.names ?? ['Loopback A', 'Loopback B'];
  const a = new LoopbackEndpoint(na, options);
  const b = new LoopbackEndpoint(nb, options);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** Device-side API handed to a `FrameHandler`. */
export interface LoopbackDevice {
  /** Queue a frame (response or unsolicited push) to the host. */
  send(frame: Uint8Array): void;
}

/** Device-side callback: receives each host frame; may reply via `device.send`. */
export type FrameHandler = (frame: Uint8Array, device: LoopbackDevice) => void | Promise<void>;

/**
 * Host-side transport whose "device" is a callback, e.g. `new LoopbackTransport(emulator.handle)`.
 * Errors thrown (or rejected) by the handler are reported on the `error` event.
 */
export class LoopbackTransport extends BaseTransport implements FrameTransport {
  readonly kind = 'loopback' as const;
  readonly #host: LoopbackEndpoint;
  readonly #device: LoopbackEndpoint;
  readonly #name: string;

  constructor(handler: FrameHandler, options: LoopbackOptions & { name?: string } = {}) {
    super();
    this.#name = options.name ?? 'Loopback';
    [this.#host, this.#device] = createLoopbackPair(options);
    const device: LoopbackDevice = { send: (frame) => this.pushFromDevice(frame) };
    this.#device.events.on('frame', (frame) => {
      try {
        const r = handler(frame, device);
        if (r) r.catch((err: unknown) => this.#handlerError(err));
      } catch (err) {
        this.#handlerError(err);
      }
    });
    this.#host.events.on('frame', (frame) => this.emitSafe('frame', frame));
    this.#host.events.on('state', (s) => this.setState(s));
    // The device end is always listening.
    void this.#device.connect();
  }

  get info(): TransportInfo {
    return { kind: 'loopback', name: this.#name };
  }

  connect(): Promise<void> {
    return this.#host.connect();
  }

  disconnect(): Promise<void> {
    return this.#host.disconnect();
  }

  send(frame: Uint8Array): Promise<void> {
    return this.#host.send(frame);
  }

  /** Push a frame from the device to the host (dropped if the host is not connected). */
  pushFromDevice(frame: Uint8Array): void {
    void this.#device.send(frame).catch((err: unknown) => this.#handlerError(err));
  }

  #handlerError(err: unknown): void {
    this.emitSafe('error', err instanceof Error ? err : new Error(String(err)));
  }
}
