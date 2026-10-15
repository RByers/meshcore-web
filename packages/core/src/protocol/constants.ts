/**
 * MeshCore companion protocol constants.
 *
 * Ground truth: docs/companion-protocol.md (firmware companion-v1.18.0,
 * examples/companion_radio/MyMesh.cpp) and docs/mesh-packet-format.md.
 */

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** FIRMWARE_VER_CODE of the firmware the docs were derived from (v1.18.0). §2.3 */
export const FIRMWARE_VER_CODE = 14;
/** FIRMWARE_VERSION string of the reference firmware. §2.3 */
export const FIRMWARE_VERSION = 'v1.18.0';
/** The app protocol version this client sends in CMD_DEVICE_QUERY (enables V3 message frames). §2, §11 */
export const APP_PROTOCOL_VERSION = 3;
/** app_target_ver at or above which the firmware sends V3 message frames (0x10/0x11). §11 */
export const V3_MESSAGES_MIN_VERSION = 3;
/** Default app name sent in CMD_APP_START. §2.1 */
export const DEFAULT_APP_NAME = 'meshcore-web';
/** Default value of CMD_APP_START[1] (meshcore.js "appVer"; ignored by firmware). §2.1 */
export const DEFAULT_APP_VERSION = 1;

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/** Max companion frame length (code byte included). §1.1, `BaseSerialInterface.h` */
export const MAX_FRAME_SIZE = 176;
export const PUB_KEY_SIZE = 32;
/** "prefix6": the first 6 bytes of a public key, used in message and response pushes. */
export const PUB_KEY_PREFIX_SIZE = 6;
/** Advert-path table compares only this many pubkey bytes (CMD 42). §4 */
export const ADVERT_PATH_PREFIX_SIZE = 7;
/** Max path bytes (hops × hash size). */
export const MAX_PATH_SIZE = 64;
export const MAX_PATH_HOPS = 63;
export const SIGNATURE_SIZE = 64;
/** 64-byte expanded Ed25519 private key. §9 */
export const PRIVATE_KEY_SIZE = 64;
export const MAX_PACKET_PAYLOAD = 184;
/** Max text bytes for a message (158 if attempt > 3). §8 */
export const MAX_TEXT_LEN = 160;
/** Size of fixed char[32] name fields (contact name, channel name). Max 31 bytes + NUL. */
export const MAX_NAME_SIZE = 32;
/** Max node / channel / contact name length in bytes (field size minus the NUL). */
export const MAX_NAME_LEN = MAX_NAME_SIZE - 1;
export const CHANNEL_SECRET_SIZE = 16;
/** Size of the default flood scope name field (char[31]); name 1..30 bytes. §4 CMD 63 */
export const DEFAULT_SCOPE_NAME_SIZE = 31;
export const TRANSPORT_KEY_SIZE = 16;
/** SIGN_DATA buffer limit. §4 CMD 33 */
export const MAX_SIGN_DATA_LEN = 8192;
/** Max CMD_SEND_CHANNEL_DATA payload (MAX_PACKET_PAYLOAD - CIPHER_BLOCK_SIZE - 3). §4 CMD 62 */
export const MAX_GROUP_DATA_LENGTH = 165;
/** CHANNEL_DATA_RECV is dropped if data_len exceeds this (MAX_FRAME_SIZE - 9). §6.4 */
export const MAX_CHANNEL_DATA_LENGTH = 167;
/** Contact record size (RESP 0x03 / PUSH 0x8A / CMD 0x09). §7.1 */
export const CONTACT_RECORD_SIZE = 148;
export const SELF_INFO_MIN_SIZE = 58;
export const DEVICE_INFO_SIZE = 82;
export const CHANNEL_INFO_SIZE = 50;
export const SENT_FRAME_SIZE = 10;
export const EXPECTED_ACK_TABLE_SIZE = 8;
export const ADVERT_PATH_TABLE_SIZE = 16;
/** Size of a repeater RepeaterStats struct (older repeaters: 48). mesh-packet-format.md §3.2 */
export const REPEATER_STATS_SIZE = 56;
export const REPEATER_STATS_LEGACY_SIZE = 48;
/** Size of a room server ServerStats struct. mesh-packet-format.md §3.2 */
export const SERVER_STATS_SIZE = 52;

/** Public channel (slot 0) PSK, hex of base64 `izOH6cXN6mrJ5e26oRXNcg==`. §5.5 */
export const PUBLIC_CHANNEL_SECRET_HEX = '8b3387e9c5cdea6ac9e5edbaa115cd72';
export const PUBLIC_CHANNEL_NAME = 'Public';

// ---------------------------------------------------------------------------
// Command codes (host -> device). §4
// ---------------------------------------------------------------------------

export const CMD = {
  APP_START: 0x01,
  SEND_TXT_MSG: 0x02,
  SEND_CHANNEL_TXT_MSG: 0x03,
  GET_CONTACTS: 0x04,
  GET_DEVICE_TIME: 0x05,
  SET_DEVICE_TIME: 0x06,
  SEND_SELF_ADVERT: 0x07,
  SET_ADVERT_NAME: 0x08,
  ADD_UPDATE_CONTACT: 0x09,
  SYNC_NEXT_MESSAGE: 0x0a,
  SET_RADIO_PARAMS: 0x0b,
  SET_RADIO_TX_POWER: 0x0c,
  RESET_PATH: 0x0d,
  SET_ADVERT_LATLON: 0x0e,
  REMOVE_CONTACT: 0x0f,
  SHARE_CONTACT: 0x10,
  EXPORT_CONTACT: 0x11,
  IMPORT_CONTACT: 0x12,
  REBOOT: 0x13,
  GET_BATT_AND_STORAGE: 0x14,
  SET_TUNING_PARAMS: 0x15,
  DEVICE_QUERY: 0x16,
  EXPORT_PRIVATE_KEY: 0x17,
  IMPORT_PRIVATE_KEY: 0x18,
  SEND_RAW_DATA: 0x19,
  SEND_LOGIN: 0x1a,
  SEND_STATUS_REQ: 0x1b,
  HAS_CONNECTION: 0x1c,
  LOGOUT: 0x1d,
  GET_CONTACT_BY_KEY: 0x1e,
  GET_CHANNEL: 0x1f,
  SET_CHANNEL: 0x20,
  SIGN_START: 0x21,
  SIGN_DATA: 0x22,
  SIGN_FINISH: 0x23,
  SEND_TRACE_PATH: 0x24,
  SET_DEVICE_PIN: 0x25,
  SET_OTHER_PARAMS: 0x26,
  SEND_TELEMETRY_REQ: 0x27,
  GET_CUSTOM_VARS: 0x28,
  SET_CUSTOM_VAR: 0x29,
  GET_ADVERT_PATH: 0x2a,
  GET_TUNING_PARAMS: 0x2b,
  SEND_BINARY_REQ: 0x32,
  FACTORY_RESET: 0x33,
  SEND_PATH_DISCOVERY_REQ: 0x34,
  SET_FLOOD_SCOPE_KEY: 0x36,
  SEND_CONTROL_DATA: 0x37,
  GET_STATS: 0x38,
  SEND_ANON_REQ: 0x39,
  SET_AUTOADD_CONFIG: 0x3a,
  GET_AUTOADD_CONFIG: 0x3b,
  GET_ALLOWED_REPEAT_FREQ: 0x3c,
  SET_PATH_HASH_MODE: 0x3d,
  SEND_CHANNEL_DATA: 0x3e,
  SET_DEFAULT_FLOOD_SCOPE: 0x3f,
  GET_DEFAULT_FLOOD_SCOPE: 0x40,
  SEND_RAW_PACKET: 0x41,
  RUN_CLI_COMMAND: 0x42,
} as const;
export type CmdName = keyof typeof CMD;
export type CmdCode = (typeof CMD)[CmdName];

// ---------------------------------------------------------------------------
// Response codes (device -> host, replies). §5
// ---------------------------------------------------------------------------

export const RESP = {
  OK: 0x00,
  ERR: 0x01,
  CONTACTS_START: 0x02,
  CONTACT: 0x03,
  END_OF_CONTACTS: 0x04,
  SELF_INFO: 0x05,
  SENT: 0x06,
  CONTACT_MSG_RECV: 0x07,
  CHANNEL_MSG_RECV: 0x08,
  CURR_TIME: 0x09,
  NO_MORE_MESSAGES: 0x0a,
  EXPORT_CONTACT: 0x0b,
  BATT_AND_STORAGE: 0x0c,
  DEVICE_INFO: 0x0d,
  PRIVATE_KEY: 0x0e,
  DISABLED: 0x0f,
  CONTACT_MSG_RECV_V3: 0x10,
  CHANNEL_MSG_RECV_V3: 0x11,
  CHANNEL_INFO: 0x12,
  SIGN_START: 0x13,
  SIGNATURE: 0x14,
  CUSTOM_VARS: 0x15,
  ADVERT_PATH: 0x16,
  TUNING_PARAMS: 0x17,
  STATS: 0x18,
  AUTOADD_CONFIG: 0x19,
  ALLOWED_REPEAT_FREQ: 0x1a,
  CHANNEL_DATA_RECV: 0x1b,
  DEFAULT_FLOOD_SCOPE: 0x1c,
  CLI_REPLY: 0x1d,
} as const;
export type RespName = keyof typeof RESP;
export type RespCode = (typeof RESP)[RespName];

// ---------------------------------------------------------------------------
// Push codes (device -> host, unsolicited). §6
// ---------------------------------------------------------------------------

export const PUSH = {
  ADVERT: 0x80,
  PATH_UPDATED: 0x81,
  SEND_CONFIRMED: 0x82,
  MSG_WAITING: 0x83,
  RAW_DATA: 0x84,
  LOGIN_SUCCESS: 0x85,
  LOGIN_FAIL: 0x86,
  STATUS_RESPONSE: 0x87,
  LOG_RX_DATA: 0x88,
  TRACE_DATA: 0x89,
  NEW_ADVERT: 0x8a,
  TELEMETRY_RESPONSE: 0x8b,
  BINARY_RESPONSE: 0x8c,
  PATH_DISCOVERY_RESPONSE: 0x8d,
  CONTROL_DATA: 0x8e,
  CONTACT_DELETED: 0x8f,
  CONTACTS_FULL: 0x90,
} as const;
export type PushName = keyof typeof PUSH;
export type PushCode = (typeof PUSH)[PushName];

/** Pushes have the high bit set; responses do not. */
export function isPushCode(code: number): boolean {
  return (code & 0x80) !== 0;
}

// ---------------------------------------------------------------------------
// Error codes (RESP_CODE_ERR [1]). §3
// ---------------------------------------------------------------------------

export const ERR = {
  UNSUPPORTED_CMD: 1,
  NOT_FOUND: 2,
  TABLE_FULL: 3,
  BAD_STATE: 4,
  FILE_IO_ERROR: 5,
  ILLEGAL_ARG: 6,
} as const;
export type ErrName = keyof typeof ERR;
export type ErrCode = (typeof ERR)[ErrName];

// ---------------------------------------------------------------------------
// Reverse lookups (for logs / the inspector)
// ---------------------------------------------------------------------------

function invert<T extends Record<string, number>>(o: T): ReadonlyMap<number, keyof T & string> {
  const m = new Map<number, keyof T & string>();
  for (const [k, v] of Object.entries(o)) m.set(v, k as keyof T & string);
  return m;
}

const CMD_BY_CODE = invert(CMD);
const RESP_BY_CODE = invert(RESP);
const PUSH_BY_CODE = invert(PUSH);
const ERR_BY_CODE = invert(ERR);

export function cmdName(code: number): CmdName | undefined {
  return CMD_BY_CODE.get(code);
}
export function respName(code: number): RespName | undefined {
  return RESP_BY_CODE.get(code);
}
export function pushName(code: number): PushName | undefined {
  return PUSH_BY_CODE.get(code);
}
/** Name for an ERR code, or `'UNKNOWN'` for codes the firmware does not define. */
export function errName(code: number): ErrName | 'UNKNOWN' {
  return ERR_BY_CODE.get(code) ?? 'UNKNOWN';
}
/** Name for any device->host frame code (response or push). */
export function deviceFrameName(code: number): RespName | PushName | undefined {
  return isPushCode(code) ? pushName(code) : respName(code);
}

// ---------------------------------------------------------------------------
// Contacts / adverts. §7.1, mesh-packet-format.md §3.5
// ---------------------------------------------------------------------------

/** Contact / advert node type (ADV_TYPE_*). */
export const ContactType = {
  NONE: 0,
  CHAT: 1,
  REPEATER: 2,
  ROOM: 3,
  SENSOR: 4,
} as const;
export type ContactTypeName = keyof typeof ContactType;

/** Contact flags (`ContactInfo.h`). §7.1 */
export const ContactFlag = {
  FAVOURITE: 0x01,
  TELEMETRY_BASE: 0x02,
  TELEMETRY_LOCATION: 0x04,
  TELEMETRY_ENVIRONMENT: 0x08,
  REMOTE_CLI: 0x10,
} as const;

/** Advert app_data flags byte. mesh-packet-format.md §3.5 */
export const AdvertFlag = {
  TYPE_MASK: 0x0f,
  HAS_LATLON: 0x10,
  HAS_FEAT1: 0x20,
  HAS_FEAT2: 0x40,
  HAS_NAME: 0x80,
} as const;

/** SET_AUTOADD_CONFIG bits. §7.3 */
export const AutoAddFlag = {
  OVERWRITE_OLDEST: 0x01,
  CHAT: 0x02,
  REPEATER: 0x04,
  ROOM: 0x08,
  SENSOR: 0x10,
} as const;

/** SELF_INFO[47] / SET_OTHER_PARAMS[1] bit 0: manual-add mode. §2.2 */
export const MANUAL_ADD_CONTACTS_BIT = 0x01;

/** advert_loc_policy. §2.2 */
export const AdvertLocPolicy = {
  NONE: 0,
  SHARE: 1,
} as const;

// ---------------------------------------------------------------------------
// Text messages. §8
// ---------------------------------------------------------------------------

export const TxtType = {
  PLAIN: 0,
  CLI_DATA: 1,
  SIGNED_PLAIN: 2,
  CLI_COMMAND: 3,
} as const;
export type TxtTypeName = keyof typeof TxtType;
/** Size of the author pubkey prefix that follows the timestamp in SIGNED_PLAIN messages. §6.2 */
export const SIGNED_PLAIN_AUTHOR_PREFIX_SIZE = 4;

/** Channel datagram data types (`TxtDataHelpers.h`). 0 is rejected. §4 CMD 62 */
export const DataType = {
  RESERVED: 0x0000,
  DEV: 0xffff,
} as const;

// ---------------------------------------------------------------------------
// Telemetry. §2.2, MyMesh.cpp onContactRequest
// ---------------------------------------------------------------------------

/** Telemetry mode values for each 2-bit field of SELF_INFO[46] / SET_OTHER_PARAMS[2]. */
export const TelemetryMode = {
  DENY: 0,
  ALLOW_FLAGS: 1,
  ALLOW_ALL: 2,
} as const;

/** Telemetry permission bits (TELEM_PERM_*), also the GET_TELEMETRY_DATA inverse mask bits. */
export const TelemetryPerm = {
  BASE: 0x01,
  LOCATION: 0x02,
  ENVIRONMENT: 0x04,
} as const;

/** CayenneLPP channel used for the device's own readings. */
export const TELEM_CHANNEL_SELF = 1;

export interface TelemetryModes {
  base: number;
  location: number;
  environment: number;
}

/** Packs telemetry modes: bits0-1 base, bits2-3 location, bits4-5 environment. §2.2 */
export function packTelemetryModes(m: TelemetryModes): number {
  return ((m.environment & 3) << 4) | ((m.location & 3) << 2) | (m.base & 3);
}

export function unpackTelemetryModes(byte: number): TelemetryModes {
  return { base: byte & 3, location: (byte >> 2) & 3, environment: (byte >> 4) & 3 };
}

// ---------------------------------------------------------------------------
// Remote request types (first byte of SEND_BINARY_REQ data). mesh-packet-format.md §3.1
// ---------------------------------------------------------------------------

export const ReqType = {
  GET_STATUS: 0x01,
  KEEP_ALIVE: 0x02,
  GET_TELEMETRY_DATA: 0x03,
  GET_AVG_MIN_MAX: 0x04,
  GET_ACCESS_LIST: 0x05,
  GET_NEIGHBOURS: 0x06,
  GET_OWNER_INFO: 0x07,
  SUBSCRIBE: 0x08,
  UNSUBSCRIBE: 0x09,
} as const;

/** CONTROL payload sub-types. mesh-packet-format.md §3.12 */
export const ControlType = {
  NODE_DISCOVER_REQ: 0x80,
  NODE_DISCOVER_RESP: 0x90,
} as const;
/** SEND_CONTROL_DATA requires `[1] & 0x80`. §4 CMD 55 */
export const CONTROL_DATA_FLAG = 0x80;

// ---------------------------------------------------------------------------
// Stats. §5.6
// ---------------------------------------------------------------------------

export const StatsType = {
  CORE: 0,
  RADIO: 1,
  PACKETS: 2,
} as const;

/** STATS CORE err_flags bits (`Dispatcher.h`). §5.6 */
export const CoreErrFlag = {
  QUEUE_FULL: 0x01,
  CAD_TIMEOUT: 0x02,
  START_RX_TIMEOUT: 0x04,
} as const;

/** LOGIN_SUCCESS ACL permission role (bits 0-1). §6.6 */
export const AclRole = {
  GUEST: 0,
  READ_ONLY: 1,
  READ_WRITE: 2,
  ADMIN: 3,
} as const;

/** Literal bodies required by REBOOT / FACTORY_RESET. §4 */
export const REBOOT_MAGIC = 'reboot';
export const FACTORY_RESET_MAGIC = 'reset';

// ---------------------------------------------------------------------------
// path_len encoding. mesh-packet-format.md §1.3
// ---------------------------------------------------------------------------

/**
 * `out_path_len` sentinel. In a contact record it means "no known path, sends will flood".
 * In CONTACT/CHANNEL message frames it means "received DIRECT" (no hop info). In
 * SEND_CHANNEL_DATA it requests a flood.
 */
export const PATH_LEN_UNKNOWN = 0xff;

export interface PathLenInfo {
  /** The raw encoded byte. */
  raw: number;
  /** True only for the 0xFF sentinel (contact: unknown path → flood). */
  isFlood: boolean;
  /** Bytes per hop hash: 1, 2 or 3 (4 = reserved/invalid). 0 for the sentinel. */
  hashSize: number;
  /** Hop count (bits 0-5). 0 for the sentinel. */
  hops: number;
  /** Path byte length = hops × hashSize. 0 for the sentinel. */
  byteLength: number;
  /** False if the hash size is the reserved value or byteLength > 64. The sentinel is valid. */
  valid: boolean;
}

/** Decodes an encoded path_len byte (bits 6-7 = hash size − 1, bits 0-5 = hops). */
export function decodePathLen(raw: number): PathLenInfo {
  const b = raw & 0xff;
  if (b === PATH_LEN_UNKNOWN) {
    return { raw: b, isFlood: true, hashSize: 0, hops: 0, byteLength: 0, valid: true };
  }
  const hops = b & 0x3f;
  const hashSize = (b >> 6) + 1;
  const byteLength = hops * hashSize;
  const valid = hashSize !== 4 && byteLength <= MAX_PATH_SIZE;
  return { raw: b, isFlood: false, hashSize, hops, byteLength, valid };
}

/** Firmware `Packet::isValidPathLen` (the 0xFF sentinel is NOT a valid on-air path_len). */
export function isValidPathLen(raw: number): boolean {
  const b = raw & 0xff;
  const hashSize = (b >> 6) + 1;
  return hashSize !== 4 && (b & 0x3f) * hashSize <= MAX_PATH_SIZE;
}

/** Path byte length for an encoded path_len (0 for the sentinel). */
export function pathByteLength(raw: number): number {
  return decodePathLen(raw).byteLength;
}

/** Encodes a path_len byte. Throws RangeError for hashSize ∉ {1,2,3}, hops ∉ 0..63 or > 64 bytes. */
export function encodePathLen(hops: number, hashSize = 1): number {
  if (!Number.isInteger(hashSize) || hashSize < 1 || hashSize > 3) {
    throw new RangeError(`encodePathLen: hashSize must be 1, 2 or 3 (got ${hashSize})`);
  }
  if (!Number.isInteger(hops) || hops < 0 || hops > MAX_PATH_HOPS) {
    throw new RangeError(`encodePathLen: hops must be 0..63 (got ${hops})`);
  }
  if (hops * hashSize > MAX_PATH_SIZE) {
    throw new RangeError(`encodePathLen: ${hops} hops × ${hashSize} B exceeds ${MAX_PATH_SIZE} bytes`);
  }
  return ((hashSize - 1) << 6) | hops;
}

// ---------------------------------------------------------------------------
// Timeouts (est_timeout in SENT). §10
// ---------------------------------------------------------------------------

export const SEND_TIMEOUT_BASE_MILLIS = 500;
export const FLOOD_SEND_TIMEOUT_FACTOR = 16;
export const DIRECT_SEND_PERHOP_FACTOR = 6;
export const DIRECT_SEND_PERHOP_EXTRA_MILLIS = 250;

/** Flood timeout: 500 + 16 × airtime. §10 */
export function floodTimeoutMs(airtimeMs: number): number {
  return Math.trunc(SEND_TIMEOUT_BASE_MILLIS + FLOOD_SEND_TIMEOUT_FACTOR * airtimeMs);
}

/** Direct timeout: 500 + (airtime × 6 + 250) × (hops + 1), hops = pathLen & 63. §10 */
export function directTimeoutMs(airtimeMs: number, pathLen: number): number {
  const hops = pathLen & 63;
  return Math.trunc(
    SEND_TIMEOUT_BASE_MILLIS +
      (airtimeMs * DIRECT_SEND_PERHOP_FACTOR + DIRECT_SEND_PERHOP_EXTRA_MILLIS) * (hops + 1),
  );
}
