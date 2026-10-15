import { TypedEmitter } from '../util/events.js';
import type { TransportEvents, TransportInfo, TransportKind, TransportState } from './transport.js';
import { TransportError } from './transport.js';

/** Shared state/event plumbing for transports. */
export abstract class BaseTransport {
  abstract readonly kind: TransportKind;
  readonly events = new TypedEmitter<TransportEvents>();
  #state: TransportState = 'disconnected';

  get state(): TransportState {
    return this.#state;
  }

  abstract get info(): TransportInfo;

  protected setState(state: TransportState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.emitSafe('state', state);
  }

  /** Emits without letting a throwing listener break the transport's own control flow. */
  protected emitSafe<K extends keyof TransportEvents>(event: K, payload: TransportEvents[K]): void {
    try {
      this.events.emit(event, payload);
    } catch (err) {
      // Surface listener bugs asynchronously rather than corrupting transport state.
      queueMicrotask(() => {
        throw err;
      });
    }
  }

  protected assertConnected(): void {
    if (this.#state !== 'connected') throw new TransportError(`${this.kind} transport is not connected`);
  }
}

export function checkFrameSize(frame: Uint8Array, max: number): void {
  if (frame.length === 0) throw new TransportError('cannot send an empty frame');
  if (frame.length > max) {
    throw new TransportError(`frame of ${frame.length} bytes exceeds the ${max}-byte limit`);
  }
}
