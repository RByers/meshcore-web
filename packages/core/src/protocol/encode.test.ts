import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, toHex, u32le } from '../util/bytes.js';
import { CMD, ContactType, MAX_FRAME_SIZE, TxtType, encodePathLen } from './constants.js';
import { decodeContactRecord } from './decode.js';
import { encodeCommand, encodeContactRecord } from './encode.js';
import { ProtocolEncodeError } from './errors.js';
import type { Command, CommandKind } from './types.js';

/** 32-byte test key 01 02 .. 20 */
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const KEY_HEX = toHex(KEY);
const enc = (c: Command): string => toHex(encodeCommand(c));
const h = (s: string): string => s.replace(/\s+/g, '').toLowerCase();

describe('encodeCommand — session (companion-protocol.md §2)', () => {
  it('APP_START: [1]=app ver, [2..7]=0, [8..]=app name (§2.1)', () => {
    expect(enc({ kind: 'appStart' })).toBe(h('01 01 000000000000') + toHex(new TextEncoder().encode('meshcore-web')));
    expect(enc({ kind: 'appStart', appName: 'x', appVersion: 2 })).toBe(h('01 02 000000000000 78'));
    expect(encodeCommand({ kind: 'appStart', appName: '' }).length).toBe(8); // firmware guard len ≥ 8
  });

  it('DEVICE_QUERY: [1]=app_target_ver, default 3 (§2.3)', () => {
    expect(enc({ kind: 'deviceQuery' })).toBe('1603');
    expect(enc({ kind: 'deviceQuery', appTargetVer: 1 })).toBe('1601');
  });
});

describe('encodeCommand — messaging (companion-protocol.md §4 rows 2, 3, 10; §8)', () => {
  it('SEND_TXT_MSG: txt_type, attempt, timestamp u32, prefix6, text', () => {
    expect(
      enc({ kind: 'sendTxtMsg', recipient: KEY, text: 'hi', timestamp: 0x6553f100, attempt: 1 }),
    ).toBe(h('02 00 01 00f15365 010203040506 6869'));
  });

  it('SEND_TXT_MSG accepts a 6-byte prefix and CLI txt types', () => {
    expect(
      enc({ kind: 'sendTxtMsg', recipient: KEY.slice(0, 6), text: 'ver', timestamp: 1, txtType: TxtType.CLI_DATA }),
    ).toBe(h('02 01 00 01000000 010203040506 766572'));
    expect(() => enc({ kind: 'sendTxtMsg', recipient: KEY.slice(0, 5), text: 'x', timestamp: 0 })).toThrow(
      ProtocolEncodeError,
    );
  });

  it('SEND_TXT_MSG with empty text is exactly 13 bytes (firmware needs ≥ 14 → caller must send text)', () => {
    expect(encodeCommand({ kind: 'sendTxtMsg', recipient: KEY, text: '', timestamp: 0 }).length).toBe(13);
  });

  it('SEND_TXT_MSG encodes UTF-8 text', () => {
    expect(enc({ kind: 'sendTxtMsg', recipient: KEY, text: 'é', timestamp: 0 })).toBe(
      h('02 00 00 00000000 010203040506 c3a9'),
    );
  });

  it('SEND_CHANNEL_TXT_MSG: [1]txt_type=0, [2]idx, [3..6]ts, text', () => {
    expect(enc({ kind: 'sendChannelTxtMsg', channelIdx: 2, text: 'yo', timestamp: 0x01020304 })).toBe(
      h('03 00 02 04030201 796f'),
    );
  });

  it('SYNC_NEXT_MESSAGE is one byte', () => {
    expect(enc({ kind: 'syncNextMessage' })).toBe('0a');
  });

  it('rejects frames over MAX_FRAME_SIZE (§1.1)', () => {
    const text = 'a'.repeat(MAX_FRAME_SIZE - 13 + 1);
    expect(() => encodeCommand({ kind: 'sendTxtMsg', recipient: KEY, text, timestamp: 0 })).toThrow(/max 176/);
    const ok = 'a'.repeat(MAX_FRAME_SIZE - 13);
    expect(encodeCommand({ kind: 'sendTxtMsg', recipient: KEY, text: ok, timestamp: 0 }).length).toBe(176);
  });
});

describe('encodeCommand — contacts (companion-protocol.md §4, §7)', () => {
  it('GET_CONTACTS with and without since', () => {
    expect(enc({ kind: 'getContacts' })).toBe('04');
    expect(enc({ kind: 'getContacts', since: 0x12345678 })).toBe('0478563412');
  });

  it('pubkey-only commands: RESET_PATH, REMOVE, SHARE, GET_BY_KEY, HAS_CONNECTION, LOGOUT, STATUS_REQ', () => {
    const cases: [CommandKind, number][] = [
      ['resetPath', 0x0d],
      ['removeContact', 0x0f],
      ['shareContact', 0x10],
      ['getContactByKey', 0x1e],
      ['hasConnection', 0x1c],
      ['logout', 0x1d],
      ['sendStatusReq', 0x1b],
    ];
    for (const [kind, code] of cases) {
      const cmd = { kind, pubKey: KEY } as Command;
      expect(enc(cmd)).toBe(code.toString(16).padStart(2, '0') + KEY_HEX);
      expect(encodeCommand(cmd).length).toBe(33);
      expect(() => encodeCommand({ kind, pubKey: KEY.slice(0, 6) } as Command)).toThrow(/32 bytes/);
    }
  });

  it('EXPORT_CONTACT: no key = self', () => {
    expect(enc({ kind: 'exportContact' })).toBe('11');
    expect(enc({ kind: 'exportContact', pubKey: KEY })).toBe('11' + KEY_HEX);
  });

  it('IMPORT_CONTACT: raw advert packet, len > 98', () => {
    const pkt = new Uint8Array(98).fill(0xab);
    expect(enc({ kind: 'importContact', packet: pkt })).toBe('12' + toHex(pkt));
    expect(() => enc({ kind: 'importContact', packet: pkt.slice(0, 97) })).toThrow(ProtocolEncodeError);
  });

  it('ADD_UPDATE_CONTACT: full 148-byte record (§7.1)', () => {
    const path = fromHex('aabbcc');
    const bytes = encodeCommand({
      kind: 'addUpdateContact',
      contact: {
        pubKey: KEY,
        type: ContactType.REPEATER,
        flags: 0x01,
        outPathLen: 0x03,
        outPath: path,
        name: 'Rpt',
        lastAdvert: 0x01020304,
        lat: 1.5,
        lon: -2.25,
        lastMod: 0x0a0b0c0d,
      },
    });
    const expected = concatBytes(
      fromHex('09'),
      KEY,
      fromHex('02 01 03'.replace(/ /g, '')),
      path,
      new Uint8Array(61),
      new TextEncoder().encode('Rpt'),
      new Uint8Array(29),
      fromHex('04030201'),
      fromHex('60e31600'), // 1500000
      fromHex('f0aaddff'), // -2250000
      fromHex('0d0c0b0a'),
    );
    expect(bytes.length).toBe(148);
    expect(toHex(bytes)).toBe(toHex(expected));
    expect(bytes[100]).toBe(0x52); // 'R' at name offset 100
    expect(bytes[132]).toBe(0x04); // last_advert at 132
  });

  it('ADD_UPDATE_CONTACT always sends lat/lon (144 bytes), lastMod optional (148)', () => {
    // MyMesh.cpp L1328-1348: a NEW contact is built in an uninitialised stack ContactInfo and
    // updateContactFromFrame (L194-216) copies gps only if present, so lat/lon are never omitted.
    const base = { pubKey: KEY, type: 1, flags: 0, outPathLen: 0xff, name: 'A', lastAdvert: 0 };
    const noLoc = encodeCommand({ kind: 'addUpdateContact', contact: base });
    expect(noLoc.length).toBe(144);
    expect(toHex(noLoc.slice(136))).toBe(h('00000000 00000000'));
    expect(encodeCommand({ kind: 'addUpdateContact', contact: { ...base, lat: 1, lon: 2 } }).length).toBe(144);
    const withMod = encodeCommand({ kind: 'addUpdateContact', contact: { ...base, lastMod: 5 } });
    expect(withMod.length).toBe(148);
    expect(toHex(withMod.slice(136))).toBe(h('00000000 00000000 05000000'));
  });

  it('ADD_UPDATE_CONTACT rejects names > 31 bytes and paths > 64 bytes', () => {
    const base = { pubKey: KEY, type: 1, flags: 0, outPathLen: 0xff, name: 'A', lastAdvert: 0 };
    expect(() => encodeCommand({ kind: 'addUpdateContact', contact: { ...base, name: 'n'.repeat(32) } })).toThrow(
      /max 31/,
    );
    expect(() =>
      encodeCommand({ kind: 'addUpdateContact', contact: { ...base, outPath: new Uint8Array(65) } }),
    ).toThrow(/max 64/);
  });

  it('encodeContactRecord round-trips through decodeContactRecord (§7.1)', () => {
    const input = {
      pubKey: KEY,
      type: ContactType.ROOM,
      flags: 0x13,
      outPathLen: encodePathLen(2, 2),
      outPath: fromHex('a1a2b1b2'),
      name: 'Room ☃',
      lastAdvert: 1700000000,
      lat: 47.606209,
      lon: -122.332071,
      lastMod: 1700000123,
    };
    const rec = decodeContactRecord(encodeContactRecord(0x03, input));
    expect(rec).toEqual({
      ...input,
      outPathInfo: { raw: 0x42, isFlood: false, hashSize: 2, hops: 2, byteLength: 4, valid: true },
    });
  });
});

describe('encodeCommand — device settings (companion-protocol.md §4)', () => {
  it('GET/SET_DEVICE_TIME', () => {
    expect(enc({ kind: 'getDeviceTime' })).toBe('05');
    expect(enc({ kind: 'setDeviceTime', epochSecs: 0x01020304 })).toBe('0604030201');
  });

  it('SEND_SELF_ADVERT: [1] optional, 1 = flood', () => {
    expect(enc({ kind: 'sendSelfAdvert' })).toBe('07');
    expect(enc({ kind: 'sendSelfAdvert', flood: true })).toBe('0701');
    expect(enc({ kind: 'sendSelfAdvert', flood: false })).toBe('0700');
  });

  it('SET_ADVERT_NAME: name bytes, 1..31', () => {
    expect(enc({ kind: 'setAdvertName', name: 'Bob' })).toBe('08426f62');
    expect(() => enc({ kind: 'setAdvertName', name: '' })).toThrow(ProtocolEncodeError);
    expect(() => enc({ kind: 'setAdvertName', name: 'x'.repeat(32) })).toThrow(ProtocolEncodeError);
    expect(() => enc({ kind: 'setAdvertName', name: 'a\0b' })).toThrow(/NUL/);
  });

  it('SET_RADIO_PARAMS: freq kHz, bw Hz, sf, cr, [11] client repeat always sent', () => {
    expect(enc({ kind: 'setRadioParams', freqKhz: 869525, bwHz: 250000, sf: 11, cr: 5 })).toBe(
      h('0b 95440d00 90d00300 0b 05 00'),
    );
    expect(enc({ kind: 'setRadioParams', freqKhz: 869525, bwHz: 250000, sf: 11, cr: 5, clientRepeat: true })).toBe(
      h('0b 95440d00 90d00300 0b 05 01'),
    );
  });

  it('SET_RADIO_TX_POWER: i8 dBm', () => {
    expect(enc({ kind: 'setRadioTxPower', dbm: 22 })).toBe('0c16');
    expect(enc({ kind: 'setRadioTxPower', dbm: -9 })).toBe('0cf7');
    expect(() => enc({ kind: 'setRadioTxPower', dbm: 200 })).toThrow(/i8/);
  });

  it('SET_ADVERT_LATLON: i32 ×1e6, optional alt', () => {
    expect(enc({ kind: 'setAdvertLatLon', lat: 1.5, lon: -2.25 })).toBe(h('0e 60e31600 f0aaddff'));
    expect(enc({ kind: 'setAdvertLatLon', lat: 1.5, lon: -2.25, alt: 100 })).toBe(h('0e 60e31600 f0aaddff 64000000'));
  });

  it('REBOOT / FACTORY_RESET literals', () => {
    expect(enc({ kind: 'reboot' })).toBe('13' + toHex(new TextEncoder().encode('reboot')));
    expect(enc({ kind: 'factoryReset' })).toBe('337265736574');
  });

  it('GET_BATT_AND_STORAGE, GET_TUNING_PARAMS, GET_CUSTOM_VARS, GET_AUTOADD_CONFIG, GET_ALLOWED_REPEAT_FREQ, GET_DEFAULT_FLOOD_SCOPE', () => {
    expect(enc({ kind: 'getBattAndStorage' })).toBe('14');
    expect(enc({ kind: 'getTuningParams' })).toBe('2b');
    expect(enc({ kind: 'getCustomVars' })).toBe('28');
    expect(enc({ kind: 'getAutoAddConfig' })).toBe('3b');
    expect(enc({ kind: 'getAllowedRepeatFreq' })).toBe('3c');
    expect(enc({ kind: 'getDefaultFloodScope' })).toBe('40');
  });

  it('SET_TUNING_PARAMS: ×1000 u32', () => {
    expect(enc({ kind: 'setTuningParams', rxDelayBase: 0.5, airtimeFactor: 1 })).toBe(h('15 f4010000 e8030000'));
  });

  it('SET_DEVICE_PIN: u32', () => {
    expect(enc({ kind: 'setDevicePin', pin: 123456 })).toBe(h('25 40e20100'));
  });

  it('SET_OTHER_PARAMS: manual_add, telemetry modes, loc policy, multi_acks (always 5 bytes)', () => {
    expect(
      enc({
        kind: 'setOtherParams',
        manualAddContacts: 1,
        telemetryModes: { base: 2, location: 1, environment: 0 },
        advertLocPolicy: 1,
        multiAcks: 2,
      }),
    ).toBe('2601060102');
  });

  it('SET_CUSTOM_VAR: "name:value"', () => {
    expect(enc({ kind: 'setCustomVar', name: 'gps', value: '1' })).toBe('296770733a31');
    expect(() => enc({ kind: 'setCustomVar', name: 'a:b', value: '1' })).toThrow(ProtocolEncodeError);
  });

  it('SET_AUTOADD_CONFIG: config, optional max_hops', () => {
    expect(enc({ kind: 'setAutoAddConfig', config: 0x1e })).toBe('3a1e');
    expect(enc({ kind: 'setAutoAddConfig', config: 0x1e, maxHops: 3 })).toBe('3a1e03');
  });

  it('SET_PATH_HASH_MODE: [1]=0, [2]=mode 0..2', () => {
    expect(enc({ kind: 'setPathHashMode', mode: 2 })).toBe('3d0002');
    expect(() => enc({ kind: 'setPathHashMode', mode: 3 })).toThrow(ProtocolEncodeError);
  });

  it('GET_STATS: [1]=stats_type', () => {
    expect(enc({ kind: 'getStats', statsType: 1 })).toBe('3801');
  });

  it('RUN_CLI_COMMAND: text, len ≥ 3', () => {
    expect(enc({ kind: 'runCliCommand', command: 'ver' })).toBe('42766572');
    expect(() => enc({ kind: 'runCliCommand', command: 'v' })).toThrow(ProtocolEncodeError);
  });
});

describe('encodeCommand — keys & signing (companion-protocol.md §4 rows 23, 24, 33-35; §9)', () => {
  it('EXPORT/IMPORT_PRIVATE_KEY', () => {
    expect(enc({ kind: 'exportPrivateKey' })).toBe('17');
    const pk = new Uint8Array(64).fill(7);
    expect(enc({ kind: 'importPrivateKey', privateKey: pk })).toBe('18' + toHex(pk));
    expect(() => enc({ kind: 'importPrivateKey', privateKey: KEY })).toThrow(/64 bytes/);
  });

  it('SIGN_START / SIGN_DATA / SIGN_FINISH', () => {
    expect(enc({ kind: 'signStart' })).toBe('21');
    expect(enc({ kind: 'signData', chunk: fromHex('0102') })).toBe('220102');
    expect(() => enc({ kind: 'signData', chunk: new Uint8Array(0) })).toThrow(ProtocolEncodeError);
    expect(enc({ kind: 'signFinish' })).toBe('23');
  });
});

describe('encodeCommand — channels (companion-protocol.md §4 rows 31, 32, 62)', () => {
  it('GET_CHANNEL: [1]=idx', () => {
    expect(enc({ kind: 'getChannel', index: 3 })).toBe('1f03');
  });

  it('SET_CHANNEL: [1]idx, [2..33]name char[32], [34..49]secret — 50 bytes', () => {
    const secret = fromHex('8b3387e9c5cdea6ac9e5edbaa115cd72');
    const b = encodeCommand({ kind: 'setChannel', index: 1, name: 'Test', secret });
    expect(b.length).toBe(50);
    expect(toHex(b)).toBe('2001' + '54657374' + '00'.repeat(28) + toHex(secret));
    expect(() => encodeCommand({ kind: 'setChannel', index: 1, name: 'x', secret: new Uint8Array(32) })).toThrow(
      /16 bytes/,
    );
  });

  it('SEND_CHANNEL_DATA: flood (0xFF, no path bytes), data_type u16, payload', () => {
    expect(enc({ kind: 'sendChannelData', channelIdx: 1, dataType: 0xffff, payload: fromHex('0102') })).toBe(
      h('3e 01 ff ffff 0102'),
    );
  });

  it('SEND_CHANNEL_DATA: direct with path', () => {
    expect(
      enc({
        kind: 'sendChannelData',
        channelIdx: 1,
        pathLen: 0x02,
        path: fromHex('aabb'),
        dataType: 0x1234,
        payload: fromHex('ff'),
      }),
    ).toBe(h('3e 01 02 aabb 3412 ff'));
    expect(() =>
      enc({ kind: 'sendChannelData', channelIdx: 1, pathLen: 0x02, path: fromHex('aa'), dataType: 1, payload: fromHex('ff') }),
    ).toThrow(/implies 2/);
    expect(() =>
      enc({ kind: 'sendChannelData', channelIdx: 1, path: fromHex('aa'), dataType: 1, payload: fromHex('ff') }),
    ).toThrow(ProtocolEncodeError);
    expect(() =>
      enc({ kind: 'sendChannelData', channelIdx: 1, pathLen: 0xc1, dataType: 1, payload: fromHex('ff') }),
    ).toThrow(/invalid path_len/);
  });
});

describe('encodeCommand — remote requests (companion-protocol.md §4 rows 25-27, 36, 39, 42, 50, 52, 57)', () => {
  it('SEND_RAW_DATA: encoded path_len, path, payload ≥ 4', () => {
    expect(
      enc({ kind: 'sendRawData', pathLen: encodePathLen(2, 2), path: fromHex('aabbccdd'), payload: fromHex('01020304') }),
    ).toBe(h('19 42 aabbccdd 01020304'));
    expect(() => enc({ kind: 'sendRawData', pathLen: 0xff, path: new Uint8Array(0), payload: fromHex('01020304') })).toThrow(
      /flood/,
    );
    expect(() => enc({ kind: 'sendRawData', pathLen: 0, path: new Uint8Array(0), payload: fromHex('010203') })).toThrow(
      /4 bytes/,
    );
  });

  it('SEND_LOGIN: pubkey, password', () => {
    expect(enc({ kind: 'sendLogin', pubKey: KEY, password: 'pw' })).toBe('1a' + KEY_HEX + '7077');
  });

  it('SEND_TRACE_PATH: tag, auth, flags (path_sz), hashes', () => {
    expect(enc({ kind: 'sendTracePath', tag: 1, authCode: 2, path: fromHex('aabb') })).toBe(
      h('24 01000000 02000000 00 aabb'),
    );
    expect(enc({ kind: 'sendTracePath', tag: 1, authCode: 2, path: fromHex('aabbccdd'), pathHashSize: 2 })).toBe(
      h('24 01000000 02000000 01 aabbccdd'),
    );
    expect(() => enc({ kind: 'sendTracePath', tag: 1, authCode: 2, path: fromHex('aabbcc'), pathHashSize: 2 })).toThrow(
      /multiple/,
    );
    expect(() => enc({ kind: 'sendTracePath', tag: 1, authCode: 2, path: fromHex('aa'), pathHashSize: 3 })).toThrow(
      /1, 2, 4 or 8/,
    );
    expect(() => enc({ kind: 'sendTracePath', tag: 1, authCode: 2, path: new Uint8Array(0) })).toThrow(/empty/);
    expect(() => enc({ kind: 'sendTracePath', tag: 1, authCode: 2, path: new Uint8Array(65) })).toThrow(/hops/);
  });

  it('SEND_TELEMETRY_REQ: [1..3] reserved, [4..35] pubkey; len 4 = self', () => {
    expect(enc({ kind: 'sendTelemetryReq' })).toBe('27000000');
    expect(enc({ kind: 'sendTelemetryReq', pubKey: KEY })).toBe('27000000' + KEY_HEX);
  });

  it('GET_ADVERT_PATH: [1]=0, [2..33] pubkey', () => {
    expect(enc({ kind: 'getAdvertPath', pubKey: KEY })).toBe('2a00' + KEY_HEX);
  });

  it('SEND_BINARY_REQ: pubkey + request data', () => {
    expect(enc({ kind: 'sendBinaryReq', pubKey: KEY, data: fromHex('03ff') })).toBe('32' + KEY_HEX + '03ff');
    expect(() => enc({ kind: 'sendBinaryReq', pubKey: KEY, data: new Uint8Array(0) })).toThrow(ProtocolEncodeError);
  });

  it('SEND_PATH_DISCOVERY_REQ: [1]=0, [2..33] pubkey', () => {
    expect(enc({ kind: 'sendPathDiscoveryReq', pubKey: KEY })).toBe('3400' + KEY_HEX);
  });

  it('SEND_ANON_REQ: pubkey + data', () => {
    expect(enc({ kind: 'sendAnonReq', pubKey: KEY, data: fromHex('01') })).toBe('39' + KEY_HEX + '01');
    expect(() => enc({ kind: 'sendAnonReq', pubKey: KEY, data: new Uint8Array(0) })).toThrow(ProtocolEncodeError);
  });
});

describe('encodeCommand — scopes, control, raw packets (companion-protocol.md §4 rows 54, 55, 63, 65)', () => {
  it('SET_FLOOD_SCOPE_KEY: clear / key / unscoped', () => {
    expect(enc({ kind: 'setFloodScopeKey' })).toBe('3600');
    const key = new Uint8Array(16).fill(0x11);
    expect(enc({ kind: 'setFloodScopeKey', key })).toBe('3600' + toHex(key));
    expect(enc({ kind: 'setFloodScopeKey', unscoped: true })).toBe('3601');
    expect(() => enc({ kind: 'setFloodScopeKey', unscoped: true, key })).toThrow(ProtocolEncodeError);
    expect(() => enc({ kind: 'setFloodScopeKey', key: new Uint8Array(8) })).toThrow(/16 bytes/);
  });

  it('SEND_CONTROL_DATA: payload[0] & 0x80 required', () => {
    expect(enc({ kind: 'sendControlData', payload: fromHex('8102aabbccdd') })).toBe('378102aabbccdd');
    expect(() => enc({ kind: 'sendControlData', payload: fromHex('01') })).toThrow(/0x80/);
    expect(() => enc({ kind: 'sendControlData', payload: new Uint8Array(0) })).toThrow(/0x80/);
  });

  it('SET_DEFAULT_FLOOD_SCOPE: name char[31] + key[16] (48 B) or clear (1 B)', () => {
    expect(enc({ kind: 'setDefaultFloodScope' })).toBe('3f');
    const key = new Uint8Array(16).fill(0x22);
    const b = encodeCommand({ kind: 'setDefaultFloodScope', scope: { name: '#test', key } });
    expect(b.length).toBe(48);
    expect(toHex(b)).toBe('3f' + '2374657374' + '00'.repeat(26) + toHex(key));
    expect(() => enc({ kind: 'setDefaultFloodScope', scope: { name: '', key } })).toThrow(/1..30/);
    expect(() => enc({ kind: 'setDefaultFloodScope', scope: { name: 'x'.repeat(31), key } })).toThrow(/1..30/);
  });

  it('SEND_RAW_PACKET: priority + raw packet', () => {
    expect(enc({ kind: 'sendRawPacket', priority: 1, packet: fromHex('1100aabb') })).toBe('41011100aabb');
    expect(() => enc({ kind: 'sendRawPacket', priority: 1, packet: fromHex('11') })).toThrow(ProtocolEncodeError);
  });

  it('raw passthrough', () => {
    expect(enc({ kind: 'raw', bytes: fromHex('35') })).toBe('35');
  });
});

describe('encodeCommand — coverage', () => {
  it('every CMD code has an encoder producing that code as byte 0', () => {
    const samples: Command[] = [
      { kind: 'appStart' },
      { kind: 'sendTxtMsg', recipient: KEY, text: 'x', timestamp: 0 },
      { kind: 'sendChannelTxtMsg', channelIdx: 0, text: 'x', timestamp: 0 },
      { kind: 'getContacts' },
      { kind: 'getDeviceTime' },
      { kind: 'setDeviceTime', epochSecs: 0 },
      { kind: 'sendSelfAdvert' },
      { kind: 'setAdvertName', name: 'n' },
      { kind: 'addUpdateContact', contact: { pubKey: KEY, type: 1, flags: 0, outPathLen: 0xff, name: 'a', lastAdvert: 0 } },
      { kind: 'syncNextMessage' },
      { kind: 'setRadioParams', freqKhz: 869525, bwHz: 250000, sf: 11, cr: 5 },
      { kind: 'setRadioTxPower', dbm: 1 },
      { kind: 'resetPath', pubKey: KEY },
      { kind: 'setAdvertLatLon', lat: 0, lon: 0 },
      { kind: 'removeContact', pubKey: KEY },
      { kind: 'shareContact', pubKey: KEY },
      { kind: 'exportContact' },
      { kind: 'importContact', packet: new Uint8Array(100) },
      { kind: 'reboot' },
      { kind: 'getBattAndStorage' },
      { kind: 'setTuningParams', rxDelayBase: 0, airtimeFactor: 1 },
      { kind: 'deviceQuery' },
      { kind: 'exportPrivateKey' },
      { kind: 'importPrivateKey', privateKey: new Uint8Array(64) },
      { kind: 'sendRawData', pathLen: 0, path: new Uint8Array(0), payload: new Uint8Array(4) },
      { kind: 'sendLogin', pubKey: KEY, password: '' },
      { kind: 'sendStatusReq', pubKey: KEY },
      { kind: 'hasConnection', pubKey: KEY },
      { kind: 'logout', pubKey: KEY },
      { kind: 'getContactByKey', pubKey: KEY },
      { kind: 'getChannel', index: 0 },
      { kind: 'setChannel', index: 0, name: 'c', secret: new Uint8Array(16) },
      { kind: 'signStart' },
      { kind: 'signData', chunk: new Uint8Array(1) },
      { kind: 'signFinish' },
      { kind: 'sendTracePath', tag: 0, authCode: 0, path: new Uint8Array(1) },
      { kind: 'setDevicePin', pin: 0 },
      { kind: 'setOtherParams', manualAddContacts: 0, telemetryModes: { base: 0, location: 0, environment: 0 }, advertLocPolicy: 0, multiAcks: 0 },
      { kind: 'sendTelemetryReq' },
      { kind: 'getCustomVars' },
      { kind: 'setCustomVar', name: 'a', value: 'b' },
      { kind: 'getAdvertPath', pubKey: KEY },
      { kind: 'getTuningParams' },
      { kind: 'sendBinaryReq', pubKey: KEY, data: new Uint8Array(1) },
      { kind: 'factoryReset' },
      { kind: 'sendPathDiscoveryReq', pubKey: KEY },
      { kind: 'setFloodScopeKey' },
      { kind: 'sendControlData', payload: fromHex('80') },
      { kind: 'getStats', statsType: 0 },
      { kind: 'sendAnonReq', pubKey: KEY, data: new Uint8Array(1) },
      { kind: 'setAutoAddConfig', config: 0 },
      { kind: 'getAutoAddConfig' },
      { kind: 'getAllowedRepeatFreq' },
      { kind: 'setPathHashMode', mode: 0 },
      { kind: 'sendChannelData', channelIdx: 0, dataType: 1, payload: new Uint8Array(0) },
      { kind: 'setDefaultFloodScope' },
      { kind: 'getDefaultFloodScope' },
      { kind: 'sendRawPacket', priority: 0, packet: new Uint8Array(3) },
      { kind: 'runCliCommand', command: 'ver' },
    ];
    const codes = new Set(samples.map((c) => encodeCommand(c)[0]));
    for (const code of Object.values(CMD)) expect(codes.has(code)).toBe(true);
    expect(codes.size).toBe(Object.values(CMD).length);
  });

  it('u32 helper sanity (little-endian)', () => {
    expect(toHex(u32le(0x6553f100))).toBe('00f15365');
  });
});

