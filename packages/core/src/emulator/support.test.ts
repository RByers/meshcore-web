import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex as fromHexStrict, toHex, utf8Encode } from '../util/bytes.js';

const fromHex = (s: string): Uint8Array => fromHexStrict(s.replace(/\s+/g, ''));
import { loraAirtimeMs } from './airtime.js';
import { ManualClock } from './clock.js';
import { buildAdvertPacket, parseAdvertPacket, parseEnvelope } from './packet-lite.js';
import { createSeededRng, randomBytes } from './rng.js';
import { sha256Sync } from './sha256.js';

describe('sha256Sync (FIPS 180-4 test vectors)', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ])('%j', (msg, digest) => {
    expect(toHex(sha256Sync(utf8Encode(msg)))).toBe(digest);
  });

  it('1,000,000 × "a" and multi-part input', () => {
    expect(toHex(sha256Sync(new Uint8Array(1_000_000).fill(0x61)))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
    expect(sha256Sync(utf8Encode('ab'), utf8Encode('c'))).toEqual(sha256Sync(utf8Encode('abc')));
    // lengths around the 55/56/64-byte padding boundaries agree with a single-part hash
    for (const n of [55, 56, 63, 64, 65, 119, 120]) {
      const b = Uint8Array.from({ length: n }, (_, i) => i);
      expect(sha256Sync(b.subarray(0, 10), b.subarray(10))).toEqual(sha256Sync(b));
    }
  });
});

describe('ManualClock', () => {
  it('runs timers in due order (FIFO on ties), including timers added while advancing', () => {
    const c = new ManualClock(1000);
    const log: string[] = [];
    c.setTimeout(() => log.push('b@20'), 20);
    c.setTimeout(() => {
      log.push('a@10');
      c.setTimeout(() => log.push('c@15'), 5);
    }, 10);
    c.setTimeout(() => log.push('d@20'), 20);
    const cancelled = c.setTimeout(() => log.push('never'), 5);
    c.clearTimeout(cancelled);
    c.advance(19);
    expect(log).toEqual(['a@10', 'c@15']);
    expect(c.now()).toBe(1019);
    c.advance(100);
    expect(log).toEqual(['a@10', 'c@15', 'b@20', 'd@20']);
    expect(c.pendingTimers).toBe(0);
  });

  it('timers observe the time they were due', () => {
    const c = new ManualClock(0);
    let seen = -1;
    c.setTimeout(() => (seen = c.now()), 30);
    c.advance(100);
    expect(seen).toBe(30);
  });
});

describe('seeded rng', () => {
  it('is deterministic per seed', () => {
    expect(randomBytes(createSeededRng(1), 16)).toEqual(randomBytes(createSeededRng(1), 16));
    expect(randomBytes(createSeededRng(1), 16)).not.toEqual(randomBytes(createSeededRng(2), 16));
  });
});

describe('loraAirtimeMs (Semtech formula)', () => {
  it('matches the reference value for SF7/125 kHz/CR4/5, and grows with SF and length', () => {
    // 20 bytes, SF7, BW125 (Tsym 1.024 ms), CR4/5, 32-symbol preamble:
    // payload = 8 + ceil((160 − 28 + 28 + 16) / 28) × 5 = 43 symbols; (36.25 + 43) × 1.024 = 81.15 ms
    expect(loraAirtimeMs(20, 7, 125000, 5)).toBe(81);
    expect(loraAirtimeMs(50, 11, 250000, 5)).toBeGreaterThan(loraAirtimeMs(50, 9, 250000, 5));
    expect(loraAirtimeMs(100, 9, 125000, 5)).toBeGreaterThan(loraAirtimeMs(10, 9, 125000, 5));
  });
});

describe('packet-lite adverts and envelopes (mesh-packet-format.md §1, §3.5)', () => {
  const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

  it('builds a flood advert 0x11 with app_data flags/latlon/name and parses it back', () => {
    const pkt = buildAdvertPacket({ pubKey: KEY, timestamp: 1700000000, type: 2, name: 'Rpt', latE6: -1, lonE6: 2 }, new Uint8Array(64));
    expect(toHex(pkt.subarray(0, 2))).toBe('1100');
    expect(toHex(pkt.subarray(2 + 32 + 4 + 64))).toBe('92' + 'ffffffff' + '02000000' + toHex(utf8Encode('Rpt')));
    expect(parseAdvertPacket(pkt)).toMatchObject({ pubKey: KEY, timestamp: 1700000000, type: 2, name: 'Rpt', latE6: -1, lonE6: 2, hasName: true });
  });

  it('names are cut at a UTF-8 boundary so app_data ≤ 32 bytes', () => {
    const pkt = buildAdvertPacket({ pubKey: KEY, timestamp: 1, type: 1, name: 'é'.repeat(20) }, new Uint8Array(64));
    const appData = pkt.subarray(2 + 100);
    expect(appData.length).toBe(31); // 1 flag byte + 15 × 2-byte chars (a 16th would need 33)
    expect(parseAdvertPacket(pkt)?.name).toBe('é'.repeat(15));
  });

  it('envelope parsing follows tryParsePacket: transport codes, path bounds, version, payload size', () => {
    expect(parseEnvelope(fromHex('1102aabb01'))).toMatchObject({ routeType: 1, payloadType: 4, pathLen: 2, path: fromHex('aabb'), payload: fromHex('01') });
    expect(parseEnvelope(fromHex('10 3412 0000 00 01'))).toMatchObject({ transportCodes: [0x1234, 0], pathLen: 0 });
    expect(parseEnvelope(fromHex('1102aabb'))).toBeNull(); // empty payload
    expect(parseEnvelope(fromHex('1103aabb01'))).toBeNull(); // path past the end
    expect(parseEnvelope(fromHex('51 00 01'))).toBeNull(); // payload version 1
    expect(parseEnvelope(fromHex('11 c1 aa 01'))).toBeNull(); // reserved hash size
    expect(parseEnvelope(concatBytes(fromHex('1100'), new Uint8Array(185)))).toBeNull();
  });
});
