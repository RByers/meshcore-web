/**
 * Host → device command encoders. Byte layouts: docs/companion-protocol.md §2, §4, §7.1.
 */

import { utf8Encode } from '../util/bytes.js';
import {
  APP_PROTOCOL_VERSION,
  CHANNEL_SECRET_SIZE,
  CMD,
  CONTROL_DATA_FLAG,
  DEFAULT_APP_NAME,
  DEFAULT_APP_VERSION,
  DEFAULT_SCOPE_NAME_SIZE,
  FACTORY_RESET_MAGIC,
  MAX_NAME_SIZE,
  MAX_PATH_SIZE,
  PATH_LEN_UNKNOWN,
  PRIVATE_KEY_SIZE,
  PUB_KEY_PREFIX_SIZE,
  PUB_KEY_SIZE,
  REBOOT_MAGIC,
  TRANSPORT_KEY_SIZE,
  TxtType,
  isValidPathLen,
  packTelemetryModes,
} from './constants.js';
import { ProtocolEncodeError } from './errors.js';
import type { Command, ContactInput } from './types.js';
import { Writer, degToMicro, nameBytes, needLen, pathFor, pubKey, writeContactRecord } from './writer.js';

/**
 * Encodes the contact record body (§7.1) after a code byte. Always writes offsets 1..135;
 * lat/lon (136..143) are written if lat/lon or lastMod are given, lastMod (144..147) if given.
 */
export function encodeContactRecord(code: number, c: ContactInput): Uint8Array {
  const w = new Writer('contactRecord');
  writeContactRecord(w, code, c);
  return w.finish();
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
      // §4 CMD 38: each field after [1] is optional, but only as a suffix.
      w.u8(CMD.SET_OTHER_PARAMS).u8(cmd.manualAddContacts);
      if (cmd.telemetryModes !== undefined) {
        w.u8(packTelemetryModes(cmd.telemetryModes));
        if (cmd.advertLocPolicy !== undefined) {
          w.u8(cmd.advertLocPolicy);
          if (cmd.multiAcks !== undefined) w.u8(cmd.multiAcks);
        } else if (cmd.multiAcks !== undefined) w.fail('multiAcks requires advertLocPolicy');
      } else if (cmd.advertLocPolicy !== undefined || cmd.multiAcks !== undefined) {
        w.fail('advertLocPolicy/multiAcks require telemetryModes');
      }
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
