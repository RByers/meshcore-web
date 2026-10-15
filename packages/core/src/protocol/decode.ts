/**
 * Device → host frame decoder. Layouts: docs/companion-protocol.md §2-§7 and
 * docs/mesh-packet-format.md §3.2 (status structs).
 */

import { utf8Decode } from '../util/bytes.js';
import {
  CHANNEL_SECRET_SIZE,
  CONTACT_RECORD_SIZE,
  MAX_NAME_SIZE,
  MAX_PATH_SIZE,
  PATH_LEN_UNKNOWN,
  PRIVATE_KEY_SIZE,
  PUB_KEY_PREFIX_SIZE,
  PUB_KEY_SIZE,
  PUSH,
  REPEATER_STATS_LEGACY_SIZE,
  RESP,
  SELF_INFO_MIN_SIZE,
  SERVER_STATS_SIZE,
  SIGNATURE_SIZE,
  SIGNED_PLAIN_AUTHOR_PREFIX_SIZE,
  StatsType,
  TxtType,
  decodePathLen,
  errName,
  unpackTelemetryModes,
} from './constants.js';
import { ProtocolDecodeError } from './errors.js';
import type {
  BattAndStorage,
  CommonNodeStats,
  Contact,
  CustomVar,
  DecodeContext,
  DeviceFrame,
  DeviceInfo,
  MessageRoute,
  NodeStats,
  RepeaterStats,
  ServerStats,
  Stats,
} from './types.js';

/** Bounds-checked little-endian reader over one frame. */
class Reader {
  private readonly dv: DataView;
  constructor(
    readonly b: Uint8Array,
    private readonly what: string,
  ) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  get length(): number {
    return this.b.length;
  }

  /** Throws unless at least `n` bytes are present. */
  need(n: number, field = 'frame'): void {
    if (this.b.length < n) {
      throw new ProtocolDecodeError(
        `${this.what}: ${field} needs ${n} bytes, frame has ${this.b.length}`,
        this.b[0] ?? -1,
        n,
        this.b.length,
      );
    }
  }

  u8(o: number): number {
    this.need(o + 1);
    return this.dv.getUint8(o);
  }
  i8(o: number): number {
    this.need(o + 1);
    return this.dv.getInt8(o);
  }
  u16(o: number): number {
    this.need(o + 2);
    return this.dv.getUint16(o, true);
  }
  i16(o: number): number {
    this.need(o + 2);
    return this.dv.getInt16(o, true);
  }
  u32(o: number): number {
    this.need(o + 4);
    return this.dv.getUint32(o, true);
  }
  i32(o: number): number {
    this.need(o + 4);
    return this.dv.getInt32(o, true);
  }
  /** Copy of `n` bytes at `o`. */
  bytes(o: number, n: number, field = 'field'): Uint8Array {
    this.need(o + n, field);
    return this.b.slice(o, o + n);
  }
  /** Copy of everything from `o` to the end (empty if past the end). */
  rest(o: number): Uint8Array {
    return this.b.slice(Math.min(o, this.b.length));
  }
  /** Fixed-size char[n] field: stops at the first NUL, ignores bytes after it. */
  cstr(o: number, n: number, field = 'string'): string {
    this.need(o + n, field);
    return utf8Decode(this.b.subarray(o, o + n), true);
  }
  /** String running to the frame end (stops at a NUL if one is present). */
  restStr(o: number): string {
    return utf8Decode(this.b.subarray(Math.min(o, this.b.length)), true);
  }
}

const snr4 = (raw: number): number => raw / 4;
const micro = (raw: number): number => raw / 1e6;

function route(pathLen: number): MessageRoute {
  if (pathLen === PATH_LEN_UNKNOWN) {
    return { pathLen, receivedVia: 'direct', hops: null, hashSize: null };
  }
  const info = decodePathLen(pathLen);
  return { pathLen, receivedVia: 'flood', hops: info.hops, hashSize: info.hashSize };
}

/** Decodes a contact record (§7.1) whose code byte is at offset 0. */
export function decodeContactRecord(bytes: Uint8Array): Contact {
  const r = new Reader(bytes, 'contact');
  r.need(CONTACT_RECORD_SIZE, 'contact record');
  const outPathLen = r.u8(35);
  const outPathInfo = decodePathLen(outPathLen);
  const validLen = outPathInfo.valid ? outPathInfo.byteLength : 0;
  return {
    pubKey: r.bytes(1, PUB_KEY_SIZE),
    type: r.u8(33),
    flags: r.u8(34),
    outPathLen,
    outPathInfo,
    outPath: r.bytes(36, Math.min(validLen, MAX_PATH_SIZE)),
    name: r.cstr(100, MAX_NAME_SIZE, 'name'),
    lastAdvert: r.u32(132),
    lat: micro(r.i32(136)),
    lon: micro(r.i32(140)),
    lastMod: r.u32(144),
  };
}

function decodeCommonStats(r: Reader): CommonNodeStats {
  return {
    batteryMv: r.u16(0),
    txQueueLen: r.u16(2),
    noiseFloorDbm: r.i16(4),
    lastRssiDbm: r.i16(6),
    packetsRecv: r.u32(8),
    packetsSent: r.u32(12),
    airTimeSecs: r.u32(16),
    upTimeSecs: r.u32(20),
    sentFlood: r.u32(24),
    sentDirect: r.u32(28),
    recvFlood: r.u32(32),
    recvDirect: r.u32(36),
    errEvents: r.u16(40),
    lastSnr: snr4(r.i16(42)),
    directDups: r.u16(44),
    floodDups: r.u16(46),
  };
}

/** Decodes a repeater RepeaterStats struct (48 or 56 bytes). mesh-packet-format.md §3.2 */
export function decodeRepeaterStats(bytes: Uint8Array): RepeaterStats {
  const r = new Reader(bytes, 'RepeaterStats');
  r.need(REPEATER_STATS_LEGACY_SIZE);
  const s: RepeaterStats = { kind: 'repeater', ...decodeCommonStats(r) };
  if (bytes.length >= 56) {
    s.rxAirTimeSecs = r.u32(48);
    s.recvErrors = r.u32(52);
  }
  return s;
}

/** Decodes a room server ServerStats struct (52 bytes). mesh-packet-format.md §3.2 */
export function decodeServerStats(bytes: Uint8Array): ServerStats {
  const r = new Reader(bytes, 'ServerStats');
  r.need(SERVER_STATS_SIZE);
  return { kind: 'room', ...decodeCommonStats(r), posted: r.u16(48), postPush: r.u16(50) };
}

/** Status struct by explicit type, else by length (52 → room, 48/56 → repeater). */
export function decodeNodeStats(bytes: Uint8Array, from?: 'repeater' | 'room'): NodeStats | null {
  const kind = from ?? (bytes.length === SERVER_STATS_SIZE ? 'room' : bytes.length === 48 || bytes.length === 56 ? 'repeater' : undefined);
  if (kind === 'room' && bytes.length >= SERVER_STATS_SIZE) return decodeServerStats(bytes);
  if (kind === 'repeater' && bytes.length >= REPEATER_STATS_LEGACY_SIZE) return decodeRepeaterStats(bytes);
  return null;
}

function parseCustomVars(raw: string): CustomVar[] {
  if (raw.length === 0) return [];
  return raw.split(',').map((item) => {
    const i = item.indexOf(':');
    return i < 0 ? { name: item, value: '' } : { name: item.slice(0, i), value: item.slice(i + 1) };
  });
}

function decodeStats(r: Reader): Stats {
  const t = r.u8(1);
  switch (t) {
    case StatsType.CORE:
      r.need(11, 'STATS core');
      return { type: 'core', batteryMv: r.u16(2), uptimeSecs: r.u32(4), errFlags: r.u16(8), outboundQueueLen: r.u8(10) };
    case StatsType.RADIO:
      r.need(14, 'STATS radio');
      return {
        type: 'radio',
        noiseFloorDbm: r.i16(2),
        lastRssiDbm: r.i8(4),
        lastSnr: snr4(r.i8(5)),
        txAirSecs: r.u32(6),
        rxAirSecs: r.u32(10),
      };
    case StatsType.PACKETS: {
      r.need(26, 'STATS packets');
      const s: Stats = {
        type: 'packets',
        recv: r.u32(2),
        sent: r.u32(6),
        sentFlood: r.u32(10),
        sentDirect: r.u32(14),
        recvFlood: r.u32(18),
        recvDirect: r.u32(22),
      };
      if (r.length >= 30) s.recvErrors = r.u32(26);
      return s;
    }
    default:
      return { type: 'unknown', statsType: t, raw: r.rest(2) };
  }
}

function decodeDeviceInfo(r: Reader): DeviceInfo {
  r.need(2, 'DEVICE_INFO');
  const info: DeviceInfo = { firmwareVerCode: r.u8(1) };
  const n = r.length;
  if (n >= 4) {
    info.maxContacts = r.u8(2) * 2;
    info.maxChannels = r.u8(3);
  }
  if (n >= 8) info.blePin = r.u32(4);
  if (n >= 20) info.buildDate = r.cstr(8, 12);
  if (n >= 60) info.manufacturer = r.cstr(20, 40);
  if (n >= 80) info.firmwareVersion = r.cstr(60, 20);
  if (n >= 81) info.clientRepeat = r.u8(80) !== 0;
  if (n >= 82) info.pathHashMode = r.u8(81);
  return info;
}

function decodeBatt(r: Reader): BattAndStorage {
  r.need(3, 'BATT_AND_STORAGE');
  const b: BattAndStorage = { batteryMv: r.u16(1) };
  if (r.length >= 11) {
    b.storageUsedKb = r.u32(3);
    b.storageTotalKb = r.u32(7);
  }
  return b;
}

/**
 * Decodes one device → host frame (response or push) by its first byte.
 * Trailing bytes beyond a fixed layout are ignored. Unknown codes yield `{kind: 'unknown'}`.
 * @throws ProtocolDecodeError if the frame is empty or shorter than its layout requires.
 */
export function decodeFrame(bytes: Uint8Array, ctx: DecodeContext = {}): DeviceFrame {
  if (bytes.length === 0) throw new ProtocolDecodeError('empty frame', -1, 1, 0);
  const code = bytes[0]!;
  const r = new Reader(bytes, `frame 0x${code.toString(16).padStart(2, '0')}`);

  switch (code) {
    // ---- responses (§3, §5) ----
    case RESP.OK:
      return { kind: 'ok', code };
    case RESP.ERR: {
      const errCode = r.u8(1);
      return { kind: 'err', code, errCode, errName: errName(errCode) };
    }
    case RESP.CONTACTS_START:
      return { kind: 'contactsStart', code, total: r.u32(1) };
    case RESP.CONTACT:
      return { kind: 'contact', code, contact: decodeContactRecord(bytes) };
    case RESP.END_OF_CONTACTS:
      return { kind: 'endOfContacts', code, mostRecentLastMod: r.u32(1) };
    case RESP.SELF_INFO: {
      r.need(SELF_INFO_MIN_SIZE, 'SELF_INFO');
      const tm = r.u8(46);
      return {
        kind: 'selfInfo',
        code,
        info: {
          advType: r.u8(1),
          txPowerDbm: r.i8(2),
          maxTxPowerDbm: r.i8(3),
          pubKey: r.bytes(4, PUB_KEY_SIZE),
          lat: micro(r.i32(36)),
          lon: micro(r.i32(40)),
          multiAcks: r.u8(44),
          advertLocPolicy: r.u8(45),
          telemetryModesRaw: tm,
          telemetryModes: unpackTelemetryModes(tm),
          manualAddContacts: r.u8(47),
          radioFreqKhz: r.u32(48),
          radioBwHz: r.u32(52),
          radioSf: r.u8(56),
          radioCr: r.u8(57),
          // §2.2: name runs to the end of the frame, no NUL
          name: r.restStr(58),
        },
      };
    }
    case RESP.SENT: {
      r.need(10, 'SENT');
      const f: DeviceFrame = {
        kind: 'sent',
        code,
        flood: r.u8(1) === 1,
        tag: r.u32(2),
        tagBytes: r.bytes(2, 4),
        estTimeoutMs: r.u32(6),
      };
      if (ctx.expecting !== undefined) f.for = ctx.expecting;
      return f;
    }
    case RESP.CONTACT_MSG_RECV:
    case RESP.CONTACT_MSG_RECV_V3: {
      const v3 = code === RESP.CONTACT_MSG_RECV_V3;
      const o = v3 ? 3 : 0;
      r.need(13 + o, 'CONTACT_MSG');
      const txtType = r.u8(8 + o);
      let textOff = 13 + o;
      let authorPrefix: Uint8Array | undefined;
      if (txtType === TxtType.SIGNED_PLAIN) {
        authorPrefix = r.bytes(textOff, SIGNED_PLAIN_AUTHOR_PREFIX_SIZE, 'author prefix');
        textOff += SIGNED_PLAIN_AUTHOR_PREFIX_SIZE;
      }
      return {
        kind: 'contactMsg',
        code,
        version: v3 ? 3 : 1,
        ...(v3 ? { snr: snr4(r.i8(1)) } : {}),
        senderPrefix: r.bytes(1 + o, PUB_KEY_PREFIX_SIZE),
        route: route(r.u8(7 + o)),
        txtType,
        senderTimestamp: r.u32(9 + o),
        ...(authorPrefix ? { authorPrefix } : {}),
        text: r.restStr(textOff),
      };
    }
    case RESP.CHANNEL_MSG_RECV:
    case RESP.CHANNEL_MSG_RECV_V3: {
      const v3 = code === RESP.CHANNEL_MSG_RECV_V3;
      const o = v3 ? 3 : 0;
      r.need(8 + o, 'CHANNEL_MSG');
      const text = r.restStr(8 + o);
      const sep = text.indexOf(': ');
      return {
        kind: 'channelMsg',
        code,
        version: v3 ? 3 : 1,
        ...(v3 ? { snr: snr4(r.i8(1)) } : {}),
        channelIdx: r.u8(1 + o),
        route: route(r.u8(2 + o)),
        txtType: r.u8(3 + o),
        senderTimestamp: r.u32(4 + o),
        text,
        ...(sep >= 0 ? { senderName: text.slice(0, sep) } : {}),
        message: sep >= 0 ? text.slice(sep + 2) : text,
      };
    }
    case RESP.CURR_TIME:
      return { kind: 'currTime', code, epochSecs: r.u32(1) };
    case RESP.NO_MORE_MESSAGES:
      return { kind: 'noMoreMessages', code };
    case RESP.EXPORT_CONTACT:
      r.need(2, 'EXPORT_CONTACT');
      return { kind: 'exportContact', code, packet: r.rest(1) };
    case RESP.BATT_AND_STORAGE:
      return { kind: 'battAndStorage', code, batt: decodeBatt(r) };
    case RESP.DEVICE_INFO:
      return { kind: 'deviceInfo', code, info: decodeDeviceInfo(r) };
    case RESP.PRIVATE_KEY:
      return { kind: 'privateKey', code, privateKey: r.bytes(1, PRIVATE_KEY_SIZE, 'private key') };
    case RESP.DISABLED:
      return { kind: 'disabled', code };
    case RESP.CHANNEL_INFO:
      r.need(50, 'CHANNEL_INFO');
      return {
        kind: 'channelInfo',
        code,
        // §5.5: bytes after the name's NUL are stale buffer contents
        channel: { index: r.u8(1), name: r.cstr(2, MAX_NAME_SIZE), secret: r.bytes(34, CHANNEL_SECRET_SIZE) },
      };
    case RESP.SIGN_START:
      return { kind: 'signStart', code, maxLen: r.u32(2) };
    case RESP.SIGNATURE:
      return { kind: 'signature', code, signature: r.bytes(1, SIGNATURE_SIZE, 'signature') };
    case RESP.CUSTOM_VARS: {
      const raw = r.restStr(1);
      return { kind: 'customVars', code, raw, vars: parseCustomVars(raw) };
    }
    case RESP.ADVERT_PATH: {
      const pathLen = r.u8(5);
      const pathInfo = decodePathLen(pathLen);
      return {
        kind: 'advertPath',
        code,
        recvTimestamp: r.u32(1),
        pathLen,
        pathInfo,
        path: r.bytes(6, pathInfo.byteLength, 'path'),
      };
    }
    case RESP.TUNING_PARAMS:
      r.need(9, 'TUNING_PARAMS');
      return { kind: 'tuningParams', code, rxDelayBase: r.u32(1) / 1000, airtimeFactor: r.u32(5) / 1000 };
    case RESP.STATS:
      return { kind: 'stats', code, stats: decodeStats(r) };
    case RESP.AUTOADD_CONFIG:
      r.need(3, 'AUTOADD_CONFIG');
      return { kind: 'autoAddConfig', code, config: r.u8(1), maxHops: r.u8(2) };
    case RESP.ALLOWED_REPEAT_FREQ: {
      const ranges = [];
      for (let o = 1; o + 8 <= bytes.length; o += 8) ranges.push({ lowerKhz: r.u32(o), upperKhz: r.u32(o + 4) });
      return { kind: 'allowedRepeatFreq', code, ranges };
    }
    case RESP.CHANNEL_DATA_RECV: {
      r.need(9, 'CHANNEL_DATA_RECV');
      const dataLen = r.u8(8);
      return {
        kind: 'channelData',
        code,
        snr: snr4(r.i8(1)),
        channelIdx: r.u8(4),
        route: route(r.u8(5)),
        dataType: r.u16(6),
        data: r.bytes(9, dataLen, 'data'),
      };
    }
    case RESP.DEFAULT_FLOOD_SCOPE:
      if (bytes.length === 1) return { kind: 'defaultFloodScope', code, scope: null };
      r.need(48, 'DEFAULT_FLOOD_SCOPE');
      return { kind: 'defaultFloodScope', code, scope: { name: r.cstr(1, 31), key: r.bytes(32, 16) } };
    case RESP.CLI_REPLY:
      return { kind: 'cliReply', code, text: r.restStr(1) };

    // ---- pushes (§6) ----
    case PUSH.ADVERT:
      return { kind: 'advert', code, pubKey: r.bytes(1, PUB_KEY_SIZE, 'pubkey') };
    case PUSH.PATH_UPDATED:
      return { kind: 'pathUpdated', code, pubKey: r.bytes(1, PUB_KEY_SIZE, 'pubkey') };
    case PUSH.SEND_CONFIRMED:
      r.need(9, 'SEND_CONFIRMED');
      return { kind: 'sendConfirmed', code, ackCode: r.u32(1), ackBytes: r.bytes(1, 4), roundTripMs: r.u32(5) };
    case PUSH.MSG_WAITING:
      return { kind: 'msgWaiting', code };
    case PUSH.RAW_DATA:
      r.need(4, 'RAW_DATA');
      return { kind: 'rawData', code, snr: snr4(r.i8(1)), rssi: r.i8(2), payload: r.rest(4) };
    case PUSH.LOGIN_SUCCESS: {
      r.need(8, 'LOGIN_SUCCESS');
      const adminFlag = r.u8(1);
      const base = { kind: 'loginSuccess' as const, code, adminFlag, isAdmin: adminFlag === 1, pubKeyPrefix: r.bytes(2, 6) };
      if (bytes.length < 14) return { ...base, legacy: true };
      return { ...base, legacy: false, serverTimestamp: r.u32(8), aclPermissions: r.u8(12), firmwareVerLevel: r.u8(13) };
    }
    case PUSH.LOGIN_FAIL:
      return { kind: 'loginFail', code, pubKeyPrefix: r.bytes(2, 6, 'prefix') };
    case PUSH.STATUS_RESPONSE: {
      r.need(8, 'STATUS_RESPONSE');
      const raw = r.rest(8);
      return { kind: 'statusResponse', code, pubKeyPrefix: r.bytes(2, 6), raw, stats: decodeNodeStats(raw, ctx.statusFrom) };
    }
    case PUSH.LOG_RX_DATA:
      r.need(3, 'LOG_RX_DATA');
      return { kind: 'logRxData', code, snr: snr4(r.i8(1)), rssi: r.i8(2), packet: r.rest(3) };
    case PUSH.TRACE_DATA: {
      r.need(12, 'TRACE_DATA');
      const pathLen = r.u8(2);
      const flags = r.u8(3);
      const pathSz = flags & 3;
      const pathHashSize = 1 << pathSz;
      const nHops = pathLen >> pathSz;
      r.need(12 + pathLen + nHops + 1, 'TRACE_DATA path/SNRs');
      const pathHashes = r.bytes(12, pathLen);
      const hops: Uint8Array[] = [];
      for (let i = 0; i < nHops; i++) hops.push(pathHashes.slice(i * pathHashSize, (i + 1) * pathHashSize));
      const snrs: number[] = [];
      for (let i = 0; i < nHops; i++) snrs.push(snr4(r.i8(12 + pathLen + i)));
      return {
        kind: 'traceData',
        code,
        pathLen,
        flags,
        pathHashSize,
        tag: r.u32(4),
        authCode: r.u32(8),
        pathHashes,
        hops,
        snrs,
        finalSnr: snr4(r.i8(12 + pathLen + nHops)),
      };
    }
    case PUSH.NEW_ADVERT:
      return { kind: 'newAdvert', code, contact: decodeContactRecord(bytes) };
    case PUSH.TELEMETRY_RESPONSE:
      r.need(8, 'TELEMETRY_RESPONSE');
      return { kind: 'telemetryResponse', code, pubKeyPrefix: r.bytes(2, 6), lpp: r.rest(8) };
    case PUSH.BINARY_RESPONSE:
      r.need(6, 'BINARY_RESPONSE');
      return { kind: 'binaryResponse', code, tag: r.u32(2), data: r.rest(6) };
    case PUSH.PATH_DISCOVERY_RESPONSE: {
      const outPathLen = r.u8(8);
      const outPathInfo = decodePathLen(outPathLen);
      const outPath = r.bytes(9, outPathInfo.byteLength, 'out path');
      const inOff = 9 + outPathInfo.byteLength;
      const inPathLen = r.u8(inOff);
      const inPathInfo = decodePathLen(inPathLen);
      return {
        kind: 'pathDiscoveryResponse',
        code,
        pubKeyPrefix: r.bytes(2, 6),
        outPathLen,
        outPathInfo,
        outPath,
        inPathLen,
        inPathInfo,
        inPath: r.bytes(inOff + 1, inPathInfo.byteLength, 'in path'),
      };
    }
    case PUSH.CONTROL_DATA:
      r.need(4, 'CONTROL_DATA');
      return { kind: 'controlData', code, snr: snr4(r.i8(1)), rssi: r.i8(2), pathLen: r.u8(3), payload: r.rest(4) };
    case PUSH.CONTACT_DELETED:
      return { kind: 'contactDeleted', code, pubKey: r.bytes(1, PUB_KEY_SIZE, 'pubkey') };
    case PUSH.CONTACTS_FULL:
      return { kind: 'contactsFull', code };
    default:
      return { kind: 'unknown', code, raw: bytes.slice() };
  }
}
