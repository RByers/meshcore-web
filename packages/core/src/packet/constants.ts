/**
 * Over-the-air packet constants. Ground truth: docs/mesh-packet-format.md §1.1 (`src/Packet.h`
 * L8-37) and `src/MeshCore.h`. Kept here (not in protocol/constants.ts) because these describe the
 * radio packet, not the companion protocol; shared sizes are re-exported from protocol/constants.
 */

export {
  PUB_KEY_SIZE,
  SIGNATURE_SIZE,
  MAX_PATH_SIZE,
  MAX_PATH_HOPS,
  MAX_PACKET_PAYLOAD,
} from '../protocol/constants.js';

/** Max whole-packet length (`MAX_TRANS_UNIT`). §1 */
export const MAX_TRANS_UNIT = 255;
/** src/dest/channel hashes inside payloads are always 1 byte (`PATH_HASH_SIZE`). §1 */
export const PAYLOAD_HASH_SIZE = 1;
/** Truncated HMAC size (`CIPHER_MAC_SIZE`). §2 */
export const CIPHER_MAC_SIZE = 2;
/** AES block size (`CIPHER_BLOCK_SIZE`). §2 */
export const CIPHER_BLOCK_SIZE = 16;
/** AES-128 key size (`CIPHER_KEY_SIZE`). §2 */
export const CIPHER_KEY_SIZE = 16;
/** Shared-secret / HMAC key size (`PUB_KEY_SIZE` is used as the HMAC key length). §2 */
export const SHARED_SECRET_SIZE = 32;
/** Packet hash (de-dup id) length (`MAX_HASH_SIZE`). §1.4 */
export const PACKET_HASH_SIZE = 8;
/** Max advert app_data bytes (`MAX_ADVERT_DATA_SIZE`). §3.5 */
export const MAX_ADVERT_DATA_SIZE = 32;
/** Fixed advert prefix: pubkey(32) + timestamp(4) + signature(64). §3.5 */
export const ADVERT_FIXED_SIZE = 100;
/** Ack code length (the part receivers compare). §3.4 */
export const ACK_CODE_SIZE = 4;

/** Header bit layout. §1.1 */
export const PH_ROUTE_MASK = 0x03;
export const PH_TYPE_SHIFT = 2;
export const PH_TYPE_MASK = 0x0f;
export const PH_VER_SHIFT = 6;
export const PH_VER_MASK = 0x03;

/** ROUTE_TYPE_* (header bits 0-1). §1.1 */
export const RouteType = {
  TRANSPORT_FLOOD: 0,
  FLOOD: 1,
  DIRECT: 2,
  TRANSPORT_DIRECT: 3,
} as const;
export type RouteTypeName = keyof typeof RouteType;
export type RouteType = (typeof RouteType)[RouteTypeName];

/** PAYLOAD_TYPE_* (header bits 2-5). 12-14 are reserved. §1.1 */
export const PayloadType = {
  REQ: 0x00,
  RESPONSE: 0x01,
  TXT_MSG: 0x02,
  ACK: 0x03,
  ADVERT: 0x04,
  GRP_TXT: 0x05,
  GRP_DATA: 0x06,
  ANON_REQ: 0x07,
  PATH: 0x08,
  TRACE: 0x09,
  MULTIPART: 0x0a,
  CONTROL: 0x0b,
  RAW_CUSTOM: 0x0f,
} as const;
export type PayloadTypeName = keyof typeof PayloadType;
export type PayloadType = (typeof PayloadType)[PayloadTypeName];

/** PAYLOAD_VER_* (header bits 6-7). Only V1 is accepted by the firmware. §1.1 */
export const PayloadVersion = {
  V1: 0,
  V2: 1,
  V3: 2,
  V4: 3,
} as const;

/** RESP_SERVER_LOGIN_OK, plaintext[4] of a login response. §3.2 */
export const RESP_SERVER_LOGIN_OK = 0;

/** PATH extra_type meaning "no extra" (followed by 4 random bytes). §3.9 */
export const PATH_EXTRA_NONE = 0xff;

const ROUTE_NAMES = new Map<number, RouteTypeName>(
  Object.entries(RouteType).map(([k, v]) => [v, k as RouteTypeName]),
);
const PAYLOAD_NAMES = new Map<number, PayloadTypeName>(
  Object.entries(PayloadType).map(([k, v]) => [v, k as PayloadTypeName]),
);

export function routeTypeName(rt: number): RouteTypeName {
  return ROUTE_NAMES.get(rt & PH_ROUTE_MASK) ?? 'FLOOD';
}

/** Name of a payload type, or `RESERVED_<n>` for 12-14. */
export function payloadTypeName(pt: number): PayloadTypeName | `RESERVED_${number}` {
  return PAYLOAD_NAMES.get(pt) ?? `RESERVED_${pt}`;
}

/** True for TRANSPORT_FLOOD / TRANSPORT_DIRECT. §1 */
export function hasTransportCodes(routeType: number): boolean {
  return routeType === RouteType.TRANSPORT_FLOOD || routeType === RouteType.TRANSPORT_DIRECT;
}
export function isFloodRoute(routeType: number): boolean {
  return routeType === RouteType.FLOOD || routeType === RouteType.TRANSPORT_FLOOD;
}
export function isDirectRoute(routeType: number): boolean {
  return routeType === RouteType.DIRECT || routeType === RouteType.TRANSPORT_DIRECT;
}
