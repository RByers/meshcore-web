import type { TypedEmitter } from '../util/events.js';

export type TransportKind = 'serial' | 'ble' | 'loopback' | 'tcp';
export type TransportState = 'disconnected' | 'connecting' | 'connected';

/** Human-readable description of the link, for the connection header. */
export interface TransportInfo {
  kind: TransportKind;
  /** e.g. BLE device name "MeshCore-alice", "USB serial 239a:8029", "Emulator". */
  name: string;
  /** Optional extra detail (BLE device id, USB vendor/product ids, …). */
  detail?: string;
}

export interface TransportEvents {
  /** One complete companion frame (code byte + body) from the peer. */
  frame: Uint8Array;
  state: TransportState;
  /** Unexpected failures: link lost, read errors, etc. Not emitted for a requested disconnect. */
  error: Error;
}

/**
 * A bidirectional, frame-oriented link to a companion device. Each `send` carries exactly one
 * companion frame; framing (serial header, BLE one-write-per-frame) is the transport's concern.
 */
export interface FrameTransport {
  readonly kind: TransportKind;
  readonly state: TransportState;
  readonly info: TransportInfo;
  readonly events: TypedEmitter<TransportEvents>;
  /** Resolves once connected. Rejects (and returns to 'disconnected') on failure. */
  connect(): Promise<void>;
  /** Idempotent; resolves once fully closed. */
  disconnect(): Promise<void>;
  /** Rejects if not connected or if the frame is empty/too large for the link. */
  send(frame: Uint8Array): Promise<void>;
}

export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportError';
  }
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
