/**
 * Host → device command encoders. Byte layouts: docs/companion-protocol.md §2, §4, §7.1.
 */

import { utf8Encode, writeU16LE, writeU32LE } from '../util/bytes.js';
import {
  APP_PROTOCOL_VERSION,
  CHANNEL_SECRET_SIZE,
  CMD,
  CONTROL_DATA_FLAG,
  DEFAULT_APP_NAME,
  DEFAULT_APP_VERSION,
  DEFAULT_SCOPE_NAME_SIZE,
  FACTORY_RESET_MAGIC,
  MAX_FRAME_SIZE,
  MAX_NAME_LEN,
  MAX_NAME_SIZE,
  MAX_PATH_SIZE,
  PATH_LEN_UNKNOWN,
  PRIVATE_KEY_SIZE,
  PUB_KEY_PREFIX_SIZE,
  PUB_KEY_SIZE,
  REBOOT_MAGIC,
  TRANSPORT_KEY_SIZE,
  TxtType,
  decodePathLen,
  isValidPathLen,
  packTelemetryModes,
} from './constants.js';
import { ProtocolEncodeError } from './errors.js';
import type { Command, ContactInput } from './types.js';

/** Growable little-endian byte writer. */
class Writer {
  private buf = new Uint8Array(64);
  private len = 0;

  constructor(private readonly cmd: string) {}

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): this {
    this.int(v, 0, 0xff, 'u8');
    this.ensure(1);
    this.buf[this.len++] = v;
    return this;
  }

  i8(v: number): this {
    this.int(v, -128, 127, 'i8');
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.int(v, 0, 0xffff, 'u16');
    this.ensure(2);
    writeU16LE(this.buf, this.len, v);
    this.len += 2;
    return this;
  }

  u32(v: number): this {
    this.int(v, 0, 0xffffffff, 'u32');
    this.ensure(4);
    writeU32LE(this.buf, this.len, v);
    this.len += 4;
    return this;
  }

  i32(v: number): this {
    this.int(v, -0x80000000, 0x7fffffff, 'i32');
    this.ensure(4);
    writeU32LE(this.buf, this.len, v >>> 0);
    this.len += 4;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  zeros(n: number): this {
    this.ensure(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this;
  }

  /** Writes `b` into a fixed-size field, zero padding the rest. */
  fixed(b: Uint8Array, size: number, field: string): this {
    if (b.length > size) this.fail(`${field} is ${b.length} bytes, max ${size}`);
    this.bytes(b);
    return this.zeros(size - b.length);
  }

  finish(): Uint8Array {
    if (this.len > MAX_FRAME_SIZE) {
      this.fail(`frame is ${this.len} bytes, max ${MAX_FRAME_SIZE}`);
    }
    return this.buf.slice(0, this.len);
  }

  fail(msg: string): never {
    throw new ProtocolEncodeError(`${this.cmd}: ${msg}`, this.cmd);
  }

  private int(v: number, min: number, max: number, t: string): void {
    if (!Number.isInteger(v) || v < min || v > max) {
      this.fail(`value ${v} out of range for ${t}`);
    }
  }
}

function needLen(w: Writer, b: Uint8Array, len: number, field: string): Uint8Array {
  if (b.length !== len) w.fail(`${field} must be ${len} bytes (got ${b.length})`);
  return b;
}

function pubKey(w: Writer, b: Uint8Array): Uint8Array {
  return needLen(w, b, PUB_KEY_SIZE, 'pubKey');
}

/** UTF-8 name that must fit a NUL-terminated char[32] (≤ 31 bytes). */
function nameBytes(w: Writer, name: string, field = 'name'): Uint8Array {
  const b = utf8Encode(name);
  if (b.length > MAX_NAME_LEN) w.fail(`${field} is ${b.length} bytes UTF-8, max ${MAX_NAME_LEN}`);
  if (b.includes(0)) w.fail(`${field} contains NUL`);
  return b;
}

function degToMicro(deg: number): number {
  return Math.round(deg * 1e6);
}

/** Path bytes for an encoded path_len; checks the length matches. */
function pathFor(w: Writer, pathLen: number, path: Uint8Array | undefined): Uint8Array {
  const info = decodePathLen(pathLen);
  const p = path ?? new Uint8Array(0);
  if (p.length !== info.byteLength) {
    w.fail(`path is ${p.length} bytes but path_len 0x${pathLen.toString(16)} implies ${info.byteLength}`);
  }
  return p;
}

/**
 * Encodes the contact record body (§7.1) after a code byte. Always writes offsets 1..135;
 * lat/lon (136..143) are written if lat/lon or lastMod are given, lastMod (144..147) if given.
 */
export function encodeContactRecord(code: number, c: ContactInput): Uint8Array {
  const w = new Writer('contactRecord');
  writeContactRecord(w, code, c);
  return w.finish();
}

function writeContactRecord(w: Writer, code: number, c: ContactInput): void {
  w.u8(code).bytes(pubKey(w, c.pubKey)).u8(c.type).u8(c.flags).u8(c.outPathLen);
  w.fixed(c.outPath ?? new Uint8Array(0), MAX_PATH_SIZE, 'outPath');
  w.fixed(nameBytes(w, c.name), MAX_NAME_SIZE, 'name');
  w.u32(c.lastAdvert);
  const hasLoc = c.lat !== undefined || c.lon !== undefined;
  if (hasLoc || c.lastMod !== undefined) {
    w.i32(degToMicro(c.lat ?? 0)).i32(degToMicro(c.lon ?? 0));
    if (c.lastMod !== undefined) w.u32(c.lastMod);
  }
}

/** Encodes one command into the exact frame bytes the firmware expects (no transport header). */
export function encodeCommand(cmd: Command): Uint8Array {
  const w = new Writer(cmd.kind);
  switch (cmd.kind) {
    case 'appStart': {
      // §2.1: [1] app version, [2..7] reserved, [8..] app name
      w.u8(CMD.APP_START).u8(cmd.appVersion ?? DEFAULT_APP_VERSION).zeros(6);
      w.bytes(utf8Encode(cmd.appName ?? DEFAULT_APP_NAME));
      break;
    }
    case 'sendTxtMsg': {
      if (cmd.recipient.length < PUB_KEY_PREFIX_SIZE) w.fail('recipient must be at least 6 bytes');
      w.u8(CMD.SEND_TXT_MSG).u8(cmd.txtType ?? TxtType.PLAIN).u8(cmd.attempt ?? 0).u32(cmd.timestamp);
      w.bytes(cmd.recipient.subarray(0, PUB_KEY_PREFIX_SIZE)).bytes(utf8Encode(cmd.text));
      break;
    }
    case 'sendChannelTxtMsg':
      w.u8(CMD.SEND_CHANNEL_TXT_MSG).u8(cmd.txtType ?? TxtType.PLAIN).u8(cmd.channelIdx).u32(cmd.timestamp);
      w.bytes(utf8Encode(cmd.text));
      break;
    case 'getContacts':
      w.u8(CMD.GET_CONTACTS);
      if (cmd.since !== undefined) w.u32(cmd.since);
      break;
    case 'getDeviceTime':
      w.u8(CMD.GET_DEVICE_TIME);
      break;
    case 'setDeviceTime':
      w.u8(CMD.SET_DEVICE_TIME).u32(cmd.epochSecs);
      break;
    case 'sendSelfAdvert':
      w.u8(CMD.SEND_SELF_ADVERT);
      if (cmd.flood !== undefined) w.u8(cmd.flood ? 1 : 0);
      break;
    case 'setAdvertName': {
      const b = nameBytes(w, cmd.name);
      if (b.length === 0) w.fail('name must not be empty');
      w.u8(CMD.SET_ADVERT_NAME).bytes(b);
      break;
    }
    case 'addUpdateContact':
      writeContactRecord(w, CMD.ADD_UPDATE_CONTACT, cmd.contact);
      break;
    case 'syncNextMessage':
      w.u8(CMD.SYNC_NEXT_MESSAGE);
      break;
    case 'setRadioParams':
      w.u8(CMD.SET_RADIO_PARAMS).u32(cmd.freqKhz).u32(cmd.bwHz).u8(cmd.sf).u8(cmd.cr);
      w.u8(cmd.clientRepeat ? 1 : 0);
      break;
    case 'setRadioTxPower':
      w.u8(CMD.SET_RADIO_TX_POWER).i8(cmd.dbm);
      break;
    case 'resetPath':
      w.u8(CMD.RESET_PATH).bytes(pubKey(w, cmd.pubKey));
      break;
    case 'setAdvertLatLon':
      w.u8(CMD.SET_ADVERT_LATLON).i32(degToMicro(cmd.lat)).i32(degToMicro(cmd.lon));
      if (cmd.alt !== undefined) w.i32(Math.round(cmd.alt));
      break;
    case 'removeContact':
      w.u8(CMD.REMOVE_CONTACT).bytes(pubKey(w, cmd.pubKey));
      break;
    case 'shareContact':
      w.u8(CMD.SHARE_CONTACT).bytes(pubKey(w, cmd.pubKey));
      break;
    case 'exportContact':
      w.u8(CMD.EXPORT_CONTACT);
      if (cmd.pubKey !== undefined) w.bytes(pubKey(w, cmd.pubKey));
      break;
    case 'importContact':
      // firmware guard: len > 2 + 32 + 64
      if (cmd.packet.length + 1 <= 2 + PUB_KEY_SIZE + 64) w.fail('advert packet too short');
      w.u8(CMD.IMPORT_CONTACT).bytes(cmd.packet);
      break;
    case 'reboot':
      w.u8(CMD.REBOOT).bytes(utf8Encode(REBOOT_MAGIC));
      break;
    case 'getBattAndStorage':
      w.u8(CMD.GET_BATT_AND_STORAGE);
      break;
    case 'setTuningParams':
      w.u8(CMD.SET_TUNING_PARAMS).u32(Math.round(cmd.rxDelayBase * 1000)).u32(Math.round(cmd.airtimeFactor * 1000));
      break;
    case 'deviceQuery':
      w.u8(CMD.DEVICE_QUERY).u8(cmd.appTargetVer ?? APP_PROTOCOL_VERSION);
      break;
    case 'exportPrivateKey':
      w.u8(CMD.EXPORT_PRIVATE_KEY);
      break;
    case 'importPrivateKey':
      w.u8(CMD.IMPORT_PRIVATE_KEY).bytes(needLen(w, cmd.privateKey, PRIVATE_KEY_SIZE, 'privateKey'));
      break;
    case 'sendRawData': {
      if (cmd.pathLen === PATH_LEN_UNKNOWN || !isValidPathLen(cmd.pathLen)) {
        w.fail(`invalid path_len 0x${cmd.pathLen.toString(16)} (flood is not supported)`);
      }
      if (cmd.payload.length < 4) w.fail('payload must be at least 4 bytes');
      w.u8(CMD.SEND_RAW_DATA).u8(cmd.pathLen).bytes(pathFor(w, cmd.pathLen, cmd.path)).bytes(cmd.payload);
      break;
    }
    case 'sendLogin':
      w.u8(CMD.SEND_LOGIN).bytes(pubKey(w, cmd.pubKey)).bytes(utf8Encode(cmd.password));
      break;
    case 'sendStatusReq':
      w.u8(CMD.SEND_STATUS_REQ).bytes(pubKey(w, cmd.pubKey));
      break;
    case 'hasConnection':
      w.u8(CMD.HAS_CONNECTION).bytes(pubKey(w, cmd.pubKey));
      break;
    case 'logout':
      w.u8(CMD.LOGOUT).bytes(pubKey(w, cmd.pubKey));
      break;
    case 'getContactByKey':
      w.u8(CMD.GET_CONTACT_BY_KEY).bytes(pubKey(w, cmd.pubKey));
      break;
    case 'getChannel':
      w.u8(CMD.GET_CHANNEL).u8(cmd.index);
      break;
    case 'setChannel':
      w.u8(CMD.SET_CHANNEL).u8(cmd.index).fixed(nameBytes(w, cmd.name), MAX_NAME_SIZE, 'name');
      w.bytes(needLen(w, cmd.secret, CHANNEL_SECRET_SIZE, 'secret'));
      break;
    case 'signStart':
      w.u8(CMD.SIGN_START);
      break;
    case 'signData':
      if (cmd.chunk.length === 0) w.fail('chunk must not be empty');
      w.u8(CMD.SIGN_DATA).bytes(cmd.chunk);
      break;
    case 'signFinish':
      w.u8(CMD.SIGN_FINISH);
      break;
    case 'sendTracePath': {
      const size = cmd.pathHashSize ?? 1;
      const pathSz = [1, 2, 4, 8].indexOf(size);
      if (pathSz < 0) w.fail(`pathHashSize must be 1, 2, 4 or 8 (got ${size})`);
      const n = cmd.path.length;
      if (n === 0) w.fail('path must not be empty');
      if (n % size !== 0) w.fail(`path length ${n} is not a multiple of ${size}`);
      if (n / size > MAX_PATH_SIZE) w.fail(`path has ${n / size} hops, max ${MAX_PATH_SIZE}`);
      // firmware guard: len - 10 < MAX_PACKET_PAYLOAD - 5 (179)
      if (n >= 179) w.fail(`path is ${n} bytes, max 178`);
      w.u8(CMD.SEND_TRACE_PATH).u32(cmd.tag).u32(cmd.authCode).u8(pathSz).bytes(cmd.path);
      break;
    }
    case 'setDevicePin':
      w.u8(CMD.SET_DEVICE_PIN).u32(cmd.pin);
      break;
    case 'setOtherParams':
      w.u8(CMD.SET_OTHER_PARAMS).u8(cmd.manualAddContacts).u8(packTelemetryModes(cmd.telemetryModes));
      w.u8(cmd.advertLocPolicy).u8(cmd.multiAcks);
      break;
    case 'sendTelemetryReq':
      w.u8(CMD.SEND_TELEMETRY_REQ).zeros(3);
      if (cmd.pubKey !== undefined) w.bytes(pubKey(w, cmd.pubKey));
      break;
    case 'getCustomVars':
      w.u8(CMD.GET_CUSTOM_VARS);
      break;
    case 'setCustomVar': {
      if (cmd.name.length === 0 || cmd.name.includes(':')) w.fail('name must be non-empty and contain no ":"');
      w.u8(CMD.SET_CUSTOM_VAR).bytes(utf8Encode(`${cmd.name}:${cmd.value}`));
      break;
    }
    case 'getAdvertPath':
      w.u8(CMD.GET_ADVERT_PATH).u8(0).bytes(pubKey(w, cmd.pubKey));
      break;
    case 'getTuningParams':
      w.u8(CMD.GET_TUNING_PARAMS);
      break;
    case 'sendBinaryReq':
      if (cmd.data.length === 0) w.fail('data must not be empty');
      w.u8(CMD.SEND_BINARY_REQ).bytes(pubKey(w, cmd.pubKey)).bytes(cmd.data);
      break;
    case 'factoryReset':
      w.u8(CMD.FACTORY_RESET).bytes(utf8Encode(FACTORY_RESET_MAGIC));
      break;
    case 'sendPathDiscoveryReq':
      w.u8(CMD.SEND_PATH_DISCOVERY_REQ).u8(0).bytes(pubKey(w, cmd.pubKey));
      break;
    case 'setFloodScopeKey':
      w.u8(CMD.SET_FLOOD_SCOPE_KEY);
      if (cmd.unscoped) {
        if (cmd.key !== undefined) w.fail('key and unscoped are mutually exclusive');
        w.u8(1);
      } else {
        w.u8(0);
        if (cmd.key !== undefined) w.bytes(needLen(w, cmd.key, TRANSPORT_KEY_SIZE, 'key'));
      }
      break;
    case 'sendControlData': {
      const first = cmd.payload[0];
      if (first === undefined || (first & CONTROL_DATA_FLAG) === 0) w.fail('payload[0] & 0x80 must be set');
      w.u8(CMD.SEND_CONTROL_DATA).bytes(cmd.payload);
      break;
    }
    case 'getStats':
      w.u8(CMD.GET_STATS).u8(cmd.statsType);
      break;
    case 'sendAnonReq':
      if (cmd.data.length === 0) w.fail('data must not be empty');
      w.u8(CMD.SEND_ANON_REQ).bytes(pubKey(w, cmd.pubKey)).bytes(cmd.data);
      break;
    case 'setAutoAddConfig':
      w.u8(CMD.SET_AUTOADD_CONFIG).u8(cmd.config);
      if (cmd.maxHops !== undefined) w.u8(cmd.maxHops);
      break;
    case 'getAutoAddConfig':
      w.u8(CMD.GET_AUTOADD_CONFIG);
      break;
    case 'getAllowedRepeatFreq':
      w.u8(CMD.GET_ALLOWED_REPEAT_FREQ);
      break;
    case 'setPathHashMode':
      if (cmd.mode < 0 || cmd.mode > 2) w.fail(`mode must be 0..2 (got ${cmd.mode})`);
      w.u8(CMD.SET_PATH_HASH_MODE).u8(0).u8(cmd.mode);
      break;
    case 'sendChannelData': {
      const pathLen = cmd.pathLen ?? PATH_LEN_UNKNOWN;
      w.u8(CMD.SEND_CHANNEL_DATA).u8(cmd.channelIdx).u8(pathLen);
      if (pathLen === PATH_LEN_UNKNOWN) {
        if (cmd.path !== undefined && cmd.path.length > 0) w.fail('path given with flood path_len 0xFF');
      } else {
        if (!isValidPathLen(pathLen)) w.fail(`invalid path_len 0x${pathLen.toString(16)}`);
        w.bytes(pathFor(w, pathLen, cmd.path));
      }
      w.u16(cmd.dataType).bytes(cmd.payload);
      break;
    }
    case 'setDefaultFloodScope':
      w.u8(CMD.SET_DEFAULT_FLOOD_SCOPE);
      if (cmd.scope !== undefined) {
        const n = utf8Encode(cmd.scope.name);
        if (n.length < 1 || n.length >= DEFAULT_SCOPE_NAME_SIZE) w.fail('scope name must be 1..30 bytes');
        if (n.includes(0)) w.fail('scope name contains NUL');
        w.fixed(n, DEFAULT_SCOPE_NAME_SIZE, 'scope name');
        w.bytes(needLen(w, cmd.scope.key, TRANSPORT_KEY_SIZE, 'scope key'));
      }
      break;
    case 'getDefaultFloodScope':
      w.u8(CMD.GET_DEFAULT_FLOOD_SCOPE);
      break;
    case 'sendRawPacket':
      if (cmd.packet.length < 2) w.fail('packet too short');
      w.u8(CMD.SEND_RAW_PACKET).u8(cmd.priority).bytes(cmd.packet);
      break;
    case 'runCliCommand': {
      const b = utf8Encode(cmd.command);
      if (b.length < 2) w.fail('command must be at least 2 bytes');
      w.u8(CMD.RUN_CLI_COMMAND).bytes(b);
      break;
    }
    case 'raw':
      w.bytes(cmd.bytes);
      break;
    default: {
      const never: never = cmd;
      throw new ProtocolEncodeError(`unknown command ${JSON.stringify(never)}`, 'unknown');
    }
  }
  return w.finish();
}
