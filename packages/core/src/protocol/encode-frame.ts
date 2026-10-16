/**
 * Device → host frame encoder: the inverse of decodeFrame, used by the device emulator.
 * Layouts: docs/companion-protocol.md §2-§7, docs/mesh-packet-format.md §3.2 (status structs).
 *
 * Canonical fields: where a decoded frame carries both a wire field and values derived from it,
 * the wire field is encoded and the derived ones are ignored:
 *  - `code` decides V1 vs V3 message frames (`version` is ignored);
 *  - ERR uses `errCode`; SENT uses `tag`; SEND_CONFIRMED uses `ackCode`;
 *  - message frames use `route.pathLen`; CHANNEL_MSG uses `text` (not senderName/message);
 *  - SELF_INFO uses `telemetryModesRaw`; CUSTOM_VARS uses `raw`; STATUS_RESPONSE uses `raw`;
 *  - LOGIN_SUCCESS uses `adminFlag` and `legacy`; contact records use `outPathLen` + `outPath`;
 *  - TRACE_DATA uses `flags`, `pathHashes`, `snrs`, `finalSnr` (path_len = pathHashes.length).
 * SNR values (dB) are written as `(int8)(snr × 4)` like the firmware's C cast (truncation).
 */

import { utf8Encode } from '../util/bytes.js';
import {
  CHANNEL_SECRET_SIZE,
  DEFAULT_SCOPE_NAME_SIZE,
  MAX_NAME_SIZE,
  PATH_LEN_UNKNOWN,
  PRIVATE_KEY_SIZE,
  PUB_KEY_PREFIX_SIZE,
  PUB_KEY_SIZE,
  PUSH,
  RESP,
  SIGNATURE_SIZE,
  SIGNED_PLAIN_AUTHOR_PREFIX_SIZE,
  StatsType,
  TRANSPORT_KEY_SIZE,
  TxtType,
} from './constants.js';
import type { CommonNodeStats, Contact, DeviceFrame, RepeaterStats, ServerStats } from './types.js';
import { Writer, needLen, writeContactRecord } from './writer.js';

/** `(int8_t)(snr * 4)`, clamped to the i8 range. */
function snrByte(snrDb: number): number {
  return Math.max(-128, Math.min(127, Math.trunc(snrDb * 4)));
}

/** `(int8_t)rssi`, clamped. */
function rssiByte(rssi: number): number {
  return Math.max(-128, Math.min(127, Math.trunc(rssi)));
}

/** Fixed char[size] field, NUL padded. `strzcpy` fields need room for the NUL. */
function cfield(w: Writer, s: string, size: number, field: string, needNul: boolean): void {
  const b = utf8Encode(s);
  const max = needNul ? size - 1 : size;
  if (b.length > max) w.fail(`${field} is ${b.length} bytes, max ${max}`);
  w.fixed(b, size, field);
}

function prefix6(w: Writer, b: Uint8Array): Uint8Array {
  return needLen(w, b, PUB_KEY_PREFIX_SIZE, 'pubKeyPrefix');
}

function key32(w: Writer, b: Uint8Array): Uint8Array {
  return needLen(w, b, PUB_KEY_SIZE, 'pubKey');
}

function contactRecord(w: Writer, code: number, c: Contact): void {
  if (c.outPathLen !== PATH_LEN_UNKNOWN && c.outPath.length !== c.outPathInfo.byteLength && c.outPathInfo.valid) {
    w.fail(`outPath is ${c.outPath.length} bytes but out_path_len implies ${c.outPathInfo.byteLength}`);
  }
  writeContactRecord(w, code, c);
}

function writeCommonStats(w: Writer, s: CommonNodeStats): void {
  w.u16(s.batteryMv).u16(s.txQueueLen).i16(s.noiseFloorDbm).i16(s.lastRssiDbm);
  w.u32(s.packetsRecv).u32(s.packetsSent).u32(s.airTimeSecs).u32(s.upTimeSecs);
  w.u32(s.sentFlood).u32(s.sentDirect).u32(s.recvFlood).u32(s.recvDirect);
  w.u16(s.errEvents).i16(Math.trunc(s.lastSnr * 4)).u16(s.directDups).u16(s.floodDups);
}

/**
 * Encodes a repeater RepeaterStats struct: 56 bytes, or the legacy 48 if rxAirTimeSecs and
 * recvErrors are both absent. mesh-packet-format.md §3.2
 */
export function encodeRepeaterStats(s: RepeaterStats): Uint8Array {
  const w = new Writer('RepeaterStats');
  writeCommonStats(w, s);
  if (s.rxAirTimeSecs !== undefined || s.recvErrors !== undefined) {
    w.u32(s.rxAirTimeSecs ?? 0).u32(s.recvErrors ?? 0);
  }
  return w.finish();
}

/** Encodes a room server ServerStats struct (52 bytes). mesh-packet-format.md §3.2 */
export function encodeServerStats(s: ServerStats): Uint8Array {
  const w = new Writer('ServerStats');
  writeCommonStats(w, s);
  w.u16(s.posted).u16(s.postPush);
  return w.finish();
}

/**
 * Encodes one device → host frame (response or push) into its exact wire bytes.
 * @throws ProtocolEncodeError for out-of-range fields or frames longer than 176 bytes (which the
 *   firmware's writeFrame would silently drop).
 */
export function encodeDeviceFrame(frame: DeviceFrame): Uint8Array {
  const w: Writer = new Writer(frame.kind);
  switch (frame.kind) {
    // ---- responses (§3, §5) ----
    case 'ok':
      w.u8(RESP.OK);
      break;
    case 'err':
      w.u8(RESP.ERR).u8(frame.errCode);
      break;
    case 'contactsStart':
      w.u8(RESP.CONTACTS_START).u32(frame.total);
      break;
    case 'contact':
      contactRecord(w, RESP.CONTACT, frame.contact);
      break;
    case 'endOfContacts':
      w.u8(RESP.END_OF_CONTACTS).u32(frame.mostRecentLastMod);
      break;
    case 'selfInfo': {
      // §2.2
      const s = frame.info;
      w.u8(RESP.SELF_INFO).u8(s.advType).i8(s.txPowerDbm).i8(s.maxTxPowerDbm).bytes(key32(w, s.pubKey));
      w.i32(Math.round(s.lat * 1e6)).i32(Math.round(s.lon * 1e6));
      w.u8(s.multiAcks).u8(s.advertLocPolicy).u8(s.telemetryModesRaw).u8(s.manualAddContacts);
      w.u32(s.radioFreqKhz).u32(s.radioBwHz).u8(s.radioSf).u8(s.radioCr);
      w.bytes(utf8Encode(s.name)); // rest of frame, no NUL
      break;
    }
    case 'sent': // §5.1
      w.u8(RESP.SENT).u8(frame.flood ? 1 : 0).u32(frame.tag).u32(frame.estTimeoutMs);
      break;
    case 'contactMsg': {
      // §6.2
      w.u8(frame.code);
      if (frame.code === RESP.CONTACT_MSG_RECV_V3) w.i8(snrByte(frame.snr ?? 0)).u8(0).u8(0);
      w.bytes(prefix6(w, frame.senderPrefix)).u8(frame.route.pathLen).u8(frame.txtType).u32(frame.senderTimestamp);
      if (frame.txtType === TxtType.SIGNED_PLAIN) {
        if (frame.authorPrefix === undefined) w.fail('SIGNED_PLAIN message needs authorPrefix');
        w.bytes(needLen(w, frame.authorPrefix, SIGNED_PLAIN_AUTHOR_PREFIX_SIZE, 'authorPrefix'));
      }
      w.bytes(utf8Encode(frame.text));
      break;
    }
    case 'channelMsg':
      // §6.3
      w.u8(frame.code);
      if (frame.code === RESP.CHANNEL_MSG_RECV_V3) w.i8(snrByte(frame.snr ?? 0)).u8(0).u8(0);
      w.u8(frame.channelIdx).u8(frame.route.pathLen).u8(frame.txtType).u32(frame.senderTimestamp);
      w.bytes(utf8Encode(frame.text));
      break;
    case 'currTime':
      w.u8(RESP.CURR_TIME).u32(frame.epochSecs);
      break;
    case 'noMoreMessages':
      w.u8(RESP.NO_MORE_MESSAGES);
      break;
    case 'exportContact':
      w.u8(RESP.EXPORT_CONTACT).bytes(frame.packet);
      break;
    case 'battAndStorage': {
      // §5.3: 11 bytes; legacy 3-byte form if storage fields are absent
      const b = frame.batt;
      w.u8(RESP.BATT_AND_STORAGE).u16(b.batteryMv);
      if (b.storageUsedKb !== undefined || b.storageTotalKb !== undefined) {
        w.u32(b.storageUsedKb ?? 0).u32(b.storageTotalKb ?? 0);
      }
      break;
    }
    case 'deviceInfo': {
      // §2.3: fields are written in order up to the first absent one (older firmware layouts)
      const d = frame.info;
      w.u8(RESP.DEVICE_INFO).u8(d.firmwareVerCode);
      if (d.maxContacts === undefined || d.maxChannels === undefined) break;
      w.u8(Math.floor(d.maxContacts / 2)).u8(d.maxChannels);
      if (d.blePin === undefined) break;
      w.u32(d.blePin);
      if (d.buildDate === undefined) break;
      cfield(w, d.buildDate, 12, 'buildDate', false);
      if (d.manufacturer === undefined) break;
      cfield(w, d.manufacturer, 40, 'manufacturer', true);
      if (d.firmwareVersion === undefined) break;
      cfield(w, d.firmwareVersion, 20, 'firmwareVersion', true);
      if (d.clientRepeat === undefined) break;
      w.u8(d.clientRepeat ? 1 : 0);
      if (d.pathHashMode === undefined) break;
      w.u8(d.pathHashMode);
      break;
    }
    case 'privateKey':
      w.u8(RESP.PRIVATE_KEY).bytes(needLen(w, frame.privateKey, PRIVATE_KEY_SIZE, 'privateKey'));
      break;
    case 'disabled':
      w.u8(RESP.DISABLED);
      break;
    case 'channelInfo': {
      // §5.5
      const c = frame.channel;
      w.u8(RESP.CHANNEL_INFO).u8(c.index);
      cfield(w, c.name, MAX_NAME_SIZE, 'name', true);
      w.bytes(needLen(w, c.secret, CHANNEL_SECRET_SIZE, 'secret'));
      break;
    }
    case 'signStart':
      w.u8(RESP.SIGN_START).u8(0).u32(frame.maxLen);
      break;
    case 'signature':
      w.u8(RESP.SIGNATURE).bytes(needLen(w, frame.signature, SIGNATURE_SIZE, 'signature'));
      break;
    case 'customVars':
      w.u8(RESP.CUSTOM_VARS).bytes(utf8Encode(frame.raw));
      break;
    case 'advertPath':
      w.u8(RESP.ADVERT_PATH).u32(frame.recvTimestamp).u8(frame.pathLen);
      w.bytes(needLen(w, frame.path, frame.pathInfo.byteLength, 'path'));
      break;
    case 'tuningParams':
      w.u8(RESP.TUNING_PARAMS).u32(Math.round(frame.rxDelayBase * 1000)).u32(Math.round(frame.airtimeFactor * 1000));
      break;
    case 'stats': {
      // §5.6
      const s = frame.stats;
      w.u8(RESP.STATS);
      switch (s.type) {
        case 'core':
          w.u8(StatsType.CORE).u16(s.batteryMv).u32(s.uptimeSecs).u16(s.errFlags).u8(s.outboundQueueLen);
          break;
        case 'radio':
          w.u8(StatsType.RADIO).i16(s.noiseFloorDbm).i8(rssiByte(s.lastRssiDbm)).i8(snrByte(s.lastSnr));
          w.u32(s.txAirSecs).u32(s.rxAirSecs);
          break;
        case 'packets':
          w.u8(StatsType.PACKETS).u32(s.recv).u32(s.sent).u32(s.sentFlood).u32(s.sentDirect);
          w.u32(s.recvFlood).u32(s.recvDirect);
          if (s.recvErrors !== undefined) w.u32(s.recvErrors);
          break;
        case 'unknown':
          w.u8(s.statsType).bytes(s.raw);
          break;
      }
      break;
    }
    case 'autoAddConfig':
      w.u8(RESP.AUTOADD_CONFIG).u8(frame.config).u8(frame.maxHops);
      break;
    case 'allowedRepeatFreq':
      w.u8(RESP.ALLOWED_REPEAT_FREQ);
      for (const r of frame.ranges) w.u32(r.lowerKhz).u32(r.upperKhz);
      break;
    case 'channelData':
      // §6.4
      w.u8(RESP.CHANNEL_DATA_RECV).i8(snrByte(frame.snr)).u8(0).u8(0).u8(frame.channelIdx).u8(frame.route.pathLen);
      w.u16(frame.dataType).u8(frame.data.length).bytes(frame.data);
      break;
    case 'defaultFloodScope':
      w.u8(RESP.DEFAULT_FLOOD_SCOPE);
      if (frame.scope !== null) {
        cfield(w, frame.scope.name, DEFAULT_SCOPE_NAME_SIZE, 'scope name', true);
        w.bytes(needLen(w, frame.scope.key, TRANSPORT_KEY_SIZE, 'scope key'));
      }
      break;
    case 'cliReply':
      w.u8(RESP.CLI_REPLY).bytes(utf8Encode(frame.text));
      break;

    // ---- pushes (§6) ----
    case 'advert':
      w.u8(PUSH.ADVERT).bytes(key32(w, frame.pubKey));
      break;
    case 'pathUpdated':
      w.u8(PUSH.PATH_UPDATED).bytes(key32(w, frame.pubKey));
      break;
    case 'sendConfirmed':
      w.u8(PUSH.SEND_CONFIRMED).u32(frame.ackCode).u32(frame.roundTripMs);
      break;
    case 'msgWaiting':
      w.u8(PUSH.MSG_WAITING);
      break;
    case 'rawData':
      w.u8(PUSH.RAW_DATA).i8(snrByte(frame.snr)).i8(rssiByte(frame.rssi)).u8(0xff).bytes(frame.payload);
      break;
    case 'loginSuccess':
      // §6.6
      w.u8(PUSH.LOGIN_SUCCESS).u8(frame.adminFlag).bytes(prefix6(w, frame.pubKeyPrefix));
      if (!frame.legacy) {
        w.u32(frame.serverTimestamp ?? 0).u8(frame.aclPermissions ?? 0).u8(frame.firmwareVerLevel ?? 0);
      }
      break;
    case 'loginFail':
      w.u8(PUSH.LOGIN_FAIL).u8(0).bytes(prefix6(w, frame.pubKeyPrefix));
      break;
    case 'statusResponse':
      w.u8(PUSH.STATUS_RESPONSE).u8(0).bytes(prefix6(w, frame.pubKeyPrefix)).bytes(frame.raw);
      break;
    case 'logRxData':
      w.u8(PUSH.LOG_RX_DATA).i8(snrByte(frame.snr)).i8(rssiByte(frame.rssi)).bytes(frame.packet);
      break;
    case 'traceData': {
      // §6.7
      const pathSz = frame.flags & 3;
      const pathLen = frame.pathHashes.length;
      if (pathLen > 0xff) w.fail('path hash list longer than 255 bytes');
      if (frame.snrs.length !== pathLen >> pathSz) {
        w.fail(`${frame.snrs.length} SNRs given, path implies ${pathLen >> pathSz}`);
      }
      w.u8(PUSH.TRACE_DATA).u8(0).u8(pathLen).u8(frame.flags).u32(frame.tag).u32(frame.authCode);
      w.bytes(frame.pathHashes);
      for (const s of frame.snrs) w.i8(snrByte(s));
      w.i8(snrByte(frame.finalSnr));
      break;
    }
    case 'newAdvert':
      contactRecord(w, PUSH.NEW_ADVERT, frame.contact);
      break;
    case 'telemetryResponse':
      w.u8(PUSH.TELEMETRY_RESPONSE).u8(0).bytes(prefix6(w, frame.pubKeyPrefix)).bytes(frame.lpp);
      break;
    case 'binaryResponse':
      w.u8(PUSH.BINARY_RESPONSE).u8(0).u32(frame.tag).bytes(frame.data);
      break;
    case 'pathDiscoveryResponse':
      w.u8(PUSH.PATH_DISCOVERY_RESPONSE).u8(0).bytes(prefix6(w, frame.pubKeyPrefix));
      w.u8(frame.outPathLen).bytes(needLen(w, frame.outPath, frame.outPathInfo.byteLength, 'outPath'));
      w.u8(frame.inPathLen).bytes(needLen(w, frame.inPath, frame.inPathInfo.byteLength, 'inPath'));
      break;
    case 'controlData':
      w.u8(PUSH.CONTROL_DATA).i8(snrByte(frame.snr)).i8(rssiByte(frame.rssi)).u8(frame.pathLen).bytes(frame.payload);
      break;
    case 'contactDeleted':
      w.u8(PUSH.CONTACT_DELETED).bytes(key32(w, frame.pubKey));
      break;
    case 'contactsFull':
      w.u8(PUSH.CONTACTS_FULL);
      break;
    case 'unknown':
      w.bytes(frame.raw);
      break;
    default: {
      const never: never = frame;
      w.fail(`unknown frame ${JSON.stringify(never)}`);
    }
  }
  return w.finish();
}
