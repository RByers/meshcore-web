/**
 * Typed shapes for every companion command (host → device) and every response /
 * push (device → host). Layouts: docs/companion-protocol.md.
 *
 * Units: lat/lon are degrees (wire: i32 × 1e6); SNR values are dB (wire: i8/i16 × 4);
 * radio frequency is kHz and bandwidth Hz, exactly as on the wire.
 */

import type { ErrName, PathLenInfo, TelemetryModes } from './constants.js';

// ===========================================================================
// Records
// ===========================================================================

/** Contact record (RESP 0x03 / PUSH 0x8A / CMD 0x09 body). §7.1 */
export interface Contact {
  pubKey: Uint8Array;
  /** ContactType (0 none, 1 chat, 2 repeater, 3 room, 4 sensor). */
  type: number;
  /** ContactFlag bits. */
  flags: number;
  /** Raw out_path_len byte (0xFF = unknown → flood). */
  outPathLen: number;
  outPathInfo: PathLenInfo;
  /** The valid out_path bytes (hops × hashSize); empty when unknown. */
  outPath: Uint8Array;
  name: string;
  /** last_advert_timestamp (sender's clock, unix secs). */
  lastAdvert: number;
  /** Degrees. */
  lat: number;
  /** Degrees. */
  lon: number;
  /** lastmod (device RTC, unix secs). */
  lastMod: number;
}

/** Input for CMD_ADD_UPDATE_CONTACT. lat/lon and lastMod are optional trailing fields. §4 CMD 9 */
export interface ContactInput {
  pubKey: Uint8Array;
  type: number;
  flags: number;
  /** Raw out_path_len byte (0xFF = unknown). */
  outPathLen: number;
  /** Path bytes; at most 64, zero padded on the wire. */
  outPath?: Uint8Array;
  name: string;
  lastAdvert: number;
  /** Degrees. Sent only if both lat and lon are given (or lastMod is given: then 0 is sent). */
  lat?: number;
  lon?: number;
  /** If absent the device sets lastmod to its RTC now. */
  lastMod?: number;
}

/** RESP_CODE_SELF_INFO (0x05). §2.2 */
export interface SelfInfo {
  advType: number;
  txPowerDbm: number;
  maxTxPowerDbm: number;
  pubKey: Uint8Array;
  lat: number;
  lon: number;
  multiAcks: number;
  advertLocPolicy: number;
  telemetryModesRaw: number;
  telemetryModes: TelemetryModes;
  /** Raw byte; bit 0 = manual add mode. */
  manualAddContacts: number;
  radioFreqKhz: number;
  radioBwHz: number;
  radioSf: number;
  radioCr: number;
  name: string;
}

/** RESP_CODE_DEVICE_INFO (0x0D). §2.3. Fields after firmwareVerCode are absent on short (old) frames. */
export interface DeviceInfo {
  firmwareVerCode: number;
  /** MAX_CONTACTS (wire byte × 2). v3+ */
  maxContacts?: number;
  /** MAX_GROUP_CHANNELS. v3+ */
  maxChannels?: number;
  /** BLE PIN stored in prefs (0 = default/unset). */
  blePin?: number;
  buildDate?: string;
  manufacturer?: string;
  firmwareVersion?: string;
  /** v9+ */
  clientRepeat?: boolean;
  /** v10+, 0..2 (hash size = mode + 1). */
  pathHashMode?: number;
}

/** RESP_CODE_CHANNEL_INFO (0x12). §5.5 */
export interface ChannelInfo {
  index: number;
  name: string;
  secret: Uint8Array;
}

/** RESP_CODE_BATT_AND_STORAGE (0x0C). §5.3. Storage fields absent on 3-byte legacy frames. */
export interface BattAndStorage {
  batteryMv: number;
  storageUsedKb?: number;
  storageTotalKb?: number;
}

/** RESP_CODE_STATS (0x18). §5.6 */
export type Stats =
  | {
      type: 'core';
      batteryMv: number;
      uptimeSecs: number;
      errFlags: number;
      outboundQueueLen: number;
    }
  | {
      type: 'radio';
      noiseFloorDbm: number;
      lastRssiDbm: number;
      /** dB */
      lastSnr: number;
      txAirSecs: number;
      rxAirSecs: number;
    }
  | {
      type: 'packets';
      recv: number;
      sent: number;
      sentFlood: number;
      sentDirect: number;
      recvFlood: number;
      recvDirect: number;
      /** Absent on older 26-byte frames. */
      recvErrors?: number;
    }
  | { type: 'unknown'; statsType: number; raw: Uint8Array };

/** Fields shared by repeater RepeaterStats and room ServerStats (offsets 0..47). mesh-packet-format.md §3.2 */
export interface CommonNodeStats {
  batteryMv: number;
  txQueueLen: number;
  noiseFloorDbm: number;
  lastRssiDbm: number;
  packetsRecv: number;
  packetsSent: number;
  airTimeSecs: number;
  upTimeSecs: number;
  sentFlood: number;
  sentDirect: number;
  recvFlood: number;
  recvDirect: number;
  errEvents: number;
  /** dB */
  lastSnr: number;
  directDups: number;
  floodDups: number;
}

export interface RepeaterStats extends CommonNodeStats {
  kind: 'repeater';
  /** Absent on legacy 48-byte frames. */
  rxAirTimeSecs?: number;
  recvErrors?: number;
}

export interface ServerStats extends CommonNodeStats {
  kind: 'room';
  posted: number;
  postPush: number;
}

export type NodeStats = RepeaterStats | ServerStats;

export interface RepeatFreqRange {
  lowerKhz: number;
  upperKhz: number;
}

export interface CustomVar {
  name: string;
  value: string;
}

/** How a queued message arrived. `pathLen` 0xFF = received DIRECT. §6.2 */
export interface MessageRoute {
  /** Raw path_len byte from the frame. */
  pathLen: number;
  receivedVia: 'direct' | 'flood';
  /** Flood hop count; null when received direct. */
  hops: number | null;
  /** Flood path hash size; null when received direct. */
  hashSize: number | null;
}

// ===========================================================================
// Device → host frames
// ===========================================================================

export interface OkFrame { kind: 'ok'; code: 0x00 }
export interface ErrFrame { kind: 'err'; code: 0x01; errCode: number; errName: ErrName | 'UNKNOWN' }
export interface ContactsStartFrame { kind: 'contactsStart'; code: 0x02; total: number }
export interface ContactFrame { kind: 'contact'; code: 0x03; contact: Contact }
export interface EndOfContactsFrame { kind: 'endOfContacts'; code: 0x04; mostRecentLastMod: number }
export interface SelfInfoFrame { kind: 'selfInfo'; code: 0x05; info: SelfInfo }

/** RESP_CODE_SENT (0x06). §5.1 */
export interface SentFrame {
  kind: 'sent';
  code: 0x06;
  /** True if sent flood (byte [1] = 1). */
  flood: boolean;
  /** [2..5] as u32 LE: expected ACK (txt), pubkey prefix (login), or request tag. */
  tag: number;
  /** [2..5] raw bytes. */
  tagBytes: Uint8Array;
  estTimeoutMs: number;
  /** The command this answers, if the caller passed `ctx.expecting`. */
  for?: CommandKind;
}

/** CONTACT_MSG_RECV (0x07, v1) / CONTACT_MSG_RECV_V3 (0x10). §6.2 */
export interface ContactMsgFrame {
  kind: 'contactMsg';
  code: 0x07 | 0x10;
  version: 1 | 3;
  /** dB; only in V3 frames. (The firmware never reports RSSI for messages.) */
  snr?: number;
  senderPrefix: Uint8Array;
  route: MessageRoute;
  txtType: number;
  senderTimestamp: number;
  /** 4-byte author prefix; only for txt_type 2 (SIGNED_PLAIN, room-server posts). */
  authorPrefix?: Uint8Array;
  text: string;
}

/** CHANNEL_MSG_RECV (0x08, v1) / CHANNEL_MSG_RECV_V3 (0x11). §6.3 */
export interface ChannelMsgFrame {
  kind: 'channelMsg';
  code: 0x08 | 0x11;
  version: 1 | 3;
  snr?: number;
  channelIdx: number;
  route: MessageRoute;
  txtType: number;
  senderTimestamp: number;
  /** Full text, `"<sender>: <message>"`. */
  text: string;
  /** Split on the first `": "` (unauthenticated). Absent if no separator. */
  senderName?: string;
  message: string;
}

export interface CurrTimeFrame { kind: 'currTime'; code: 0x09; epochSecs: number }
export interface NoMoreMessagesFrame { kind: 'noMoreMessages'; code: 0x0a }
/** [1..] raw advert mesh packet. §5.4 */
export interface ExportContactFrame { kind: 'exportContact'; code: 0x0b; packet: Uint8Array }
export interface BattAndStorageFrame { kind: 'battAndStorage'; code: 0x0c; batt: BattAndStorage }
export interface DeviceInfoFrame { kind: 'deviceInfo'; code: 0x0d; info: DeviceInfo }
export interface PrivateKeyFrame { kind: 'privateKey'; code: 0x0e; privateKey: Uint8Array }
export interface DisabledFrame { kind: 'disabled'; code: 0x0f }
export interface ChannelInfoFrame { kind: 'channelInfo'; code: 0x12; channel: ChannelInfo }
export interface SignStartFrame { kind: 'signStart'; code: 0x13; maxLen: number }
export interface SignatureFrame { kind: 'signature'; code: 0x14; signature: Uint8Array }
export interface CustomVarsFrame { kind: 'customVars'; code: 0x15; raw: string; vars: CustomVar[] }
export interface AdvertPathFrame {
  kind: 'advertPath';
  code: 0x16;
  recvTimestamp: number;
  pathLen: number;
  pathInfo: PathLenInfo;
  path: Uint8Array;
}
export interface TuningParamsFrame {
  kind: 'tuningParams';
  code: 0x17;
  /** Wire value / 1000. */
  rxDelayBase: number;
  /** Wire value / 1000. */
  airtimeFactor: number;
}
export interface StatsFrame { kind: 'stats'; code: 0x18; stats: Stats }
export interface AutoAddConfigFrame { kind: 'autoAddConfig'; code: 0x19; config: number; maxHops: number }
export interface AllowedRepeatFreqFrame { kind: 'allowedRepeatFreq'; code: 0x1a; ranges: RepeatFreqRange[] }
/** CHANNEL_DATA_RECV (0x1B), always V3-style. §6.4 */
export interface ChannelDataFrame {
  kind: 'channelData';
  code: 0x1b;
  snr: number;
  channelIdx: number;
  route: MessageRoute;
  dataType: number;
  data: Uint8Array;
}
export interface DefaultFloodScopeFrame {
  kind: 'defaultFloodScope';
  code: 0x1c;
  /** null when no default scope is set (1-byte frame). */
  scope: { name: string; key: Uint8Array } | null;
}
export interface CliReplyFrame { kind: 'cliReply'; code: 0x1d; text: string }

// ---- pushes (§6) ----

export interface AdvertPush { kind: 'advert'; code: 0x80; pubKey: Uint8Array }
export interface PathUpdatedPush { kind: 'pathUpdated'; code: 0x81; pubKey: Uint8Array }
export interface SendConfirmedPush {
  kind: 'sendConfirmed';
  code: 0x82;
  /** Same value as SENT.tag. */
  ackCode: number;
  ackBytes: Uint8Array;
  roundTripMs: number;
}
export interface MsgWaitingPush { kind: 'msgWaiting'; code: 0x83 }
export interface RawDataPush { kind: 'rawData'; code: 0x84; snr: number; rssi: number; payload: Uint8Array }
/** LOGIN_SUCCESS (0x85). §6.6 */
export interface LoginSuccessPush {
  kind: 'loginSuccess';
  code: 0x85;
  /** Raw [1]: repeater 1/0; room 1 admin, 2 guest-with-perms-0, 0 other. */
  adminFlag: number;
  isAdmin: boolean;
  pubKeyPrefix: Uint8Array;
  /** True for the 8-byte legacy frame (no timestamp / ACL / level). */
  legacy: boolean;
  serverTimestamp?: number;
  /** v7+: bits 0-1 role (AclRole). */
  aclPermissions?: number;
  firmwareVerLevel?: number;
}
export interface LoginFailPush { kind: 'loginFail'; code: 0x86; pubKeyPrefix: Uint8Array }
/** STATUS_RESPONSE (0x87). §6.8 */
export interface StatusResponsePush {
  kind: 'statusResponse';
  code: 0x87;
  pubKeyPrefix: Uint8Array;
  /** Raw status struct bytes ([8..]). */
  raw: Uint8Array;
  /** Decoded by length (52 = room, 48/56 = repeater) or by ctx.statusFrom; null if unrecognised. */
  stats: NodeStats | null;
}
export interface LogRxDataPush { kind: 'logRxData'; code: 0x88; snr: number; rssi: number; packet: Uint8Array }
/** TRACE_DATA (0x89). §6.7 */
export interface TraceDataPush {
  kind: 'traceData';
  code: 0x89;
  /** [2] byte length of the path-hash list. */
  pathLen: number;
  flags: number;
  /** 1 << (flags & 3). */
  pathHashSize: number;
  tag: number;
  authCode: number;
  /** Raw hash list (pathLen bytes). */
  pathHashes: Uint8Array;
  /** Hash list split into hops. */
  hops: Uint8Array[];
  /** Per-hop SNR in dB (one per hop). */
  snrs: number[];
  /** SNR (dB) of the final hop into this node. */
  finalSnr: number;
}
export interface NewAdvertPush { kind: 'newAdvert'; code: 0x8a; contact: Contact }
/** TELEMETRY_RESPONSE (0x8B): raw CayenneLPP bytes (decoded in a later phase). §6.9 */
export interface TelemetryResponsePush { kind: 'telemetryResponse'; code: 0x8b; pubKeyPrefix: Uint8Array; lpp: Uint8Array }
/** BINARY_RESPONSE (0x8C). In the unmatched case [2..5] is the remote's tag too. §6 */
export interface BinaryResponsePush { kind: 'binaryResponse'; code: 0x8c; tag: number; data: Uint8Array }
/** PATH_DISCOVERY_RESPONSE (0x8D). §6 */
export interface PathDiscoveryResponsePush {
  kind: 'pathDiscoveryResponse';
  code: 0x8d;
  pubKeyPrefix: Uint8Array;
  outPathLen: number;
  outPathInfo: PathLenInfo;
  outPath: Uint8Array;
  inPathLen: number;
  inPathInfo: PathLenInfo;
  inPath: Uint8Array;
}
export interface ControlDataPush {
  kind: 'controlData';
  code: 0x8e;
  snr: number;
  rssi: number;
  pathLen: number;
  payload: Uint8Array;
}
export interface ContactDeletedPush { kind: 'contactDeleted'; code: 0x8f; pubKey: Uint8Array }
export interface ContactsFullPush { kind: 'contactsFull'; code: 0x90 }

/** A frame whose code this decoder does not know. */
export interface UnknownFrame { kind: 'unknown'; code: number; raw: Uint8Array }

export type ResponseFrame =
  | OkFrame
  | ErrFrame
  | ContactsStartFrame
  | ContactFrame
  | EndOfContactsFrame
  | SelfInfoFrame
  | SentFrame
  | ContactMsgFrame
  | ChannelMsgFrame
  | CurrTimeFrame
  | NoMoreMessagesFrame
  | ExportContactFrame
  | BattAndStorageFrame
  | DeviceInfoFrame
  | PrivateKeyFrame
  | DisabledFrame
  | ChannelInfoFrame
  | SignStartFrame
  | SignatureFrame
  | CustomVarsFrame
  | AdvertPathFrame
  | TuningParamsFrame
  | StatsFrame
  | AutoAddConfigFrame
  | AllowedRepeatFreqFrame
  | ChannelDataFrame
  | DefaultFloodScopeFrame
  | CliReplyFrame;

export type PushFrame =
  | AdvertPush
  | PathUpdatedPush
  | SendConfirmedPush
  | MsgWaitingPush
  | RawDataPush
  | LoginSuccessPush
  | LoginFailPush
  | StatusResponsePush
  | LogRxDataPush
  | TraceDataPush
  | NewAdvertPush
  | TelemetryResponsePush
  | BinaryResponsePush
  | PathDiscoveryResponsePush
  | ControlDataPush
  | ContactDeletedPush
  | ContactsFullPush;

export type DeviceFrame = ResponseFrame | PushFrame | UnknownFrame;
export type DeviceFrameKind = DeviceFrame['kind'];

// ===========================================================================
// Host → device commands (§4)
// ===========================================================================

export type Command =
  /** 0x01. `appVersion` → [1] (default 1), [2..7] zero, [8..] app name. §2.1 */
  | { kind: 'appStart'; appName?: string; appVersion?: number }
  /** 0x02. `recipient` = full pubkey or ≥6-byte prefix (first 6 used). txtType default PLAIN. */
  | {
      kind: 'sendTxtMsg';
      recipient: Uint8Array;
      text: string;
      timestamp: number;
      txtType?: number;
      attempt?: number;
    }
  /** 0x03. txt_type must be 0. */
  | { kind: 'sendChannelTxtMsg'; channelIdx: number; text: string; timestamp: number; txtType?: number }
  /** 0x04. `since` (lastmod filter) adds [1..4]. */
  | { kind: 'getContacts'; since?: number }
  | { kind: 'getDeviceTime' }
  | { kind: 'setDeviceTime'; epochSecs: number }
  /** 0x07. flood=true → [1]=1; false → [1]=0; undefined → no [1] (zero-hop). */
  | { kind: 'sendSelfAdvert'; flood?: boolean }
  /** 0x08. Name ≤ 31 bytes UTF-8. */
  | { kind: 'setAdvertName'; name: string }
  | { kind: 'addUpdateContact'; contact: ContactInput }
  | { kind: 'syncNextMessage' }
  /** 0x0B. [11] client-repeat is always sent (omitting it turns repeat OFF). */
  | { kind: 'setRadioParams'; freqKhz: number; bwHz: number; sf: number; cr: number; clientRepeat?: boolean }
  | { kind: 'setRadioTxPower'; dbm: number }
  | { kind: 'resetPath'; pubKey: Uint8Array }
  /** 0x0E. Degrees. `alt` (metres, ignored by firmware) adds [9..12]. */
  | { kind: 'setAdvertLatLon'; lat: number; lon: number; alt?: number }
  | { kind: 'removeContact'; pubKey: Uint8Array }
  | { kind: 'shareContact'; pubKey: Uint8Array }
  /** 0x11. No pubKey = export self. */
  | { kind: 'exportContact'; pubKey?: Uint8Array }
  /** 0x12. Raw advert packet (wire format), > 97 bytes. */
  | { kind: 'importContact'; packet: Uint8Array }
  | { kind: 'reboot' }
  | { kind: 'getBattAndStorage' }
  /** 0x15. Floats; sent × 1000 as u32. */
  | { kind: 'setTuningParams'; rxDelayBase: number; airtimeFactor: number }
  /** 0x16. Default APP_PROTOCOL_VERSION (3). */
  | { kind: 'deviceQuery'; appTargetVer?: number }
  | { kind: 'exportPrivateKey' }
  | { kind: 'importPrivateKey'; privateKey: Uint8Array }
  /** 0x19. Direct only: pathLen must be a valid encoded byte (not 0xFF); payload ≥ 4 bytes. */
  | { kind: 'sendRawData'; pathLen: number; path: Uint8Array; payload: Uint8Array }
  | { kind: 'sendLogin'; pubKey: Uint8Array; password: string }
  | { kind: 'sendStatusReq'; pubKey: Uint8Array }
  | { kind: 'hasConnection'; pubKey: Uint8Array }
  | { kind: 'logout'; pubKey: Uint8Array }
  | { kind: 'getContactByKey'; pubKey: Uint8Array }
  | { kind: 'getChannel'; index: number }
  /** 0x20. Name ≤ 31 bytes, secret exactly 16 bytes. */
  | { kind: 'setChannel'; index: number; name: string; secret: Uint8Array }
  | { kind: 'signStart' }
  | { kind: 'signData'; chunk: Uint8Array }
  | { kind: 'signFinish' }
  /** 0x24. `pathHashSize` 1/2/4/8 → flags bits 0-1 (default 1). path = concatenated hop hashes. */
  | { kind: 'sendTracePath'; tag: number; authCode: number; path: Uint8Array; pathHashSize?: number }
  | { kind: 'setDevicePin'; pin: number }
  /** 0x26. Always sent in full (5 bytes). */
  | {
      kind: 'setOtherParams';
      manualAddContacts: number;
      telemetryModes: TelemetryModes;
      advertLocPolicy: number;
      multiAcks: number;
    }
  /** 0x27. No pubKey = self telemetry (exactly 4 bytes). */
  | { kind: 'sendTelemetryReq'; pubKey?: Uint8Array }
  | { kind: 'getCustomVars' }
  | { kind: 'setCustomVar'; name: string; value: string }
  | { kind: 'getAdvertPath'; pubKey: Uint8Array }
  | { kind: 'getTuningParams' }
  /** 0x32. data[0] = REQ_TYPE. */
  | { kind: 'sendBinaryReq'; pubKey: Uint8Array; data: Uint8Array }
  | { kind: 'factoryReset' }
  | { kind: 'sendPathDiscoveryReq'; pubKey: Uint8Array }
  /** 0x36. key (16 B) → set override; neither → clear; unscoped → [1]=1. */
  | { kind: 'setFloodScopeKey'; key?: Uint8Array; unscoped?: boolean }
  /** 0x37. payload[0] & 0x80 must be set. */
  | { kind: 'sendControlData'; payload: Uint8Array }
  | { kind: 'getStats'; statsType: number }
  | { kind: 'sendAnonReq'; pubKey: Uint8Array; data: Uint8Array }
  | { kind: 'setAutoAddConfig'; config: number; maxHops?: number }
  | { kind: 'getAutoAddConfig' }
  | { kind: 'getAllowedRepeatFreq' }
  /** 0x3D. mode 0..2. */
  | { kind: 'setPathHashMode'; mode: number }
  /** 0x3E. pathLen undefined/0xFF = flood (no path bytes). */
  | {
      kind: 'sendChannelData';
      channelIdx: number;
      dataType: number;
      payload: Uint8Array;
      pathLen?: number;
      path?: Uint8Array;
    }
  /** 0x3F. No scope = clear (1-byte frame). */
  | { kind: 'setDefaultFloodScope'; scope?: { name: string; key: Uint8Array } }
  | { kind: 'getDefaultFloodScope' }
  /** 0x41. packet = full raw mesh packet. */
  | { kind: 'sendRawPacket'; priority: number; packet: Uint8Array }
  | { kind: 'runCliCommand'; command: string }
  /** Escape hatch: send these exact bytes (e.g. to probe ERR behaviour). */
  | { kind: 'raw'; bytes: Uint8Array };

export type CommandKind = Command['kind'];

/** Hints for decodeFrame. */
export interface DecodeContext {
  /** The command the frame is expected to answer; copied to SENT.for. */
  expecting?: CommandKind;
  /** Node type a STATUS_RESPONSE is from; overrides the length heuristic. */
  statusFrom?: 'repeater' | 'room';
}
