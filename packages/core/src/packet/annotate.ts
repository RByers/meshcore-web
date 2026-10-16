/**
 * Byte-level packet annotator for the packet inspector. docs/mesh-packet-format.md §1-§3.
 *
 * Produces a tree whose leaves (ignoring `bits` and `decrypted` children) tile the packet exactly.
 * Header/path_len bit fields are `bits` children of their byte. When a key decrypts an encrypted
 * payload and its MAC verifies, the ciphertext node gets `decrypted: true` children that tile the
 * ciphertext range (AES-ECB keeps byte positions, so plaintext byte i sits at ciphertext offset +
 * i). Never throws: problems are collected in `errors`.
 */

import { readU16LE, readU32LE, toHex, utf8Decode } from '../util/bytes.js';
import { ContactType, ReqType, TxtType, decodePathLen, isValidPathLen } from '../protocol/constants.js';
import {
  CIPHER_BLOCK_SIZE,
  MAX_ADVERT_DATA_SIZE,
  PH_ROUTE_MASK,
  PayloadType,
  hasTransportCodes,
  payloadTypeName,
  routeTypeName,
} from './constants.js';
import { calcSharedSecret, ed25519Verify, macThenDecrypt } from './crypto.js';
import { firmwareRejectReasons, packetHash, parsePacket } from './packet.js';
import { advertSignedMessage, channelHash } from './payloads.js';

export interface AnnotationNode {
  /** Absolute byte offset within the packet. */
  offset: number;
  length: number;
  name: string;
  value: string;
  meaning?: string;
  children?: AnnotationNode[];
  /** This node describes decrypted plaintext (positions map 1:1 onto the ciphertext bytes). */
  decrypted?: true;
  /** A bit field of its parent's byte (does not take part in byte tiling). */
  bits?: { mask: number };
}

export interface Annotation extends AnnotationNode {
  /** Problems found (truncation, invalid encodings, firmware rejection reasons). */
  errors: string[];
}

export interface AnnotateKeys {
  /** Channel PSKs (16 or 32 bytes) to try on GRP_TXT / GRP_DATA. */
  channelPsks?: readonly Uint8Array[];
  /** Raw 32-byte peer shared secrets to try on REQ/RESPONSE/TXT_MSG/PATH/ANON_REQ. */
  sharedSecrets?: readonly Uint8Array[];
  /** Local identity, for ECDH with `contacts` / ANON_REQ senders. `privateKey` = 64-byte expanded key. */
  self?: { publicKey: Uint8Array; privateKey: Uint8Array };
  /** Known peer public keys. */
  contacts?: readonly Uint8Array[];
}

export interface AnnotateOptions {
  keys?: AnnotateKeys;
  /** Verify advert signatures (default true). */
  verifySignatures?: boolean;
}

type Pending = () => Promise<void>;

const ADV_TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(ContactType).map(([k, v]) => [v, k.toLowerCase()]),
);
const REQ_NAMES: Record<number, string> = Object.fromEntries(Object.entries(ReqType).map(([k, v]) => [v, k]));
const TXT_NAMES: Record<number, string> = Object.fromEntries(Object.entries(TxtType).map(([k, v]) => [v, k]));

function hex2(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}

function i8(b: number): number {
  return b > 127 ? b - 256 : b;
}

function isoTime(ts: number): string {
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().replace('.000Z', 'Z');
}

/** Cursor that appends nodes over `src[pos..end)`; reported offset = `base + pos`. */
class Fields {
  readonly nodes: AnnotationNode[] = [];
  constructor(
    readonly src: Uint8Array,
    public pos: number,
    readonly end: number,
    readonly base: number,
    readonly errors: string[],
    readonly decrypted = false,
  ) {}

  get remaining(): number {
    return this.end - this.pos;
  }

  bytes(len: number): Uint8Array {
    return this.src.subarray(this.pos, this.pos + len);
  }

  /** Adds a node of `len` bytes, or records a truncation error and returns null. */
  add(
    len: number,
    name: string,
    value: (b: Uint8Array) => string = toHex,
    meaning?: string | ((b: Uint8Array) => string | undefined),
  ): AnnotationNode | null {
    if (len <= 0) return null;
    if (len > this.remaining) {
      this.errors.push(`${name}: truncated (need ${len} bytes, have ${this.remaining})`);
      return null;
    }
    const b = this.bytes(len);
    const node: AnnotationNode = { offset: this.base + this.pos, length: len, name, value: value(b) };
    const m = typeof meaning === 'function' ? meaning(b) : meaning;
    if (m !== undefined && m !== '') node.meaning = m;
    if (this.decrypted) node.decrypted = true;
    this.nodes.push(node);
    this.pos += len;
    return node;
  }

  u8(name: string, meaning?: (v: number) => string | undefined): AnnotationNode | null {
    return this.add(1, name, (b) => String(b[0]!), meaning ? (b) => meaning(b[0]!) : undefined);
  }

  u16(name: string, meaning?: (v: number) => string | undefined): AnnotationNode | null {
    return this.add(2, name, (b) => String(readU16LE(b, 0)), meaning ? (b) => meaning(readU16LE(b, 0)) : undefined);
  }

  u32(name: string, meaning?: (v: number) => string | undefined): AnnotationNode | null {
    return this.add(4, name, (b) => String(readU32LE(b, 0)), meaning ? (b) => meaning(readU32LE(b, 0)) : undefined);
  }

  timestamp(name: string): AnnotationNode | null {
    return this.u32(name, isoTime);
  }

  /** Remaining bytes as one node. */
  rest(name: string, value: (b: Uint8Array) => string = toHex, meaning?: string | ((b: Uint8Array) => string | undefined)): AnnotationNode | null {
    return this.add(this.remaining, name, value, meaning);
  }

  /** Trailing bytes: all-zero → "padding", else "unparsed". */
  finish(): AnnotationNode[] {
    if (this.remaining > 0) {
      const b = this.bytes(this.remaining);
      if (this.decrypted && b.every((x) => x === 0)) this.rest('padding', toHex, 'zero padding to the AES block size');
      else this.rest('unparsed', toHex, 'bytes not covered by the layout');
    }
    return this.nodes;
  }

  /** Text up to NUL (or end) then the NUL itself, if any. */
  cstring(name: string, meaning?: string): string {
    const view = this.bytes(this.remaining);
    const nul = view.indexOf(0);
    const len = nul < 0 ? view.length : nul;
    const text = utf8Decode(view.subarray(0, len));
    this.add(len, name, () => JSON.stringify(text), meaning);
    return text;
  }
}

function bit(parent: AnnotationNode, mask: number, name: string, value: string, meaning?: string): void {
  const n: AnnotationNode = { offset: parent.offset, length: parent.length, name, value, bits: { mask } };
  if (meaning) n.meaning = meaning;
  if (parent.decrypted) n.decrypted = true;
  (parent.children ??= []).push(n);
}

function pathLenBits(node: AnnotationNode, raw: number, trace = false): void {
  const hashSize = (raw >> 6) + 1;
  bit(node, 0xc0, 'hash size', String(hashSize), hashSize === 4 ? 'reserved (invalid)' : `${hashSize}-byte entries`);
  bit(node, 0x3f, trace ? 'SNR count' : 'hop count', String(raw & 0x3f));
}

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

/** Annotates a raw packet. Decrypts with `opts.keys` when given. Never throws. */
export async function annotatePacket(bytes: Uint8Array, opts: AnnotateOptions = {}): Promise<Annotation> {
  const pending: Pending[] = [];
  const ann = buildAnnotation(bytes, opts, pending);
  for (const p of pending) {
    try {
      await p();
    } catch (e) {
      ann.errors.push(`async step failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return ann;
}

/** Synchronous structural annotation (no decryption, no signature check, no packet hash). */
export function annotatePacketSync(bytes: Uint8Array): Annotation {
  return buildAnnotation(bytes, { verifySignatures: false }, null);
}

/**
 * Annotates a bare payload (no envelope), e.g. the RAW_DATA / TRACE_DATA / CONTROL_DATA payloads
 * the device reports without their packet header. Offsets are relative to `bytes`. Never throws.
 */
export async function annotatePayload(payloadType: number, bytes: Uint8Array, opts: AnnotateOptions = {}): Promise<Annotation> {
  const pending: Pending[] = [];
  const ann = buildPayloadAnnotation(payloadType, bytes, opts, pending);
  for (const p of pending) {
    try {
      await p();
    } catch (e) {
      ann.errors.push(`async step failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return ann;
}

/** Synchronous structural variant of {@link annotatePayload}. */
export function annotatePayloadSync(payloadType: number, bytes: Uint8Array): Annotation {
  return buildPayloadAnnotation(payloadType, bytes, { verifySignatures: false }, null);
}

function buildPayloadAnnotation(payloadType: number, bytes: Uint8Array, opts: AnnotateOptions, pending: Pending[] | null): Annotation {
  const errors: string[] = [];
  const root: Annotation = { offset: 0, length: bytes.length, name: 'payload', value: `${payloadTypeName(payloadType)}, ${bytes.length} bytes`, errors };
  try {
    const f = new Fields(bytes, 0, bytes.length, 0, errors);
    if (bytes.length === 0) errors.push('empty payload');
    else annotatePayloadFields(payloadType, f, opts, pending);
    root.children = f.finish();
  } catch (e) {
    errors.push(`annotator failure: ${e instanceof Error ? e.message : String(e)}`);
    root.children = bytes.length ? [{ offset: 0, length: bytes.length, name: 'unparsed', value: toHex(bytes) }] : [];
  }
  return root;
}

function buildAnnotation(bytes: Uint8Array, opts: AnnotateOptions, pending: Pending[] | null): Annotation {
  const errors: string[] = [];
  const root: Annotation = { offset: 0, length: bytes.length, name: 'packet', value: `${bytes.length} bytes`, errors };
  try {
    root.children = annotateEnvelope(bytes, errors, opts, pending, root);
  } catch (e) {
    // Defensive: any bug becomes an error and an unparsed node rather than an exception.
    errors.push(`annotator failure: ${e instanceof Error ? e.message : String(e)}`);
    root.children = bytes.length ? [{ offset: 0, length: bytes.length, name: 'unparsed', value: toHex(bytes) }] : [];
  }
  return root;
}

function annotateEnvelope(
  bytes: Uint8Array,
  errors: string[],
  opts: AnnotateOptions,
  pending: Pending[] | null,
  root: Annotation,
): AnnotationNode[] {
  const f = new Fields(bytes, 0, bytes.length, 0, errors);
  if (bytes.length === 0) {
    errors.push('empty packet');
    return f.nodes;
  }
  const header = bytes[0]!;
  const routeType = header & PH_ROUTE_MASK;
  const payloadType = (header >> 2) & 0x0f;
  const version = header >> 6;
  const hdr = f.add(1, 'header', (b) => hex2(b[0]!), `${routeTypeName(routeType)} ${payloadTypeName(payloadType)}`)!;
  bit(hdr, 0x03, 'route type', String(routeType), routeTypeName(routeType));
  bit(hdr, 0x3c, 'payload type', String(payloadType), payloadTypeName(payloadType));
  bit(hdr, 0xc0, 'payload version', String(version), version === 0 ? 'v1' : 'reserved (dropped by firmware)');
  root.value = `${routeTypeName(routeType)} ${payloadTypeName(payloadType)}`;

  if (hasTransportCodes(routeType)) {
    const tc = f.add(4, 'transport codes', toHex, 'region scope codes (need region keys to verify)');
    if (!tc) return f.finish();
    tc.children = [
      { offset: 1, length: 2, name: 'transport_code[0]', value: String(readU16LE(bytes, 1)), meaning: 'region code' },
      { offset: 3, length: 2, name: 'transport_code[1]', value: String(readU16LE(bytes, 3)), meaning: 'reserved (home region)' },
    ];
  }

  const isTrace = payloadType === PayloadType.TRACE;
  const plNode = f.add(1, 'path_len', (b) => hex2(b[0]!));
  if (!plNode) return f.finish();
  const raw = bytes[f.pos - 1]!;
  pathLenBits(plNode, raw, isTrace);
  if (!isValidPathLen(raw)) {
    errors.push(`invalid path_len ${hex2(raw)}`);
    plNode.meaning = 'invalid';
    return f.finish();
  }
  const pl = decodePathLen(raw);
  plNode.meaning = isTrace ? `${pl.hops} SNR values` : `${pl.hops} hops × ${pl.hashSize} B`;
  if (pl.byteLength > 0) {
    const pathNode = f.add(pl.byteLength, isTrace ? 'path (SNRs)' : 'path');
    if (!pathNode) return f.finish();
    pathNode.children = [];
    for (let i = 0; i < pl.hops; i++) {
      const off = pathNode.offset + i * pl.hashSize;
      const entry = bytes.subarray(off, off + pl.hashSize);
      pathNode.children.push(
        isTrace && pl.hashSize === 1
          ? { offset: off, length: 1, name: `snr[${i}]`, value: String(i8(entry[0]!)), meaning: `${i8(entry[0]!) / 4} dB` }
          : { offset: off, length: pl.hashSize, name: `hop[${i}]`, value: toHex(entry) },
      );
    }
  }

  try {
    const parsed = parsePacket(bytes);
    for (const r of firmwareRejectReasons(parsed)) errors.push(`firmware would reject: ${r}`);
    if (pending) {
      pending.push(async () => {
        root.meaning = `packet hash ${toHex(await packetHash(parsed))}`;
      });
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  if (f.remaining === 0) {
    errors.push('missing payload');
    return f.nodes;
  }
  const payloadNode = f.add(f.remaining, 'payload', toHex, `${payloadTypeName(payloadType)}`)!;
  const pf = new Fields(bytes, payloadNode.offset, bytes.length, 0, errors);
  annotatePayloadFields(payloadType, pf, opts, pending);
  payloadNode.children = pf.finish();
  return f.nodes;
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

function annotatePayloadFields(type: number, f: Fields, opts: AnnotateOptions, pending: Pending[] | null): void {
  switch (type) {
    case PayloadType.REQ:
    case PayloadType.RESPONSE:
    case PayloadType.TXT_MSG:
    case PayloadType.PATH:
      return peerDatagram(type, f, opts, pending);
    case PayloadType.ACK:
      return ackFields(f);
    case PayloadType.ADVERT:
      return advert(f, opts, pending);
    case PayloadType.GRP_TXT:
    case PayloadType.GRP_DATA:
      return groupDatagram(type, f, opts, pending);
    case PayloadType.ANON_REQ:
      return anonReq(f, opts, pending);
    case PayloadType.TRACE:
      return trace(f);
    case PayloadType.MULTIPART:
      return multipart(f);
    case PayloadType.CONTROL:
      return control(f);
    case PayloadType.RAW_CUSTOM:
      f.rest('data', toHex, 'opaque application bytes');
      return;
    default:
      f.errors.push(`reserved payload type ${type}`);
      return;
  }
}

/** MAC + ciphertext nodes; schedules decryption with the candidate secrets. */
function encrypted(
  f: Fields,
  candidates: (() => Promise<{ secret: Uint8Array; label: string }[]>) | null,
  inner: (pf: Fields) => void,
  pending: Pending[] | null,
): void {
  const macNode = f.add(2, 'MAC', toHex, 'HMAC-SHA256(secret, ciphertext)[0..2]');
  if (!macNode) return;
  const ctLen = f.remaining;
  const ctNode = f.rest('ciphertext', toHex, `AES-128-ECB, ${ctLen} bytes`);
  if (!ctNode) {
    f.errors.push('missing ciphertext');
    return;
  }
  if (ctLen % CIPHER_BLOCK_SIZE !== 0) {
    f.errors.push(`ciphertext length ${ctLen} is not a multiple of ${CIPHER_BLOCK_SIZE} (firmware rejects)`);
    return;
  }
  if (!candidates || !pending) return;
  const macAndCt = f.src.slice(macNode.offset - f.base, ctNode.offset - f.base + ctNode.length);
  pending.push(async () => {
    for (const c of await candidates()) {
      const pt = await macThenDecrypt(c.secret, macAndCt);
      if (!pt) continue;
      macNode.meaning = `verified (${c.label})`;
      ctNode.meaning = `decrypted with ${c.label}`;
      const pf = new Fields(pt, 0, pt.length, ctNode.offset, f.errors, true);
      try {
        inner(pf);
      } catch (e) {
        f.errors.push(`decrypted payload: ${e instanceof Error ? e.message : String(e)}`);
      }
      ctNode.children = pf.finish();
      return;
    }
  });
}

function peerCandidates(destHash: number, srcHash: number, keys: AnnotateKeys | undefined) {
  if (!keys) return null;
  return async (): Promise<{ secret: Uint8Array; label: string }[]> => {
    const out: { secret: Uint8Array; label: string }[] = [];
    (keys.sharedSecrets ?? []).forEach((s, i) => out.push({ secret: s, label: `shared secret #${i}` }));
    const self = keys.self;
    if (self) {
      for (const c of keys.contacts ?? []) {
        const mine = self.publicKey[0];
        if ((c[0] === srcHash && mine === destHash) || (c[0] === destHash && mine === srcHash)) {
          try {
            out.push({ secret: await calcSharedSecret(self.privateKey, c), label: `ECDH with ${toHex(c.subarray(0, 6))}` });
          } catch {
            // invalid contact key; skip
          }
        }
      }
    }
    return out;
  };
}

function peerDatagram(type: number, f: Fields, opts: AnnotateOptions, pending: Pending[] | null): void {
  const dest = f.src[f.pos];
  const src = f.src[f.pos + 1];
  if (!f.add(1, 'dest_hash', (b) => hex2(b[0]!), 'destination pubkey[0]')) return;
  if (!f.add(1, 'src_hash', (b) => hex2(b[0]!), 'source pubkey[0]')) return;
  const inner =
    type === PayloadType.TXT_MSG ? txtMsgInner : type === PayloadType.REQ ? reqInner : type === PayloadType.PATH ? pathInner : responseInner;
  encrypted(f, peerCandidates(dest!, src!, opts.keys), inner, pending);
}

function anonReq(f: Fields, opts: AnnotateOptions, pending: Pending[] | null): void {
  const dest = f.src[f.pos]!;
  if (!f.add(1, 'dest_hash', (b) => hex2(b[0]!), 'destination pubkey[0]')) return;
  const senderNode = f.add(32, 'sender public key', toHex, 'cleartext Ed25519 key of the requester');
  if (!senderNode) return;
  const sender = f.src.slice(senderNode.offset - f.base, senderNode.offset - f.base + 32);
  const keys = opts.keys;
  const candidates = keys
    ? async () => {
        const out: { secret: Uint8Array; label: string }[] = [];
        (keys.sharedSecrets ?? []).forEach((s, i) => out.push({ secret: s, label: `shared secret #${i}` }));
        const self = keys.self;
        if (self) {
          const targets: Uint8Array[] = [];
          if (self.publicKey[0] === dest) targets.push(sender);
          if (sender.every((b, i) => b === self.publicKey[i])) targets.push(...(keys.contacts ?? []).filter((c) => c[0] === dest));
          for (const t of targets) {
            try {
              out.push({ secret: await calcSharedSecret(self.privateKey, t), label: `ECDH with ${toHex(t.subarray(0, 6))}` });
            } catch {
              // skip
            }
          }
        }
        return out;
      }
    : null;
  encrypted(f, candidates, anonInner, pending);
}

function groupDatagram(type: number, f: Fields, opts: AnnotateOptions, pending: Pending[] | null): void {
  const hash = f.src[f.pos]!;
  if (!f.add(1, 'channel_hash', (b) => hex2(b[0]!), 'SHA256(PSK)[0]')) return;
  const psks = opts.keys?.channelPsks;
  const candidates = psks?.length
    ? async () => {
        const out: { secret: Uint8Array; label: string }[] = [];
        for (const [i, psk] of psks.entries()) {
          try {
            if ((await channelHash(psk)) === hash) out.push({ secret: psk, label: `channel PSK #${i}` });
          } catch {
            // bad PSK length
          }
        }
        return out;
      }
    : null;
  encrypted(f, candidates, type === PayloadType.GRP_TXT ? grpTxtInner : grpDataInner, pending);
}

function ackFields(f: Fields): void {
  f.add(4, 'ack code', toHex, (b) => `u32 ${readU32LE(b, 0)}; first 4 bytes of SHA256(plaintext ‖ pubkey)`);
  if (f.remaining >= 2) {
    f.u8('extended attempt', () => 'byte after the text NUL in the original plaintext');
    f.add(1, 'random', toHex, 'makes the packet hash unique');
  }
}

function advert(f: Fields, opts: AnnotateOptions, pending: Pending[] | null): void {
  const start = f.pos;
  const pkNode = f.add(32, 'public key', toHex, 'Ed25519');
  if (!pkNode) return;
  if (!f.timestamp('timestamp')) return;
  const sigNode = f.add(64, 'signature', toHex, 'Ed25519 over pubkey ‖ timestamp ‖ app_data[0..32]');
  if (!sigNode) return;
  const appStart = f.pos;
  const appEnd = Math.min(f.end, appStart + MAX_ADVERT_DATA_SIZE);
  if (f.remaining === 0) {
    f.errors.push('advert without app_data');
  } else {
    const appNode = f.add(appEnd - appStart, 'app_data')!;
    const af = new Fields(f.src, appStart, appEnd, f.base, f.errors);
    advertAppData(af);
    appNode.children = af.finish();
    if (f.remaining > 0) f.rest('ignored', toHex, 'beyond 32 bytes of app_data (not signed or parsed)');
  }
  if (pending && opts.verifySignatures !== false) {
    const pub = f.src.slice(start, start + 32);
    const ts = readU32LE(f.src, start + 32);
    const sig = f.src.slice(start + 36, start + 100);
    const app = f.src.slice(appStart, appEnd);
    pending.push(async () => {
      const ok = await ed25519Verify(pub, advertSignedMessage(pub, ts, app), sig);
      sigNode.meaning = ok ? 'valid signature' : 'INVALID signature';
      if (!ok) f.errors.push('advert signature does not verify');
    });
  }
}

function advertAppData(f: Fields): void {
  const flags = f.src[f.pos]!;
  const node = f.add(1, 'flags', (b) => hex2(b[0]!))!;
  bit(node, 0x0f, 'node type', String(flags & 0x0f), ADV_TYPE_NAMES[flags & 0x0f] ?? 'future');
  bit(node, 0x10, 'has lat/lon', String(Boolean(flags & 0x10)));
  bit(node, 0x20, 'has feat1', String(Boolean(flags & 0x20)));
  bit(node, 0x40, 'has feat2', String(Boolean(flags & 0x40)));
  bit(node, 0x80, 'has name', String(Boolean(flags & 0x80)));
  const i32 = (b: Uint8Array): number => new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true);
  if (flags & 0x10) {
    if (!f.add(4, 'latitude', (b) => String(i32(b) / 1e6), '° (i32 ×1e6)')) return;
    if (!f.add(4, 'longitude', (b) => String(i32(b) / 1e6), '° (i32 ×1e6)')) return;
  }
  if (flags & 0x20 && !f.u16('feat1', () => 'reserved')) return;
  if (flags & 0x40 && !f.u16('feat2', () => 'reserved')) return;
  if (flags & 0x80) f.rest('name', (b) => JSON.stringify(utf8Decode(b, true)), 'UTF-8, no NUL');
}

function trace(f: Fields): void {
  if (!f.u32('tag')) return;
  if (!f.u32('auth code')) return;
  const flags = f.src[f.pos]!;
  const node = f.add(1, 'flags', (b) => hex2(b[0]!));
  if (!node) return;
  const sz = 1 << (flags & 3);
  bit(node, 0x03, 'path_sz', String(flags & 3), `${sz}-byte hop hashes`);
  if (f.remaining === 0) return;
  const list = f.rest('hop hashes', toHex, 'nodes to visit')!;
  list.children = [];
  let i = 0;
  let off = list.offset;
  for (; off + sz <= list.offset + list.length; off += sz, i++) {
    list.children.push({ offset: off, length: sz, name: `hash[${i}]`, value: toHex(f.src.subarray(off - f.base, off - f.base + sz)) });
  }
  if (off < list.offset + list.length) {
    const len = list.offset + list.length - off;
    list.children.push({ offset: off, length: len, name: 'unparsed', value: toHex(f.src.subarray(off - f.base, off - f.base + len)), meaning: 'partial hash entry' });
    f.errors.push('trace hop list is not a multiple of the hash size');
  }
}

function multipart(f: Fields): void {
  const b0 = f.src[f.pos]!;
  const node = f.add(1, 'multipart header', (b) => hex2(b[0]!));
  if (!node) return;
  bit(node, 0xf0, 'remaining', String(b0 >> 4));
  bit(node, 0x0f, 'inner type', String(b0 & 0x0f), payloadTypeName(b0 & 0x0f));
  if ((b0 & 0x0f) === PayloadType.ACK) ackFields(f);
  else f.rest('inner payload');
}

function control(f: Fields): void {
  const flags = f.src[f.pos]!;
  const node = f.add(1, 'flags', (b) => hex2(b[0]!));
  if (!node) return;
  const sub = flags & 0xf0;
  bit(node, 0xf0, 'sub_type', hex2(sub), sub === 0x80 ? 'DISCOVER_REQ' : sub === 0x90 ? 'DISCOVER_RESP' : 'unknown');
  if (sub === 0x80) {
    bit(node, 0x01, 'prefix_only', String(flags & 1));
    f.u8('type filter', (v) => `bitmask of 1<<ADV_TYPE: ${v.toString(2).padStart(8, '0')}`);
    f.u32('tag');
    if (f.remaining >= 4) f.timestamp('since');
  } else if (sub === 0x90) {
    bit(node, 0x0f, 'node type', String(flags & 0x0f), ADV_TYPE_NAMES[flags & 0x0f] ?? 'future');
    f.add(1, 'snr', (b) => String(i8(b[0]!)), (b) => `${i8(b[0]!) / 4} dB`);
    f.u32('tag');
    f.rest('public key', toHex, (b) => (b.length === 8 ? 'prefix' : b.length === 32 ? 'full key' : 'unexpected length'));
  } else {
    f.rest('data');
  }
}

// ---------------------------------------------------------------------------
// Decrypted inner layouts
// ---------------------------------------------------------------------------

function txtMsgInner(f: Fields): void {
  f.timestamp('timestamp');
  const flags = f.src[f.pos];
  const node = f.add(1, 'flags', (b) => hex2(b[0]!));
  if (!node || flags === undefined) return;
  const t = flags >> 2;
  bit(node, 0xfc, 'txt_type', String(t), TXT_NAMES[t] ?? 'unknown');
  bit(node, 0x03, 'attempt', String(flags & 3));
  if (t === TxtType.SIGNED_PLAIN) f.add(4, 'author prefix', toHex, 'author pubkey[0..4]');
  f.cstring('text', 'UTF-8');
  if (f.remaining > 0) {
    f.add(1, 'NUL', toHex);
    const ext = f.src[f.pos];
    if (ext !== undefined && ext > 3) f.u8('extended attempt');
  }
}

function reqInner(f: Fields): void {
  f.timestamp('timestamp (tag)');
  f.u8('req_type', (v) => REQ_NAMES[v] ?? 'app-defined');
  trimmedRest(f, 'request data');
}

function responseInner(f: Fields): void {
  f.u32('tag', (v) => `request tag / server time ${isoTime(v)}`);
  trimmedRest(f, 'response body', 'layout depends on the request (§3.2)');
}

function anonInner(f: Fields): void {
  f.timestamp('timestamp');
  trimmedRest(f, 'request data', 'login: password (repeater/sensor) or sync_since u32 + password (room); or type + reply path');
}

function grpTxtInner(f: Fields): void {
  f.timestamp('timestamp');
  const flags = f.src[f.pos];
  const node = f.add(1, 'flags', (b) => hex2(b[0]!));
  if (!node || flags === undefined) return;
  bit(node, 0xfc, 'txt_type', String(flags >> 2), flags >> 2 === 0 ? 'PLAIN' : 'unsupported (dropped)');
  bit(node, 0x03, 'attempt', String(flags & 3));
  const text = f.cstring('text', '"<sender>: <message>"');
  const sep = text.indexOf(': ');
  const last = f.nodes[f.nodes.length - 1];
  if (sep >= 0 && last) last.meaning = `sender ${JSON.stringify(text.slice(0, sep))} (unauthenticated)`;
  if (f.remaining > 0 && f.src[f.pos] === 0) f.add(1, 'NUL', toHex);
}

function grpDataInner(f: Fields): void {
  f.u16('data_type', (v) => (v === 0 ? 'reserved (invalid)' : v === 0xffff ? 'dev' : v >= 0xff00 ? 'testing' : undefined));
  const len = f.src[f.pos];
  f.u8('data_len');
  if (len !== undefined) {
    if (len > f.remaining) f.errors.push(`grp data: data_len ${len} exceeds ${f.remaining} available`);
    f.add(Math.min(len, f.remaining), 'data');
  }
}

function pathInner(f: Fields): void {
  const raw = f.src[f.pos];
  const node = f.add(1, 'path_len', (b) => hex2(b[0]!), 'route from the original sender to the replier');
  if (!node || raw === undefined) return;
  pathLenBits(node, raw);
  if (!isValidPathLen(raw)) {
    f.errors.push(`PATH: invalid inner path_len ${hex2(raw)}`);
    return;
  }
  const pl = decodePathLen(raw);
  if (pl.byteLength > 0) {
    const p = f.add(pl.byteLength, 'path');
    if (!p) return;
    p.decrypted = true;
    p.children = [];
    for (let i = 0; i < pl.hops; i++) {
      const off = p.offset + i * pl.hashSize;
      p.children.push({
        offset: off,
        length: pl.hashSize,
        name: `hop[${i}]`,
        value: toHex(f.src.subarray(off - f.base, off - f.base + pl.hashSize)),
        decrypted: true,
      });
    }
  }
  const et = f.src[f.pos];
  if (!f.add(1, 'extra_type', (b) => hex2(b[0]!), (b) => (b[0] === 0xff ? 'none' : payloadTypeName(b[0]! & 0x0f)))) return;
  if (et === 0xff) {
    f.add(Math.min(4, f.remaining), 'random', toHex, 'makes the packet hash unique');
  } else if (et !== undefined && (et & 0x0f) === PayloadType.ACK) {
    f.add(4, 'ack code', toHex, (b) => `u32 ${readU32LE(b, 0)}`);
    // optional 6-byte form: attempt byte + random byte (indistinguishable from padding when zero)
    if (f.remaining >= 2 && !f.bytes(f.remaining).every((x) => x === 0)) {
      f.add(1, 'extended attempt', toHex);
      f.add(1, 'random', toHex);
    }
  } else if (et !== undefined && (et & 0x0f) === PayloadType.RESPONSE) {
    f.u32('response tag');
    trimmedRest(f, 'response body');
  } else {
    trimmedRest(f, 'extra');
  }
}

/** Remaining bytes minus trailing zero padding (which `finish()` labels). */
function trimmedRest(f: Fields, name: string, meaning?: string): void {
  const b = f.bytes(f.remaining);
  let n = b.length;
  while (n > 0 && b[n - 1] === 0) n--;
  if (n > 0) f.add(n, name, toHex, meaning);
}
