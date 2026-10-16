/**
 * Packet envelope parse/build. docs/mesh-packet-format.md §1 (`Dispatcher::tryParsePacket`,
 * `Packet::readFrom/writeTo`, `Packet::calculatePacketHash`).
 *
 * `[header][transport_codes 2×u16 LE if route 0|3][path_len][path][payload]`
 */

import { concatBytes, readU16LE, utf8Encode, writeU16LE } from '../util/bytes.js';
import { decodePathLen, encodePathLen, isValidPathLen } from '../protocol/constants.js';
import {
  MAX_PACKET_PAYLOAD,
  MAX_PATH_SIZE,
  MAX_TRANS_UNIT,
  PACKET_HASH_SIZE,
  PH_ROUTE_MASK,
  PH_TYPE_MASK,
  PH_TYPE_SHIFT,
  PH_VER_MASK,
  PH_VER_SHIFT,
  PayloadType,
  hasTransportCodes,
  type RouteType,
} from './constants.js';
import { hmacSha256, sha256 } from './crypto.js';

/** Thrown by {@link parsePacket} / {@link buildPacket} for structurally invalid input. */
export class PacketError extends Error {
  override readonly name = 'PacketError';
}

export interface ParsedPacket {
  /** Raw header byte. */
  header: number;
  routeType: RouteType;
  /** 0..15 (12-14 reserved). */
  payloadType: number;
  /** Header bits 6-7 (0 = v1; the firmware drops anything else). */
  payloadVersion: number;
  /** Present only for TRANSPORT_FLOOD / TRANSPORT_DIRECT. */
  transportCodes?: readonly [number, number];
  /** Raw encoded path_len byte (§1.3). */
  pathLen: number;
  /** Bytes per path entry (1..3). For TRACE the entries are SNR bytes (size 1). */
  pathHashSize: number;
  /** Number of path entries. */
  pathHashCount: number;
  /** Raw path bytes (pathHashCount × pathHashSize). */
  path: Uint8Array;
  payload: Uint8Array;
}

export interface PacketInit {
  routeType: RouteType;
  payloadType: number;
  /** Defaults to 0 (v1). */
  payloadVersion?: number;
  /** Required-ish for TRANSPORT_* routes (defaults to [0, 0]); forbidden for others. */
  transportCodes?: readonly [number, number];
  /** Raw path bytes; length must be a multiple of `pathHashSize`. Default empty. */
  path?: Uint8Array;
  /** 1, 2 or 3. Default 1. */
  pathHashSize?: number;
  payload: Uint8Array;
}

/** Splits a header byte into its fields. §1.1 */
export function decodeHeader(header: number): { routeType: RouteType; payloadType: number; payloadVersion: number } {
  return {
    routeType: (header & PH_ROUTE_MASK) as RouteType,
    payloadType: (header >> PH_TYPE_SHIFT) & PH_TYPE_MASK,
    payloadVersion: (header >> PH_VER_SHIFT) & PH_VER_MASK,
  };
}

/** Packs a header byte. §1.1 */
export function encodeHeader(routeType: number, payloadType: number, payloadVersion = 0): number {
  return (
    ((payloadVersion & PH_VER_MASK) << PH_VER_SHIFT) |
    ((payloadType & PH_TYPE_MASK) << PH_TYPE_SHIFT) |
    (routeType & PH_ROUTE_MASK)
  );
}

/**
 * Parses the envelope. Throws {@link PacketError} when the structure cannot be split (empty,
 * truncated transport codes / path_len / path, reserved hash size, path > 64 bytes). An empty
 * payload and a non-zero version are accepted here; see {@link firmwareRejectReasons}.
 */
export function parsePacket(bytes: Uint8Array): ParsedPacket {
  if (bytes.length < 2) throw new PacketError(`packet too short (${bytes.length} bytes)`);
  const header = bytes[0]!;
  const h = decodeHeader(header);
  let i = 1;
  let transportCodes: readonly [number, number] | undefined;
  if (hasTransportCodes(h.routeType)) {
    if (bytes.length < 6) throw new PacketError('truncated transport codes');
    transportCodes = [readU16LE(bytes, 1), readU16LE(bytes, 3)];
    i = 5;
  }
  if (i >= bytes.length) throw new PacketError('missing path_len');
  const pathLen = bytes[i++]!;
  if (!isValidPathLen(pathLen)) throw new PacketError(`invalid path_len 0x${pathLen.toString(16).padStart(2, '0')}`);
  const pl = decodePathLen(pathLen);
  if (i + pl.byteLength > bytes.length) throw new PacketError('path extends past end of packet');
  const path = bytes.slice(i, i + pl.byteLength);
  i += pl.byteLength;
  const p: ParsedPacket = {
    header,
    ...h,
    pathLen,
    pathHashSize: pl.hashSize,
    pathHashCount: pl.hops,
    path,
    payload: bytes.slice(i),
  };
  if (transportCodes) p.transportCodes = transportCodes;
  return p;
}

/**
 * Reasons the firmware's `Packet::readFrom` / `Dispatcher` would drop this packet (empty when it
 * would be accepted). §1
 */
export function firmwareRejectReasons(p: ParsedPacket): string[] {
  const r: string[] = [];
  if (p.payloadVersion !== 0) r.push(`payload version ${p.payloadVersion} is not supported`);
  if (p.payload.length === 0) r.push('empty payload');
  if (p.payload.length > MAX_PACKET_PAYLOAD) r.push(`payload ${p.payload.length} > ${MAX_PACKET_PAYLOAD} bytes`);
  return r;
}

/** Splits a raw path into its entries. */
export function splitPath(path: Uint8Array, hashSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i + hashSize <= path.length; i += hashSize) out.push(path.slice(i, i + hashSize));
  return out;
}

/** Serialises a packet (`Packet::writeTo`). Throws {@link PacketError} / RangeError on bad input. */
export function buildPacket(p: PacketInit): Uint8Array {
  const hashSize = p.pathHashSize ?? 1;
  const path = p.path ?? new Uint8Array(0);
  if (path.length % hashSize !== 0) throw new PacketError(`path length ${path.length} is not a multiple of ${hashSize}`);
  if (path.length > MAX_PATH_SIZE) throw new PacketError(`path ${path.length} > ${MAX_PATH_SIZE} bytes`);
  const pathLen = encodePathLen(path.length / hashSize, hashSize);
  const withCodes = hasTransportCodes(p.routeType);
  if (!withCodes && p.transportCodes) throw new PacketError('transport codes require a TRANSPORT_* route type');
  const header = encodeHeader(p.routeType, p.payloadType, p.payloadVersion ?? 0);
  const codes = new Uint8Array(withCodes ? 4 : 0);
  if (withCodes) {
    const [c0, c1] = p.transportCodes ?? [0, 0];
    writeU16LE(codes, 0, c0);
    writeU16LE(codes, 2, c1);
  }
  const out = concatBytes(Uint8Array.of(header), codes, Uint8Array.of(pathLen), path, p.payload);
  if (out.length > MAX_TRANS_UNIT) throw new PacketError(`packet ${out.length} > ${MAX_TRANS_UNIT} bytes`);
  return out;
}

/**
 * Packet hash (de-dup id): SHA256(payload_type ‖ [TRACE: path_len as u16 LE] ‖ payload)[0..8].
 * §1.4
 */
export async function packetHash(p: Pick<ParsedPacket, 'payloadType' | 'pathLen' | 'payload'>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [Uint8Array.of(p.payloadType)];
  if (p.payloadType === PayloadType.TRACE) {
    const pl = new Uint8Array(2);
    writeU16LE(pl, 0, p.pathLen);
    parts.push(pl);
  }
  parts.push(p.payload);
  return (await sha256(...parts)).slice(0, PACKET_HASH_SIZE);
}

/**
 * Transport (region scope) code: first 2 bytes (u16 LE) of HMAC-SHA256(key16, payload_type ‖
 * payload); 0x0000 → 0x0001, 0xFFFF → 0xFFFE. §1.2
 */
export async function calcTransportCode(key: Uint8Array, payloadType: number, payload: Uint8Array): Promise<number> {
  const mac = await hmacSha256(key.subarray(0, 16), Uint8Array.of(payloadType), payload);
  const code = readU16LE(mac, 0);
  if (code === 0) return 1;
  if (code === 0xffff) return 0xfffe;
  return code;
}

/** Region key for a public hashtag region: SHA256("#name")[0..16]. §1.2 */
export async function regionKey(name: string): Promise<Uint8Array> {
  const n = name.startsWith('#') ? name : `#${name}`;
  return (await sha256(utf8Encode(n))).slice(0, 16);
}
