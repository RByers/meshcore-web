import { describe, expect, it } from 'vitest';
import {
  CMD,
  ERR,
  PATH_LEN_UNKNOWN,
  PUSH,
  RESP,
  cmdName,
  decodePathLen,
  deviceFrameName,
  directTimeoutMs,
  encodePathLen,
  errName,
  floodTimeoutMs,
  isPushCode,
  isValidPathLen,
  packTelemetryModes,
  pathByteLength,
  pushName,
  respName,
  unpackTelemetryModes,
} from './constants.js';

describe('code tables (companion-protocol.md §3, §4, §5, §6)', () => {
  it('has every command code from the §4 table', () => {
    // §4: 1..43, 50..52, 54..66 (44-49 parked, 53 unassigned)
    const expected = [
      ...Array.from({ length: 43 }, (_, i) => i + 1),
      50, 51, 52,
      ...Array.from({ length: 13 }, (_, i) => i + 54),
    ];
    expect(Object.values(CMD).sort((a, b) => a - b)).toEqual(expected);
    expect(CMD.DEVICE_QUERY).toBe(22);
    expect(CMD.RUN_CLI_COMMAND).toBe(0x42);
  });

  it('has every response code 0x00..0x1D (§5 table)', () => {
    expect(Object.values(RESP).sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it('has every push code 0x80..0x90 (§6 table)', () => {
    expect(Object.values(PUSH).sort((a, b) => a - b)).toEqual(Array.from({ length: 17 }, (_, i) => 0x80 + i));
  });

  it('maps ERR codes to names (§3)', () => {
    expect(errName(1)).toBe('UNSUPPORTED_CMD');
    expect(errName(2)).toBe('NOT_FOUND');
    expect(errName(3)).toBe('TABLE_FULL');
    expect(errName(4)).toBe('BAD_STATE');
    expect(errName(5)).toBe('FILE_IO_ERROR');
    expect(errName(6)).toBe('ILLEGAL_ARG');
    expect(errName(0)).toBe('UNKNOWN');
    expect(errName(99)).toBe('UNKNOWN');
    expect(ERR.ILLEGAL_ARG).toBe(6);
  });

  it('reverse-maps names', () => {
    expect(cmdName(0x0a)).toBe('SYNC_NEXT_MESSAGE');
    expect(cmdName(0x35)).toBeUndefined();
    expect(respName(0x1d)).toBe('CLI_REPLY');
    expect(pushName(0x83)).toBe('MSG_WAITING');
    expect(deviceFrameName(0x10)).toBe('CONTACT_MSG_RECV_V3');
    expect(deviceFrameName(0x8d)).toBe('PATH_DISCOVERY_RESPONSE');
    expect(deviceFrameName(0xfe)).toBeUndefined();
    expect(isPushCode(0x80)).toBe(true);
    expect(isPushCode(0x1d)).toBe(false);
  });
});

describe('path_len encoding (mesh-packet-format.md §1.3)', () => {
  const table: [hops: number, hashSize: number, raw: number, bytes: number][] = [
    [0, 1, 0x00, 0], // zero-hop
    [5, 1, 0x05, 5],
    [63, 1, 0x3f, 63],
    [1, 2, 0x41, 2],
    [5, 2, 0x45, 10],
    [32, 2, 0x60, 64],
    [10, 3, 0x8a, 30],
    [21, 3, 0x95, 63],
  ];

  it.each(table)('%i hops × %i B ↔ 0x%s', (hops, hashSize, raw, bytes) => {
    expect(encodePathLen(hops, hashSize)).toBe(raw);
    expect(decodePathLen(raw)).toEqual({ raw, isFlood: false, hashSize, hops, byteLength: bytes, valid: true });
    expect(pathByteLength(raw)).toBe(bytes);
    expect(isValidPathLen(raw)).toBe(true);
  });

  it('defaults to 1-byte hashes', () => {
    expect(encodePathLen(3)).toBe(0x03);
  });

  it('decodes the 0xFF flood/unknown sentinel', () => {
    expect(decodePathLen(PATH_LEN_UNKNOWN)).toEqual({
      raw: 0xff, isFlood: true, hashSize: 0, hops: 0, byteLength: 0, valid: true,
    });
    expect(pathByteLength(0xff)).toBe(0);
    // firmware isValidPathLen(0xFF) is false (hash size 4 reserved)
    expect(isValidPathLen(0xff)).toBe(false);
  });

  it('flags invalid encodings', () => {
    expect(decodePathLen(0xc1).valid).toBe(false); // hash size 4 reserved
    expect(isValidPathLen(0xc1)).toBe(false);
    expect(decodePathLen(0x61)).toMatchObject({ hops: 33, hashSize: 2, byteLength: 66, valid: false });
    expect(isValidPathLen(0x61)).toBe(false);
    expect(decodePathLen(0x96).valid).toBe(false); // 22 × 3 = 66
  });

  it('rejects unencodable inputs', () => {
    expect(() => encodePathLen(1, 0)).toThrow(RangeError);
    expect(() => encodePathLen(1, 4)).toThrow(RangeError);
    expect(() => encodePathLen(64, 1)).toThrow(RangeError);
    expect(() => encodePathLen(-1, 1)).toThrow(RangeError);
    expect(() => encodePathLen(1.5, 1)).toThrow(RangeError);
    expect(() => encodePathLen(33, 2)).toThrow(RangeError);
    expect(() => encodePathLen(22, 3)).toThrow(RangeError);
  });
});

describe('telemetry modes (companion-protocol.md §2.2 SELF_INFO[46])', () => {
  it('packs bits0-1 base, bits2-3 loc, bits4-5 env', () => {
    expect(packTelemetryModes({ base: 2, location: 1, environment: 0 })).toBe(0x06);
    expect(packTelemetryModes({ base: 1, location: 2, environment: 2 })).toBe(0x29);
    expect(unpackTelemetryModes(0x29)).toEqual({ base: 1, location: 2, environment: 2 });
    expect(unpackTelemetryModes(0xff)).toEqual({ base: 3, location: 3, environment: 3 });
  });
});

describe('timeouts (companion-protocol.md §10)', () => {
  it('flood = 500 + 16 × airtime', () => {
    expect(floodTimeoutMs(100)).toBe(2100);
  });
  it('direct = 500 + (airtime × 6 + 250) × (hops + 1), hops = path_len & 63', () => {
    expect(directTimeoutMs(100, 0)).toBe(1350);
    expect(directTimeoutMs(100, 0x42)).toBe(500 + 850 * 3);
  });
});
