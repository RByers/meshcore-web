/**
 * Payload parsers/builders for every PAYLOAD_TYPE. docs/mesh-packet-format.md §3.
 *
 * `parsePayload` decodes the parts visible without keys; the `parse*Plaintext` functions decode
 * the inner layouts after decryption (plaintext keeps its zero padding, §2), and the `build*`
 * functions produce byte-exact firmware layouts.
 */

import {
  concatBytes,
  readU16LE,
  readU32LE,
  u16le,
  u32le,
  utf8Decode,
  utf8Encode,
  writeU32LE,
} from '../util/bytes.js';
import {
  AdvertFlag,
  ControlType,
  MAX_GROUP_DATA_LENGTH,
  MAX_TEXT_LEN,
  TxtType,
  decodePathLen,
  encodePathLen,
  isValidPathLen,
} from '../protocol/constants.js';
import { decodeNodeStats } from '../protocol/decode.js';
import type { NodeStats } from '../protocol/types.js';
import {
  ACK_CODE_SIZE,
  ADVERT_FIXED_SIZE,
  CIPHER_BLOCK_SIZE,
  CIPHER_MAC_SIZE,
  MAX_ADVERT_DATA_SIZE,
  MAX_PACKET_PAYLOAD,
  PATH_EXTRA_NONE,
  PUB_KEY_SIZE,
  PayloadType,
  RESP_SERVER_LOGIN_OK,
  SIGNATURE_SIZE,
} from './constants.js';
import { ed25519Sign, ed25519Verify, encryptThenMac, macThenDecrypt, sha256 } from './crypto.js';

/** Thrown by payload parsers/builders for truncated or out-of-range input. */
export class PayloadError extends Error {
  override readonly name = 'PayloadError';
}

function need(bytes: Uint8Array, n: number, what: string): void {
  if (bytes.length < n) throw new PayloadError(`${what}: need ${n} bytes, got ${bytes.length}`);
}

function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

function i8(b: number): number {
  return b > 127 ? b - 256 : b;
}

/** Bytes up to the first NUL (or the end). */
function cBytes(bytes: Uint8Array): Uint8Array {
  const nul = bytes.indexOf(0);
  return nul < 0 ? bytes : bytes.subarray(0, nul);
}

function toBytes(text: string | Uint8Array): Uint8Array {
  return typeof text === 'string' ? utf8Encode(text) : text;
}

/** Longest prefix of `b` (≤ max bytes) that does not split a UTF-8 sequence (`validUtf8PrefixLength`). */
export function utf8Truncate(b: Uint8Array, max: number): Uint8Array {
  if (b.length <= max) return b;
  let n = max;
  while (n > 0 && (b[n]! & 0xc0) === 0x80) n--;
  return b.subarray(0, n);
}

// ---------------------------------------------------------------------------
// Hashes & codes
// ---------------------------------------------------------------------------

/** A node's hash: the first `size` bytes of its public key (payload hashes are always 1 byte). §1.3, §3.0 */
export function nodeHash(publicKey: Uint8Array, size = 1): Uint8Array {
  return publicKey.slice(0, size);
}

/** The 1-byte node hash used in payloads (`pubkey[0]`). §3.0 */
export function nodeHashByte(publicKey: Uint8Array): number {
  return publicKey[0] ?? 0;
}

/**
 * Channel hash: SHA256(psk[0..16])[0] for a 128-bit PSK (16 bytes, or 32 with a zero upper half),
 * else SHA256(psk32)[0]. §2, `BCM setChannel`
 */
export async function channelHash(psk: Uint8Array): Promise<number> {
  if (psk.length !== 16 && psk.length !== 32) throw new RangeError(`channel PSK must be 16 or 32 bytes`);
  const is128 = psk.length === 16 || psk.subarray(16).every((b) => b === 0);
  return (await sha256(is128 ? psk.subarray(0, 16) : psk))[0]!;
}

/** Hashtag channel PSK: SHA256("#name")[0..16]. §2 */
export async function hashtagChannelPsk(name: string): Promise<Uint8Array> {
  const n = name.startsWith('#') ? name : `#${name}`;
  return (await sha256(utf8Encode(n))).slice(0, 16);
}

/** ACK code = SHA256(covered plaintext ‖ pubkey)[0..4]. §3.4 */
export async function computeAckCode(coveredPlaintext: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> {
  return (await sha256(coveredPlaintext, publicKey)).slice(0, ACK_CODE_SIZE);
}

/**
 * Expected ACK for a plain TXT_MSG (`BCM composeMsgPacket`): SHA256(timestamp u32 ‖ (attempt & 3)
 * ‖ text bytes without NUL ‖ SENDER pubkey)[0..4]. §3.4, companion-protocol.md §8
 */
export async function textAckCode(o: {
  timestamp: number;
  attempt?: number;
  text: string | Uint8Array;
  senderPublicKey: Uint8Array;
}): Promise<Uint8Array> {
  const covered = concatBytes(u32le(o.timestamp), Uint8Array.of((o.attempt ?? 0) & 3), toBytes(o.text));
  return computeAckCode(covered, o.senderPublicKey);
}

/**
 * The ACK code a receiver would send for a decrypted TXT_MSG plaintext (`BCM onPeerDataRecv`):
 * plain → covers `[0 .. 5+text_len)` + sender pubkey; signed plain → `[0 .. 9+text_len)` +
 * receiver pubkey. CLI types are not ACKed (null).
 */
export async function ackCodeForTxtPlaintext(
  plaintext: Uint8Array,
  keys: { senderPublicKey: Uint8Array; receiverPublicKey?: Uint8Array },
): Promise<Uint8Array | null> {
  const m = parseTxtMsgPlaintext(plaintext);
  if (m.txtType === TxtType.PLAIN) {
    return computeAckCode(plaintext.subarray(0, 5 + m.textBytes.length), keys.senderPublicKey);
  }
  if (m.txtType === TxtType.SIGNED_PLAIN) {
    if (!keys.receiverPublicKey) throw new RangeError('signed-plain ACK needs the receiver public key');
    return computeAckCode(plaintext.subarray(0, 9 + m.textBytes.length), keys.receiverPublicKey);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Visible payload structures
// ---------------------------------------------------------------------------

export type PeerDatagramKind = 'req' | 'response' | 'txtMsg' | 'path';

/** REQ / RESPONSE / TXT_MSG / PATH envelope. §3.0 */
export interface PeerDatagramPayload {
  kind: PeerDatagramKind;
  destHash: number;
  srcHash: number;
  mac: Uint8Array;
  ciphertext: Uint8Array;
}

/** ACK. §3.4 */
export interface AckPayload {
  kind: 'ack';
  /** The 4 compared bytes. */
  ackCode: Uint8Array;
  /** Same bytes as a u32 LE (as in RESP_CODE_SENT). */
  ackCodeU32: number;
  /** Bytes after the code (6-byte form: extended attempt byte, random byte). */
  extra: Uint8Array;
}

/** Advert app_data, decoded. §3.5 */
export interface AdvertAppData {
  flags: number;
  /** ADV_TYPE (flags bits 0-3). */
  nodeType: number;
  /** Raw i32 ×1e6 values and degrees, when flag 0x10. */
  latitudeE6?: number;
  longitudeE6?: number;
  latitude?: number;
  longitude?: number;
  feat1?: number;
  feat2?: number;
  name?: string;
  /** False when the declared optional fields don't fit (`AdvertDataParser` `_valid`). */
  valid: boolean;
}

/** ADVERT. §3.5 */
export interface AdvertPayload {
  kind: 'advert';
  publicKey: Uint8Array;
  timestamp: number;
  signature: Uint8Array;
  /** All bytes after the signature (the firmware uses at most the first 32). */
  appData: Uint8Array;
  app: AdvertAppData;
}

export type GroupDatagramKind = 'grpTxt' | 'grpData';

/** GRP_TXT / GRP_DATA envelope. §3.6, §3.7 */
export interface GroupDatagramPayload {
  kind: GroupDatagramKind;
  channelHash: number;
  mac: Uint8Array;
  ciphertext: Uint8Array;
}

/** ANON_REQ envelope. §3.8 */
export interface AnonReqPayload {
  kind: 'anonReq';
  destHash: number;
  senderPublicKey: Uint8Array;
  mac: Uint8Array;
  ciphertext: Uint8Array;
}

/** TRACE. §3.10 */
export interface TracePayload {
  kind: 'trace';
  tag: number;
  authCode: number;
  flags: number;
  /** flags bits 0-1. */
  pathSz: number;
  /** 1 << pathSz. */
  hashSize: number;
  /** Raw hop-hash list (rest of payload). */
  hashes: Uint8Array;
}

/** MULTIPART. §3.11 */
export interface MultipartPayload {
  kind: 'multipart';
  remaining: number;
  innerType: number;
  inner: Uint8Array;
  /** When innerType is ACK and ≥ 4 inner bytes. */
  ackCode?: Uint8Array;
}

/** CONTROL. §3.12 */
export type ControlPayload =
  | {
      kind: 'control';
      subType: typeof ControlType.NODE_DISCOVER_REQ;
      flags: number;
      prefixOnly: boolean;
      typeFilter: number;
      tag: number;
      since?: number;
      /** Bytes after the declared fields. */
      rest: Uint8Array;
    }
  | {
      kind: 'control';
      subType: typeof ControlType.NODE_DISCOVER_RESP;
      flags: number;
      nodeType: number;
      /** SNR in dB (raw i8 / 4). */
      snr: number;
      tag: number;
      /** 8-byte prefix or full 32-byte key. */
      publicKey: Uint8Array;
    }
  | { kind: 'control'; subType: number; flags: number; data: Uint8Array };

/** RAW_CUSTOM. §3.13 */
export interface RawCustomPayload {
  kind: 'rawCustom';
  data: Uint8Array;
}

/** Reserved payload types 12-14. */
export interface UnknownPayload {
  kind: 'unknown';
  payloadType: number;
  data: Uint8Array;
}

export type ParsedPayload =
  | PeerDatagramPayload
  | AckPayload
  | AdvertPayload
  | GroupDatagramPayload
  | AnonReqPayload
  | TracePayload
  | MultipartPayload
  | ControlPayload
  | RawCustomPayload
  | UnknownPayload;

const PEER_KINDS: Partial<Record<number, PeerDatagramKind>> = {
  [PayloadType.REQ]: 'req',
  [PayloadType.RESPONSE]: 'response',
  [PayloadType.TXT_MSG]: 'txtMsg',
  [PayloadType.PATH]: 'path',
};

/**
 * Parses the key-less view of a payload. Throws {@link PayloadError} when it is shorter than the
 * firmware's minimum for that type.
 */
export function parsePayload(payloadType: number, bytes: Uint8Array): ParsedPayload {
  const peer = PEER_KINDS[payloadType];
  if (peer) {
    // Mesh.cpp: rejects when i + CIPHER_MAC_SIZE >= payload_len (i = 2)
    need(bytes, 2 + CIPHER_MAC_SIZE + 1, peer);
    return {
      kind: peer,
      destHash: bytes[0]!,
      srcHash: bytes[1]!,
      mac: bytes.slice(2, 4),
      ciphertext: bytes.slice(4),
    };
  }
  switch (payloadType) {
    case PayloadType.ACK: {
      need(bytes, ACK_CODE_SIZE, 'ack');
      return { kind: 'ack', ackCode: bytes.slice(0, 4), ackCodeU32: readU32LE(bytes, 0), extra: bytes.slice(4) };
    }
    case PayloadType.ADVERT:
      return parseAdvertPayload(bytes);
    case PayloadType.GRP_TXT:
    case PayloadType.GRP_DATA: {
      need(bytes, 1 + CIPHER_MAC_SIZE + 1, 'group datagram');
      return {
        kind: payloadType === PayloadType.GRP_TXT ? 'grpTxt' : 'grpData',
        channelHash: bytes[0]!,
        mac: bytes.slice(1, 3),
        ciphertext: bytes.slice(3),
      };
    }
    case PayloadType.ANON_REQ: {
      need(bytes, 1 + PUB_KEY_SIZE + CIPHER_MAC_SIZE + 1, 'anon req');
      return {
        kind: 'anonReq',
        destHash: bytes[0]!,
        senderPublicKey: bytes.slice(1, 33),
        mac: bytes.slice(33, 35),
        ciphertext: bytes.slice(35),
      };
    }
    case PayloadType.TRACE: {
      need(bytes, 9, 'trace');
      const flags = bytes[8]!;
      const pathSz = flags & 3;
      return {
        kind: 'trace',
        tag: readU32LE(bytes, 0),
        authCode: readU32LE(bytes, 4),
        flags,
        pathSz,
        hashSize: 1 << pathSz,
        hashes: bytes.slice(9),
      };
    }
    case PayloadType.MULTIPART: {
      need(bytes, 1, 'multipart');
      const b = bytes[0]!;
      const m: MultipartPayload = { kind: 'multipart', remaining: b >> 4, innerType: b & 0x0f, inner: bytes.slice(1) };
      if (m.innerType === PayloadType.ACK && m.inner.length >= 4) m.ackCode = m.inner.slice(0, 4);
      return m;
    }
    case PayloadType.CONTROL:
      return parseControlPayload(bytes);
    case PayloadType.RAW_CUSTOM:
      return { kind: 'rawCustom', data: bytes.slice() };
    default:
      return { kind: 'unknown', payloadType, data: bytes.slice() };
  }
}

// ---------------------------------------------------------------------------
// ADVERT. §3.5
// ---------------------------------------------------------------------------

export function parseAdvertPayload(bytes: Uint8Array): AdvertPayload {
  need(bytes, ADVERT_FIXED_SIZE, 'advert');
  const appData = bytes.slice(ADVERT_FIXED_SIZE);
  return {
    kind: 'advert',
    publicKey: bytes.slice(0, 32),
    timestamp: readU32LE(bytes, 32),
    signature: bytes.slice(36, 100),
    appData,
    app: parseAdvertAppData(appData),
  };
}

/** `AdvertDataParser`: flags, [lat i32, lon i32], [feat1 u16], [feat2 u16], [name…]. Truncates to 32 bytes. */
export function parseAdvertAppData(appData: Uint8Array): AdvertAppData {
  const a = appData.subarray(0, MAX_ADVERT_DATA_SIZE);
  const flags = a[0] ?? 0;
  const out: AdvertAppData = { flags, nodeType: flags & AdvertFlag.TYPE_MASK, valid: false };
  if (a.length === 0) return out;
  let i = 1;
  const view = new DataView(a.buffer, a.byteOffset, a.byteLength);
  if (flags & AdvertFlag.HAS_LATLON) {
    if (i + 8 <= a.length) {
      out.latitudeE6 = view.getInt32(i, true);
      out.longitudeE6 = view.getInt32(i + 4, true);
      out.latitude = out.latitudeE6 / 1e6;
      out.longitude = out.longitudeE6 / 1e6;
    }
    i += 8;
  }
  if (flags & AdvertFlag.HAS_FEAT1) {
    if (i + 2 <= a.length) out.feat1 = readU16LE(a, i);
    i += 2;
  }
  if (flags & AdvertFlag.HAS_FEAT2) {
    if (i + 2 <= a.length) out.feat2 = readU16LE(a, i);
    i += 2;
  }
  if (a.length >= i) {
    out.valid = true;
    if (flags & AdvertFlag.HAS_NAME && a.length > i) out.name = utf8Decode(a.subarray(i), true);
  }
  return out;
}

export interface AdvertAppDataInit {
  nodeType: number;
  /** Degrees; both or neither. Encoded as i32 ×1e6 (rounded). */
  latitude?: number;
  longitude?: number;
  /** Included when defined (the firmware includes them only when non-zero). */
  feat1?: number;
  feat2?: number;
  /** Cut at a UTF-8 boundary to fit 32 bytes total. Omitted when empty. */
  name?: string;
}

/** `AdvertDataBuilder::encodeTo`. §3.5 */
export function encodeAdvertAppData(d: AdvertAppDataInit): Uint8Array {
  const out = new Uint8Array(MAX_ADVERT_DATA_SIZE);
  const view = new DataView(out.buffer);
  let flags = d.nodeType & AdvertFlag.TYPE_MASK;
  let i = 1;
  if (d.latitude !== undefined || d.longitude !== undefined) {
    flags |= AdvertFlag.HAS_LATLON;
    view.setInt32(i, Math.round((d.latitude ?? 0) * 1e6), true);
    view.setInt32(i + 4, Math.round((d.longitude ?? 0) * 1e6), true);
    i += 8;
  }
  if (d.feat1 !== undefined) {
    flags |= AdvertFlag.HAS_FEAT1;
    view.setUint16(i, d.feat1, true);
    i += 2;
  }
  if (d.feat2 !== undefined) {
    flags |= AdvertFlag.HAS_FEAT2;
    view.setUint16(i, d.feat2, true);
    i += 2;
  }
  if (d.name) {
    const name = utf8Truncate(utf8Encode(d.name), MAX_ADVERT_DATA_SIZE - i);
    if (name.length > 0) {
      flags |= AdvertFlag.HAS_NAME;
      out.set(name, i);
      i += name.length;
    }
  }
  out[0] = flags;
  return out.slice(0, i);
}

/** The signed message: pubkey ‖ timestamp u32 ‖ app_data[0..32]. §3.5 */
export function advertSignedMessage(publicKey: Uint8Array, timestamp: number, appData: Uint8Array): Uint8Array {
  return concatBytes(publicKey, u32le(timestamp), appData.subarray(0, MAX_ADVERT_DATA_SIZE));
}

/** Verifies an advert's Ed25519 signature exactly as `Mesh.cpp` does. */
export async function verifyAdvert(a: Pick<AdvertPayload, 'publicKey' | 'timestamp' | 'signature' | 'appData'>): Promise<boolean> {
  return ed25519Verify(a.publicKey, advertSignedMessage(a.publicKey, a.timestamp, a.appData), a.signature);
}

/**
 * Builds a signed ADVERT payload (`Mesh::createAdvert`). Signing uses the 32-byte seed (see the
 * note in crypto.ts on the firmware's expanded key).
 */
export async function buildAdvertPayload(o: {
  keys: { publicKey: Uint8Array; seed: Uint8Array };
  timestamp: number;
  appData: AdvertAppDataInit | Uint8Array;
}): Promise<Uint8Array> {
  const appData = o.appData instanceof Uint8Array ? o.appData : encodeAdvertAppData(o.appData);
  if (appData.length > MAX_ADVERT_DATA_SIZE) throw new PayloadError(`advert app_data > ${MAX_ADVERT_DATA_SIZE} bytes`);
  if (o.keys.publicKey.length !== PUB_KEY_SIZE) throw new PayloadError('public key must be 32 bytes');
  const sig = await ed25519Sign(o.keys.seed, advertSignedMessage(o.keys.publicKey, o.timestamp, appData));
  if (sig.length !== SIGNATURE_SIZE) throw new PayloadError('bad signature size');
  return concatBytes(o.keys.publicKey, u32le(o.timestamp), sig, appData);
}

// ---------------------------------------------------------------------------
// ACK / MULTIPART / TRACE / RAW / CONTROL builders
// ---------------------------------------------------------------------------

/** ACK payload: 4-byte code, optionally + extended-attempt byte + random byte. §3.4 */
export function buildAckPayload(ackCode: Uint8Array, extra?: Uint8Array): Uint8Array {
  if (ackCode.length !== ACK_CODE_SIZE) throw new PayloadError('ack code must be 4 bytes');
  return concatBytes(ackCode, extra ?? new Uint8Array(0));
}

/** MULTIPART ACK (`Mesh::createMultiAck`): `[(remaining << 4) | ACK][ack bytes]`. §3.11 */
export function buildMultipartAckPayload(ack: Uint8Array, remaining: number): Uint8Array {
  if (remaining < 0 || remaining > 15) throw new PayloadError('remaining must be 0..15');
  return concatBytes(Uint8Array.of((remaining << 4) | PayloadType.ACK), ack);
}

/** TRACE payload: tag u32, auth u32, flags, hop hashes. §3.10 */
export function buildTracePayload(o: { tag: number; authCode: number; flags?: number; hashes: Uint8Array }): Uint8Array {
  const out = new Uint8Array(9 + o.hashes.length);
  writeU32LE(out, 0, o.tag);
  writeU32LE(out, 4, o.authCode);
  out[8] = o.flags ?? 0;
  out.set(o.hashes, 9);
  return out;
}

export function parseControlPayload(bytes: Uint8Array): ControlPayload {
  need(bytes, 1, 'control');
  const flags = bytes[0]!;
  const subType = flags & 0xf0;
  if (subType === ControlType.NODE_DISCOVER_REQ && bytes.length >= 6) {
    const p: ControlPayload = {
      kind: 'control',
      subType: ControlType.NODE_DISCOVER_REQ,
      flags,
      prefixOnly: (flags & 1) !== 0,
      typeFilter: bytes[1]!,
      tag: readU32LE(bytes, 2),
      rest: bytes.slice(bytes.length >= 10 ? 10 : 6),
    };
    if (bytes.length >= 10) p.since = readU32LE(bytes, 6);
    return p;
  }
  if (subType === ControlType.NODE_DISCOVER_RESP && bytes.length >= 6) {
    return {
      kind: 'control',
      subType: ControlType.NODE_DISCOVER_RESP,
      flags,
      nodeType: flags & 0x0f,
      snr: i8(bytes[1]!) / 4,
      tag: readU32LE(bytes, 2),
      publicKey: bytes.slice(6),
    };
  }
  return { kind: 'control', subType, flags, data: bytes.slice(1) };
}

/** DISCOVER_REQ: `[0x80 | prefix_only][type_filter][tag u32][since u32]?`. §3.12 */
export function buildDiscoverReqPayload(o: { prefixOnly?: boolean; typeFilter: number; tag: number; since?: number }): Uint8Array {
  return concatBytes(
    Uint8Array.of(ControlType.NODE_DISCOVER_REQ | (o.prefixOnly ? 1 : 0), o.typeFilter & 0xff),
    u32le(o.tag),
    o.since !== undefined ? u32le(o.since) : new Uint8Array(0),
  );
}

/** DISCOVER_RESP: `[0x90 | node_type][snr×4 i8][tag u32][pubkey 8|32]`. §3.12 */
export function buildDiscoverRespPayload(o: { nodeType: number; snr: number; tag: number; publicKey: Uint8Array }): Uint8Array {
  const snr = Math.max(-128, Math.min(127, Math.round(o.snr * 4)));
  return concatBytes(
    Uint8Array.of(ControlType.NODE_DISCOVER_RESP | (o.nodeType & 0x0f), snr & 0xff),
    u32le(o.tag),
    o.publicKey,
  );
}

// ---------------------------------------------------------------------------
// Encrypted envelopes
// ---------------------------------------------------------------------------

/**
 * Size guard. `firmwareOverhead` reproduces each `Mesh::create*Datagram` check (`data_len + overhead
 * + CIPHER_BLOCK_SIZE-1 > MAX_PACKET_PAYLOAD`; the firmware's overheads are 2 for peer datagrams
 * (MAC only), 33 for ANON_REQ and 1 for group datagrams), plus the real padded size must fit.
 */
function checkEncryptedFits(prefix: number, firmwareOverhead: number, plaintextLen: number, what: string): void {
  const padded = Math.ceil(plaintextLen / CIPHER_BLOCK_SIZE) * CIPHER_BLOCK_SIZE;
  if (
    plaintextLen + firmwareOverhead + CIPHER_BLOCK_SIZE - 1 > MAX_PACKET_PAYLOAD ||
    prefix + CIPHER_MAC_SIZE + padded > MAX_PACKET_PAYLOAD
  ) {
    throw new PayloadError(`${what}: plaintext of ${plaintextLen} bytes does not fit in a payload`);
  }
}

/** REQ/RESPONSE/TXT_MSG/PATH payload: `[dest_hash][src_hash][MAC][ciphertext]`. §3.0 */
export async function buildPeerDatagramPayload(o: {
  destHash: number;
  srcHash: number;
  secret: Uint8Array;
  plaintext: Uint8Array;
}): Promise<Uint8Array> {
  checkEncryptedFits(2, CIPHER_MAC_SIZE, o.plaintext.length, 'peer datagram');
  return concatBytes(Uint8Array.of(o.destHash & 0xff, o.srcHash & 0xff), await encryptThenMac(o.secret, o.plaintext));
}

/** ANON_REQ payload: `[dest_hash][sender pubkey 32][MAC][ciphertext]`. §3.8 */
export async function buildAnonReqPayload(o: {
  destHash: number;
  senderPublicKey: Uint8Array;
  secret: Uint8Array;
  plaintext: Uint8Array;
}): Promise<Uint8Array> {
  if (o.senderPublicKey.length !== PUB_KEY_SIZE) throw new PayloadError('sender public key must be 32 bytes');
  checkEncryptedFits(33, 1 + PUB_KEY_SIZE, o.plaintext.length, 'anon req');
  return concatBytes(Uint8Array.of(o.destHash & 0xff), o.senderPublicKey, await encryptThenMac(o.secret, o.plaintext));
}

/** GRP_TXT/GRP_DATA payload: `[channel_hash][MAC][ciphertext]`, secret = channel PSK. §3.6 */
export async function buildGroupDatagramPayload(o: {
  channelHash: number;
  secret: Uint8Array;
  plaintext: Uint8Array;
}): Promise<Uint8Array> {
  checkEncryptedFits(1, 1, o.plaintext.length, 'group datagram');
  return concatBytes(Uint8Array.of(o.channelHash & 0xff), await encryptThenMac(o.secret, o.plaintext));
}

/** MAC-checks and decrypts any encrypted envelope; null on MAC failure / bad alignment. */
export async function decryptPayload(
  p: Pick<PeerDatagramPayload | GroupDatagramPayload | AnonReqPayload, 'mac' | 'ciphertext'>,
  secret: Uint8Array,
): Promise<Uint8Array | null> {
  return macThenDecrypt(secret, concatBytes(p.mac, p.ciphertext));
}

// ---------------------------------------------------------------------------
// TXT_MSG plaintext. §3.3
// ---------------------------------------------------------------------------

export interface TxtMsgPlaintext {
  timestamp: number;
  /** Raw flags byte. */
  flags: number;
  /** flags >> 2 (TxtType). */
  txtType: number;
  /** Effective attempt: the extended attempt byte if present (> 3), else flags & 3. */
  attempt: number;
  /** SIGNED_PLAIN only: 4-byte author pubkey prefix. */
  authorPrefix?: Uint8Array;
  text: string;
  /** Text bytes up to (excluding) the NUL / padding. */
  textBytes: Uint8Array;
  /** Byte offset of the text within the plaintext. */
  textOffset: number;
}

/** Decodes a decrypted TXT_MSG plaintext (padding allowed). The firmware requires > 5 bytes. */
export function parseTxtMsgPlaintext(pt: Uint8Array): TxtMsgPlaintext {
  need(pt, 5, 'txt msg plaintext');
  const flags = pt[4]!;
  const txtType = flags >> 2;
  let off = 5;
  let authorPrefix: Uint8Array | undefined;
  if (txtType === TxtType.SIGNED_PLAIN) {
    need(pt, 9, 'signed txt msg plaintext');
    authorPrefix = pt.slice(5, 9);
    off = 9;
  }
  const textBytes = cBytes(pt.subarray(off)).slice();
  let attempt = flags & 3;
  const after = off + textBytes.length + 1;
  const ext = pt[after];
  if (off + textBytes.length < pt.length && ext !== undefined && ext > 3) attempt = ext;
  const m: TxtMsgPlaintext = {
    timestamp: readU32LE(pt, 0),
    flags,
    txtType,
    attempt,
    text: utf8Decode(textBytes),
    textBytes,
    textOffset: off,
  };
  if (authorPrefix) m.authorPrefix = authorPrefix;
  return m;
}

/**
 * Builds a TXT_MSG plaintext like `BCM composeMsgPacket`/`sendCommandData`: `[timestamp][flags =
 * txtType<<2 | attempt&3][author prefix (signed only)][text]` and, when attempt > 3, `[0][attempt]`.
 * No NUL otherwise (the zero padding terminates the text).
 */
export function buildTxtMsgPlaintext(o: {
  timestamp: number;
  text: string | Uint8Array;
  txtType?: number;
  attempt?: number;
  authorPrefix?: Uint8Array;
}): Uint8Array {
  const text = toBytes(o.text);
  const attempt = o.attempt ?? 0;
  const txtType = o.txtType ?? TxtType.PLAIN;
  if (text.length > MAX_TEXT_LEN) throw new PayloadError(`text > ${MAX_TEXT_LEN} bytes`);
  if (attempt > 3 && text.length > MAX_TEXT_LEN - 2) throw new PayloadError(`text > ${MAX_TEXT_LEN - 2} bytes with attempt > 3`);
  const parts = [u32le(o.timestamp), Uint8Array.of(((txtType & 0x3f) << 2) | (attempt & 3))];
  if (txtType === TxtType.SIGNED_PLAIN) {
    if (!o.authorPrefix || o.authorPrefix.length < 4) throw new PayloadError('signed plain needs a 4-byte author prefix');
    parts.push(o.authorPrefix.subarray(0, 4));
  }
  parts.push(text);
  if (attempt > 3) parts.push(Uint8Array.of(0, attempt & 0xff));
  return concatBytes(...parts);
}

// ---------------------------------------------------------------------------
// REQ / RESPONSE plaintext. §3.1, §3.2
// ---------------------------------------------------------------------------

export interface ReqPlaintext {
  /** Sender timestamp, also the request tag. */
  timestamp: number;
  reqType: number;
  /** Request data (includes padding). */
  data: Uint8Array;
}

export function parseReqPlaintext(pt: Uint8Array): ReqPlaintext {
  need(pt, 5, 'req plaintext');
  return { timestamp: readU32LE(pt, 0), reqType: pt[4]!, data: pt.slice(5) };
}

export function buildReqPlaintext(timestamp: number, reqType: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  return concatBytes(u32le(timestamp), Uint8Array.of(reqType), data);
}

export interface ResponsePlaintext {
  tag: number;
  /** Body (includes padding). */
  body: Uint8Array;
}

export function parseResponsePlaintext(pt: Uint8Array): ResponsePlaintext {
  need(pt, 4, 'response plaintext');
  return { tag: readU32LE(pt, 0), body: pt.slice(4) };
}

export function buildResponsePlaintext(tag: number, body: Uint8Array): Uint8Array {
  return concatBytes(u32le(tag), body);
}

export interface LoginResponse {
  serverTime: number;
  ok: boolean;
  /** True for a legacy `"OK"` reply. */
  legacy: boolean;
  keepAliveSecs16?: number;
  /** Repeater: 1/0. Room: 1 admin, 2 guest-with-perms-0, 0 other. */
  isAdmin?: number;
  permissions?: number;
  /** permissions bits 0-1 (AclRole). */
  role?: number;
  random?: Uint8Array;
  firmwareVerLevel?: number;
}

/** Login reply (RESPONSE to an ANON_REQ login), whole plaintext incl. the tag. §3.2 */
export function parseLoginResponse(pt: Uint8Array): LoginResponse {
  need(pt, 5, 'login response');
  const serverTime = readU32LE(pt, 0);
  if (pt[4] === 0x4f && pt[5] === 0x4b) return { serverTime, ok: true, legacy: true }; // "OK"
  const r: LoginResponse = { serverTime, ok: pt[4] === RESP_SERVER_LOGIN_OK, legacy: false };
  if (!r.ok || pt.length < 12) return r;
  r.keepAliveSecs16 = pt[5]!;
  r.isAdmin = pt[6]!;
  r.permissions = pt[7]!;
  r.role = pt[7]! & 3;
  r.random = pt.slice(8, 12);
  if (pt.length >= 13) r.firmwareVerLevel = pt[12]!;
  return r;
}

/** Login OK reply body as the repeater writes it (13 bytes). §3.2 */
export function buildLoginOkPlaintext(o: {
  serverTime: number;
  isAdmin: number;
  permissions: number;
  random?: Uint8Array;
  firmwareVerLevel: number;
}): Uint8Array {
  return concatBytes(
    u32le(o.serverTime),
    Uint8Array.of(RESP_SERVER_LOGIN_OK, 0, o.isAdmin, o.permissions),
    (o.random ?? randomBytes(4)).subarray(0, 4),
    Uint8Array.of(o.firmwareVerLevel),
  );
}

/**
 * STATUS body (plaintext[4..]). Over the air the plaintext is padded to 16 bytes, so repeater (56)
 * and room (52) bodies both arrive as 60 bytes: pass `from` (default 'repeater').
 */
export function parseStatusBody(body: Uint8Array, from: 'repeater' | 'room' = 'repeater'): NodeStats | null {
  return decodeNodeStats(body, from);
}

export interface AclEntry {
  pubKeyPrefix: Uint8Array;
  permissions: number;
}

/** GET_ACCESS_LIST body: repeated {prefix 6, perms u8}. Padding entries (perms 0) are dropped. §3.2 */
export function parseAccessList(body: Uint8Array): AclEntry[] {
  const out: AclEntry[] = [];
  for (let i = 0; i + 7 <= body.length; i += 7) {
    const permissions = body[i + 6]!;
    if (permissions === 0) continue; // the firmware never writes perms-0 entries; these are padding
    out.push({ pubKeyPrefix: body.slice(i, i + 6), permissions });
  }
  return out;
}

export interface Neighbour {
  pubKeyPrefix: Uint8Array;
  heardSecsAgo: number;
  /** dB (i8 / 4). */
  snr: number;
}

/** GET_NEIGHBOURS body: `[total i16][count i16]` + count × {prefix, heard u32, snr i8}. §3.2 */
export function parseNeighbours(body: Uint8Array, prefixLen: number): { total: number; results: Neighbour[] } {
  need(body, 4, 'neighbours');
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const total = v.getInt16(0, true);
  const count = v.getInt16(2, true);
  const results: Neighbour[] = [];
  let i = 4;
  for (let n = 0; n < count && i + prefixLen + 5 <= body.length; n++) {
    results.push({
      pubKeyPrefix: body.slice(i, i + prefixLen),
      heardSecsAgo: readU32LE(body, i + prefixLen),
      snr: i8(body[i + prefixLen + 4]!) / 4,
    });
    i += prefixLen + 5;
  }
  return { total, results };
}

/** GET_OWNER_INFO body: `"<fw version>\n<node name>\n<owner info>"`. §3.2 */
export function parseOwnerInfo(body: Uint8Array): { firmwareVersion: string; nodeName: string; ownerInfo: string } {
  const [firmwareVersion = '', nodeName = '', ...rest] = utf8Decode(body, true).split('\n');
  return { firmwareVersion, nodeName, ownerInfo: rest.join('\n') };
}

// ---------------------------------------------------------------------------
// ANON_REQ plaintext. §3.8
// ---------------------------------------------------------------------------

export interface LoginRequest {
  timestamp: number;
  /** Room-server form only. */
  syncSince?: number;
  password: string;
}

/** Login request plaintext. `room` selects `[timestamp][sync_since][password]`. §3.8 */
export function parseLoginRequest(pt: Uint8Array, room = false): LoginRequest {
  need(pt, room ? 8 : 4, 'login request');
  const off = room ? 8 : 4;
  const r: LoginRequest = { timestamp: readU32LE(pt, 0), password: utf8Decode(pt.subarray(off, off + 15), true) };
  if (room) r.syncSince = readU32LE(pt, 4);
  return r;
}

/** Login request plaintext (`BCM sendLogin`). Password ≤ 15 bytes. */
export function buildLoginRequest(o: { timestamp: number; password: string; syncSince?: number }): Uint8Array {
  const pw = utf8Encode(o.password);
  if (pw.length > 15) throw new PayloadError('password > 15 bytes');
  return concatBytes(u32le(o.timestamp), o.syncSince !== undefined ? u32le(o.syncSince) : new Uint8Array(0), pw);
}

// ---------------------------------------------------------------------------
// GRP_TXT / GRP_DATA plaintext. §3.6, §3.7
// ---------------------------------------------------------------------------

export interface GrpTxtPlaintext {
  timestamp: number;
  flags: number;
  txtType: number;
  /** Full text, "<sender>: <message>". */
  text: string;
  textBytes: Uint8Array;
  /** Text before the first ": " (unauthenticated). */
  senderName?: string;
  /** Text after the first ": " (or the whole text). */
  message: string;
}

export function parseGrpTxtPlaintext(pt: Uint8Array): GrpTxtPlaintext {
  need(pt, 5, 'grp txt plaintext');
  const textBytes = cBytes(pt.subarray(5)).slice();
  const text = utf8Decode(textBytes);
  const sep = text.indexOf(': ');
  const r: GrpTxtPlaintext = {
    timestamp: readU32LE(pt, 0),
    flags: pt[4]!,
    txtType: pt[4]! >> 2,
    text,
    textBytes,
    message: sep >= 0 ? text.slice(sep + 2) : text,
  };
  if (sep >= 0) r.senderName = text.slice(0, sep);
  return r;
}

/**
 * `BCM sendGroupMessage`: `[timestamp][0]["<sender>: " + text]`, text cut (byte-wise, as the
 * firmware does) so that prefix + text ≤ 160 bytes; no NUL.
 */
export function buildGrpTxtPlaintext(o: { timestamp: number; senderName: string; text: string | Uint8Array }): Uint8Array {
  const prefix = utf8Encode(`${o.senderName}: `);
  let text = toBytes(o.text);
  if (prefix.length + text.length > MAX_TEXT_LEN) text = text.subarray(0, Math.max(0, MAX_TEXT_LEN - prefix.length));
  return concatBytes(u32le(o.timestamp), Uint8Array.of(0), prefix, text);
}

export interface GrpDataPlaintext {
  dataType: number;
  dataLen: number;
  data: Uint8Array;
}

/** `[data_type u16][data_len u8][data]`. Throws when data_len exceeds the available bytes. */
export function parseGrpDataPlaintext(pt: Uint8Array): GrpDataPlaintext {
  need(pt, 3, 'grp data plaintext');
  const dataLen = pt[2]!;
  if (dataLen > pt.length - 3) throw new PayloadError(`grp data: data_len ${dataLen} > ${pt.length - 3} available`);
  return { dataType: readU16LE(pt, 0), dataLen, data: pt.slice(3, 3 + dataLen) };
}

export function buildGrpDataPlaintext(dataType: number, data: Uint8Array): Uint8Array {
  if (data.length > MAX_GROUP_DATA_LENGTH) throw new PayloadError(`group data > ${MAX_GROUP_DATA_LENGTH} bytes`);
  return concatBytes(u16le(dataType), Uint8Array.of(data.length), data);
}

// ---------------------------------------------------------------------------
// PATH plaintext. §3.9
// ---------------------------------------------------------------------------

export interface PathPlaintext {
  /** Raw encoded path_len. */
  pathLen: number;
  hashSize: number;
  hashCount: number;
  path: Uint8Array;
  /** Raw extra_type byte (0xFF = none). */
  extraTypeRaw: number;
  /** Low 4 bits (what the firmware dispatches on). */
  extraType: number;
  /** True unless extraTypeRaw is 0xFF. */
  hasExtra: boolean;
  /** Remaining bytes (may include zero padding). */
  extra: Uint8Array;
}

export function parsePathPlaintext(pt: Uint8Array): PathPlaintext {
  need(pt, 1, 'path plaintext');
  const pathLen = pt[0]!;
  if (!isValidPathLen(pathLen)) throw new PayloadError(`path plaintext: invalid path_len 0x${pathLen.toString(16)}`);
  const pl = decodePathLen(pathLen);
  need(pt, 2 + pl.byteLength, 'path plaintext');
  const extraTypeRaw = pt[1 + pl.byteLength]!;
  return {
    pathLen,
    hashSize: pl.hashSize,
    hashCount: pl.hops,
    path: pt.slice(1, 1 + pl.byteLength),
    extraTypeRaw,
    extraType: extraTypeRaw & 0x0f,
    hasExtra: extraTypeRaw !== PATH_EXTRA_NONE,
    extra: pt.slice(2 + pl.byteLength),
  };
}

/**
 * `Mesh::createPathReturn` plaintext: `[path_len][path][extra_type][extra]`, or with no extra
 * `[path_len][path][0xFF][4 random]`.
 */
export function buildPathPlaintext(o: {
  path: Uint8Array;
  hashSize?: number;
  extraType?: number;
  extra?: Uint8Array;
  random?: Uint8Array;
}): Uint8Array {
  const hashSize = o.hashSize ?? 1;
  if (o.path.length % hashSize !== 0) throw new PayloadError('path length is not a multiple of hash size');
  const pathLen = encodePathLen(o.path.length / hashSize, hashSize);
  const tail =
    o.extra && o.extra.length > 0
      ? concatBytes(Uint8Array.of((o.extraType ?? 0) & 0xff), o.extra)
      : concatBytes(Uint8Array.of(PATH_EXTRA_NONE), (o.random ?? randomBytes(4)).subarray(0, 4));
  return concatBytes(Uint8Array.of(pathLen), o.path, tail);
}
