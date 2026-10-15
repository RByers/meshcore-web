import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, toHex, u16le, u32le, utf8Encode } from '../util/bytes.js';
import { PUSH, RESP } from './constants.js';
import { decodeContactRecord, decodeFrame, decodeNodeStats, decodeRepeaterStats, decodeServerStats } from './decode.js';
import { encodeContactRecord } from './encode.js';
import { ProtocolDecodeError } from './errors.js';
import type { DeviceFrame } from './types.js';

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PREFIX6 = KEY.slice(0, 6);
const x = (s: string): Uint8Array => fromHex(s.replace(/\s+/g, ''));
const str = (s: string): Uint8Array => utf8Encode(s);
const i16le = (v: number): Uint8Array => u16le(v & 0xffff);
const i32le = (v: number): Uint8Array => u32le(v >>> 0);

function dec<K extends DeviceFrame['kind']>(bytes: Uint8Array, kind: K, ctx = {}): Extract<DeviceFrame, { kind: K }> {
  const f = decodeFrame(bytes, ctx);
  expect(f.kind).toBe(kind);
  return f as Extract<DeviceFrame, { kind: K }>;
}

function expectShort(bytes: Uint8Array): void {
  expect(() => decodeFrame(bytes)).toThrow(ProtocolDecodeError);
}

/** Contact record per §7.1 with the given code. */
function contactBytes(code: number, outPathLen = 0x42, name = 'Alice'): Uint8Array {
  const path = new Uint8Array(64);
  path.set(x('a1a2b1b2'));
  path.fill(0xee, 4); // undefined bytes past the valid path
  const nameField = new Uint8Array(32);
  nameField.set(str(name));
  return concatBytes(
    Uint8Array.of(code),
    KEY,
    Uint8Array.of(2, 0x11, outPathLen),
    path,
    nameField,
    u32le(1700000000),
    i32le(47606209),
    i32le(-122332071),
    u32le(1700000500),
  );
}

describe('decodeFrame — generic (companion-protocol.md §3)', () => {
  it('OK is 1 byte; trailing bytes tolerated (DOC "optional u32")', () => {
    expect(decodeFrame(x('00'))).toEqual({ kind: 'ok', code: 0 });
    expect(decodeFrame(x('00 01020304'))).toEqual({ kind: 'ok', code: 0 });
  });

  it.each([
    [1, 'UNSUPPORTED_CMD'],
    [2, 'NOT_FOUND'],
    [3, 'TABLE_FULL'],
    [4, 'BAD_STATE'],
    [5, 'FILE_IO_ERROR'],
    [6, 'ILLEGAL_ARG'],
    [7, 'UNKNOWN'],
  ])('ERR %i → %s', (code, name) => {
    expect(decodeFrame(Uint8Array.of(0x01, code))).toEqual({ kind: 'err', code: 1, errCode: code, errName: name });
  });

  it('ERR needs 2 bytes', () => expectShort(x('01')));

  it('DISABLED (0x0F)', () => {
    expect(decodeFrame(x('0f'))).toEqual({ kind: 'disabled', code: 0x0f });
  });

  it('empty frame throws ProtocolDecodeError with code -1', () => {
    try {
      decodeFrame(new Uint8Array(0));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolDecodeError);
      expect((e as ProtocolDecodeError).code).toBe(-1);
    }
  });

  it('short-frame errors carry code/needed/actual', () => {
    try {
      decodeFrame(x('06 01 02'));
      expect.unreachable();
    } catch (e) {
      const err = e as ProtocolDecodeError;
      expect(err).toBeInstanceOf(ProtocolDecodeError);
      expect(err.name).toBe('ProtocolDecodeError');
      expect(err.code).toBe(0x06);
      expect(err.needed).toBe(10);
      expect(err.actual).toBe(3);
    }
  });

  it('unknown codes decode to {kind: "unknown"} with a copy of the bytes', () => {
    const raw = x('1e 0102');
    const f = dec(raw, 'unknown');
    expect(f.code).toBe(0x1e);
    expect(toHex(f.raw)).toBe('1e0102');
    expect(f.raw).not.toBe(raw);
    expect(dec(x('91'), 'unknown').code).toBe(0x91);
    expect(dec(x('ff'), 'unknown').code).toBe(0xff);
  });
});

describe('decodeFrame — session (companion-protocol.md §2.2, §2.3)', () => {
  const selfInfo = concatBytes(
    x('05 01 16 1e'),
    KEY,
    i32le(-33868800),
    i32le(151209300),
    x('02 01 29 01'),
    u32le(915000),
    u32le(250000),
    x('0a 05'),
    str('My Node'),
  );

  it('SELF_INFO: all fields; name runs to frame end with no NUL', () => {
    const { info } = dec(selfInfo, 'selfInfo');
    expect(info).toEqual({
      advType: 1,
      txPowerDbm: 22,
      maxTxPowerDbm: 30,
      pubKey: KEY,
      lat: -33.8688,
      lon: 151.2093,
      multiAcks: 2,
      advertLocPolicy: 1,
      telemetryModesRaw: 0x29,
      telemetryModes: { base: 1, location: 2, environment: 2 },
      manualAddContacts: 1,
      radioFreqKhz: 915000,
      radioBwHz: 250000,
      radioSf: 10,
      radioCr: 5,
      name: 'My Node',
    });
  });

  it('SELF_INFO: tx power is signed (i8)', () => {
    const b = selfInfo.slice();
    b[2] = 0xf7;
    expect(dec(b, 'selfInfo').info.txPowerDbm).toBe(-9);
  });

  it('SELF_INFO: empty name, and short frame', () => {
    expect(dec(selfInfo.slice(0, 58), 'selfInfo').info.name).toBe('');
    expectShort(selfInfo.slice(0, 57));
  });

  const deviceInfo = concatBytes(
    x('0d 0e af 28'),
    u32le(123456),
    str('15 Oct 2026'),
    x('00'),
    (() => {
      const m = new Uint8Array(40);
      m.set(str('Heltec V3'));
      return m;
    })(),
    (() => {
      const v = new Uint8Array(20);
      v.set(str('v1.18.0'));
      v.fill(0x55, 8); // garbage after the NUL is ignored
      return v;
    })(),
    x('01 02'),
  );

  it('DEVICE_INFO: 82 bytes, fixed NUL-padded strings, v9/v10 tail', () => {
    expect(deviceInfo.length).toBe(82);
    expect(dec(deviceInfo, 'deviceInfo').info).toEqual({
      firmwareVerCode: 14,
      maxContacts: 350,
      maxChannels: 40,
      blePin: 123456,
      buildDate: '15 Oct 2026',
      manufacturer: 'Heltec V3',
      firmwareVersion: 'v1.18.0',
      clientRepeat: true,
      pathHashMode: 2,
    });
  });

  it('DEVICE_INFO: older shorter frames omit later fields', () => {
    expect(dec(deviceInfo.slice(0, 80), 'deviceInfo').info).not.toHaveProperty('clientRepeat');
    expect(dec(deviceInfo.slice(0, 81), 'deviceInfo').info.clientRepeat).toBe(true);
    expect(dec(deviceInfo.slice(0, 81), 'deviceInfo').info).not.toHaveProperty('pathHashMode');
    expect(dec(x('0d 02'), 'deviceInfo').info).toEqual({ firmwareVerCode: 2 });
    expect(dec(x('0d 03 32 08'), 'deviceInfo').info).toEqual({ firmwareVerCode: 3, maxContacts: 100, maxChannels: 8 });
    expectShort(x('0d'));
  });
});

describe('decodeFrame — replies (companion-protocol.md §5)', () => {
  it('SENT: flood flag, tag u32 + raw bytes, est timeout (§5.1)', () => {
    const f = dec(x('06 01 0d0c0b0a e8030000'), 'sent');
    expect(f).toEqual({
      kind: 'sent',
      code: 6,
      flood: true,
      tag: 0x0a0b0c0d,
      tagBytes: x('0d0c0b0a'),
      estTimeoutMs: 1000,
    });
    expect(dec(x('06 00 01020304 00000000'), 'sent').flood).toBe(false);
    expect(dec(x('06 00 01020304 00000000'), 'sent', { expecting: 'sendLogin' }).for).toBe('sendLogin');
    expectShort(x('06 00 01020304 000000'));
  });

  it('CONTACTS_START / END_OF_CONTACTS (§5.2)', () => {
    expect(dec(x('02 5e010000'), 'contactsStart').total).toBe(350);
    expect(dec(x('04 f4eb5465'), 'endOfContacts').mostRecentLastMod).toBe(0x6554ebf4);
    expectShort(x('02 5e01'));
    expectShort(x('04'));
  });

  it('CONTACT (0x03): 148-byte record, outPath trimmed to hops × hash size (§7.1)', () => {
    const { contact } = dec(contactBytes(RESP.CONTACT), 'contact');
    expect(contact).toEqual({
      pubKey: KEY,
      type: 2,
      flags: 0x11,
      outPathLen: 0x42,
      outPathInfo: { raw: 0x42, isFlood: false, hashSize: 2, hops: 2, byteLength: 4, valid: true },
      outPath: x('a1a2b1b2'),
      name: 'Alice',
      lastAdvert: 1700000000,
      lat: 47.606209,
      lon: -122.332071,
      lastMod: 1700000500,
    });
  });

  it('CONTACT: out_path_len 0xFF = unknown/flood, empty path', () => {
    const { contact } = dec(contactBytes(RESP.CONTACT, 0xff), 'contact');
    expect(contact.outPathInfo.isFlood).toBe(true);
    expect(contact.outPath.length).toBe(0);
  });

  it('CONTACT: 3-byte hashes (0x80..0xBF stay unsigned, unlike meshcore.js)', () => {
    const { contact } = dec(contactBytes(RESP.CONTACT, 0x81), 'contact');
    expect(contact.outPathLen).toBe(0x81);
    expect(contact.outPathInfo).toMatchObject({ hashSize: 3, hops: 1, isFlood: false });
    expect(toHex(contact.outPath)).toBe('a1a2b1');
  });

  it('CONTACT: invalid out_path_len yields empty outPath', () => {
    const { contact } = dec(contactBytes(RESP.CONTACT, 0xc5), 'contact');
    expect(contact.outPathInfo.valid).toBe(false);
    expect(contact.outPath.length).toBe(0);
  });

  it('CONTACT: name is NUL-terminated within char[32]; short record throws', () => {
    const b = contactBytes(RESP.CONTACT, 0, 'Bob');
    b[104] = 0x7a; // garbage after NUL
    expect(dec(b, 'contact').contact.name).toBe('Bob');
    expectShort(b.slice(0, 147));
  });

  it('CONTACT: decodeContactRecord ∘ encodeContactRecord is identity on the bytes', () => {
    const b = contactBytes(RESP.CONTACT, 0x42);
    b.fill(0, 40, 100); // encoder zero-pads the unused path bytes
    const c = decodeContactRecord(b);
    expect(toHex(encodeContactRecord(RESP.CONTACT, c))).toBe(toHex(b));
  });

  it('CURR_TIME (0x09)', () => {
    expect(dec(x('09 00f15365'), 'currTime').epochSecs).toBe(0x6553f100);
    expectShort(x('09 00f153'));
  });

  it('NO_MORE_MESSAGES (0x0A)', () => {
    expect(decodeFrame(x('0a'))).toEqual({ kind: 'noMoreMessages', code: 0x0a });
  });

  it('EXPORT_CONTACT (0x0B): raw advert packet (§5.4)', () => {
    expect(toHex(dec(x('0b 1100 aabbcc'), 'exportContact').packet)).toBe('1100aabbcc');
    expectShort(x('0b'));
  });

  it('BATT_AND_STORAGE (0x0C): 11 bytes; 3-byte legacy (§5.3)', () => {
    expect(dec(x('0c 6810 00010000 00040000'), 'battAndStorage').batt).toEqual({
      batteryMv: 4200,
      storageUsedKb: 256,
      storageTotalKb: 1024,
    });
    expect(dec(x('0c 6810'), 'battAndStorage').batt).toEqual({ batteryMv: 4200 });
    expectShort(x('0c 68'));
  });

  it('PRIVATE_KEY (0x0E): 64 bytes', () => {
    const pk = new Uint8Array(64).fill(9);
    expect(dec(concatBytes(x('0e'), pk), 'privateKey').privateKey).toEqual(pk);
    expectShort(concatBytes(x('0e'), pk.slice(0, 63)));
  });

  it('CHANNEL_INFO (0x12): stop at NUL; stale bytes after it are ignored (§5.5)', () => {
    const name = new Uint8Array(32).fill(0x41); // stale "AAAA..."
    name.set(str('Public\0'));
    const secret = x('8b3387e9c5cdea6ac9e5edbaa115cd72');
    const b = concatBytes(x('12 00'), name, secret);
    expect(b.length).toBe(50);
    expect(dec(b, 'channelInfo').channel).toEqual({ index: 0, name: 'Public', secret });
    expectShort(b.slice(0, 49));
  });

  it('CHANNEL_INFO: empty slot', () => {
    const b = concatBytes(x('12 07'), new Uint8Array(48));
    expect(dec(b, 'channelInfo').channel).toEqual({ index: 7, name: '', secret: new Uint8Array(16) });
  });

  it('SIGN_START (0x13) / SIGNATURE (0x14)', () => {
    expect(dec(x('13 00 00200000'), 'signStart').maxLen).toBe(8192);
    const sig = new Uint8Array(64).fill(0x5a);
    expect(dec(concatBytes(x('14'), sig), 'signature').signature).toEqual(sig);
    expectShort(x('13 00 0020'));
    expectShort(x('14 00'));
  });

  it('CUSTOM_VARS (0x15): "name:value,..." with no NUL', () => {
    expect(dec(concatBytes(x('15'), str('gps:1,gps_interval:900')), 'customVars')).toEqual({
      kind: 'customVars',
      code: 0x15,
      raw: 'gps:1,gps_interval:900',
      vars: [
        { name: 'gps', value: '1' },
        { name: 'gps_interval', value: '900' },
      ],
    });
    expect(dec(x('15'), 'customVars').vars).toEqual([]);
    expect(dec(concatBytes(x('15'), str('flag')), 'customVars').vars).toEqual([{ name: 'flag', value: '' }]);
  });

  it('ADVERT_PATH (0x16): recv_timestamp, encoded path_len, path bytes', () => {
    const f = dec(x('16 00f15365 42 a1a2b1b2'), 'advertPath');
    expect(f.recvTimestamp).toBe(0x6553f100);
    expect(f.pathLen).toBe(0x42);
    expect(f.pathInfo.hops).toBe(2);
    expect(toHex(f.path)).toBe('a1a2b1b2');
    expectShort(x('16 00f15365 42 a1a2b1'));
  });

  it('TUNING_PARAMS (0x17): ×1000 u32 → float', () => {
    expect(dec(x('17 f4010000 e8030000'), 'tuningParams')).toMatchObject({ rxDelayBase: 0.5, airtimeFactor: 1 });
    expectShort(x('17 f4010000 e80300'));
  });

  it('STATS core (§5.6)', () => {
    expect(dec(x('18 00 6810 10270000 0300 02'), 'stats').stats).toEqual({
      type: 'core',
      batteryMv: 4200,
      uptimeSecs: 10000,
      errFlags: 3,
      outboundQueueLen: 2,
    });
    expectShort(x('18 00 6810 10270000 0300'));
  });

  it('STATS radio: i16 noise floor, i8 rssi, i8 snr×4', () => {
    expect(dec(x('18 01 8cff b5 f6 64000000 c8000000'), 'stats').stats).toEqual({
      type: 'radio',
      noiseFloorDbm: -116,
      lastRssiDbm: -75,
      lastSnr: -2.5,
      txAirSecs: 100,
      rxAirSecs: 200,
    });
    expectShort(x('18 01 8cff b5 f6 64000000 c80000'));
  });

  it('STATS packets: 30 bytes, and 26-byte legacy without recv_errors', () => {
    const body = concatBytes(...[1, 2, 3, 4, 5, 6, 7].map((n) => u32le(n)));
    const full = concatBytes(x('18 02'), body);
    expect(dec(full, 'stats').stats).toEqual({
      type: 'packets',
      recv: 1,
      sent: 2,
      sentFlood: 3,
      sentDirect: 4,
      recvFlood: 5,
      recvDirect: 6,
      recvErrors: 7,
    });
    expect(dec(full.slice(0, 26), 'stats').stats).not.toHaveProperty('recvErrors');
    expectShort(full.slice(0, 25));
  });

  it('STATS unknown type', () => {
    expect(dec(x('18 09 aabb'), 'stats').stats).toEqual({ type: 'unknown', statsType: 9, raw: x('aabb') });
    expectShort(x('18'));
  });

  it('AUTOADD_CONFIG (0x19)', () => {
    expect(dec(x('19 1e 03'), 'autoAddConfig')).toMatchObject({ config: 0x1e, maxHops: 3 });
    expectShort(x('19 1e'));
  });

  it('ALLOWED_REPEAT_FREQ (0x1A): repeated {lower, upper} kHz', () => {
    const b = concatBytes(x('1a'), u32le(433000), u32le(433000), u32le(869495), u32le(869495), u32le(918000), u32le(918000));
    expect(dec(b, 'allowedRepeatFreq').ranges).toEqual([
      { lowerKhz: 433000, upperKhz: 433000 },
      { lowerKhz: 869495, upperKhz: 869495 },
      { lowerKhz: 918000, upperKhz: 918000 },
    ]);
    expect(dec(x('1a'), 'allowedRepeatFreq').ranges).toEqual([]);
  });

  it('DEFAULT_FLOOD_SCOPE (0x1C): 48 bytes or unset', () => {
    const name = new Uint8Array(31);
    name.set(str('#seattle'));
    const key = new Uint8Array(16).fill(0x33);
    expect(dec(concatBytes(x('1c'), name, key), 'defaultFloodScope').scope).toEqual({ name: '#seattle', key });
    expect(dec(x('1c'), 'defaultFloodScope').scope).toBeNull();
    expectShort(concatBytes(x('1c'), name));
  });

  it('CLI_REPLY (0x1D): text, no NUL', () => {
    expect(dec(concatBytes(x('1d'), str('v1.18.0')), 'cliReply').text).toBe('v1.18.0');
    expect(dec(x('1d'), 'cliReply').text).toBe('');
  });
});

describe('decodeFrame — queued messages, v1 vs v3 (companion-protocol.md §6.2-§6.4)', () => {
  const v1 = concatBytes(x('07'), PREFIX6, x('02 00'), u32le(1700000000), str('hello'));
  const v3 = concatBytes(x('10 f6 0000'), PREFIX6, x('02 00'), u32le(1700000000), str('hello'));

  it('CONTACT_MSG_RECV v1 (0x07): no SNR', () => {
    expect(decodeFrame(v1)).toEqual({
      kind: 'contactMsg',
      code: 0x07,
      version: 1,
      senderPrefix: PREFIX6,
      route: { pathLen: 2, receivedVia: 'flood', hops: 2, hashSize: 1 },
      txtType: 0,
      senderTimestamp: 1700000000,
      text: 'hello',
    });
  });

  it('CONTACT_MSG_RECV_V3 (0x10): SNR×4 at [1], reserved [2..3], same fields shifted by 3', () => {
    const f = dec(v3, 'contactMsg');
    expect(f).toEqual({ ...dec(v1, 'contactMsg'), code: 0x10, version: 3, snr: -2.5 });
  });

  it('v1 and v3 normalise to the same shape (only code/version/snr differ)', () => {
    const { code: _a, version: _b, snr: _c, ...r3 } = dec(v3, 'contactMsg');
    const { code: _d, version: _e, ...r1 } = dec(v1, 'contactMsg');
    expect(r3).toEqual(r1);
  });

  it('path_len 0xFF = received direct', () => {
    const b = v3.slice();
    b[10] = 0xff;
    expect(dec(b, 'contactMsg').route).toEqual({ pathLen: 0xff, receivedVia: 'direct', hops: null, hashSize: null });
  });

  it('flood with 2-byte hashes', () => {
    const b = v1.slice();
    b[7] = 0x43;
    expect(dec(b, 'contactMsg').route).toEqual({ pathLen: 0x43, receivedVia: 'flood', hops: 3, hashSize: 2 });
  });

  it('txt_type 2 (SIGNED_PLAIN): 4-byte author prefix precedes the text', () => {
    const b1 = concatBytes(x('07'), PREFIX6, x('ff 02'), u32le(5), x('deadbeef'), str('post'));
    const f1 = dec(b1, 'contactMsg');
    expect(toHex(f1.authorPrefix!)).toBe('deadbeef');
    expect(f1.text).toBe('post');
    const b3 = concatBytes(x('10 08 0000'), PREFIX6, x('ff 02'), u32le(5), x('deadbeef'), str('post'));
    expect(dec(b3, 'contactMsg')).toMatchObject({ text: 'post', snr: 2, authorPrefix: x('deadbeef') });
    expectShort(concatBytes(x('07'), PREFIX6, x('ff 02'), u32le(5), x('dead')));
  });

  it('other txt types have no authorPrefix; empty text OK; short frames throw', () => {
    expect(dec(v1.slice(0, 13), 'contactMsg')).not.toHaveProperty('authorPrefix');
    expect(dec(v1.slice(0, 13), 'contactMsg').text).toBe('');
    expectShort(v1.slice(0, 12));
    expectShort(v3.slice(0, 15));
  });

  const ch1 = concatBytes(x('08 00 ff 00'), u32le(1700000001), str('Bob: hi: there'));
  const ch3 = concatBytes(x('11 0c 0000 00 ff 00'), u32le(1700000001), str('Bob: hi: there'));

  it('CHANNEL_MSG_RECV v1 (0x08): split sender on first ": "', () => {
    expect(decodeFrame(ch1)).toEqual({
      kind: 'channelMsg',
      code: 0x08,
      version: 1,
      channelIdx: 0,
      route: { pathLen: 0xff, receivedVia: 'direct', hops: null, hashSize: null },
      txtType: 0,
      senderTimestamp: 1700000001,
      text: 'Bob: hi: there',
      senderName: 'Bob',
      message: 'hi: there',
    });
  });

  it('CHANNEL_MSG_RECV_V3 (0x11)', () => {
    expect(decodeFrame(ch3)).toEqual({ ...decodeFrame(ch1), code: 0x11, version: 3, snr: 3 });
  });

  it('channel message without separator', () => {
    const b = concatBytes(x('08 01 05 00'), u32le(1), str('no separator'));
    const f = dec(b, 'channelMsg');
    expect(f).not.toHaveProperty('senderName');
    expect(f.message).toBe('no separator');
    expect(f.route).toMatchObject({ receivedVia: 'flood', hops: 5 });
    expectShort(b.slice(0, 7));
    expectShort(ch3.slice(0, 10));
  });

  it('CHANNEL_DATA_RECV (0x1B): snr, idx, path_len, data_type, data_len, data', () => {
    const b = x('1b f8 0000 02 ff ffff 03 aabbcc 99');
    expect(decodeFrame(b)).toEqual({
      kind: 'channelData',
      code: 0x1b,
      snr: -2,
      channelIdx: 2,
      route: { pathLen: 0xff, receivedVia: 'direct', hops: null, hashSize: null },
      dataType: 0xffff,
      data: x('aabbcc'),
    });
    expectShort(x('1b f8 0000 02 ff ffff 03 aabb'));
    expectShort(x('1b f8 0000 02 ff ffff'));
  });
});

describe('decodeFrame — pushes (companion-protocol.md §6)', () => {
  it('ADVERT (0x80), PATH_UPDATED (0x81), CONTACT_DELETED (0x8F): pubkey', () => {
    for (const [code, kind] of [
      [PUSH.ADVERT, 'advert'],
      [PUSH.PATH_UPDATED, 'pathUpdated'],
      [PUSH.CONTACT_DELETED, 'contactDeleted'],
    ] as const) {
      expect(decodeFrame(concatBytes(Uint8Array.of(code), KEY))).toEqual({ kind, code, pubKey: KEY });
      expectShort(concatBytes(Uint8Array.of(code), KEY.slice(0, 31)));
    }
  });

  it('SEND_CONFIRMED (0x82): 4-byte ack + u32 round-trip ms (§6.5)', () => {
    expect(decodeFrame(x('82 0d0c0b0a 2c010000'))).toEqual({
      kind: 'sendConfirmed',
      code: 0x82,
      ackCode: 0x0a0b0c0d,
      ackBytes: x('0d0c0b0a'),
      roundTripMs: 300,
    });
    expectShort(x('82 0d0c0b0a 2c01'));
  });

  it('MSG_WAITING (0x83) and CONTACTS_FULL (0x90): 1 byte', () => {
    expect(decodeFrame(x('83'))).toEqual({ kind: 'msgWaiting', code: 0x83 });
    expect(decodeFrame(x('90'))).toEqual({ kind: 'contactsFull', code: 0x90 });
  });

  it('RAW_DATA (0x84): snr, rssi, 0xFF reserved, payload', () => {
    expect(decodeFrame(x('84 28 a6 ff 01020304'))).toEqual({
      kind: 'rawData',
      code: 0x84,
      snr: 10,
      rssi: -90,
      payload: x('01020304'),
    });
    expectShort(x('84 28 a6'));
  });

  it('LOGIN_SUCCESS (0x85): new 14-byte format (§6.6)', () => {
    expect(decodeFrame(concatBytes(x('85 01'), PREFIX6, u32le(1700000000), x('03 02')))).toEqual({
      kind: 'loginSuccess',
      code: 0x85,
      adminFlag: 1,
      isAdmin: true,
      pubKeyPrefix: PREFIX6,
      legacy: false,
      serverTimestamp: 1700000000,
      aclPermissions: 3,
      firmwareVerLevel: 2,
    });
  });

  it('LOGIN_SUCCESS: legacy 8-byte format', () => {
    expect(decodeFrame(concatBytes(x('85 00'), PREFIX6))).toEqual({
      kind: 'loginSuccess',
      code: 0x85,
      adminFlag: 0,
      isAdmin: false,
      pubKeyPrefix: PREFIX6,
      legacy: true,
    });
    expect(dec(concatBytes(x('85 02'), PREFIX6, u32le(1), x('00 01')), 'loginSuccess').isAdmin).toBe(false);
    expectShort(concatBytes(x('85 00'), PREFIX6.slice(0, 5)));
  });

  it('LOGIN_FAIL (0x86)', () => {
    expect(decodeFrame(concatBytes(x('86 00'), PREFIX6))).toEqual({ kind: 'loginFail', code: 0x86, pubKeyPrefix: PREFIX6 });
    expectShort(x('86 00 0102'));
  });

  const common = concatBytes(
    u16le(4100), // batt
    u16le(1), // tx queue
    i16le(-118), // noise floor
    i16le(-80), // last rssi
    u32le(1000), // recv
    u32le(900), // sent
    u32le(50), // air time
    u32le(86400), // uptime
    u32le(10), // sent flood
    u32le(20), // sent direct
    u32le(30), // recv flood
    u32le(40), // recv direct
    u16le(0x0001), // err events
    i16le(-26), // last snr ×4
    u16le(5), // direct dups
    u16le(6), // flood dups
  );
  const commonDecoded = {
    batteryMv: 4100,
    txQueueLen: 1,
    noiseFloorDbm: -118,
    lastRssiDbm: -80,
    packetsRecv: 1000,
    packetsSent: 900,
    airTimeSecs: 50,
    upTimeSecs: 86400,
    sentFlood: 10,
    sentDirect: 20,
    recvFlood: 30,
    recvDirect: 40,
    errEvents: 1,
    lastSnr: -6.5,
    directDups: 5,
    floodDups: 6,
  };
  const repeater = concatBytes(common, u32le(77), u32le(3));
  const room = concatBytes(common, u16le(12), u16le(4));

  it('RepeaterStats: 56 bytes (mesh-packet-format.md §3.2)', () => {
    expect(common.length).toBe(48);
    expect(decodeRepeaterStats(repeater)).toEqual({ kind: 'repeater', ...commonDecoded, rxAirTimeSecs: 77, recvErrors: 3 });
    expect(decodeRepeaterStats(common)).toEqual({ kind: 'repeater', ...commonDecoded });
    expect(() => decodeRepeaterStats(common.slice(0, 47))).toThrow(ProtocolDecodeError);
  });

  it('ServerStats: 52 bytes (mesh-packet-format.md §3.2)', () => {
    expect(decodeServerStats(room)).toEqual({ kind: 'room', ...commonDecoded, posted: 12, postPush: 4 });
    expect(() => decodeServerStats(common)).toThrow(ProtocolDecodeError);
  });

  it('decodeNodeStats: by length or explicit type', () => {
    expect(decodeNodeStats(room)?.kind).toBe('room');
    expect(decodeNodeStats(repeater)?.kind).toBe('repeater');
    expect(decodeNodeStats(common)?.kind).toBe('repeater');
    expect(decodeNodeStats(new Uint8Array(20))).toBeNull();
    expect(decodeNodeStats(repeater, 'room')?.kind).toBe('room');
    expect(decodeNodeStats(common, 'room')).toBeNull();
    expect(decodeNodeStats(room, 'repeater')?.kind).toBe('repeater');
  });

  it('STATUS_RESPONSE (0x87): [1]=0, prefix6, status struct (§6.8)', () => {
    const f = dec(concatBytes(x('87 00'), PREFIX6, repeater), 'statusResponse');
    expect(f.pubKeyPrefix).toEqual(PREFIX6);
    expect(f.raw).toEqual(repeater);
    expect(f.stats).toEqual({ kind: 'repeater', ...commonDecoded, rxAirTimeSecs: 77, recvErrors: 3 });
    expect(dec(concatBytes(x('87 00'), PREFIX6, room), 'statusResponse').stats?.kind).toBe('room');
    expect(dec(concatBytes(x('87 00'), PREFIX6, room), 'statusResponse', { statusFrom: 'repeater' }).stats?.kind).toBe(
      'repeater',
    );
    expect(dec(concatBytes(x('87 00'), PREFIX6, x('0102')), 'statusResponse').stats).toBeNull();
    expectShort(x('87 00 0102'));
  });

  it('LOG_RX_DATA (0x88): snr, rssi, raw packet', () => {
    expect(decodeFrame(x('88 1d c4 1500 aabb'))).toEqual({
      kind: 'logRxData',
      code: 0x88,
      snr: 7.25,
      rssi: -60,
      packet: x('1500aabb'),
    });
    expectShort(x('88 1d'));
  });

  it('TRACE_DATA (0x89): 1-byte hashes (§6.7)', () => {
    const b = x('89 00 03 00 01000000 02000000 aabbcc 28 14 f0 0c');
    expect(decodeFrame(b)).toEqual({
      kind: 'traceData',
      code: 0x89,
      pathLen: 3,
      flags: 0,
      pathHashSize: 1,
      tag: 1,
      authCode: 2,
      pathHashes: x('aabbcc'),
      hops: [x('aa'), x('bb'), x('cc')],
      snrs: [10, 5, -4],
      finalSnr: 3,
    });
  });

  it('TRACE_DATA: 2-byte hashes → path_len >> 1 SNRs (meshcore.js reads path_len)', () => {
    const b = x('89 00 04 01 01000000 02000000 aabbccdd 28 14 0c');
    const f = dec(b, 'traceData');
    expect(f.pathHashSize).toBe(2);
    expect(f.hops).toEqual([x('aabb'), x('ccdd')]);
    expect(f.snrs).toEqual([10, 5]);
    expect(f.finalSnr).toBe(3);
    expectShort(b.slice(0, b.length - 1));
    expectShort(x('89 00 04 01 01000000 020000'));
  });

  it('NEW_ADVERT (0x8A): full contact record', () => {
    const f = dec(contactBytes(PUSH.NEW_ADVERT, 0xff, 'Stranger'), 'newAdvert');
    expect(f.code).toBe(0x8a);
    expect(f.contact.name).toBe('Stranger');
    expect(f.contact.outPathInfo.isFlood).toBe(true);
    expectShort(contactBytes(PUSH.NEW_ADVERT).slice(0, 100));
  });

  it('TELEMETRY_RESPONSE (0x8B): prefix6 + raw LPP (§6.9)', () => {
    expect(decodeFrame(concatBytes(x('8b 00'), PREFIX6, x('0174019a')))).toEqual({
      kind: 'telemetryResponse',
      code: 0x8b,
      pubKeyPrefix: PREFIX6,
      lpp: x('0174019a'),
    });
    expect(dec(concatBytes(x('8b 00'), PREFIX6), 'telemetryResponse').lpp.length).toBe(0);
    expectShort(x('8b 00 0102'));
  });

  it('BINARY_RESPONSE (0x8C): [1]=0, tag u32, data', () => {
    expect(decodeFrame(x('8c 00 78563412 0102'))).toEqual({
      kind: 'binaryResponse',
      code: 0x8c,
      tag: 0x12345678,
      data: x('0102'),
    });
    expectShort(x('8c 00 7856'));
  });

  it('PATH_DISCOVERY_RESPONSE (0x8D): out path then in path, both encoded', () => {
    const b = concatBytes(x('8d 00'), PREFIX6, x('42 a1a2b1b2 01 cc'));
    expect(decodeFrame(b)).toEqual({
      kind: 'pathDiscoveryResponse',
      code: 0x8d,
      pubKeyPrefix: PREFIX6,
      outPathLen: 0x42,
      outPathInfo: { raw: 0x42, isFlood: false, hashSize: 2, hops: 2, byteLength: 4, valid: true },
      outPath: x('a1a2b1b2'),
      inPathLen: 0x01,
      inPathInfo: { raw: 0x01, isFlood: false, hashSize: 1, hops: 1, byteLength: 1, valid: true },
      inPath: x('cc'),
    });
    const zero = dec(concatBytes(x('8d 00'), PREFIX6, x('00 00')), 'pathDiscoveryResponse');
    expect(zero.outPath.length + zero.inPath.length).toBe(0);
    expectShort(concatBytes(x('8d 00'), PREFIX6, x('42 a1a2b1b2')));
    expectShort(concatBytes(x('8d 00'), PREFIX6, x('42 a1a2b1b2 02 cc')));
  });

  it('CONTROL_DATA (0x8E): snr, rssi, path_len, payload', () => {
    expect(decodeFrame(x('8e 10 b0 00 9201 aabbccdd'))).toEqual({
      kind: 'controlData',
      code: 0x8e,
      snr: 4,
      rssi: -80,
      pathLen: 0,
      payload: x('9201aabbccdd'),
    });
    expectShort(x('8e 10 b0'));
  });
});

describe('decodeFrame — realistic session transcript', () => {
  it('decodes a handshake + sync sequence built from the documented layouts', () => {
    const frames = [
      // DEVICE_INFO (truncated v8-era, 80 bytes)
      concatBytes(x('0d 08 32 08'), u32le(0), str('1 Jan 2025\0\0'), new Uint8Array(40), str('v1.9.0').slice(), new Uint8Array(14)),
      // SELF_INFO
      concatBytes(x('05 01 14 16'), KEY, i32le(0), i32le(0), x('00 00 00 00'), u32le(869525), u32le(250000), x('0b 05'), str('me')),
      x('00'), // OK for SET_DEVICE_TIME
      x('02 02000000'),
      contactBytes(RESP.CONTACT, 0xff, 'one'),
      contactBytes(RESP.CONTACT, 0x00, 'two'),
      x('04 f4eb5465'),
      x('83'),
      concatBytes(x('10 28 0000'), PREFIX6, x('ff 00'), u32le(1), str('hey')),
      concatBytes(x('11 f0 0000 00 01 00'), u32le(2), str('Carol: hello all')),
      x('0a'),
      x('88 14 b0 1104 aabbcc'),
      x('01 02'),
    ];
    const kinds = frames.map((f) => decodeFrame(f).kind);
    expect(kinds).toEqual([
      'deviceInfo',
      'selfInfo',
      'ok',
      'contactsStart',
      'contact',
      'contact',
      'endOfContacts',
      'msgWaiting',
      'contactMsg',
      'channelMsg',
      'noMoreMessages',
      'logRxData',
      'err',
    ]);
    const di = dec(frames[0]!, 'deviceInfo').info;
    expect(di).toMatchObject({ firmwareVerCode: 8, maxContacts: 100, maxChannels: 8, firmwareVersion: 'v1.9.0' });
    expect(di).not.toHaveProperty('clientRepeat');
    expect(dec(frames[1]!, 'selfInfo').info).toMatchObject({ name: 'me', radioFreqKhz: 869525, radioSf: 11 });
    expect(dec(frames[9]!, 'channelMsg')).toMatchObject({ senderName: 'Carol', message: 'hello all', snr: -4 });
    expect(dec(frames[12]!, 'err').errName).toBe('NOT_FOUND');
  });

  it('every RESP and PUSH code decodes to a non-unknown kind given a valid frame', () => {
    const valid: Record<number, Uint8Array> = {
      0x00: x('00'), 0x01: x('0101'), 0x02: x('0200000000'), 0x03: contactBytes(3), 0x04: x('0400000000'),
      0x05: concatBytes(x('05'), new Uint8Array(57)), 0x06: x('06' + '00'.repeat(9)),
      0x07: x('07' + '00'.repeat(12)), 0x08: x('08' + '00'.repeat(7)), 0x09: x('0900000000'), 0x0a: x('0a'),
      0x0b: x('0b11'), 0x0c: x('0c0000'), 0x0d: x('0d0e'), 0x0e: x('0e' + '00'.repeat(64)), 0x0f: x('0f'),
      0x10: x('10' + '00'.repeat(15)), 0x11: x('11' + '00'.repeat(10)), 0x12: x('12' + '00'.repeat(49)),
      0x13: x('13' + '00'.repeat(5)), 0x14: x('14' + '00'.repeat(64)), 0x15: x('15'), 0x16: x('16' + '00'.repeat(5)),
      0x17: x('17' + '00'.repeat(8)), 0x18: x('18' + '00'.repeat(10)), 0x19: x('190000'), 0x1a: x('1a'),
      0x1b: x('1b' + '00'.repeat(8)), 0x1c: x('1c'), 0x1d: x('1d'),
      0x80: concatBytes(x('80'), KEY), 0x81: concatBytes(x('81'), KEY), 0x82: x('82' + '00'.repeat(8)), 0x83: x('83'),
      0x84: x('84000000'), 0x85: x('85' + '00'.repeat(7)), 0x86: x('86' + '00'.repeat(7)), 0x87: x('87' + '00'.repeat(7)),
      0x88: x('880000'), 0x89: x('89' + '00'.repeat(12)), 0x8a: contactBytes(0x8a), 0x8b: x('8b' + '00'.repeat(7)),
      0x8c: x('8c' + '00'.repeat(5)), 0x8d: x('8d' + '00'.repeat(9)), 0x8e: x('8e000000'),
      0x8f: concatBytes(x('8f'), KEY), 0x90: x('90'),
    };
    for (const code of [...Object.values(RESP), ...Object.values(PUSH)]) {
      const f = valid[code];
      expect(f, `fixture for 0x${code.toString(16)}`).toBeDefined();
      const d = decodeFrame(f!);
      expect(d.kind).not.toBe('unknown');
      expect(d.code).toBe(code);
    }
  });
});
