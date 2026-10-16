import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, toHex, u16le, u32le, utf8Encode } from '../util/bytes.js';
import { PUSH, RESP, decodePathLen } from './constants.js';
import { decodeFrame, decodeRepeaterStats, decodeServerStats } from './decode.js';
import { encodeDeviceFrame, encodeRepeaterStats, encodeServerStats } from './encode-frame.js';
import { ProtocolEncodeError } from './errors.js';
import type { DeviceFrame } from './types.js';

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const P6 = KEY.slice(0, 6);
const x = (s: string): Uint8Array => fromHex(s.replace(/\s+/g, ''));
const str = (s: string): Uint8Array => utf8Encode(s);
const i16le = (v: number): Uint8Array => u16le(v & 0xffff);
const i32le = (v: number): Uint8Array => u32le(v >>> 0);
const pad = (b: Uint8Array, n: number): Uint8Array => {
  const out = new Uint8Array(n);
  out.set(b);
  return out;
};

function contactBytes(code: number, outPathLen: number, path: Uint8Array, name: string): Uint8Array {
  return concatBytes(
    Uint8Array.of(code),
    KEY,
    Uint8Array.of(3, 0x11, outPathLen),
    pad(path, 64),
    pad(str(name), 32),
    u32le(1700000000),
    i32le(47606209),
    i32le(-122332071),
    u32le(1700000500),
  );
}

const STATUS_COMMON = concatBytes(
  u16le(4100), u16le(2), i16le(-110), i16le(-80),
  u32le(1000), u32le(900), u32le(55), u32le(86400),
  u32le(10), u32le(20), u32le(30), u32le(40),
  u16le(1), i16le(-27), u16le(3), u16le(4),
);

/**
 * One wire-exact fixture per device frame kind (layouts per companion-protocol.md §2-§7).
 * Each must survive decodeFrame → encodeDeviceFrame unchanged.
 */
const FIXTURES: Array<[string, Uint8Array]> = [
  ['OK §3', x('00')],
  ['ERR §3', x('01 06')],
  ['CONTACTS_START §5.2', concatBytes(x('02'), u32le(42))],
  ['CONTACT §7.1 (2-byte hashes)', contactBytes(0x03, 0x42, x('a1a2b1b2'), 'Alice')],
  ['CONTACT §7.1 (flood)', contactBytes(0x03, 0xff, new Uint8Array(0), 'Bob')],
  ['END_OF_CONTACTS §5.2', concatBytes(x('04'), u32le(1700000500))],
  [
    'SELF_INFO §2.2',
    concatBytes(
      x('05 01 f7 16'),
      KEY,
      i32le(-33865143),
      i32le(151209900),
      x('02 01 19 01'),
      u32le(869525),
      u32le(250000),
      x('0b 05'),
      str('Node ⛰'),
    ),
  ],
  ['SENT §5.1', concatBytes(x('06 01'), x('a1b2c3d4'), u32le(5236))],
  ['CONTACT_MSG_RECV v1 §6.2', concatBytes(x('07'), P6, x('ff 00'), u32le(1700000000), str('hello'))],
  ['CONTACT_MSG_RECV_V3 §6.2', concatBytes(x('10 f6 0000'), P6, x('43 00'), u32le(1700000000), str('héllo'))],
  ['CONTACT_MSG_RECV_V3 signed §6.2', concatBytes(x('10 1c 0000'), P6, x('02 02'), u32le(5), x('deadbeef'), str('post'))],
  ['CHANNEL_MSG_RECV v1 §6.3', concatBytes(x('08 00 03 00'), u32le(1700000001), str('Bob: hi'))],
  ['CHANNEL_MSG_RECV_V3 §6.3', concatBytes(x('11 2c 0000 01 ff 00'), u32le(1700000001), str('Al: a: b'))],
  ['CURR_TIME', concatBytes(x('09'), u32le(1700000000))],
  ['NO_MORE_MESSAGES', x('0a')],
  ['EXPORT_CONTACT §5.4', concatBytes(x('0b 11 00'), KEY, u32le(1), new Uint8Array(64), x('81'), str('Me'))],
  ['BATT_AND_STORAGE §5.3', concatBytes(x('0c'), u16le(4012), u32le(120), u32le(1024))],
  ['BATT_AND_STORAGE legacy', concatBytes(x('0c'), u16le(3700))],
  [
    'DEVICE_INFO §2.3',
    concatBytes(x('0d 0e af 08'), u32le(123456), pad(str('15 Oct 2026'), 12), pad(str('Heltec V3'), 40), pad(str('v1.18.0'), 20), x('01 02')),
  ],
  ['DEVICE_INFO v2 (short)', x('0d 02')],
  ['PRIVATE_KEY', concatBytes(x('0e'), Uint8Array.from({ length: 64 }, (_, i) => i))],
  ['DISABLED', x('0f')],
  ['CHANNEL_INFO §5.5', concatBytes(x('12 00'), pad(str('Public'), 32), x('8b3387e9c5cdea6ac9e5edbaa115cd72'))],
  ['SIGN_START', concatBytes(x('13 00'), u32le(8192))],
  ['SIGNATURE', concatBytes(x('14'), new Uint8Array(64).fill(0x5a))],
  ['CUSTOM_VARS', concatBytes(x('15'), str('gps:1,gps_interval:60'))],
  ['ADVERT_PATH', concatBytes(x('16'), u32le(1700000000), x('82 aabbccddeeff'))],
  ['TUNING_PARAMS', concatBytes(x('17'), u32le(10500), u32le(1000))],
  ['STATS core §5.6', concatBytes(x('18 00'), u16le(4100), u32le(3600), u16le(5), x('03'))],
  ['STATS radio §5.6', concatBytes(x('18 01'), i16le(-112), x('b0 25'), u32le(12), u32le(345))],
  ['STATS packets §5.6', concatBytes(x('18 02'), u32le(1), u32le(2), u32le(3), u32le(4), u32le(5), u32le(6), u32le(7))],
  ['STATS packets legacy', concatBytes(x('18 02'), u32le(1), u32le(2), u32le(3), u32le(4), u32le(5), u32le(6))],
  ['STATS unknown type', x('18 07 0102')],
  ['AUTOADD_CONFIG', x('19 1e 03')],
  ['ALLOWED_REPEAT_FREQ', concatBytes(x('1a'), u32le(433000), u32le(433000), u32le(869495), u32le(869495))],
  ['CHANNEL_DATA_RECV §6.4', concatBytes(x('1b 14 0000 02 ff'), u16le(0xffff), x('03 010203'))],
  ['DEFAULT_FLOOD_SCOPE set', concatBytes(x('1c'), pad(str('#europe'), 31), x('00112233445566778899aabbccddeeff'))],
  ['DEFAULT_FLOOD_SCOPE unset', x('1c')],
  ['CLI_REPLY', concatBytes(x('1d'), str('> OK'))],
  ['PUSH ADVERT', concatBytes(x('80'), KEY)],
  ['PUSH PATH_UPDATED', concatBytes(x('81'), KEY)],
  ['PUSH SEND_CONFIRMED §6.5', concatBytes(x('82 a1b2c3d4'), u32le(1234))],
  ['PUSH MSG_WAITING', x('83')],
  ['PUSH RAW_DATA', concatBytes(x('84 f0 b5 ff'), x('01020304'))],
  ['PUSH LOGIN_SUCCESS §6.6', concatBytes(x('85 01'), P6, u32le(1700000000), x('03 02'))],
  ['PUSH LOGIN_SUCCESS legacy', concatBytes(x('85 00'), P6)],
  ['PUSH LOGIN_FAIL', concatBytes(x('86 00'), P6)],
  ['PUSH STATUS_RESPONSE repeater', concatBytes(x('87 00'), P6, STATUS_COMMON, u32le(77), u32le(8))],
  ['PUSH STATUS_RESPONSE room', concatBytes(x('87 00'), P6, STATUS_COMMON, u16le(12), u16le(34))],
  ['PUSH LOG_RX_DATA', concatBytes(x('88 1d c4'), x('1100 0102'))],
  ['PUSH TRACE_DATA §6.7', concatBytes(x('89 00 03 00'), u32le(7), u32le(9), x('aabbcc'), x('28 14 f8'), x('1e'))],
  ['PUSH TRACE_DATA 2-byte hashes', concatBytes(x('89 00 04 01'), u32le(7), u32le(9), x('aabbccdd'), x('28 14'), x('1e'))],
  ['PUSH NEW_ADVERT', contactBytes(0x8a, 0xff, new Uint8Array(0), 'Stranger')],
  ['PUSH TELEMETRY_RESPONSE', concatBytes(x('8b 00'), P6, x('01 74 01a4'))],
  ['PUSH BINARY_RESPONSE', concatBytes(x('8c 00'), u32le(0x11223344), x('0102'))],
  ['PUSH PATH_DISCOVERY_RESPONSE', concatBytes(x('8d 00'), P6, x('02 a1a2'), x('41 b1b2'))],
  ['PUSH CONTROL_DATA', concatBytes(x('8e 18 c0 00'), x('92 1c 01020304'))],
  ['PUSH CONTACT_DELETED', concatBytes(x('8f'), KEY)],
  ['PUSH CONTACTS_FULL', x('90')],
  ['unknown code', x('7f 0102')],
];

describe('encodeDeviceFrame — decodeFrame round trip (companion-protocol.md §2-§7)', () => {
  it.each(FIXTURES)('%s', (_name, bytes) => {
    const decoded = decodeFrame(bytes);
    const encoded = encodeDeviceFrame(decoded);
    expect(toHex(encoded)).toBe(toHex(bytes));
    expect(decodeFrame(encoded)).toEqual(decoded);
  });

  it('covers every RESP and PUSH code', () => {
    const covered = new Set(FIXTURES.map(([, b]) => b[0]));
    const all = [...Object.entries(RESP), ...Object.entries(PUSH)];
    expect(all.filter(([, code]) => !covered.has(code))).toEqual([]);
  });
});

describe('encodeDeviceFrame — constructed frames', () => {
  it('SENT [1]flood [2..5]tag LE [6..9]timeout (§5.1)', () => {
    const f: DeviceFrame = { kind: 'sent', code: 0x06, flood: false, tag: 0x04030201, tagBytes: x('01020304'), estTimeoutMs: 1000 };
    expect(toHex(encodeDeviceFrame(f))).toBe('06' + '00' + '01020304' + 'e8030000');
  });

  it('V3 message frames write SNR×4 truncated like a C cast, then 2 reserved zeros', () => {
    const f: DeviceFrame = {
      kind: 'contactMsg',
      code: 0x10,
      version: 3,
      snr: -2.6,
      senderPrefix: P6,
      route: { pathLen: 0xff, receivedVia: 'direct', hops: null, hashSize: null },
      txtType: 0,
      senderTimestamp: 1,
      text: 'a',
    };
    expect(toHex(encodeDeviceFrame(f))).toBe('10' + 'f6' + '0000' + toHex(P6) + 'ff' + '00' + '01000000' + '61');
  });

  it('the code, not `version`, selects V1 vs V3 layout', () => {
    const f: DeviceFrame = {
      kind: 'channelMsg',
      code: 0x08,
      version: 3,
      snr: 5,
      channelIdx: 0,
      route: { pathLen: 0, receivedVia: 'flood', hops: 0, hashSize: 1 },
      txtType: 0,
      senderTimestamp: 0,
      text: 'x: y',
      message: 'y',
    };
    expect(encodeDeviceFrame(f).length).toBe(8 + 4);
  });

  it('rejects frames over 176 bytes (firmware writeFrame drops them)', () => {
    const f: DeviceFrame = { kind: 'cliReply', code: 0x1d, text: 'x'.repeat(176) };
    expect(() => encodeDeviceFrame(f)).toThrow(ProtocolEncodeError);
    expect(encodeDeviceFrame({ kind: 'cliReply', code: 0x1d, text: 'x'.repeat(175) }).length).toBe(176);
  });

  it('rejects inconsistent fields', () => {
    const bad: DeviceFrame = {
      kind: 'traceData',
      code: 0x89,
      pathLen: 2,
      flags: 0,
      pathHashSize: 1,
      tag: 0,
      authCode: 0,
      pathHashes: x('aabb'),
      hops: [],
      snrs: [1],
      finalSnr: 0,
    };
    expect(() => encodeDeviceFrame(bad)).toThrow(/SNRs/);
    const contact = decodeFrame(contactBytes(0x03, 0x42, x('a1a2b1b2'), 'A'));
    if (contact.kind !== 'contact') throw new Error('expected contact');
    contact.contact.outPath = x('a1');
    expect(() => encodeDeviceFrame(contact)).toThrow(/outPath/);
    expect(() =>
      encodeDeviceFrame({
        kind: 'channelInfo',
        code: 0x12,
        channel: { index: 0, name: 'n'.repeat(32), secret: new Uint8Array(16) },
      }),
    ).toThrow(/name/);
  });

  it('PATH_DISCOVERY_RESPONSE writes the path bytes after each encoded path_len', () => {
    const f: DeviceFrame = {
      kind: 'pathDiscoveryResponse',
      code: 0x8d,
      pubKeyPrefix: P6,
      outPathLen: 0x00,
      outPathInfo: decodePathLen(0),
      outPath: new Uint8Array(0),
      inPathLen: 0x01,
      inPathInfo: decodePathLen(1),
      inPath: x('ee'),
    };
    expect(toHex(encodeDeviceFrame(f))).toBe('8d00' + toHex(P6) + '00' + '01ee');
  });
});

describe('encodeRepeaterStats / encodeServerStats (mesh-packet-format.md §3.2)', () => {
  it('repeater: 56 bytes, legacy 48 when the v2 fields are absent', () => {
    const full = concatBytes(STATUS_COMMON, u32le(77), u32le(8));
    expect(toHex(encodeRepeaterStats(decodeRepeaterStats(full)))).toBe(toHex(full));
    expect(toHex(encodeRepeaterStats(decodeRepeaterStats(STATUS_COMMON)))).toBe(toHex(STATUS_COMMON));
  });

  it('room server: 52 bytes', () => {
    const b = concatBytes(STATUS_COMMON, u16le(12), u16le(34));
    expect(toHex(encodeServerStats(decodeServerStats(b)))).toBe(toHex(b));
  });
});
