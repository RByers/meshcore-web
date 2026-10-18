/** Change notifications emitted by the store repositories (after the write has committed). */

import { TypedEmitter } from '../util/events.js';
import type {
  ChannelRecord,
  ContactRecord,
  ConversationType,
  DeviceRecord,
  FrameRecord,
  MessageRecord,
  NoiseFloorSample,
  PacketRecord,
} from './schema.js';

export type LogStoreName = 'frames' | 'packets';

export interface RadioStoreEvents {
  /** A frame was appended to the frame log. */
  frame: FrameRecord;
  /** A packet was appended to the packet log. */
  packet: PacketRecord;
  /** A stored packet changed in place (e.g. a sent packet's `send` outcome); same id. */
  packetUpdated: { record: PacketRecord; previous: PacketRecord };
  /**
   * Bulk change to a log (clear / prune / import / backfill); re-query rather than patch. For
   * 'backfill', `added` counts new rows and `updated` rows changed in place.
   */
  logChanged: { store: LogStoreName; reason: 'clear' | 'prune' | 'import' | 'backfill'; removed: number; added: number; updated?: number };
  contact: { type: 'put'; record: ContactRecord } | { type: 'delete'; key: string };
  message:
    | { type: 'add'; record: MessageRecord }
    | { type: 'update'; record: MessageRecord }
    | { type: 'delete'; id: number; convKey: string };
  channel: { type: 'put'; record: ChannelRecord } | { type: 'delete'; key: string };
  /** A conversation's unread count changed. */
  unread: { convType: ConversationType; convKey: string; count: number };
  setting: { key: string; value: unknown };
  /** A noise-floor sample was stored. */
  noiseFloor: NoiseFloorSample;
  /** Noise-floor samples were removed (prune / clear); re-query. */
  noiseFloorChanged: { removed: number };
}

export interface DevicesEvents {
  device: { type: 'put'; record: DeviceRecord } | { type: 'delete'; pubKey: string };
}

export type RadioStoreEmitter = TypedEmitter<RadioStoreEvents>;

/**
 * Emits without letting a listener error fail the (already committed) store operation; such
 * errors are reported via `console.error`.
 */
export function safeEmit<E extends object, K extends keyof E>(emitter: TypedEmitter<E>, event: K, payload: E[K]): void {
  try {
    emitter.emit(event, payload);
  } catch (err) {
    console.error(`store listener for "${String(event)}" threw`, err);
  }
}
