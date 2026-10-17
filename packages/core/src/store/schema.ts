/**
 * IndexedDB schema: one database per radio (`meshcore-web:<pubkeyHex>`) plus one global
 * `meshcore-web:devices` database listing known radios. roadmap.md goals 3 and 5.
 *
 * Bytes are stored as `Uint8Array` (structured clone); timestamps are epoch milliseconds unless
 * the field says "secs" (sender/firmware clocks are epoch seconds).
 */

import type { Contact, DeviceInfo, SelfInfo } from '../protocol/types.js';
import { toHex } from '../util/bytes.js';
import type { Migration } from './idb.js';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const DB_PREFIX = 'meshcore-web:';
export const DEVICES_DB_NAME = `${DB_PREFIX}devices`;

/** Normalises a public key (bytes or hex) to lowercase hex. */
export function pubKeyHex(pubKey: Uint8Array | string): string {
  const hex = typeof pubKey === 'string' ? pubKey.trim().toLowerCase() : toHex(pubKey);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`invalid public key hex: ${JSON.stringify(hex)}`);
  }
  return hex;
}

export function radioDbName(pubKey: Uint8Array | string): string {
  return `${DB_PREFIX}${pubKeyHex(pubKey)}`;
}

export const STORE = {
  frames: 'frames',
  packets: 'packets',
  contacts: 'contacts',
  messages: 'messages',
  channels: 'channels',
  settings: 'settings',
} as const;
export type RadioStoreName = (typeof STORE)[keyof typeof STORE];

export const DEVICES_STORE = 'devices';

/** Index names per store. Compound indexes end in the column used for ordering. */
export const INDEX = {
  frames: { ts: 'ts', code: 'code', directionTs: 'direction_ts', codeTs: 'code_ts' },
  packets: {
    ts: 'ts',
    payloadType: 'payloadType',
    hash: 'hash',
    directionTs: 'direction_ts',
    payloadTypeTs: 'payloadType_ts',
  },
  messages: { convTs: 'conv_ts', convReceived: 'conv_received', status: 'status', ackCode: 'ackCode' },
  channels: { deviceIndex: 'deviceIndex' },
  devices: { lastConnected: 'lastConnected' },
} as const;

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

/** 'in' = device → host, 'out' = host → device. */
export type FrameDirection = 'in' | 'out';

export interface FrameRecord {
  id: number;
  /** Epoch ms when the frame crossed the transport. */
  ts: number;
  direction: FrameDirection;
  /** The complete companion frame (code byte first, no serial framing). */
  bytes: Uint8Array;
  /** First byte (command / response / push code); -1 for an empty frame. */
  code: number;
  /** Decoded `DeviceFrame['kind']` (in) or `Command['kind']` (out), or 'unknown'. */
  kind: string;
  size: number;
}

/** 'rx' = heard by the radio, 'tx' = sent by the radio. */
export type PacketDirection = 'rx' | 'tx';

/**
 * Where a packet record came from: a LOG_RX_DATA push (full packet), a RAW_DATA push (RAW_CUSTOM
 * payload only), a TRACE_DATA push (trace payload reconstructed from the push), a packet we asked
 * the device to send, or an import.
 */
export type PacketSource = 'logRxData' | 'rawData' | 'traceData' | 'sent' | 'import' | 'other';

/**
 * What `bytes` holds: a full over-the-air packet (`packet`), only a payload (`payload`, for
 * RAW_DATA and TRACE_DATA pushes where the device does not report the envelope, and for sent
 * packets whose payload the host supplied), or nothing (`none`: a transmission the host asked the
 * radio to make, e.g. CMD_SEND_TXT_MSG, recorded from the command frame. The radio builds and
 * encrypts the on-air bytes itself and does not echo them, so only the requested fields, kept in
 * `decodedSummary`, are known; `bytes` is empty and `hash` is ''). Adding `none` needed no
 * IndexedDB migration: `format` is not indexed.
 */
export type PacketBytesFormat = 'packet' | 'payload' | 'none';

export interface PacketRecord {
  id: number;
  ts: number;
  direction: PacketDirection;
  bytes: Uint8Array;
  format: PacketBytesFormat;
  source: PacketSource;
  /** SNR in dB (already divided by 4). */
  snr?: number;
  /** RSSI in dBm. */
  rssi?: number;
  /** `frames.id` of the frame that carried / requested this packet. */
  sourceFrameId?: number;
  /** RouteType (0..3), or -1 when unknown (payload-only / unparsable). */
  routeType: number;
  /** PayloadType (0..15), or -1 when unparsable. */
  payloadType: number;
  /** Raw encoded path_len byte, or -1 when unknown. */
  pathLen: number;
  /** Packet hash (§1.4, 8 bytes) as hex; '' when it could not be computed. */
  hash: string;
  decodedSummary?: string;
  /** Set when `format === 'packet'` but the envelope did not parse. */
  parseError?: string;
}

/** App-only contact fields (not on the device). */
export interface ContactLocalFields {
  /** Epoch ms we last heard from / about this contact (0 = never). */
  lastSeen: number;
  unreadCount: number;
  notes: string;
  favourite: boolean;
  muted: boolean;
  /**
   * SMAZ-compress outgoing DMs (MeshCore Open compatible, feature-inventory.md §2.4a). Optional:
   * records written before this field existed read as off, so no migration is needed.
   */
  smaz?: boolean;
  /**
   * Paths used for (or observed towards) this contact with their delivery statistics, most
   * recently used first (issue #6, mirrors MeshCore Open's path history). Optional: absent = none.
   */
  pathHistory?: PathHistoryEntry[];
}

/** Outcome of the last message sent over a path. */
export type PathResult = 'success' | 'failure';

/** One remembered path to a contact (see `app/path-history.ts`). */
export interface PathHistoryEntry {
  /** Raw out_path_len byte (0xFF = flood). */
  pathLen: number;
  /** The hop hashes (hops × hash size bytes); empty for flood / direct. */
  path: Uint8Array;
  /** Messages sent over this path (each message counts once per path, retries included). */
  attempts: number;
  /** Messages delivered (ACK) over this path. */
  successes: number;
  /** Messages not delivered over this path (ACK timeout). */
  failures: number;
  /** Epoch ms this path was last used for a send, set or observed. */
  lastUsed: number;
  /** Epoch ms of the last delivery over this path. */
  lastSuccess?: number;
  lastResult?: PathResult;
  /** Round trip of the last delivery (ms). */
  roundTripMs?: number;
  /** First learnt from the device (PATH_UPDATED / advert) rather than by sending over it. */
  observed?: boolean;
}

export interface ContactRecord extends Contact, ContactLocalFields {
  /** Primary key: public key hex. */
  key: string;
  /** Whether the contact was in the device's list at the last sync. */
  onDevice: boolean;
  /** Epoch ms of the last write. */
  updatedAt: number;
}

export const DEFAULT_CONTACT_LOCAL: Readonly<ContactLocalFields> = {
  lastSeen: 0,
  unreadCount: 0,
  notes: '',
  favourite: false,
  muted: false,
};

/** feature-inventory.md §3.2. Channel messages never become 'delivered'. */
export type { MessageStatus } from "../client/types.js";
import type { MessageStatus } from "../client/types.js";
export type MessageDirection = 'in' | 'out';
export type ConversationType = 'contact' | 'channel';

export interface MessageRecord {
  id: number;
  /** Contact public key hex, or channel key (sha256(psk) hex). */
  convKey: string;
  convType: ConversationType;
  direction: MessageDirection;
  text: string;
  /** Sender's clock, epoch secs. */
  timestamp: number;
  /** Local arrival (or creation, for outgoing) time, epoch ms. Lists sort by this. */
  receivedAt: number;
  txtType: number;
  status: MessageStatus;
  /** Expected ACK code (u32) for outgoing DMs (RESP_SENT tag). */
  ackCode?: number;
  /** Send attempt (0-based) for outgoing DMs. */
  attempt?: number;
  /** Raw encoded path_len byte (0xFF = flood/direct-zero-hop per firmware conventions). */
  pathLen: number;
  snr?: number;
  /** Channel messages: the "sender: text" prefix. */
  senderName?: string;
  /** DM: sender pubkey prefix hex as reported by the device. */
  senderPrefix?: string;
  /** `frames.id` of the frame this message came from / was sent in. */
  rawFrameId?: number;
  /** Epoch ms of the status change to delivered (for outgoing DMs). */
  deliveredAt?: number;
  roundTripMs?: number;
  /** Sent / received SMAZ-compressed ("s:" envelope, feature-inventory.md §2.4a); `text` is plain. */
  compressed?: boolean;
  /**
   * Emoji reactions to this message (MeshCore Open compatible, feature-inventory.md §2.4b), in
   * arrival order. Optional: records written before this field existed have none, so no migration.
   */
  reactions?: MessageReaction[];
}

/** One reaction on a message. Incoming `r:` texts are stored here, never as messages. */
export interface MessageReaction {
  emoji: string;
  /** Who reacted: the channel sender / DM contact name; our advert name for our own reactions. */
  sender: string;
  /** Our own reaction. */
  own?: true;
  /** Own reactions: send state (pending → sent → delivered for DMs, pending → sent for channels, or failed). */
  status?: MessageStatus;
  /** Local arrival (or send) time, epoch ms. */
  at: number;
}

export interface ChannelRecord {
  /** Primary key: sha256(psk) hex. Survives device slot reuse. */
  key: string;
  /** Device slot (0..maxChannels-1), or null when this channel is not loaded on the device. */
  deviceIndex: number | null;
  name: string;
  psk: Uint8Array;
  muted: boolean;
  unread: number;
  /** SMAZ-compress outgoing messages (MeshCore Open compatible). Optional; absent = off. */
  smaz?: boolean;
  updatedAt: number;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

export type StoredTransportKind = 'serial' | 'ble' | 'emulator' | 'loopback' | (string & {});

export interface DeviceRecord {
  /** Primary key: radio public key hex. */
  pubKey: string;
  name: string;
  /** Epoch ms. */
  firstConnected: number;
  lastConnected: number;
  transport: StoredTransportKind;
  deviceInfo?: DeviceInfo;
  selfInfo?: SelfInfo;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/** v1: initial stores and the single-column indexes. */
const radioV1: Migration = ({ db }) => {
  const frames = db.createObjectStore(STORE.frames, { keyPath: 'id', autoIncrement: true });
  frames.createIndex(INDEX.frames.ts, 'ts');
  frames.createIndex(INDEX.frames.code, 'code');

  const packets = db.createObjectStore(STORE.packets, { keyPath: 'id', autoIncrement: true });
  packets.createIndex(INDEX.packets.ts, 'ts');
  packets.createIndex(INDEX.packets.payloadType, 'payloadType');
  packets.createIndex(INDEX.packets.hash, 'hash');

  db.createObjectStore(STORE.contacts, { keyPath: 'key' });

  const messages = db.createObjectStore(STORE.messages, { keyPath: 'id', autoIncrement: true });
  messages.createIndex(INDEX.messages.convTs, ['convKey', 'timestamp']);
  messages.createIndex(INDEX.messages.status, 'status');
  messages.createIndex(INDEX.messages.ackCode, 'ackCode');

  const channels = db.createObjectStore(STORE.channels, { keyPath: 'key' });
  channels.createIndex(INDEX.channels.deviceIndex, 'deviceIndex');

  db.createObjectStore(STORE.settings, { keyPath: 'key' });
};

/**
 * v2: compound indexes for filtered time-ordered paging (packet log filters, arrival-order chat
 * lists) and back-fill of contact local fields / `onDevice` for v1 records.
 */
const radioV2: Migration = ({ tx }) => {
  const frames = tx.objectStore(STORE.frames);
  frames.createIndex(INDEX.frames.directionTs, ['direction', 'ts']);
  frames.createIndex(INDEX.frames.codeTs, ['code', 'ts']);

  const packets = tx.objectStore(STORE.packets);
  packets.createIndex(INDEX.packets.directionTs, ['direction', 'ts']);
  packets.createIndex(INDEX.packets.payloadTypeTs, ['payloadType', 'ts']);

  const messages = tx.objectStore(STORE.messages);
  messages.createIndex(INDEX.messages.convReceived, ['convKey', 'receivedAt']);

  const contacts = tx.objectStore(STORE.contacts);
  const req = contacts.openCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    const rec = cursor.value as Partial<ContactRecord> & { key: string };
    cursor.update({ ...DEFAULT_CONTACT_LOCAL, onDevice: true, updatedAt: 0, ...rec });
    cursor.continue();
  };
};

export const RADIO_DB_MIGRATIONS: readonly Migration[] = [radioV1, radioV2];
export const RADIO_DB_VERSION = RADIO_DB_MIGRATIONS.length;

const devicesV1: Migration = ({ db }) => {
  const devices = db.createObjectStore(DEVICES_STORE, { keyPath: 'pubKey' });
  devices.createIndex(INDEX.devices.lastConnected, 'lastConnected');
};

export const DEVICES_DB_MIGRATIONS: readonly Migration[] = [devicesV1];
export const DEVICES_DB_VERSION = DEVICES_DB_MIGRATIONS.length;
