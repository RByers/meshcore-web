/** Facade opening every repository of one radio's database (`meshcore-web:<pubkeyHex>`). */

import type { DeviceFrame } from '../protocol/types.js';
import { decodeFrame } from '../protocol/decode.js';
import { TypedEmitter } from '../util/events.js';
import { deleteDatabase, openDatabase, type IdbDatabase } from './idb.js';
import { RADIO_DB_MIGRATIONS, RADIO_DB_VERSION, pubKeyHex, radioDbName, type FrameDirection, type FrameRecord, type PacketRecord } from './schema.js';
import type { LogStoreName, RadioStoreEvents } from './events.js';
import { DEFAULT_RETENTION, type RetentionPolicy } from './time-log.js';
import { FrameLog } from './frame-log.js';
import { PacketLog } from './packet-log.js';
import { ContactsRepo } from './contacts.js';
import { MessagesRepo } from './messages.js';
import { ChannelsRepo } from './channels.js';
import { SettingsRepo } from './settings.js';
import type { StoreOpenOptions } from './devices.js';

export interface RadioStoreOptions extends StoreOpenOptions {
  /** Retention defaults for `prune()`; merged over {@link DEFAULT_RETENTION}. */
  retention?: Partial<Record<LogStoreName, RetentionPolicy>>;
}

export interface CaptureResult {
  frame: FrameRecord;
  /** The over-the-air packet carried by the frame (LOG_RX_DATA / RAW_DATA / TRACE / CONTROL). */
  packet: PacketRecord | null;
  /** The decoded frame for 'in' frames (null if decoding failed or for 'out'). */
  decoded: DeviceFrame | null;
}

export class RadioStore {
  readonly events = new TypedEmitter<RadioStoreEvents>();
  readonly frames: FrameLog;
  readonly packets: PacketLog;
  readonly contacts: ContactsRepo;
  readonly messages: MessagesRepo;
  readonly channels: ChannelsRepo;
  readonly settings: SettingsRepo;

  private constructor(
    readonly pubKey: string,
    readonly db: IdbDatabase,
    retention: Partial<Record<LogStoreName, RetentionPolicy>>,
  ) {
    this.frames = new FrameLog(db, this.events, { ...DEFAULT_RETENTION.frames, ...retention.frames });
    this.packets = new PacketLog(db, this.events, { ...DEFAULT_RETENTION.packets, ...retention.packets });
    this.contacts = new ContactsRepo(db, this.events);
    this.messages = new MessagesRepo(db, this.events);
    this.channels = new ChannelsRepo(db, this.events);
    this.settings = new SettingsRepo(db, this.events);
  }

  /** Opens (creating / migrating as needed) the database of the radio with this public key. */
  static async open(pubKey: Uint8Array | string, opts: RadioStoreOptions = {}): Promise<RadioStore> {
    const hex = pubKeyHex(pubKey);
    const db = await openDatabase({
      name: radioDbName(hex),
      version: RADIO_DB_VERSION,
      migrations: RADIO_DB_MIGRATIONS,
      ...(opts.factory ? { factory: opts.factory } : {}),
      ...(opts.keyRange ? { keyRange: opts.keyRange } : {}),
    });
    return new RadioStore(hex, db, opts.retention ?? {});
  }

  /** Deletes a radio's database entirely. */
  static delete(pubKey: Uint8Array | string, opts: StoreOpenOptions = {}): Promise<void> {
    return deleteDatabase(radioDbName(pubKey), opts.factory);
  }

  /**
   * Capture pipeline step: logs a frame and, for packet-bearing pushes, the packet it carries
   * (linked via `sourceFrameId`). Pass `decoded` if the caller already decoded the frame.
   */
  async captureFrame(
    direction: FrameDirection,
    bytes: Uint8Array,
    opts: { ts?: number; decoded?: DeviceFrame } = {},
  ): Promise<CaptureResult> {
    let decoded: DeviceFrame | null = null;
    if (direction === 'in') {
      try {
        decoded = opts.decoded ?? decodeFrame(bytes);
      } catch {
        decoded = null;
      }
    }
    const ts = opts.ts ?? Date.now();
    const frame = await this.frames.append({ direction, bytes, ts, ...(decoded ? { kind: decoded.kind } : {}) });
    const packet = decoded ? await this.packets.appendFromFrame(decoded, { ts, sourceFrameId: frame.id }) : null;
    return { frame, packet, decoded };
  }

  /** Applies both logs' retention policies. */
  async prune(now = Date.now()): Promise<{ frames: number; packets: number }> {
    const frames = await this.frames.prune(undefined, now);
    const packets = await this.packets.prune(undefined, now);
    return { frames, packets };
  }

  close(): void {
    this.db.close();
    this.events.removeAllListeners();
  }
}
