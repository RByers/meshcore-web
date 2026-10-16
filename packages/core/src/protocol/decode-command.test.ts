import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, u32le, utf8Encode } from '../util/bytes.js';
import { CMD, ERR } from './constants.js';
import { decodeCommand, tryDecodeCommand } from './decode-command.js';
import { encodeCommand } from './encode.js';
import { CommandDecodeError, ProtocolDecodeError } from './errors.js';
import type { Command } from './types.js';

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const KEY2 = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
const PRIV = Uint8Array.from({ length: 64 }, (_, i) => 255 - i);
const SECRET = fromHex('8b3387e9c5cdea6ac9e5edbaa115cd72');
const x = (s: string): Uint8Array => fromHex(s.replace(/\s+/g, ''));
const str = (s: string): Uint8Array => utf8Encode(s);

/** An advert packet long enough for IMPORT_CONTACT (len > 98). */
const ADVERT_PKT = concatBytes(x('1100'), KEY, u32le(1700000000), new Uint8Array(64), x('81'), str('Bob'));

/**
 * [command, expected decode]. The expected value is the canonical form: what decodeCommand
 * returns for the bytes encodeCommand produced (defaults filled in, prefixes truncated, …).
 */
const ROUND_TRIPS: Array<[Command, Command?]> = [
  [{ kind: 'appStart', appName: 'meshcore-web', appVersion: 1 }],
  [{ kind: 'appStart' }, { kind: 'appStart', appName: 'meshcore-web', appVersion: 1 }],
  [
    { kind: 'sendTxtMsg', recipient: KEY, text: 'héllo', timestamp: 1700000000, txtType: 0, attempt: 2 },
    { kind: 'sendTxtMsg', recipient: KEY.slice(0, 6), text: 'héllo', timestamp: 1700000000, txtType: 0, attempt: 2 },
  ],
  [{ kind: 'sendTxtMsg', recipient: KEY.slice(0, 6), text: 'ls', timestamp: 5, txtType: 3, attempt: 0 }],
  [{ kind: 'sendChannelTxtMsg', channelIdx: 1, text: 'hi all', timestamp: 1700000001, txtType: 0 }],
  [{ kind: 'getContacts' }],
  [{ kind: 'getContacts', since: 1700000123 }],
  [{ kind: 'getDeviceTime' }],
  [{ kind: 'setDeviceTime', epochSecs: 1700000000 }],
  [{ kind: 'sendSelfAdvert' }],
  [{ kind: 'sendSelfAdvert', flood: true }],
  [{ kind: 'sendSelfAdvert', flood: false }],
  [{ kind: 'setAdvertName', name: 'Alice 🌲' }],
  [
    {
      kind: 'addUpdateContact',
      contact: { pubKey: KEY, type: 2, flags: 1, outPathLen: 0x42, outPath: x('a1a2b1b2'), name: 'Rpt', lastAdvert: 1700000000 },
    },
  ],
  [
    {
      kind: 'addUpdateContact',
      contact: {
        pubKey: KEY,
        type: 1,
        flags: 0,
        outPathLen: 0xff,
        name: 'Bob',
        lastAdvert: 1,
        lat: 47.606209,
        lon: -122.332071,
        lastMod: 1700000500,
      },
    },
    {
      kind: 'addUpdateContact',
      contact: {
        pubKey: KEY,
        type: 1,
        flags: 0,
        outPathLen: 0xff,
        outPath: new Uint8Array(0),
        name: 'Bob',
        lastAdvert: 1,
        lat: 47.606209,
        lon: -122.332071,
        lastMod: 1700000500,
      },
    },
  ],
  [{ kind: 'syncNextMessage' }],
  [{ kind: 'setRadioParams', freqKhz: 869525, bwHz: 250000, sf: 11, cr: 5, clientRepeat: true }],
  [
    { kind: 'setRadioParams', freqKhz: 869525, bwHz: 250000, sf: 11, cr: 5 },
    { kind: 'setRadioParams', freqKhz: 869525, bwHz: 250000, sf: 11, cr: 5, clientRepeat: false },
  ],
  [{ kind: 'setRadioTxPower', dbm: -9 }],
  [{ kind: 'setRadioTxPower', dbm: 22 }],
  [{ kind: 'resetPath', pubKey: KEY }],
  [{ kind: 'setAdvertLatLon', lat: -33.865143, lon: 151.2099 }],
  [{ kind: 'setAdvertLatLon', lat: 1.5, lon: 2.5, alt: -12 }],
  [{ kind: 'removeContact', pubKey: KEY }],
  [{ kind: 'shareContact', pubKey: KEY }],
  [{ kind: 'exportContact' }],
  [{ kind: 'exportContact', pubKey: KEY2 }],
  [{ kind: 'importContact', packet: ADVERT_PKT }],
  [{ kind: 'reboot' }],
  [{ kind: 'getBattAndStorage' }],
  [{ kind: 'setTuningParams', rxDelayBase: 10.5, airtimeFactor: 1 }],
  [{ kind: 'deviceQuery' }, { kind: 'deviceQuery', appTargetVer: 3 }],
  [{ kind: 'deviceQuery', appTargetVer: 1 }],
  [{ kind: 'exportPrivateKey' }],
  [{ kind: 'importPrivateKey', privateKey: PRIV }],
  [{ kind: 'sendRawData', pathLen: 0x42, path: x('01020304'), payload: x('deadbeef01') }],
  [{ kind: 'sendRawData', pathLen: 0, path: new Uint8Array(0), payload: x('00000000') }],
  [{ kind: 'sendLogin', pubKey: KEY, password: 'secret' }],
  [{ kind: 'sendLogin', pubKey: KEY, password: '' }],
  [{ kind: 'sendStatusReq', pubKey: KEY }],
  [{ kind: 'hasConnection', pubKey: KEY }],
  [{ kind: 'logout', pubKey: KEY }],
  [{ kind: 'getContactByKey', pubKey: KEY }],
  [{ kind: 'getChannel', index: 7 }],
  [{ kind: 'setChannel', index: 1, name: '#test', secret: SECRET }],
  [{ kind: 'signStart' }],
  [{ kind: 'signData', chunk: x('0102030405') }],
  [{ kind: 'signFinish' }],
  [
    { kind: 'sendTracePath', tag: 0x12345678, authCode: 0xcafebabe, path: x('aabbcc') },
    { kind: 'sendTracePath', tag: 0x12345678, authCode: 0xcafebabe, path: x('aabbcc'), pathHashSize: 1 },
  ],
  [{ kind: 'sendTracePath', tag: 1, authCode: 2, path: x('aabbccdd'), pathHashSize: 2 }],
  [{ kind: 'setDevicePin', pin: 123456 }],
  [
    {
      kind: 'setOtherParams',
      manualAddContacts: 1,
      telemetryModes: { base: 2, location: 1, environment: 0 },
      advertLocPolicy: 1,
      multiAcks: 2,
    },
  ],
  [{ kind: 'setOtherParams', manualAddContacts: 0 }],
  [{ kind: 'setOtherParams', manualAddContacts: 0, telemetryModes: { base: 1, location: 0, environment: 2 } }],
  [{ kind: 'sendTelemetryReq' }],
  [{ kind: 'sendTelemetryReq', pubKey: KEY }],
  [{ kind: 'getCustomVars' }],
  [{ kind: 'setCustomVar', name: 'gps', value: '1' }],
  [{ kind: 'setCustomVar', name: 'x', value: 'a:b' }],
  [{ kind: 'getAdvertPath', pubKey: KEY }],
  [{ kind: 'getTuningParams' }],
  [{ kind: 'sendBinaryReq', pubKey: KEY, data: x('0600050000000102') }],
  [{ kind: 'factoryReset' }],
  [{ kind: 'sendPathDiscoveryReq', pubKey: KEY }],
  [{ kind: 'setFloodScopeKey' }],
  [{ kind: 'setFloodScopeKey', key: SECRET }],
  [{ kind: 'setFloodScopeKey', unscoped: true }],
  [{ kind: 'sendControlData', payload: x('80 1e 01020304') }],
  [{ kind: 'getStats', statsType: 2 }],
  [{ kind: 'sendAnonReq', pubKey: KEY, data: x('03') }],
  [{ kind: 'setAutoAddConfig', config: 0x1f }],
  [{ kind: 'setAutoAddConfig', config: 0x02, maxHops: 3 }],
  [{ kind: 'getAutoAddConfig' }],
  [{ kind: 'getAllowedRepeatFreq' }],
  [{ kind: 'setPathHashMode', mode: 2 }],
  [{ kind: 'sendChannelData', channelIdx: 0, dataType: 0xffff, payload: x('010203') }],
  [{ kind: 'sendChannelData', channelIdx: 2, dataType: 0x1234, payload: x('ff'), pathLen: 0x02, path: x('a1b2') }],
  [{ kind: 'setDefaultFloodScope' }],
  [{ kind: 'setDefaultFloodScope', scope: { name: '#europe', key: SECRET } }],
  [{ kind: 'getDefaultFloodScope' }],
  [{ kind: 'sendRawPacket', priority: 1, packet: x('0900 0102030405060708 00 aa') }],
  [{ kind: 'runCliCommand', command: 'get name' }],
];

describe('decodeCommand — round trip with encodeCommand (companion-protocol.md §4)', () => {
  it.each(ROUND_TRIPS.map(([c, e]) => [c.kind, c, e ?? c] as const))('%s', (_kind, cmd, expected) => {
    expect(decodeCommand(encodeCommand(cmd))).toEqual(expected);
  });

  it('covers every CMD code', () => {
    const covered = new Set(ROUND_TRIPS.map(([c]) => encodeCommand(c)[0]));
    const missing = Object.entries(CMD).filter(([, code]) => !covered.has(code));
    expect(missing).toEqual([]);
  });
});

describe('decodeCommand — byte layouts', () => {
  it('SEND_TXT_MSG: [1]type [2]attempt [3..6]ts [7..12]prefix6 [13..]text (§4 #2)', () => {
    const b = concatBytes(x('02 00 05'), u32le(1700000000), KEY.slice(0, 6), str('hi'));
    expect(decodeCommand(b)).toEqual({
      kind: 'sendTxtMsg',
      txtType: 0,
      attempt: 5,
      timestamp: 1700000000,
      recipient: KEY.slice(0, 6),
      text: 'hi',
    });
  });

  it('SEND_TXT_MSG: an exactly-14-byte frame has 1 byte of text; 13 bytes is ERR 1', () => {
    const b = concatBytes(x('02 00 00'), u32le(1), KEY.slice(0, 6), str('x'));
    expect(decodeCommand(b)).toMatchObject({ text: 'x' });
    expect(tryDecodeCommand(b.subarray(0, 13))).toMatchObject({ ok: false, error: { errCode: ERR.UNSUPPORTED_CMD } });
  });

  it('APP_START: app name from [8], [1..7] ignored except appVersion (§2.1)', () => {
    expect(decodeCommand(concatBytes(x('01 09 ffffffffffff'), str('app')))).toEqual({
      kind: 'appStart',
      appVersion: 9,
      appName: 'app',
    });
    expect(decodeCommand(x('01 00 000000000000'))).toEqual({ kind: 'appStart', appVersion: 0, appName: '' });
  });

  it('SET_ADVERT_NAME truncates to 31 bytes and stops at a NUL', () => {
    const long = 'abcdefghijklmnopqrstuvwxyz0123456789';
    expect(decodeCommand(concatBytes(x('08'), str(long)))).toEqual({ kind: 'setAdvertName', name: long.slice(0, 31) });
    expect(decodeCommand(x('08 41 00 42'))).toEqual({ kind: 'setAdvertName', name: 'A' });
  });

  it('ADD_UPDATE_CONTACT: lat/lon need len ≥ 144, lastmod needs 148 (§7.1); bytes up to 135 zero-filled', () => {
    const full = encodeCommand({
      kind: 'addUpdateContact',
      contact: { pubKey: KEY, type: 1, flags: 0, outPathLen: 0, name: 'Z', lastAdvert: 9, lat: 1, lon: 2, lastMod: 3 },
    });
    expect(full.length).toBe(148);
    expect(decodeCommand(full.subarray(0, 147))).toMatchObject({ contact: { lat: 1, lon: 2 } });
    expect(decodeCommand(full.subarray(0, 147))).not.toHaveProperty('contact.lastMod');
    expect(decodeCommand(full.subarray(0, 143))).not.toHaveProperty('contact.lat');
    // the L1328 guard is only len ≥ 36; name / lastAdvert then read as zeros
    expect(decodeCommand(full.subarray(0, 36))).toMatchObject({ contact: { pubKey: KEY, type: 1, name: '', lastAdvert: 0 } });
  });

  it('SET_RADIO_PARAMS without [11] means repeat OFF; short frames read zeros (no length check)', () => {
    expect(decodeCommand(concatBytes(x('0b'), u32le(869525), u32le(250000), x('0b05')))).toMatchObject({
      clientRepeat: false,
      sf: 11,
    });
    expect(decodeCommand(x('0b'))).toEqual({ kind: 'setRadioParams', freqKhz: 0, bwHz: 0, sf: 0, cr: 0, clientRepeat: false });
  });

  it('SEND_SELF_ADVERT: [1]=1 flood, anything else zero-hop', () => {
    expect(decodeCommand(x('07 02'))).toEqual({ kind: 'sendSelfAdvert', flood: false });
  });

  it('SET_OTHER_PARAMS: [1] read even when len = 1 (stale byte → 0)', () => {
    expect(decodeCommand(x('26'))).toEqual({ kind: 'setOtherParams', manualAddContacts: 0 });
  });

  it('SEND_TELEMETRY_REQ: len 4 = self, len ≥ 36 = remote, anything else ERR 1', () => {
    expect(decodeCommand(x('27 000000'))).toEqual({ kind: 'sendTelemetryReq' });
    expect(decodeCommand(concatBytes(x('27 000000'), KEY))).toEqual({ kind: 'sendTelemetryReq', pubKey: KEY });
    expect(tryDecodeCommand(x('27 0000'))).toMatchObject({ ok: false, error: { errCode: 1 } });
    expect(tryDecodeCommand(x('27 00000000'))).toMatchObject({ ok: false, error: { errCode: 1 } });
  });

  it('SEND_CHANNEL_DATA: flood path_len 0xFF has no path bytes; data_type u16 LE (§4 #62)', () => {
    expect(decodeCommand(x('3e 03 ff 3412 aabb'))).toEqual({
      kind: 'sendChannelData',
      channelIdx: 3,
      dataType: 0x1234,
      payload: x('aabb'),
    });
    // len 4: data_type high byte is past the end (stale → 0), payload empty
    expect(decodeCommand(x('3e 00 ff 01'))).toEqual({ kind: 'sendChannelData', channelIdx: 0, dataType: 1, payload: new Uint8Array(0) });
  });

  it('SET_DEFAULT_FLOOD_SCOPE: shorter than 48 bytes clears', () => {
    expect(decodeCommand(x('3f 41'))).toEqual({ kind: 'setDefaultFloodScope' });
  });

  it('EXPORT_CONTACT: fewer than 33 bytes exports self', () => {
    expect(decodeCommand(concatBytes(x('11'), KEY.slice(0, 31)))).toEqual({ kind: 'exportContact' });
  });

  it('SEND_ANON_REQ / BINARY_REQ data follow the 32-byte key', () => {
    expect(decodeCommand(concatBytes(x('39'), KEY, x('07')))).toEqual({ kind: 'sendAnonReq', pubKey: KEY, data: x('07') });
  });
});

describe('decodeCommand — ERR codes for malformed frames (§3, §4)', () => {
  const k = (n = 32): Uint8Array => KEY.slice(0, n);
  const cases: Array<[string, Uint8Array, number]> = [
    ['APP_START len 7', x('01 00 000000000000').subarray(0, 7), ERR.UNSUPPORTED_CMD],
    ['SEND_TXT_MSG len 13', concatBytes(x('02 00 00'), u32le(1), k(6)).subarray(0, 13), ERR.UNSUPPORTED_CMD],
    ['SET_DEVICE_TIME len 4', x('06 010203'), ERR.UNSUPPORTED_CMD],
    ['SET_ADVERT_NAME empty', x('08'), ERR.UNSUPPORTED_CMD],
    ['ADD_UPDATE_CONTACT len 35', concatBytes(x('09'), k(), x('0100')), ERR.UNSUPPORTED_CMD],
    ['RESET_PATH len 32', concatBytes(x('0d'), k(31)), ERR.UNSUPPORTED_CMD],
    ['SET_ADVERT_LATLON len 8', x('0e 01020304 050607'), ERR.UNSUPPORTED_CMD],
    ['IMPORT_CONTACT len 98', concatBytes(x('12'), new Uint8Array(97)), ERR.UNSUPPORTED_CMD],
    ['REBOOT without literal', x('13 7265626f6f'), ERR.UNSUPPORTED_CMD],
    ['DEVICE_QUERY len 1', x('16'), ERR.UNSUPPORTED_CMD],
    ['IMPORT_PRIVATE_KEY len 64', concatBytes(x('18'), PRIV.subarray(0, 63)), ERR.UNSUPPORTED_CMD],
    ['SEND_RAW_DATA len 5', x('19 00 010203'), ERR.UNSUPPORTED_CMD],
    ['SEND_RAW_DATA flood path_len', x('19 ff 01020304'), ERR.UNSUPPORTED_CMD],
    ['SEND_RAW_DATA reserved hash size', x('19 c1 aa 01020304'), ERR.UNSUPPORTED_CMD],
    ['SEND_RAW_DATA payload 3 bytes', x('19 01 aa 010203'), ERR.ILLEGAL_ARG],
    ['SEND_LOGIN len 32', concatBytes(x('1a'), k(31)), ERR.UNSUPPORTED_CMD],
    ['SEND_STATUS_REQ len 32', concatBytes(x('1b'), k(31)), ERR.UNSUPPORTED_CMD],
    ['HAS_CONNECTION len 32', concatBytes(x('1c'), k(31)), ERR.UNSUPPORTED_CMD],
    ['LOGOUT len 32', concatBytes(x('1d'), k(31)), ERR.UNSUPPORTED_CMD],
    ['GET_CHANNEL len 1', x('1f'), ERR.UNSUPPORTED_CMD],
    ['SET_CHANNEL len 49', concatBytes(x('20 01'), new Uint8Array(47)), ERR.UNSUPPORTED_CMD],
    ['SET_CHANNEL 256-bit (len 66)', concatBytes(x('20 01'), new Uint8Array(64)), ERR.UNSUPPORTED_CMD],
    ['SIGN_DATA empty', x('22'), ERR.UNSUPPORTED_CMD],
    ['SEND_TRACE_PATH len 10', x('24 01000000 02000000 00'), ERR.UNSUPPORTED_CMD],
    ['SEND_TRACE_PATH path 179 B', concatBytes(x('24 01000000 02000000 00'), new Uint8Array(179)), ERR.UNSUPPORTED_CMD],
    ['SEND_TRACE_PATH odd path for 2-byte hashes', x('24 01000000 02000000 01 aabbcc'), ERR.ILLEGAL_ARG],
    ['SEND_TRACE_PATH > 64 hops', concatBytes(x('24 01000000 02000000 00'), new Uint8Array(65)), ERR.ILLEGAL_ARG],
    ['SET_DEVICE_PIN len 4', x('25 010203'), ERR.UNSUPPORTED_CMD],
    ['SEND_TELEMETRY_REQ len 35', concatBytes(x('27 000000'), k(31)), ERR.UNSUPPORTED_CMD],
    ['SET_CUSTOM_VAR len 3', x('29 613a'), ERR.UNSUPPORTED_CMD],
    ['SET_CUSTOM_VAR without ":"', concatBytes(x('29'), str('gps1')), ERR.ILLEGAL_ARG],
    ['GET_ADVERT_PATH len 33', concatBytes(x('2a 00'), k(31)), ERR.UNSUPPORTED_CMD],
    ['SEND_BINARY_REQ len 33 (no data)', concatBytes(x('32'), k()), ERR.UNSUPPORTED_CMD],
    ['FACTORY_RESET without literal', x('33 7265736574').subarray(0, 5), ERR.UNSUPPORTED_CMD],
    ['SEND_PATH_DISCOVERY_REQ [1]≠0', concatBytes(x('34 01'), k()), ERR.UNSUPPORTED_CMD],
    ['SEND_PATH_DISCOVERY_REQ len 33', concatBytes(x('34 00'), k(31)), ERR.UNSUPPORTED_CMD],
    ['SET_FLOOD_SCOPE_KEY len 1', x('36'), ERR.UNSUPPORTED_CMD],
    ['SET_FLOOD_SCOPE_KEY [1]=2', x('36 02'), ERR.UNSUPPORTED_CMD],
    ['SEND_CONTROL_DATA without 0x80', x('37 10'), ERR.UNSUPPORTED_CMD],
    ['GET_STATS len 1', x('38'), ERR.UNSUPPORTED_CMD],
    ['SEND_ANON_REQ len 33', concatBytes(x('39'), k()), ERR.UNSUPPORTED_CMD],
    ['SET_PATH_HASH_MODE [1]≠0', x('3d 01 01'), ERR.UNSUPPORTED_CMD],
    ['SET_PATH_HASH_MODE len 2', x('3d 00'), ERR.UNSUPPORTED_CMD],
    ['SEND_CHANNEL_DATA len 3 → ERR 6', x('3e 00 ff'), ERR.ILLEGAL_ARG],
    ['SEND_CHANNEL_DATA bad path_len', x('3e 00 c1 aa 0100'), ERR.ILLEGAL_ARG],
    ['SET_DEFAULT_FLOOD_SCOPE empty name', concatBytes(x('3f'), new Uint8Array(47)), ERR.ILLEGAL_ARG],
    ['SET_DEFAULT_FLOOD_SCOPE 31-char name', concatBytes(x('3f'), str('a'.repeat(31)), SECRET), ERR.ILLEGAL_ARG],
    ['SEND_RAW_PACKET len 3', x('41 00 11'), ERR.UNSUPPORTED_CMD],
    ['RUN_CLI_COMMAND len 2', x('42 61'), ERR.UNSUPPORTED_CMD],
    ['unassigned 0x2c', x('2c'), ERR.UNSUPPORTED_CMD],
    ['unassigned 0x35', x('35'), ERR.UNSUPPORTED_CMD],
    ['unknown 0xff', x('ff 00'), ERR.UNSUPPORTED_CMD],
  ];

  it.each(cases)('%s → ERR %i', (_name, bytes, errCode) => {
    const r = tryDecodeCommand(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.errCode).toBe(errCode);
      expect(r.error.code).toBe(bytes[0]);
      expect(r.error.actual).toBe(bytes.length);
    }
  });

  it('throws CommandDecodeError, a ProtocolDecodeError', () => {
    expect(() => decodeCommand(x('16'))).toThrow(CommandDecodeError);
    expect(() => decodeCommand(x('16'))).toThrow(ProtocolDecodeError);
    expect(() => decodeCommand(new Uint8Array(0))).toThrow(CommandDecodeError);
  });

  it('commands without length guards decode from zero-filled bytes (firmware reads a stale buffer)', () => {
    expect(decodeCommand(x('0f'))).toEqual({ kind: 'removeContact', pubKey: new Uint8Array(32) });
    expect(decodeCommand(x('03'))).toEqual({ kind: 'sendChannelTxtMsg', txtType: 0, channelIdx: 0, timestamp: 0, text: '' });
    expect(decodeCommand(x('15'))).toEqual({ kind: 'setTuningParams', rxDelayBase: 0, airtimeFactor: 0 });
    expect(decodeCommand(x('3a'))).toEqual({ kind: 'setAutoAddConfig', config: 0 });
  });
});
