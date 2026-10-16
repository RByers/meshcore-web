/**
 * Byte-level annotator for companion frames (host ↔ device), for the frame inspector. Produces the
 * same {@link Annotation} tree as the packet annotator (packet/annotate.ts): leaf nodes (ignoring
 * `bits` children) tile the frame exactly, so every byte is explained.
 *
 * Layouts: docs/companion-protocol.md §2 (APP_START, SELF_INFO, DEVICE_QUERY / DEVICE_INFO), §4
 * (command table), §5 (responses), §6 (pushes), §7.1 (contact record). Over-the-air packets carried
 * by frames (LOG_RX_DATA, EXPORT_CONTACT, IMPORT_CONTACT, SEND_RAW_PACKET, RAW_DATA, CONTROL_DATA)
 * are annotated with the packet annotator and nested. Never throws: problems go to `errors`.
 */

import { readU16LE, readU32LE, toHex, utf8Decode } from '../util/bytes.js';
import {
  annotatePacketSync,
  annotatePayloadSync,
  type Annotation,
  type AnnotationNode,
} from '../packet/annotate.js';
import { PayloadType } from '../packet/constants.js';
import {
  CMD,
  ContactType,
  PATH_LEN_UNKNOWN,
  PUSH,
  RESP,
  ReqType,
  StatsType,
  TxtType,
  cmdName,
  decodePathLen,
  deviceFrameName,
  errName,
  isPushCode,
} from './constants.js';

/** 'in' = device → host (response / push), 'out' = host → device (command). */
export type FrameAnnotationDirection = 'in' | 'out';

const TYPE_NAMES: Record<number, string> = Object.fromEntries(Object.entries(ContactType).map(([k, v]) => [v, k.toLowerCase()]));
const TXT_NAMES: Record<number, string> = Object.fromEntries(Object.entries(TxtType).map(([k, v]) => [v, k]));
const REQ_NAMES: Record<number, string> = Object.fromEntries(Object.entries(ReqType).map(([k, v]) => [v, k]));

function hex2(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}

function isoTime(secs: number): string {
  const d = new Date(secs * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().replace('.000Z', 'Z');
}

function i8(b: number): number {
  return b > 127 ? b - 256 : b;
}

/** Shifts every node of a sub-annotation by `delta` bytes (for nesting packets inside frames). */
export function shiftAnnotation<T extends AnnotationNode>(n: T, delta: number): T {
  const out = { ...n, offset: n.offset + delta } as T;
  if (n.children) out.children = n.children.map((c) => shiftAnnotation(c, delta));
  return out;
}

/** Cursor that appends tiling nodes over `bytes`. Short frames produce a truncated node + error. */
class Cursor {
  readonly nodes: AnnotationNode[] = [];
  pos = 0;
  /** Set once a field ran past the end; later fields are silently skipped. */
  truncated = false;
  constructor(
    readonly bytes: Uint8Array,
    readonly errors: string[],
  ) {}

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  view(len: number): Uint8Array {
    return this.bytes.subarray(this.pos, this.pos + len);
  }

  /**
   * Adds a node of `len` bytes. If fewer remain, the rest becomes a "(truncated)" node, an error
   * is recorded, and null is returned (callers stop there).
   */
  add(len: number, name: string, value: (b: Uint8Array) => string = toHex, meaning?: string | ((b: Uint8Array) => string | undefined)): AnnotationNode | null {
    if (len <= 0 || this.truncated) return null;
    if (len > this.remaining) {
      this.truncated = true;
      this.errors.push(`${name}: truncated (need ${len} bytes, have ${this.remaining})`);
      if (this.remaining > 0) {
        const b = this.view(this.remaining);
        this.nodes.push({ offset: this.pos, length: b.length, name: `${name} (truncated)`, value: toHex(b) });
        this.pos = this.bytes.length;
      }
      return null;
    }
    const b = this.view(len);
    const node: AnnotationNode = { offset: this.pos, length: len, name, value: value(b) };
    const m = typeof meaning === 'function' ? meaning(b) : meaning;
    if (m !== undefined && m !== '') node.meaning = m;
    this.nodes.push(node);
    this.pos += len;
    return node;
  }

  u8(name: string, meaning?: (v: number) => string | undefined): AnnotationNode | null {
    return this.add(1, name, (b) => String(b[0]!), meaning ? (b) => meaning(b[0]!) : undefined);
  }
  i8(name: string, meaning?: (v: number) => string | undefined): AnnotationNode | null {
    return this.add(1, name, (b) => String(i8(b[0]!)), meaning ? (b) => meaning(i8(b[0]!)) : undefined);
  }
  u16(name: string, meaning?: (v: number) => string | undefined): AnnotationNode | null {
    return this.add(2, name, (b) => String(readU16LE(b, 0)), meaning ? (b) => meaning(readU16LE(b, 0)) : undefined);
  }
  i16(name: string, meaning?: (v: number) => string | undefined): AnnotationNode | null {
    const s16 = (b: Uint8Array): number => (readU16LE(b, 0) << 16) >> 16;
    return this.add(2, name, (b) => String(s16(b)), meaning ? (b) => meaning(s16(b)) : undefined);
  }
  u32(name: string, meaning?: (v: number) => string | undefined): AnnotationNode | null {
    return this.add(4, name, (b) => String(readU32LE(b, 0)), meaning ? (b) => meaning(readU32LE(b, 0)) : undefined);
  }
  i32(name: string, meaning?: (v: number) => string | undefined): AnnotationNode | null {
    return this.add(4, name, (b) => String(readU32LE(b, 0) | 0), meaning ? (b) => meaning(readU32LE(b, 0) | 0) : undefined);
  }
  timestamp(name: string): AnnotationNode | null {
    return this.u32(name, (v) => (v ? isoTime(v) : 'unset'));
  }
  /** i8 SNR ×4. */
  snr(name = 'SNR'): AnnotationNode | null {
    return this.add(1, name, (b) => String(i8(b[0]!)), (b) => `${i8(b[0]!) / 4} dB (×4)`);
  }
  rssi(): AnnotationNode | null {
    return this.add(1, 'RSSI', (b) => String(i8(b[0]!)), 'dBm');
  }
  degrees(name: string): AnnotationNode | null {
    return this.i32(name, (v) => `${v / 1e6}° (i32 ×1e6)`);
  }
  hex(len: number, name: string, meaning?: string): AnnotationNode | null {
    return this.add(len, name, toHex, meaning);
  }
  reserved(len: number, meaning = 'reserved'): AnnotationNode | null {
    return this.add(len, 'reserved', toHex, meaning);
  }
  pubKey(name = 'public key'): AnnotationNode | null {
    return this.hex(32, name, 'Ed25519 public key');
  }
  prefix6(name = 'pubkey prefix'): AnnotationNode | null {
    return this.hex(6, name, 'first 6 bytes of the public key');
  }
  /** Fixed char[n] field (stops at the first NUL; bytes after it are padding / stale). */
  cfield(len: number, name: string): AnnotationNode | null {
    return this.add(len, name, (b) => JSON.stringify(utf8Decode(b, true)), (b) => {
      const nul = b.indexOf(0);
      return nul < 0 ? `char[${len}], no NUL` : `char[${len}], NUL at +${nul}`;
    });
  }
  /** Text to the frame end. */
  text(name: string, meaning = 'UTF-8, rest of frame'): AnnotationNode | null {
    return this.add(this.remaining, name, (b) => JSON.stringify(utf8Decode(b, true)), meaning);
  }
  rest(name: string, meaning?: string): AnnotationNode | null {
    return this.add(this.remaining, name, toHex, meaning);
  }
  /** Encoded path_len byte (§1.3 of mesh-packet-format.md); `sentinel` describes 0xFF. */
  pathLen(name: string, sentinel?: string): { node: AnnotationNode; byteLength: number } | null {
    const raw = this.bytes[this.pos];
    const node = this.add(1, name, (b) => hex2(b[0]!));
    if (!node || raw === undefined) return null;
    if (raw === PATH_LEN_UNKNOWN && sentinel) {
      node.meaning = sentinel;
      return { node, byteLength: 0 };
    }
    const info = decodePathLen(raw);
    const hashSize = (raw >> 6) + 1;
    node.children = [
      { offset: node.offset, length: 1, name: 'hash size', value: String(hashSize), meaning: hashSize === 4 ? 'reserved (invalid)' : `${hashSize}-byte entries`, bits: { mask: 0xc0 } },
      { offset: node.offset, length: 1, name: 'hop count', value: String(raw & 0x3f), bits: { mask: 0x3f } },
    ];
    if (!info.valid) {
      node.meaning = 'invalid';
      this.errors.push(`${name}: invalid path_len ${hex2(raw)}`);
      return { node, byteLength: 0 };
    }
    node.meaning = `${info.hops} hops × ${info.hashSize} B`;
    return { node, byteLength: info.byteLength };
  }
  path(len: number, hashSize: number, name = 'path'): AnnotationNode | null {
    if (len <= 0) return null;
    const node = this.hex(len, name);
    if (!node) return null;
    node.children = [];
    const n = Math.max(1, hashSize);
    for (let i = 0; i * n < len; i++) {
      const off = node.offset + i * n;
      const l = Math.min(n, len - i * n);
      node.children.push({ offset: off, length: l, name: `hop[${i}]`, value: toHex(this.bytes.subarray(off, off + l)) });
    }
    return node;
  }
  /** A raw over-the-air packet, annotated and nested. */
  packet(len: number, name = 'packet'): AnnotationNode | null {
    const start = this.pos;
    const node = this.hex(len, name);
    if (!node) return null;
    const ann = annotatePacketSync(this.bytes.subarray(start, start + node.length));
    nest(node, ann, start, this.errors);
    return node;
  }
  /** A bare payload of the given type, annotated and nested. */
  payload(len: number, payloadType: number, name = 'payload'): AnnotationNode | null {
    const start = this.pos;
    const node = this.hex(len, name);
    if (!node) return null;
    nest(node, annotatePayloadSync(payloadType, this.bytes.subarray(start, start + node.length)), start, this.errors);
    return node;
  }
  bit(node: AnnotationNode | null, mask: number, name: string, value: string, meaning?: string): void {
    if (!node) return;
    const n: AnnotationNode = { offset: node.offset, length: node.length, name, value, bits: { mask } };
    if (meaning) n.meaning = meaning;
    (node.children ??= []).push(n);
  }
  /** Bytes beyond the layout. */
  finish(what = 'trailing bytes'): AnnotationNode[] {
    if (this.remaining > 0) this.rest(what, 'beyond the documented layout (ignored)');
    return this.nodes;
  }
}

function nest(node: AnnotationNode, ann: Annotation, start: number, errors: string[]): void {
  node.value = ann.value;
  if (ann.meaning) node.meaning = ann.meaning;
  node.children = (ann.children ?? []).map((c) => shiftAnnotation(c, start));
  for (const e of ann.errors) errors.push(`${node.name}: ${e}`);
}

/** Annotates a companion frame. `direction` 'in' = device → host, 'out' = host → device. */
export function annotateFrame(direction: FrameAnnotationDirection, bytes: Uint8Array): Annotation {
  const errors: string[] = [];
  const root: Annotation = { offset: 0, length: bytes.length, name: 'frame', value: `${bytes.length} bytes`, errors };
  if (bytes.length === 0) {
    errors.push('empty frame');
    root.children = [];
    return root;
  }
  const code = bytes[0]!;
  const name = direction === 'out' ? cmdName(code) : deviceFrameName(code);
  root.value = name ?? `unknown ${hex2(code)}`;
  root.meaning = direction === 'out' ? 'host → device command' : isPushCode(code) ? 'device → host push' : 'device → host response';
  const c = new Cursor(bytes, errors);
  c.add(1, 'code', (b) => hex2(b[0]!), name ?? (direction === 'out' ? 'unknown command' : 'unknown frame code'));
  try {
    if (direction === 'out') commandBody(code, c);
    else deviceBody(code, c);
    if (!name) {
      errors.push(`unknown ${direction === 'out' ? 'command' : 'frame'} code ${hex2(code)}`);
      c.finish('body');
    } else c.finish();
  } catch (e) {
    errors.push(`annotator failure: ${e instanceof Error ? e.message : String(e)}`);
    c.finish('unparsed');
  }
  root.children = c.nodes;
  return root;
}

// ---------------------------------------------------------------------------
// Shared records
// ---------------------------------------------------------------------------

/** Contact record body (§7.1) from offset 1. `optionalTail`: CMD 9 may omit lat/lon/lastmod. */
function contactRecord(c: Cursor, optionalTail = false): void {
  if (!c.pubKey()) return;
  if (!c.u8('type', (v) => TYPE_NAMES[v] ?? 'unknown')) return;
  if (!c.u8('flags', (v) => contactFlags(v))) return;
  const raw = c.bytes[c.pos];
  const pl = c.pathLen('out_path_len', 'unknown path (flood)');
  if (!pl || raw === undefined) return;
  const pathStart = c.pos;
  if (c.remaining < 64) {
    c.add(64, 'out_path');
    return;
  }
  if (pl.byteLength > 0) c.path(pl.byteLength, (raw >> 6) + 1, 'out_path');
  if (c.pos - pathStart < 64) c.hex(64 - (c.pos - pathStart), 'out_path padding', 'unused bytes of the 64-byte path field');
  if (!c.cfield(32, 'name')) return;
  if (!c.timestamp('last_advert')) return;
  if (optionalTail && c.remaining === 0) return;
  if (!c.degrees('latitude')) return;
  if (!c.degrees('longitude')) return;
  if (optionalTail && c.remaining === 0) return;
  c.timestamp('lastmod');
}

function contactFlags(v: number): string {
  const names: string[] = [];
  if (v & 0x01) names.push('favourite');
  if (v & 0x02) names.push('telemetry base');
  if (v & 0x04) names.push('telemetry location');
  if (v & 0x08) names.push('telemetry environment');
  if (v & 0x10) names.push('remote CLI');
  return names.length ? names.join(', ') : 'none';
}

/** RepeaterStats / ServerStats common part. mesh-packet-format.md §3.2 */
function nodeStats(c: Cursor): void {
  const fields: Array<[string, 'u16' | 'i16' | 'u32', string?]> = [
    ['battery', 'u16', 'mV'],
    ['tx queue', 'u16'],
    ['noise floor', 'i16', 'dBm'],
    ['last RSSI', 'i16', 'dBm'],
    ['packets recv', 'u32'],
    ['packets sent', 'u32'],
    ['air time', 'u32', 'secs'],
    ['uptime', 'u32', 'secs'],
    ['sent flood', 'u32'],
    ['sent direct', 'u32'],
    ['recv flood', 'u32'],
    ['recv direct', 'u32'],
    ['err events', 'u16'],
    ['last SNR', 'i16', '×4 dB'],
    ['direct dups', 'u16'],
    ['flood dups', 'u16'],
  ];
  for (const [n, t, unit] of fields) {
    if (c.remaining === 0) return;
    const m = unit ? () => unit : undefined;
    if (!(t === 'u16' ? c.u16(n, m) : t === 'i16' ? c.i16(n, m) : c.u32(n, m))) return;
  }
  if (c.remaining === 4) {
    c.u16('posted');
    c.u16('post push');
  } else if (c.remaining >= 8) {
    c.u32('rx air time', () => 'secs');
    c.u32('recv errors');
  }
}

// ---------------------------------------------------------------------------
// Device → host
// ---------------------------------------------------------------------------

function deviceBody(code: number, c: Cursor): void {
  switch (code) {
    case RESP.OK:
    case RESP.NO_MORE_MESSAGES:
    case RESP.DISABLED:
    case PUSH.MSG_WAITING:
    case PUSH.CONTACTS_FULL:
      return;
    case RESP.ERR:
      c.u8('error code', (v) => errName(v));
      return;
    case RESP.CONTACTS_START:
      c.u32('total', () => 'number of contacts on the device');
      return;
    case RESP.CONTACT:
    case PUSH.NEW_ADVERT:
      contactRecord(c);
      return;
    case RESP.END_OF_CONTACTS:
      c.u32('most recent lastmod', (v) => (v ? isoTime(v) : 'none sent'));
      return;
    case RESP.SELF_INFO: {
      c.u8('adv type', (v) => TYPE_NAMES[v] ?? 'unknown');
      c.i8('tx power', () => 'dBm');
      c.i8('max tx power', () => 'dBm');
      if (!c.pubKey()) return;
      if (!c.degrees('latitude') || !c.degrees('longitude')) return;
      c.u8('multi acks');
      c.u8('advert loc policy', (v) => (v === 0 ? 'none' : v === 1 ? 'share' : 'unknown'));
      const tm = c.u8('telemetry modes', (v) => `base ${v & 3}, location ${(v >> 2) & 3}, environment ${(v >> 4) & 3}`);
      c.bit(tm, 0x03, 'base', String(c.bytes[46]! & 3));
      c.bit(tm, 0x0c, 'location', String((c.bytes[46]! >> 2) & 3));
      c.bit(tm, 0x30, 'environment', String((c.bytes[46]! >> 4) & 3));
      c.u8('manual add contacts', (v) => (v & 1 ? 'manual' : 'auto'));
      c.u32('radio freq', (v) => `${v / 1000} MHz`);
      c.u32('radio bw', (v) => `${v / 1000} kHz`);
      c.u8('radio sf', (v) => `SF${v}`);
      c.u8('radio cr', (v) => `4/${v}`);
      c.text('name', 'UTF-8 to the end of the frame, no NUL');
      return;
    }
    case RESP.SENT:
      c.u8('flood', (v) => (v === 1 ? 'sent flood' : 'sent direct'));
      c.add(4, 'tag / expected ack', toHex, (b) => `u32 ${readU32LE(b, 0)}`);
      c.u32('est timeout', () => 'ms');
      return;
    case RESP.CONTACT_MSG_RECV:
    case RESP.CONTACT_MSG_RECV_V3: {
      if (code === RESP.CONTACT_MSG_RECV_V3) {
        c.snr();
        c.reserved(2);
      }
      c.prefix6('sender prefix');
      c.pathLen('path_len', 'received direct');
      const t = c.bytes[c.pos];
      c.u8('txt_type', (v) => TXT_NAMES[v] ?? 'unknown');
      c.timestamp('sender timestamp');
      if (t === TxtType.SIGNED_PLAIN) c.hex(4, 'author prefix', 'author pubkey[0..4] (room server post)');
      if (c.remaining > 0) c.text('text');
      return;
    }
    case RESP.CHANNEL_MSG_RECV:
    case RESP.CHANNEL_MSG_RECV_V3:
      if (code === RESP.CHANNEL_MSG_RECV_V3) {
        c.snr();
        c.reserved(2);
      }
      c.u8('channel idx');
      c.pathLen('path_len', 'received direct');
      c.u8('txt_type', (v) => TXT_NAMES[v] ?? 'unknown');
      c.timestamp('sender timestamp');
      if (c.remaining > 0) c.text('text', '"<sender>: <message>"');
      return;
    case RESP.CURR_TIME:
      c.timestamp('epoch secs');
      return;
    case RESP.EXPORT_CONTACT:
      c.packet(c.remaining, 'advert packet');
      return;
    case RESP.BATT_AND_STORAGE:
      c.u16('battery', () => 'mV');
      if (c.remaining > 0) {
        c.u32('storage used', () => 'KB');
        c.u32('storage total', () => 'KB');
      }
      return;
    case RESP.DEVICE_INFO: {
      c.u8('firmware ver code');
      const opt = (): boolean => c.remaining > 0;
      if (!opt()) return;
      c.u8('max contacts / 2', (v) => `${v * 2} contacts`);
      c.u8('max channels');
      if (!opt()) return;
      c.u32('BLE PIN');
      if (!opt()) return;
      c.cfield(12, 'build date');
      if (!opt()) return;
      c.cfield(40, 'manufacturer');
      if (!opt()) return;
      c.cfield(20, 'firmware version');
      if (!opt()) return;
      c.u8('client repeat', (v) => (v ? 'on' : 'off'));
      if (!opt()) return;
      c.u8('path hash mode', (v) => `${v + 1}-byte hashes`);
      return;
    }
    case RESP.PRIVATE_KEY:
      c.hex(64, 'private key', '64-byte expanded Ed25519 private key');
      return;
    case RESP.CHANNEL_INFO:
      c.u8('channel idx');
      c.cfield(32, 'name');
      c.hex(16, 'secret', '128-bit channel PSK');
      return;
    case RESP.SIGN_START:
      c.reserved(1);
      c.u32('max length', () => 'bytes');
      return;
    case RESP.SIGNATURE:
      c.hex(64, 'signature', 'Ed25519');
      return;
    case RESP.CUSTOM_VARS:
    case RESP.CLI_REPLY:
      if (c.remaining > 0) c.text(code === RESP.CLI_REPLY ? 'reply' : 'vars', code === RESP.CLI_REPLY ? 'UTF-8' : '"name:value,name:value"');
      return;
    case RESP.ADVERT_PATH: {
      c.timestamp('recv timestamp');
      const pl = c.pathLen('path_len');
      if (pl && pl.byteLength > 0) c.path(pl.byteLength, (c.bytes[5]! >> 6) + 1);
      return;
    }
    case RESP.TUNING_PARAMS:
      c.u32('rx delay base', (v) => `×1000 = ${v / 1000}`);
      c.u32('airtime factor', (v) => `×1000 = ${v / 1000}`);
      return;
    case RESP.STATS: {
      const t = c.bytes[1];
      c.u8('stats type', (v) => (v === StatsType.CORE ? 'CORE' : v === StatsType.RADIO ? 'RADIO' : v === StatsType.PACKETS ? 'PACKETS' : 'unknown'));
      if (t === StatsType.CORE) {
        c.u16('battery', () => 'mV');
        c.u32('uptime', () => 'secs');
        c.u16('err flags', (v) => [v & 1 ? 'queue full' : '', v & 2 ? 'CAD timeout' : '', v & 4 ? 'start RX timeout' : ''].filter(Boolean).join(', ') || 'none');
        c.u8('outbound queue');
      } else if (t === StatsType.RADIO) {
        c.i16('noise floor', () => 'dBm');
        c.i8('last RSSI', () => 'dBm');
        c.snr('last SNR');
        c.u32('tx air time', () => 'secs');
        c.u32('rx air time', () => 'secs');
      } else if (t === StatsType.PACKETS) {
        for (const n of ['recv', 'sent', 'sent flood', 'sent direct', 'recv flood', 'recv direct']) c.u32(n);
        if (c.remaining >= 4) c.u32('recv errors');
      } else if (c.remaining > 0) {
        c.rest('stats data', 'unknown stats type');
      }
      return;
    }
    case RESP.AUTOADD_CONFIG:
      c.u8('config', (v) => autoAddFlags(v));
      c.u8('max hops');
      return;
    case RESP.ALLOWED_REPEAT_FREQ:
      for (let i = 0; c.remaining >= 8; i++) {
        c.u32(`range[${i}] lower`, (v) => `${v / 1000} MHz`);
        c.u32(`range[${i}] upper`, (v) => `${v / 1000} MHz`);
      }
      return;
    case RESP.CHANNEL_DATA_RECV: {
      c.snr();
      c.reserved(2);
      c.u8('channel idx');
      c.pathLen('path_len', 'received direct');
      c.u16('data type');
      const n = c.bytes[c.pos];
      c.u8('data len');
      if (n !== undefined && n > 0) c.hex(n, 'data');
      return;
    }
    case RESP.DEFAULT_FLOOD_SCOPE:
      if (c.remaining === 0) return;
      c.cfield(31, 'scope name');
      c.hex(16, 'scope key', 'transport key');
      return;

    // ---- pushes ----
    case PUSH.ADVERT:
    case PUSH.PATH_UPDATED:
    case PUSH.CONTACT_DELETED:
      c.pubKey();
      return;
    case PUSH.SEND_CONFIRMED:
      c.add(4, 'ack code', toHex, (b) => `u32 ${readU32LE(b, 0)}`);
      c.u32('round trip', () => 'ms');
      return;
    case PUSH.RAW_DATA:
      c.snr();
      c.rssi();
      c.reserved(1);
      if (c.remaining > 0) c.payload(c.remaining, PayloadType.RAW_CUSTOM);
      return;
    case PUSH.LOGIN_SUCCESS:
      c.u8('admin flag', (v) => (v === 1 ? 'admin' : v === 2 ? 'guest' : 'other'));
      c.prefix6();
      if (c.remaining === 0) return;
      c.timestamp('server timestamp');
      c.u8('ACL permissions', (v) => ['guest', 'read-only', 'read-write', 'admin'][v & 3]);
      c.u8('server firmware level');
      return;
    case PUSH.LOGIN_FAIL:
      c.reserved(1);
      c.prefix6();
      return;
    case PUSH.STATUS_RESPONSE: {
      c.reserved(1);
      c.prefix6();
      if (c.remaining === 0) return;
      const start = c.pos;
      const node = c.rest('status', c.remaining === 52 ? 'ServerStats' : 'RepeaterStats');
      if (node) {
        const sub = new Cursor(c.bytes.subarray(0, c.bytes.length), c.errors);
        sub.pos = start;
        nodeStats(sub);
        sub.finish();
        node.children = sub.nodes;
      }
      return;
    }
    case PUSH.LOG_RX_DATA:
      c.snr();
      c.rssi();
      if (c.remaining > 0) c.packet(c.remaining);
      else c.errors.push('LOG_RX_DATA without packet bytes');
      return;
    case PUSH.TRACE_DATA: {
      c.reserved(1);
      const pathLen = c.bytes[c.pos];
      c.u8('path_len', () => 'byte length of the hash list');
      const flags = c.bytes[c.pos];
      const fl = c.u8('flags');
      if (pathLen === undefined || flags === undefined) return;
      const sz = flags & 3;
      c.bit(fl, 0x03, 'path_sz', String(sz), `${1 << sz}-byte hashes`);
      c.u32('tag');
      c.u32('auth code');
      if (pathLen > 0) c.path(pathLen, 1 << sz, 'path hashes');
      const hops = pathLen >> sz;
      for (let i = 0; i < hops && c.remaining > 0; i++) c.snr(`snr[${i}]`);
      c.snr('final SNR');
      return;
    }
    case PUSH.TELEMETRY_RESPONSE:
      c.reserved(1);
      c.prefix6();
      if (c.remaining > 0) c.rest('CayenneLPP');
      return;
    case PUSH.BINARY_RESPONSE:
      c.reserved(1);
      c.u32('tag');
      if (c.remaining > 0) c.rest('response data');
      return;
    case PUSH.PATH_DISCOVERY_RESPONSE: {
      c.reserved(1);
      c.prefix6();
      const outRaw = c.bytes[c.pos];
      const out = c.pathLen('out_path_len');
      if (!out || outRaw === undefined) return;
      if (out.byteLength > 0) c.path(out.byteLength, (outRaw >> 6) + 1, 'out path');
      const inRaw = c.bytes[c.pos];
      const inn = c.pathLen('in_path_len');
      if (!inn || inRaw === undefined) return;
      if (inn.byteLength > 0) c.path(inn.byteLength, (inRaw >> 6) + 1, 'in path');
      return;
    }
    case PUSH.CONTROL_DATA:
      c.snr();
      c.rssi();
      c.u8('path_len');
      if (c.remaining > 0) c.payload(c.remaining, PayloadType.CONTROL);
      return;
    default:
      return;
  }
}

function autoAddFlags(v: number): string {
  const n: string[] = [];
  if (v & 0x01) n.push('overwrite oldest');
  if (v & 0x02) n.push('chat');
  if (v & 0x04) n.push('repeater');
  if (v & 0x08) n.push('room');
  if (v & 0x10) n.push('sensor');
  return n.length ? n.join(', ') : 'none';
}

// ---------------------------------------------------------------------------
// Host → device
// ---------------------------------------------------------------------------

function commandBody(code: number, c: Cursor): void {
  const opt = (): boolean => c.remaining > 0;
  switch (code) {
    case CMD.APP_START:
      c.u8('app version');
      c.reserved(6);
      if (opt()) c.text('app name');
      return;
    case CMD.SEND_TXT_MSG:
      c.u8('txt_type', (v) => TXT_NAMES[v] ?? 'unknown');
      c.u8('attempt');
      c.timestamp('timestamp');
      c.prefix6('recipient prefix');
      if (opt()) c.text('text');
      return;
    case CMD.SEND_CHANNEL_TXT_MSG:
      c.u8('txt_type', (v) => TXT_NAMES[v] ?? 'unknown');
      c.u8('channel idx');
      c.timestamp('timestamp');
      if (opt()) c.text('text');
      return;
    case CMD.GET_CONTACTS:
      if (c.remaining >= 4) c.u32('since', (v) => `lastmod > ${isoTime(v)}`);
      return;
    case CMD.SET_DEVICE_TIME:
      c.timestamp('epoch secs');
      return;
    case CMD.SEND_SELF_ADVERT:
      if (opt()) c.u8('mode', (v) => (v === 1 ? 'flood' : 'zero-hop'));
      return;
    case CMD.SET_ADVERT_NAME:
      c.text('name', 'UTF-8 (truncated to 31 bytes)');
      return;
    case CMD.ADD_UPDATE_CONTACT:
      contactRecord(c, true);
      return;
    case CMD.SET_RADIO_PARAMS:
      c.u32('freq', (v) => `${v / 1000} MHz`);
      c.u32('bw', (v) => `${v / 1000} kHz`);
      c.u8('sf', (v) => `SF${v}`);
      c.u8('cr', (v) => `4/${v}`);
      if (opt()) c.u8('client repeat', (v) => (v ? 'on' : 'off'));
      return;
    case CMD.SET_RADIO_TX_POWER:
      c.i8('tx power', () => 'dBm');
      return;
    case CMD.RESET_PATH:
    case CMD.REMOVE_CONTACT:
    case CMD.SHARE_CONTACT:
    case CMD.SEND_STATUS_REQ:
    case CMD.HAS_CONNECTION:
    case CMD.LOGOUT:
    case CMD.GET_CONTACT_BY_KEY:
      c.pubKey();
      return;
    case CMD.EXPORT_CONTACT:
      if (opt()) c.pubKey();
      return;
    case CMD.SET_ADVERT_LATLON:
      c.degrees('latitude');
      c.degrees('longitude');
      if (opt()) c.i32('altitude', () => 'ignored');
      return;
    case CMD.IMPORT_CONTACT:
      c.packet(c.remaining, 'advert packet');
      return;
    case CMD.REBOOT:
    case CMD.FACTORY_RESET:
      c.text('magic', 'literal required by the firmware');
      return;
    case CMD.SET_TUNING_PARAMS:
      c.u32('rx delay base', (v) => `×1000 = ${v / 1000}`);
      c.u32('airtime factor', (v) => `×1000 = ${v / 1000}`);
      return;
    case CMD.DEVICE_QUERY:
      c.u8('app target ver', () => 'protocol version the app speaks');
      return;
    case CMD.IMPORT_PRIVATE_KEY:
      c.hex(64, 'private key', '64-byte expanded Ed25519 private key');
      return;
    case CMD.SEND_RAW_DATA: {
      const raw = c.bytes[c.pos];
      const pl = c.pathLen('path_len');
      if (!pl || raw === undefined) return;
      if (pl.byteLength > 0) c.path(pl.byteLength, (raw >> 6) + 1);
      if (opt()) c.payload(c.remaining, PayloadType.RAW_CUSTOM);
      return;
    }
    case CMD.SEND_LOGIN:
      c.pubKey();
      if (opt()) c.text('password');
      return;
    case CMD.GET_CHANNEL:
      c.u8('channel idx');
      return;
    case CMD.SET_CHANNEL:
      c.u8('channel idx');
      c.cfield(32, 'name');
      c.hex(c.remaining >= 32 ? 32 : 16, 'secret', c.remaining >= 32 ? '256-bit (unsupported: ERR 1)' : '128-bit channel PSK');
      return;
    case CMD.SIGN_DATA:
      c.rest('chunk');
      return;
    case CMD.SEND_TRACE_PATH: {
      c.u32('tag');
      c.u32('auth code');
      const flags = c.bytes[c.pos];
      const fl = c.u8('flags');
      if (flags === undefined) return;
      c.bit(fl, 0x03, 'path_sz', String(flags & 3), `${1 << (flags & 3)}-byte hashes`);
      if (opt()) c.path(c.remaining, 1 << (flags & 3), 'path hashes');
      return;
    }
    case CMD.SET_DEVICE_PIN:
      c.u32('pin', (v) => (v === 0 ? 'random / default' : undefined));
      return;
    case CMD.SET_OTHER_PARAMS:
      c.u8('manual add contacts', (v) => (v & 1 ? 'manual' : 'auto'));
      if (!opt()) return;
      c.u8('telemetry modes', (v) => `base ${v & 3}, location ${(v >> 2) & 3}, environment ${(v >> 4) & 3}`);
      if (!opt()) return;
      c.u8('advert loc policy', (v) => (v === 0 ? 'none' : v === 1 ? 'share' : 'unknown'));
      if (!opt()) return;
      c.u8('multi acks');
      return;
    case CMD.SEND_TELEMETRY_REQ:
      c.reserved(3);
      if (opt()) c.pubKey();
      else c.nodes[0]!.meaning = 'CMD 39 with length 4: self telemetry';
      return;
    case CMD.SET_CUSTOM_VAR:
      c.text('var', '"name:value"');
      return;
    case CMD.GET_ADVERT_PATH:
      c.reserved(1);
      c.pubKey();
      return;
    case CMD.SEND_BINARY_REQ:
      c.pubKey();
      if (opt()) {
        const t = c.bytes[c.pos]!;
        c.rest('request data', `first byte = req type ${REQ_NAMES[t] ?? hex2(t)}`);
      }
      return;
    case CMD.SEND_PATH_DISCOVERY_REQ:
      c.reserved(1, 'reserved (must be 0)');
      c.pubKey();
      return;
    case CMD.SET_FLOOD_SCOPE_KEY:
      c.u8('mode', (v) => (v === 1 ? 'force unscoped' : v === 0 ? 'set / clear key' : 'invalid'));
      if (opt()) c.hex(c.remaining >= 16 ? 16 : c.remaining, 'transport key');
      return;
    case CMD.SEND_CONTROL_DATA:
      c.payload(c.remaining, PayloadType.CONTROL, 'control payload');
      return;
    case CMD.GET_STATS:
      c.u8('stats type', (v) => (v === 0 ? 'CORE' : v === 1 ? 'RADIO' : v === 2 ? 'PACKETS' : 'unknown'));
      return;
    case CMD.SEND_ANON_REQ:
      c.pubKey();
      if (opt()) c.rest('request data');
      return;
    case CMD.SET_AUTOADD_CONFIG:
      c.u8('config', (v) => autoAddFlags(v));
      if (opt()) c.u8('max hops');
      return;
    case CMD.SET_PATH_HASH_MODE:
      c.reserved(1, 'reserved (must be 0)');
      c.u8('mode', (v) => `${v + 1}-byte hashes`);
      return;
    case CMD.SEND_CHANNEL_DATA: {
      c.u8('channel idx');
      const raw = c.bytes[c.pos];
      const pl = c.pathLen('path_len', 'flood');
      if (!pl || raw === undefined) return;
      if (pl.byteLength > 0) c.path(pl.byteLength, (raw >> 6) + 1);
      c.u16('data type');
      if (opt()) c.rest('payload');
      return;
    }
    case CMD.SET_DEFAULT_FLOOD_SCOPE:
      if (c.remaining < 47) {
        if (opt()) c.rest('ignored', 'shorter than 48 bytes: clears the default scope');
        return;
      }
      c.cfield(31, 'scope name');
      c.hex(16, 'scope key', 'transport key');
      return;
    case CMD.SEND_RAW_PACKET:
      c.u8('priority');
      if (opt()) c.packet(c.remaining);
      return;
    case CMD.RUN_CLI_COMMAND:
      c.text('command');
      return;
    default:
      // GET_DEVICE_TIME, SYNC_NEXT_MESSAGE, GET_BATT_AND_STORAGE, EXPORT_PRIVATE_KEY, SIGN_START,
      // SIGN_FINISH, GET_CUSTOM_VARS, GET_TUNING_PARAMS, GET_AUTOADD_CONFIG, GET_ALLOWED_REPEAT_FREQ,
      // GET_DEFAULT_FLOOD_SCOPE: no body.
      return;
  }
}
