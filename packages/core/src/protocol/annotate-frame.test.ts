import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, u16le, u32le, utf8Encode } from '../util/bytes.js';
import type { AnnotationNode } from '../packet/annotate.js';
import { CMD, PUSH, RESP } from './constants.js';
import { annotateFrame } from './annotate-frame.js';
import { encodeCommand } from './encode.js';
import type { Command } from './types.js';

// Wire fixtures as in encode-frame.test.ts (layouts per companion-protocol.md §2-§7).
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


// One command per CMD code, as in encode.test.ts (§4 command table).
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


/** Non-bit children must tile their parent exactly (no gaps/overlaps), recursively. */
function checkTiling(n: AnnotationNode, path = n.name): void {
  const kids = (n.children ?? []).filter((c) => !c.bits && !c.decrypted);
  for (const c of n.children ?? []) {
    if (c.bits) expect([c.offset, c.length], `${path}/${c.name} bits`).toEqual([n.offset, n.length]);
  }
  if (kids.length === 0) return;
  let pos = n.offset;
  for (const c of kids) {
    expect(c.offset, `${path}/${c.name} starts at ${pos}`).toBe(pos);
    expect(c.length, `${path}/${c.name} length`).toBeGreaterThan(0);
    pos += c.length;
    checkTiling(c, `${path}/${c.name}`);
  }
  expect(pos, `${path} children end`).toBe(n.offset + n.length);
}

function leaves(n: AnnotationNode): AnnotationNode[] {
  const kids = (n.children ?? []).filter((c) => !c.bits && !c.decrypted);
  return kids.length ? kids.flatMap(leaves) : [n];
}

function find(n: AnnotationNode, name: string): AnnotationNode | undefined {
  if (n.name === name) return n;
  for (const c of n.children ?? []) {
    const f = find(c, name);
    if (f) return f;
  }
  return undefined;
}

/** Errors that come from a nested over-the-air packet (fixtures use dummy packets). */
const nestedErr = (e: string): boolean => /^(packet|advert packet|payload|control payload): /.test(e);

describe('annotateFrame — device → host (companion-protocol.md §2-§7)', () => {
  it.each(FIXTURES)('%s: covers every byte with documented fields', (name, bytes) => {
    const ann = annotateFrame('in', bytes);
    expect(ann.length).toBe(bytes.length);
    checkTiling(ann);
    const names = leaves(ann).map((l) => l.name);
    if (name === 'unknown code') {
      expect(ann.errors).toEqual(['unknown frame code 0x7f']);
      return;
    }
    expect(names.filter((n) => n.includes('truncated') || n === 'trailing bytes')).toEqual([]);
    expect(ann.errors.filter((e) => !nestedErr(e))).toEqual([]);
  });

  it('covers every RESP and PUSH code with a non-unknown name', () => {
    for (const code of [...Object.values(RESP), ...Object.values(PUSH)]) {
      const ann = annotateFrame('in', Uint8Array.of(code));
      expect(ann.value).not.toMatch(/^unknown/);
    }
  });

  it('SELF_INFO §2.2: field offsets', () => {
    const bytes = FIXTURES.find(([n]) => n.startsWith('SELF_INFO'))![1];
    const ann = annotateFrame('in', bytes);
    expect(ann.value).toBe('SELF_INFO');
    expect(find(ann, 'public key')).toMatchObject({ offset: 4, length: 32 });
    expect(find(ann, 'latitude')).toMatchObject({ offset: 36, length: 4, value: String(-33865143) });
    expect(find(ann, 'radio freq')).toMatchObject({ offset: 48, length: 4, value: '869525' });
    expect(find(ann, 'name')).toMatchObject({ offset: 58, value: JSON.stringify('Node ⛰') });
  });

  it('contact record §7.1: path, padding, name at 100, lastmod at 144', () => {
    const bytes = FIXTURES.find(([n]) => n.startsWith('CONTACT §7.1 (2-byte'))![1];
    const ann = annotateFrame('in', bytes);
    expect(find(ann, 'out_path_len')).toMatchObject({ offset: 35, meaning: '2 hops × 2 B' });
    expect(find(ann, 'out_path')).toMatchObject({ offset: 36, length: 4 });
    expect(find(ann, 'hop[1]')).toMatchObject({ offset: 38, length: 2, value: 'b1b2' });
    expect(find(ann, 'out_path padding')).toMatchObject({ offset: 40, length: 60 });
    expect(find(ann, 'name')).toMatchObject({ offset: 100, length: 32, value: '"Alice"' });
    expect(find(ann, 'lastmod')).toMatchObject({ offset: 144, length: 4 });
  });

  it('LOG_RX_DATA §6: SNR/RSSI then the nested over-the-air packet from offset 3', () => {
    const bytes = FIXTURES.find(([n]) => n === 'PUSH LOG_RX_DATA')![1];
    const ann = annotateFrame('in', bytes);
    expect(find(ann, 'SNR')).toMatchObject({ offset: 1, value: '29', meaning: '7.25 dB (×4)' });
    expect(find(ann, 'RSSI')).toMatchObject({ offset: 2, value: '-60' });
    const pkt = find(ann, 'packet')!;
    expect(pkt).toMatchObject({ offset: 3, length: 4, value: 'FLOOD ADVERT' });
    expect(find(pkt, 'header')).toMatchObject({ offset: 3, length: 1 });
    expect(find(pkt, 'path_len')).toMatchObject({ offset: 4, length: 1 });
  });

  it('TRACE_DATA §6.7: hashes, per-hop SNRs and the final SNR', () => {
    const bytes = FIXTURES.find(([n]) => n === 'PUSH TRACE_DATA 2-byte hashes')![1];
    const ann = annotateFrame('in', bytes);
    expect(find(ann, 'path hashes')).toMatchObject({ offset: 12, length: 4 });
    expect(find(ann, 'hop[1]')).toMatchObject({ offset: 14, length: 2, value: 'ccdd' });
    expect(find(ann, 'snr[1]')).toMatchObject({ offset: 17, value: '20' });
    expect(find(ann, 'final SNR')).toMatchObject({ offset: 18, value: '30' });
  });

  it('CHANNEL_MSG_RECV_V3 §6.3: SNR, reserved, text at 11', () => {
    const bytes = FIXTURES.find(([n]) => n === 'CHANNEL_MSG_RECV_V3 §6.3')![1];
    const ann = annotateFrame('in', bytes);
    expect(find(ann, 'reserved')).toMatchObject({ offset: 2, length: 2 });
    expect(find(ann, 'path_len')).toMatchObject({ offset: 5, meaning: 'received direct' });
    expect(find(ann, 'text')).toMatchObject({ offset: 11, value: '"Al: a: b"' });
  });

  it('truncated frames still tile and report an error', () => {
    const ann = annotateFrame('in', fromHex('0500'));
    checkTiling(ann);
    expect(ann.errors.length).toBe(1);
    expect(ann.errors[0]).toContain('truncated');
    expect(annotateFrame('in', new Uint8Array(0)).errors).toEqual(['empty frame']);
  });

  it('bytes beyond a fixed layout become "trailing bytes"', () => {
    const ann = annotateFrame('in', x('00 aabb'));
    expect(leaves(ann).map((l) => [l.name, l.offset, l.length])).toEqual([
      ['code', 0, 1],
      ['trailing bytes', 1, 2],
    ]);
  });
});

/** Paths of nodes without a description. */
function undescribed(n: AnnotationNode, path = n.name): string[] {
  const own = n.description ? [] : [path];
  return [...own, ...(n.children ?? []).flatMap((c) => undescribed(c, `${path}/${c.name}`))];
}

describe('annotateFrame — every field has a description (docs/companion-protocol.md)', () => {
  it.each(FIXTURES.filter(([n]) => n !== 'unknown code'))('%s', (_name, bytes) => {
    expect(undescribed(annotateFrame('in', bytes))).toEqual([]);
  });

  it('every command sample', () => {
    for (const cmd of samples) expect(undescribed(annotateFrame('out', encodeCommand(cmd))), cmd.kind).toEqual([]);
  });

  it('the code byte describes what the frame is for', () => {
    const ann = annotateFrame('out', encodeCommand({ kind: 'deviceQuery', appTargetVer: 3 }));
    expect(find(ann, 'code')!.description).toMatch(/^DEVICE_QUERY: .*protocol version/);
    expect(find(ann, 'app target ver')!.description).toContain('V3');
  });

  it('nested packets keep the packet descriptions', () => {
    const ann = annotateFrame('in', FIXTURES.find(([n]) => n === 'PUSH LOG_RX_DATA')![1]);
    expect(find(ann, 'packet')!.description).toContain('ADVERT (4)');
    expect(find(ann, 'header')!.description).toContain('Header byte');
  });
});

describe('annotateFrame — host → device (companion-protocol.md §4)', () => {
  it('every CMD code: tiles, named, no truncation or trailing bytes', () => {
    const seen = new Set<number>();
    for (const cmd of samples) {
      const bytes = encodeCommand(cmd);
      seen.add(bytes[0]!);
      const ann = annotateFrame('out', bytes);
      expect(ann.value, cmd.kind).not.toMatch(/^unknown/);
      checkTiling(ann);
      const bad = leaves(ann).filter((l) => l.name.includes('truncated') || l.name === 'trailing bytes');
      expect(bad, cmd.kind).toEqual([]);
      expect(ann.errors.filter((e) => !nestedErr(e)), cmd.kind).toEqual([]);
    }
    expect(seen.size).toBe(Object.values(CMD).length);
  });

  it('APP_START §2.1: version, 6 reserved bytes, name from 8', () => {
    const ann = annotateFrame('out', encodeCommand({ kind: 'appStart', appName: 'meshcore-web', appVersion: 1 }));
    expect(ann.value).toBe('APP_START');
    expect(find(ann, 'app version')).toMatchObject({ offset: 1, value: '1' });
    expect(find(ann, 'reserved')).toMatchObject({ offset: 2, length: 6 });
    expect(find(ann, 'app name')).toMatchObject({ offset: 8, value: '"meshcore-web"' });
  });

  it('SEND_TXT_MSG §4 #2: recipient prefix at 7, text at 13', () => {
    const ann = annotateFrame('out', encodeCommand({ kind: 'sendTxtMsg', recipient: KEY, text: 'hi', timestamp: 1700000000 }));
    expect(find(ann, 'timestamp')).toMatchObject({ offset: 3, value: '1700000000', meaning: '2023-11-14T22:13:20Z' });
    expect(find(ann, 'recipient prefix')).toMatchObject({ offset: 7, length: 6, value: '010203040506' });
    expect(find(ann, 'text')).toMatchObject({ offset: 13, length: 2, value: '"hi"' });
  });

  it('SEND_RAW_PACKET §4 #65 nests the packet annotation', () => {
    const pkt = concatBytes(x('0d 01 aa'), u32le(0x01020304), fromHex('0102'));
    const ann = annotateFrame('out', concatBytes(x('41 00'), pkt));
    const p = find(ann, 'packet')!;
    expect(p).toMatchObject({ offset: 2, length: pkt.length, value: 'FLOOD ACK' });
    expect(find(p, 'hop[0]')).toMatchObject({ offset: 4, value: 'aa' });
    expect(find(p, 'ack code')).toMatchObject({ offset: 5, length: 4 });
    void u16le;
    void utf8Encode;
  });

  it('unknown command codes are flagged and still tiled', () => {
    const ann = annotateFrame('out', x('2c 0102'));
    expect(ann.value).toBe('unknown 0x2c');
    expect(ann.errors).toEqual(['unknown command code 0x2c']);
    expect(leaves(ann).map((l) => l.name)).toEqual(['code', 'body']);
  });
});
