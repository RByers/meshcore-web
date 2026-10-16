/**
 * Host → device command decoder: the inverse of encodeCommand, used by the device emulator.
 *
 * It mirrors the guard checks of `MyMesh::handleCmdFrame` (companion-protocol.md §4, firmware
 * `examples/companion_radio/MyMesh.cpp`). A frame that fails a guard throws CommandDecodeError
 * carrying the ERR code the firmware would answer with:
 *  - a failed length/guard check in the `else if` chain falls through to the final `else`
 *    → ERR 1 (UNSUPPORTED_CMD), even for known command codes (§3);
 *  - a few structural checks inside a branch answer ERR 6 (ILLEGAL_ARG): SEND_RAW_DATA payload
 *    < 4 bytes, SEND_CHANNEL_DATA len < 4 / bad path_len, TRACE path size, SET_CUSTOM_VAR without
 *    ':', SET_DEFAULT_FLOOD_SCOPE bad name length.
 *
 * Checks that depend on device state (contact lookup, channel index, value ranges such as radio
 * params, tx power, lat/lon, PIN, path-hash mode, txt_type of a found recipient) are left to the
 * device, because their ERR code depends on evaluation order with state lookups.
 *
 * Commands without a length guard read bytes past the frame end from the firmware's stale
 * `cmd_frame` buffer; this decoder reads those as zero (deterministic stand-in).
 */

import { readU32LE, utf8Decode } from '../util/bytes.js';
import {
  CHANNEL_SECRET_SIZE,
  CMD,
  CONTROL_DATA_FLAG,
  DEFAULT_SCOPE_NAME_SIZE,
  ERR,
  FACTORY_RESET_MAGIC,
  MAX_NAME_SIZE,
  MAX_PACKET_PAYLOAD,
  MAX_PATH_SIZE,
  PATH_LEN_UNKNOWN,
  PRIVATE_KEY_SIZE,
  PUB_KEY_PREFIX_SIZE,
  PUB_KEY_SIZE,
  REBOOT_MAGIC,
  TRANSPORT_KEY_SIZE,
  decodePathLen,
  isValidPathLen,
  unpackTelemetryModes,
} from './constants.js';
import { CommandDecodeError } from './errors.js';
import type { Command, ContactInput } from './types.js';

/** Size of the zero-filled stand-in for the firmware's `cmd_frame` buffer. */
const CMD_BUFFER_SIZE = 256;

export type CommandDecodeResult =
  | { ok: true; command: Command }
  | { ok: false; error: CommandDecodeError };

/** Like decodeCommand but returns the error instead of throwing it. */
export function tryDecodeCommand(bytes: Uint8Array): CommandDecodeResult {
  try {
    return { ok: true, command: decodeCommand(bytes) };
  } catch (err) {
    if (err instanceof CommandDecodeError) return { ok: false, error: err };
    throw err;
  }
}

/**
 * Decodes one host → device frame into a Command.
 * @throws CommandDecodeError (with the firmware's ERR code) for frames the firmware rejects
 *   before looking at device state, including unknown codes (ERR 1).
 */
export function decodeCommand(bytes: Uint8Array): Command {
  const len = bytes.length;
  if (len === 0) throw new CommandDecodeError('empty command frame', -1, ERR.UNSUPPORTED_CMD, 1, 0);
  const f = new Uint8Array(Math.max(CMD_BUFFER_SIZE, len));
  f.set(bytes);
  const code = f[0]!;
  const hex = `0x${code.toString(16).padStart(2, '0')}`;

  const fail = (errCode: number, why: string, needed = len): never => {
    throw new CommandDecodeError(`command ${hex}: ${why}`, code, errCode, needed, len);
  };
  /** Guard of the `else if` chain: failing it falls through to ERR 1. */
  const guard = (ok: boolean, why: string, needed = len): void => {
    if (!ok) fail(ERR.UNSUPPORTED_CMD, why, needed);
  };
  const minLen = (n: number): void => guard(len >= n, `needs at least ${n} bytes, got ${len}`, n);
  const u8 = (o: number): number => f[o]!;
  const i8 = (o: number): number => (f[o]! << 24) >> 24;
  const u32 = (o: number): number => readU32LE(f, o);
  const i32 = (o: number): number => readU32LE(f, o) | 0;
  const slice = (o: number, n: number): Uint8Array => f.slice(o, o + n);
  const tail = (o: number): Uint8Array => bytes.slice(Math.min(o, len));
  /** C-string semantics (firmware NUL-terminates at `cmd_frame[len]`). */
  const cstrTail = (o: number): string => utf8Decode(tail(o), true);
  const cstr = (o: number, n: number): string => utf8Decode(f.subarray(o, o + n), true);
  const key = (o: number): Uint8Array => slice(o, PUB_KEY_SIZE);
  const magic = (word: string): boolean => {
    for (let i = 0; i < word.length; i++) if (f[1 + i] !== word.charCodeAt(i)) return false;
    return true;
  };

  switch (code) {
    case CMD.APP_START: // §2.1, len ≥ 8
      minLen(8);
      return { kind: 'appStart', appVersion: u8(1), appName: cstrTail(8) };

    case CMD.SEND_TXT_MSG: // §4 #2, len ≥ 14
      minLen(14);
      return {
        kind: 'sendTxtMsg',
        txtType: u8(1),
        attempt: u8(2),
        timestamp: u32(3),
        recipient: slice(7, PUB_KEY_PREFIX_SIZE),
        text: cstrTail(13),
      };

    case CMD.SEND_CHANNEL_TXT_MSG: // §4 #3, no guard
      return { kind: 'sendChannelTxtMsg', txtType: u8(1), channelIdx: u8(2), timestamp: u32(3), text: cstrTail(7) };

    case CMD.GET_CONTACTS: // §7.2: since only if len ≥ 5
      return len >= 5 ? { kind: 'getContacts', since: u32(1) } : { kind: 'getContacts' };

    case CMD.GET_DEVICE_TIME:
      return { kind: 'getDeviceTime' };

    case CMD.SET_DEVICE_TIME:
      minLen(5);
      return { kind: 'setDeviceTime', epochSecs: u32(1) };

    case CMD.SEND_SELF_ADVERT: // [1] optional: 1 = flood, else zero-hop
      return len >= 2 ? { kind: 'sendSelfAdvert', flood: u8(1) === 1 } : { kind: 'sendSelfAdvert' };

    case CMD.SET_ADVERT_NAME: {
      minLen(2);
      const n = Math.min(len - 1, MAX_NAME_SIZE - 1); // truncated to 31 bytes
      return { kind: 'setAdvertName', name: utf8Decode(f.subarray(1, 1 + n), true) };
    }

    case CMD.ADD_UPDATE_CONTACT: {
      // L1328 guard is len ≥ 36, but offsets up to 135 are always read (§4 #9)
      minLen(1 + PUB_KEY_SIZE + 3);
      const outPathLen = u8(35);
      const info = decodePathLen(outPathLen);
      const contact: ContactInput = {
        pubKey: key(1),
        type: u8(33),
        flags: u8(34),
        outPathLen,
        outPath: slice(36, info.valid ? info.byteLength : 0),
        name: cstr(100, MAX_NAME_SIZE),
        lastAdvert: u32(132),
      };
      if (len >= 144) {
        contact.lat = i32(136) / 1e6;
        contact.lon = i32(140) / 1e6;
        if (len >= 148) contact.lastMod = u32(144);
      }
      return { kind: 'addUpdateContact', contact };
    }

    case CMD.SYNC_NEXT_MESSAGE:
      return { kind: 'syncNextMessage' };

    case CMD.SET_RADIO_PARAMS: // no length check; [11] optional, absent = repeat off
      return {
        kind: 'setRadioParams',
        freqKhz: u32(1),
        bwHz: u32(5),
        sf: u8(9),
        cr: u8(10),
        clientRepeat: len > 11 ? u8(11) !== 0 : false,
      };

    case CMD.SET_RADIO_TX_POWER:
      return { kind: 'setRadioTxPower', dbm: i8(1) };

    case CMD.RESET_PATH:
      minLen(1 + PUB_KEY_SIZE);
      return { kind: 'resetPath', pubKey: key(1) };

    case CMD.SET_ADVERT_LATLON: {
      minLen(9);
      const c: Command = { kind: 'setAdvertLatLon', lat: i32(1) / 1e6, lon: i32(5) / 1e6 };
      if (len >= 13) c.alt = i32(9);
      return c;
    }

    case CMD.REMOVE_CONTACT: // no guard
      return { kind: 'removeContact', pubKey: key(1) };

    case CMD.SHARE_CONTACT: // no guard
      return { kind: 'shareContact', pubKey: key(1) };

    case CMD.EXPORT_CONTACT: // len < 33 → export self
      return len < 1 + PUB_KEY_SIZE ? { kind: 'exportContact' } : { kind: 'exportContact', pubKey: key(1) };

    case CMD.IMPORT_CONTACT:
      guard(len > 2 + PUB_KEY_SIZE + 64, `needs more than ${2 + PUB_KEY_SIZE + 64} bytes, got ${len}`, 99);
      return { kind: 'importContact', packet: tail(1) };

    case CMD.REBOOT:
      guard(magic(REBOOT_MAGIC), 'missing "reboot" literal', 1 + REBOOT_MAGIC.length);
      return { kind: 'reboot' };

    case CMD.GET_BATT_AND_STORAGE:
      return { kind: 'getBattAndStorage' };

    case CMD.SET_TUNING_PARAMS: // no length check
      return { kind: 'setTuningParams', rxDelayBase: u32(1) / 1000, airtimeFactor: u32(5) / 1000 };

    case CMD.DEVICE_QUERY:
      minLen(2);
      return { kind: 'deviceQuery', appTargetVer: u8(1) };

    case CMD.EXPORT_PRIVATE_KEY:
      return { kind: 'exportPrivateKey' };

    case CMD.IMPORT_PRIVATE_KEY:
      minLen(1 + PRIVATE_KEY_SIZE);
      return { kind: 'importPrivateKey', privateKey: slice(1, PRIVATE_KEY_SIZE) };

    case CMD.SEND_RAW_DATA: {
      minLen(6);
      const pathLen = u8(1);
      // any invalid path_len, including 0xFF (flood), → ERR 1
      guard(isValidPathLen(pathLen), `invalid path_len 0x${pathLen.toString(16)} (flood unsupported)`);
      const n = decodePathLen(pathLen).byteLength;
      const i = 2 + n;
      if (i + 4 > len) fail(ERR.ILLEGAL_ARG, 'payload shorter than 4 bytes', i + 4);
      return { kind: 'sendRawData', pathLen, path: slice(2, n), payload: tail(i) };
    }

    case CMD.SEND_LOGIN:
      minLen(1 + PUB_KEY_SIZE);
      return { kind: 'sendLogin', pubKey: key(1), password: cstrTail(1 + PUB_KEY_SIZE) };

    case CMD.SEND_STATUS_REQ:
      minLen(1 + PUB_KEY_SIZE);
      return { kind: 'sendStatusReq', pubKey: key(1) };

    case CMD.HAS_CONNECTION:
      minLen(1 + PUB_KEY_SIZE);
      return { kind: 'hasConnection', pubKey: key(1) };

    case CMD.LOGOUT:
      minLen(1 + PUB_KEY_SIZE);
      return { kind: 'logout', pubKey: key(1) };

    case CMD.GET_CONTACT_BY_KEY: // no guard
      return { kind: 'getContactByKey', pubKey: key(1) };

    case CMD.GET_CHANNEL:
      minLen(2);
      return { kind: 'getChannel', index: u8(1) };

    case CMD.SET_CHANNEL:
      // 256-bit secrets (len ≥ 66) are checked first and rejected with ERR 1
      guard(len < 2 + 32 + 32, '256-bit channel secrets are not supported');
      minLen(2 + MAX_NAME_SIZE + CHANNEL_SECRET_SIZE);
      return { kind: 'setChannel', index: u8(1), name: cstr(2, MAX_NAME_SIZE), secret: slice(34, CHANNEL_SECRET_SIZE) };

    case CMD.SIGN_START:
      return { kind: 'signStart' };

    case CMD.SIGN_DATA:
      minLen(2);
      return { kind: 'signData', chunk: tail(1) };

    case CMD.SIGN_FINISH:
      return { kind: 'signFinish' };

    case CMD.SEND_TRACE_PATH: {
      // len > 10 and len - 10 < MAX_PACKET_PAYLOAD - 5 (179), else ERR 1
      guard(len > 10, `needs more than 10 bytes, got ${len}`, 11);
      guard(len - 10 < MAX_PACKET_PAYLOAD - 5, `path of ${len - 10} bytes is too long`);
      const flags = u8(9);
      const pathSz = flags & 0x03;
      const n = len - 10;
      if (n >> pathSz > MAX_PATH_SIZE || n % (1 << pathSz) !== 0) {
        fail(ERR.ILLEGAL_ARG, `path of ${n} bytes does not fit hash size ${1 << pathSz}`);
      }
      return { kind: 'sendTracePath', tag: u32(1), authCode: u32(5), pathHashSize: 1 << pathSz, path: tail(10) };
    }

    case CMD.SET_DEVICE_PIN:
      minLen(5);
      return { kind: 'setDevicePin', pin: u32(1) };

    case CMD.SET_OTHER_PARAMS: {
      // no guard: [1] is read even if len = 1; later fields are optional
      const c: Command = { kind: 'setOtherParams', manualAddContacts: u8(1) };
      if (len >= 3) {
        c.telemetryModes = unpackTelemetryModes(u8(2));
        if (len >= 4) {
          c.advertLocPolicy = u8(3);
          if (len >= 5) c.multiAcks = u8(4);
        }
      }
      return c;
    }

    case CMD.SEND_TELEMETRY_REQ:
      if (len === 4) return { kind: 'sendTelemetryReq' }; // self telemetry
      minLen(4 + PUB_KEY_SIZE);
      return { kind: 'sendTelemetryReq', pubKey: key(4) };

    case CMD.GET_CUSTOM_VARS:
      return { kind: 'getCustomVars' };

    case CMD.SET_CUSTOM_VAR: {
      minLen(4);
      const text = cstrTail(1);
      const sep = text.indexOf(':');
      if (sep < 0) fail(ERR.ILLEGAL_ARG, 'missing ":" separator');
      return { kind: 'setCustomVar', name: text.slice(0, sep), value: text.slice(sep + 1) };
    }

    case CMD.GET_ADVERT_PATH:
      minLen(2 + PUB_KEY_SIZE);
      return { kind: 'getAdvertPath', pubKey: key(2) };

    case CMD.GET_TUNING_PARAMS:
      return { kind: 'getTuningParams' };

    case CMD.SEND_BINARY_REQ:
      minLen(2 + PUB_KEY_SIZE);
      return { kind: 'sendBinaryReq', pubKey: key(1), data: tail(1 + PUB_KEY_SIZE) };

    case CMD.FACTORY_RESET:
      guard(magic(FACTORY_RESET_MAGIC), 'missing "reset" literal', 1 + FACTORY_RESET_MAGIC.length);
      return { kind: 'factoryReset' };

    case CMD.SEND_PATH_DISCOVERY_REQ:
      guard(u8(1) === 0, 'reserved byte [1] must be 0');
      minLen(2 + PUB_KEY_SIZE);
      return { kind: 'sendPathDiscoveryReq', pubKey: key(2) };

    case CMD.SET_FLOOD_SCOPE_KEY:
      minLen(2);
      if (u8(1) === 1) return { kind: 'setFloodScopeKey', unscoped: true };
      guard(u8(1) === 0, `[1] must be 0 or 1 (got ${u8(1)})`);
      return len >= 2 + TRANSPORT_KEY_SIZE
        ? { kind: 'setFloodScopeKey', key: slice(2, TRANSPORT_KEY_SIZE) }
        : { kind: 'setFloodScopeKey' };

    case CMD.SEND_CONTROL_DATA:
      minLen(2);
      guard((u8(1) & CONTROL_DATA_FLAG) !== 0, 'payload[0] & 0x80 must be set');
      return { kind: 'sendControlData', payload: tail(1) };

    case CMD.GET_STATS:
      minLen(2);
      return { kind: 'getStats', statsType: u8(1) };

    case CMD.SEND_ANON_REQ:
      guard(len > 1 + PUB_KEY_SIZE, `needs more than ${1 + PUB_KEY_SIZE} bytes, got ${len}`, 2 + PUB_KEY_SIZE);
      return { kind: 'sendAnonReq', pubKey: key(1), data: tail(1 + PUB_KEY_SIZE) };

    case CMD.SET_AUTOADD_CONFIG: // no guard; [2] optional
      return len >= 3
        ? { kind: 'setAutoAddConfig', config: u8(1), maxHops: u8(2) }
        : { kind: 'setAutoAddConfig', config: u8(1) };

    case CMD.GET_AUTOADD_CONFIG:
      return { kind: 'getAutoAddConfig' };

    case CMD.GET_ALLOWED_REPEAT_FREQ:
      return { kind: 'getAllowedRepeatFreq' };

    case CMD.SET_PATH_HASH_MODE:
      guard(u8(1) === 0, 'reserved byte [1] must be 0');
      minLen(3);
      return { kind: 'setPathHashMode', mode: u8(2) };

    case CMD.SEND_CHANNEL_DATA: {
      if (len < 4) fail(ERR.ILLEGAL_ARG, `needs at least 4 bytes, got ${len}`, 4); // ERR 6, not 1
      const channelIdx = u8(1);
      const pathLen = u8(2);
      if (pathLen !== PATH_LEN_UNKNOWN && !isValidPathLen(pathLen)) {
        fail(ERR.ILLEGAL_ARG, `invalid path_len 0x${pathLen.toString(16)}`);
      }
      let i = 3;
      let path: Uint8Array | undefined;
      if (pathLen !== PATH_LEN_UNKNOWN) {
        const n = decodePathLen(pathLen).byteLength;
        path = slice(i, n);
        i += n;
      }
      const dataType = u8(i) | (u8(i + 1) << 8);
      i += 2;
      const c: Command = { kind: 'sendChannelData', channelIdx, dataType, payload: tail(i) };
      if (path !== undefined) {
        c.pathLen = pathLen;
        c.path = path;
      }
      return c;
    }

    case CMD.SET_DEFAULT_FLOOD_SCOPE: {
      if (len < 1 + DEFAULT_SCOPE_NAME_SIZE + TRANSPORT_KEY_SIZE) return { kind: 'setDefaultFloodScope' }; // clear
      // strlen from [1]: may run past the 31-byte field into the key
      let n = 0;
      while (f[1 + n] !== 0 && 1 + n < f.length) n++;
      if (n === 0 || n >= DEFAULT_SCOPE_NAME_SIZE) fail(ERR.ILLEGAL_ARG, `scope name must be 1..30 bytes (got ${n})`);
      return {
        kind: 'setDefaultFloodScope',
        scope: { name: cstr(1, DEFAULT_SCOPE_NAME_SIZE), key: slice(1 + DEFAULT_SCOPE_NAME_SIZE, TRANSPORT_KEY_SIZE) },
      };
    }

    case CMD.GET_DEFAULT_FLOOD_SCOPE:
      return { kind: 'getDefaultFloodScope' };

    case CMD.SEND_RAW_PACKET:
      minLen(4);
      return { kind: 'sendRawPacket', priority: u8(1), packet: tail(2) };

    case CMD.RUN_CLI_COMMAND:
      minLen(3);
      return { kind: 'runCliCommand', command: cstrTail(1) };

    default:
      return fail(ERR.UNSUPPORTED_CMD, 'unknown command code');
  }
}
