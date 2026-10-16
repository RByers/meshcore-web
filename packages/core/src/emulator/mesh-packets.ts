/**
 * Synchronous builders/decoders for the on-air packets the emulator sends, on top of the
 * authoritative codec in `packet/` (envelope, payload and plaintext layouts) and the sync crypto
 * in `crypto-sync.ts`. docs/mesh-packet-format.md is the reference for every layout.
 */

import { bytesEqual, concatBytes, u32le } from '../util/bytes.js';
import { CIPHER_BLOCK_SIZE, CIPHER_MAC_SIZE, MAX_PACKET_PAYLOAD, MAX_PATH_SIZE, PayloadType, RouteType, isFloodRoute } from '../packet/constants.js';
import { PacketError, buildPacket, firmwareRejectReasons, parsePacket } from '../packet/packet.js';
import type { ParsedPacket } from '../packet/packet.js';
import { PayloadError, advertSignedMessage, buildAckPayload, buildPathPlaintext, encodeAdvertAppData, parsePayload } from '../packet/payloads.js';
import type { AdvertAppDataInit, TracePayload } from '../packet/payloads.js';
import { decodePathLen, PATH_LEN_UNKNOWN } from '../protocol/constants.js';
import { ed25519SignExpanded, encryptThenMacSync, transportCodeSync } from './crypto-sync.js';

export interface MeshIdentity {
  publicKey: Uint8Array;
  /** 64-byte expanded (firmware-format) private key. */
  privateKey: Uint8Array;
}

/** How to send a packet: `path: null` = flood, otherwise DIRECT along `path`. */
export interface SendRoute {
  path: Uint8Array | null;
  /** Bytes per path entry (1..3). Default 1. */
  hashSize?: number;
  /** Flood only: region key → TRANSPORT_FLOOD with code[0] = calcTransportCode, code[1] = 0. §1.2 */
  scopeKey?: Uint8Array | null;
}

export const FLOOD: SendRoute = { path: null };
export const ZERO_HOP: SendRoute = { path: new Uint8Array(0) };

/** Route for a stored contact path (encoded out_path_len, 0xFF = unknown → flood). */
export function contactRoute(outPathLen: number, outPath: Uint8Array): SendRoute {
  if (outPathLen === PATH_LEN_UNKNOWN) return FLOOD;
  const info = decodePathLen(outPathLen);
  return { path: outPath.slice(0, info.byteLength), hashSize: info.hashSize };
}

/** Wraps a payload in an envelope (`Mesh::sendFlood` / `sendDirect`). */
export function envelope(payloadType: number, payload: Uint8Array, route: SendRoute): Uint8Array {
  const hashSize = route.hashSize ?? 1;
  if (route.path === null) {
    const scoped = route.scopeKey && route.scopeKey.some((b) => b !== 0);
    if (scoped) {
      return buildPacket({
        routeType: RouteType.TRANSPORT_FLOOD,
        payloadType,
        transportCodes: [transportCodeSync(route.scopeKey!, payloadType, payload), 0],
        pathHashSize: hashSize,
        payload,
      });
    }
    return buildPacket({ routeType: RouteType.FLOOD, payloadType, pathHashSize: hashSize, payload });
  }
  return buildPacket({ routeType: RouteType.DIRECT, payloadType, path: route.path, pathHashSize: hashSize, payload });
}

/** True when `plaintext` fits an encrypted envelope with `prefix` visible bytes. §3.0 size guards */
export function fitsEncrypted(prefix: number, plaintextLen: number): boolean {
  const padded = Math.ceil(plaintextLen / CIPHER_BLOCK_SIZE) * CIPHER_BLOCK_SIZE;
  return prefix + CIPHER_MAC_SIZE + padded <= MAX_PACKET_PAYLOAD;
}

/** REQ/RESPONSE/TXT_MSG/PATH payload `[dest_hash][src_hash][MAC][ciphertext]`. §3.0 */
export function peerDatagramPayload(destPub: Uint8Array, srcPub: Uint8Array, secret: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(destPub[0]!, srcPub[0]!), encryptThenMacSync(secret, plaintext));
}

/** ANON_REQ payload `[dest_hash][sender pubkey][MAC][ciphertext]`. §3.8 */
export function anonReqPayload(destPub: Uint8Array, senderPub: Uint8Array, secret: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(destPub[0]!), senderPub, encryptThenMacSync(secret, plaintext));
}

/** GRP_TXT / GRP_DATA payload `[channel_hash][MAC][ciphertext]`. §3.6 */
export function groupPayload(channelHash: number, psk: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(channelHash & 0xff), encryptThenMacSync(psk, plaintext));
}

/** Signed ADVERT payload (`Mesh::createAdvert`). §3.5 */
export function advertPayload(id: MeshIdentity, timestamp: number, app: AdvertAppDataInit): Uint8Array {
  const appData = encodeAdvertAppData(app);
  const sig = ed25519SignExpanded(id.privateKey, id.publicKey, advertSignedMessage(id.publicKey, timestamp, appData));
  return concatBytes(id.publicKey, u32le(timestamp), sig, appData);
}

/**
 * An ADVERT payload for a key whose private key is unknown (seeded contacts): the signature is
 * random filler, so it will not verify — exactly like a forged advert.
 */
export function unsignedAdvertPayload(publicKey: Uint8Array, timestamp: number, app: AdvertAppDataInit, filler: Uint8Array): Uint8Array {
  return concatBytes(publicKey, u32le(timestamp), filler.subarray(0, 64), encodeAdvertAppData(app));
}

/** PATH return plaintext (`Mesh::createPathReturn`) carrying an ACK. §3.9 */
export function pathWithAck(path: Uint8Array, hashSize: number, ack: number): Uint8Array {
  return buildPathPlaintext({ path, hashSize, extraType: PayloadType.ACK, extra: u32le(ack) });
}

/** ACK payload: the 4-byte code. §3.4 */
export function ackPayload(ack: number): Uint8Array {
  return buildAckPayload(u32le(ack));
}

/** parsePacket + the firmware's reject rules; null where `Dispatcher` would drop the packet. */
export function tryParse(raw: Uint8Array): ParsedPacket | null {
  try {
    const p = parsePacket(raw);
    return firmwareRejectReasons(p).length === 0 ? p : null;
  } catch (e) {
    if (e instanceof PacketError) return null;
    throw e;
  }
}

/** Re-serialises a parsed packet with a new route/path (forwarding). */
export function rebuild(p: ParsedPacket, change: { routeType?: number; path: Uint8Array; pathHashSize?: number }): Uint8Array {
  return buildPacket({
    routeType: (change.routeType ?? p.routeType) as ParsedPacket['routeType'],
    payloadType: p.payloadType,
    payloadVersion: p.payloadVersion,
    ...(p.transportCodes ? { transportCodes: p.transportCodes } : {}),
    path: change.path,
    pathHashSize: change.pathHashSize ?? p.pathHashSize,
    payload: p.payload,
  });
}

/** Path with `hash` appended, or null when it would exceed MAX_PATH_SIZE / 63 hops. */
export function appendHop(p: ParsedPacket, hash: Uint8Array): Uint8Array | null {
  if (p.pathHashCount >= 63 || p.path.length + p.pathHashSize > MAX_PATH_SIZE) return null;
  return concatBytes(p.path, hash.subarray(0, p.pathHashSize));
}

export const isFlood = (p: ParsedPacket): boolean => isFloodRoute(p.routeType);

export const keyStartsWith = (key: Uint8Array, prefix: Uint8Array): boolean =>
  prefix.length <= key.length && bytesEqual(key.subarray(0, prefix.length), prefix);

/** TRACE payload (§3.10), or null when truncated. */
export function parseTraceSafe(payload: Uint8Array): TracePayload | null {
  try {
    const t = parsePayload(PayloadType.TRACE, payload);
    return t.kind === 'trace' ? t : null;
  } catch (e) {
    if (e instanceof PayloadError) return null;
    throw e;
  }
}
