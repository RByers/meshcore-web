/**
 * Just enough of the over-the-air packet format (mesh-packet-format.md §1, §3.5) for the
 * emulator: advert packets for EXPORT/IMPORT/SHARE_CONTACT and envelope validation for
 * SEND_RAW_PACKET. The full codec lives in `src/packet/`; this module avoids depending on it.
 *
 * Signatures are FAKE: `fakeSignature` is a SHA-256 based stand-in, not Ed25519. Nothing in the
 * emulator verifies signatures.
 */

import { concatBytes, readU16LE, readU32LE, u32le, utf8Decode, utf8Encode } from '../util/bytes.js';
import { AdvertFlag, MAX_PACKET_PAYLOAD, PUB_KEY_SIZE, SIGNATURE_SIZE, decodePathLen, isValidPathLen } from '../protocol/constants.js';
import { sha256Sync } from './sha256.js';

export const RouteType = { TRANSPORT_FLOOD: 0, FLOOD: 1, DIRECT: 2, TRANSPORT_DIRECT: 3 } as const;
export const PayloadType = {
  REQ: 0,
  RESPONSE: 1,
  TXT_MSG: 2,
  ACK: 3,
  ADVERT: 4,
  GRP_TXT: 5,
  GRP_DATA: 6,
  ANON_REQ: 7,
  PATH: 8,
  TRACE: 9,
  MULTIPART: 10,
  CONTROL: 11,
  RAW_CUSTOM: 15,
} as const;

/** MAX_ADVERT_DATA_SIZE (`MeshCore.h`). */
export const MAX_ADVERT_DATA_SIZE = 32;

export interface PacketEnvelope {
  header: number;
  routeType: number;
  payloadType: number;
  payloadVersion: number;
  transportCodes?: [number, number];
  pathLen: number;
  path: Uint8Array;
  payload: Uint8Array;
}

/** `Dispatcher::tryParsePacket` rules (§1). Returns null where the firmware would reject. */
export function parseEnvelope(raw: Uint8Array): PacketEnvelope | null {
  if (raw.length < 2) return null;
  const header = raw[0]!;
  const routeType = header & 0x03;
  const payloadType = (header >> 2) & 0x0f;
  const payloadVersion = header >> 6;
  if (payloadVersion > 0) return null;
  let i = 1;
  let transportCodes: [number, number] | undefined;
  if (routeType === RouteType.TRANSPORT_FLOOD || routeType === RouteType.TRANSPORT_DIRECT) {
    if (raw.length < 5) return null;
    transportCodes = [readU16LE(raw, 1), readU16LE(raw, 3)];
    i = 5;
  }
  const pathLen = raw[i++];
  if (pathLen === undefined || !isValidPathLen(pathLen)) return null;
  const n = decodePathLen(pathLen).byteLength;
  if (i + n > raw.length) return null;
  const path = raw.slice(i, i + n);
  i += n;
  const payload = raw.slice(i);
  if (payload.length < 1 || payload.length > MAX_PACKET_PAYLOAD) return null;
  const env: PacketEnvelope = { header, routeType, payloadType, payloadVersion, pathLen, path, payload };
  if (transportCodes) env.transportCodes = transportCodes;
  return env;
}

export interface AdvertFields {
  pubKey: Uint8Array;
  timestamp: number;
  /** ContactType. */
  type: number;
  name: string;
  /** Micro-degrees; both or neither. */
  latE6?: number;
  lonE6?: number;
}

export interface ParsedAdvert extends AdvertFields {
  signature: Uint8Array;
  appData: Uint8Array;
  /** False when the advert has no name (companions ignore those). */
  hasName: boolean;
  envelope: PacketEnvelope;
}

/** Deterministic 64-byte stand-in for an Ed25519 signature. NOT a real signature. */
export function fakeSignature(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  const a = sha256Sync(privateKey, message);
  return concatBytes(a, sha256Sync(a, privateKey));
}

/** Truncates UTF-8 bytes to `max` at a code-point boundary. */
function truncUtf8(b: Uint8Array, max: number): Uint8Array {
  if (b.length <= max) return b;
  let n = max;
  while (n > 0 && (b[n]! & 0xc0) === 0x80) n--;
  return b.slice(0, n);
}

/** app_data: flags, optional lat/lon, name (§3.5). */
export function buildAdvertAppData(f: Omit<AdvertFields, 'pubKey' | 'timestamp'>): Uint8Array {
  const hasLoc = f.latE6 !== undefined && f.lonE6 !== undefined;
  const head: number[] = [(f.type & AdvertFlag.TYPE_MASK) | (hasLoc ? AdvertFlag.HAS_LATLON : 0) | AdvertFlag.HAS_NAME];
  const parts: Uint8Array[] = [Uint8Array.from(head)];
  if (hasLoc) parts.push(u32le(f.latE6! >>> 0), u32le(f.lonE6! >>> 0));
  const used = parts.reduce((s, p) => s + p.length, 0);
  parts.push(truncUtf8(utf8Encode(f.name), MAX_ADVERT_DATA_SIZE - used));
  return concatBytes(...parts);
}

/** A flood advert packet with an empty path (header 0x11), as EXPORT_CONTACT returns for self. */
export function buildAdvertPacket(f: AdvertFields, privateKey: Uint8Array): Uint8Array {
  const appData = buildAdvertAppData(f);
  const ts = u32le(f.timestamp);
  const signature = fakeSignature(privateKey, concatBytes(f.pubKey, ts, appData));
  const header = (PayloadType.ADVERT << 2) | RouteType.FLOOD;
  return concatBytes(Uint8Array.of(header, 0), f.pubKey, ts, signature, appData);
}

/** Parses an advert packet; null if the envelope or the advert payload is malformed. */
export function parseAdvertPacket(raw: Uint8Array): ParsedAdvert | null {
  const env = parseEnvelope(raw);
  if (!env || env.payloadType !== PayloadType.ADVERT) return null;
  const p = env.payload;
  if (p.length < PUB_KEY_SIZE + 4 + SIGNATURE_SIZE + 1) return null;
  const appData = p.slice(PUB_KEY_SIZE + 4 + SIGNATURE_SIZE);
  const flags = appData[0]!;
  let i = 1;
  const out: ParsedAdvert = {
    pubKey: p.slice(0, PUB_KEY_SIZE),
    timestamp: readU32LE(p, PUB_KEY_SIZE),
    signature: p.slice(PUB_KEY_SIZE + 4, PUB_KEY_SIZE + 4 + SIGNATURE_SIZE),
    type: flags & AdvertFlag.TYPE_MASK,
    name: '',
    appData,
    hasName: false,
    envelope: env,
  };
  if (flags & AdvertFlag.HAS_LATLON) {
    if (appData.length < i + 8) return null;
    out.latE6 = readU32LE(appData, i) | 0;
    out.lonE6 = readU32LE(appData, i + 4) | 0;
    i += 8;
  }
  if (flags & AdvertFlag.HAS_FEAT1) i += 2;
  if (flags & AdvertFlag.HAS_FEAT2) i += 2;
  if (appData.length < i) return null;
  if (flags & AdvertFlag.HAS_NAME) {
    out.name = utf8Decode(appData.subarray(i, Math.min(appData.length, MAX_ADVERT_DATA_SIZE)), true);
    out.hasName = out.name.length > 0;
  }
  return out;
}

/** Re-headers a stored advert as FLOOD without transport codes, keeping its path (`BCM onAdvertRecv`). */
export function asFloodAdvert(env: PacketEnvelope): Uint8Array {
  const header = (env.header & ~0x03) | RouteType.FLOOD;
  return concatBytes(Uint8Array.of(header, env.pathLen), env.path, env.payload);
}

