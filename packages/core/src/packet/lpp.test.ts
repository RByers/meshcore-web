import { describe, expect, it } from 'vitest';
import { fromHex } from '../util/bytes.js';
import { LppType, decodeAvgMinMax, decodeLpp, lppHelperDataSize, lppTypeName, lppValueSize } from './lpp.js';

const x = (s: string): Uint8Array => fromHex(s.replace(/\s+/g, ''));

describe('CayenneLPP decoder (mesh-packet-format.md §4)', () => {
  it('firmware telemetry: voltage, temperature, humidity (1 byte /2), pressure', () => {
    const r = decodeLpp(x('01 74 019a  02 67 ff38  02 68 64  02 73 2775  0000'));
    expect(r.error).toBeUndefined();
    expect(r.readings.map((v) => (v.kind === 'scalar' ? [v.channel, v.name, v.value, v.unit] : null))).toEqual([
      [1, 'VOLTAGE', 4.1, 'V'],
      [2, 'TEMPERATURE', -20, '°C'],
      [2, 'RELATIVE_HUMIDITY', 50, '%'],
      [2, 'BAROMETRIC_PRESSURE', 1010.1, 'hPa'],
    ]);
    expect(r.readings[1]).toMatchObject({ offset: 4, length: 4 });
    expect(r.consumed).toBe(15);
  });

  it('GPS: lat/lon i24 /10000, alt i24 /100 (Cayenne spec example)', () => {
    const r = decodeLpp(x('01 88 06765f f2960a 0003e8'));
    expect(r.readings[0]).toMatchObject({ kind: 'gps', latitude: 42.3519, longitude: -87.9094, altitude: 10 });
  });

  it('accelerometer / gyrometer 3×i16, colour, generic, current/voltage read signed', () => {
    const r = decodeLpp(x('06 71 04d2 fb2e 0000  07 86 0064 ff9c 0000  08 87 ff8000  09 64 00010000  01 75 fc18  01 74 ff9c'));
    expect(r.readings[0]).toMatchObject({ kind: 'xyz', x: 1.234, y: -1.234, z: 0, unit: 'G' });
    expect(r.readings[1]).toMatchObject({ kind: 'xyz', x: 1, y: -1, z: 0 });
    expect(r.readings[2]).toMatchObject({ kind: 'colour', r: 255, g: 128, b: 0 });
    expect(r.readings[3]).toMatchObject({ kind: 'scalar', value: 65536 });
    expect(r.readings[4]).toMatchObject({ kind: 'scalar', name: 'CURRENT', value: -1 });
    expect(r.readings[5]).toMatchObject({ kind: 'scalar', name: 'VOLTAGE', value: -1 });
  });

  it('stops at unknown types and truncation with an error; tolerates a lone pad byte', () => {
    expect(decodeLpp(x('01 74 019a 01 c8 00'))).toMatchObject({ consumed: 4, error: 'unknown LPP type 200 at 4' });
    expect(decodeLpp(x('01 67 01'))).toMatchObject({ consumed: 0, error: 'truncated TEMPERATURE at 0' });
    expect(decodeLpp(x('01 74 019a 00')).error).toBeUndefined();
    expect(decodeLpp(new Uint8Array(0)).readings).toEqual([]);
  });

  it('sizes: wire humidity 1 byte vs LPPDataHelpers getDataSize 2 (doc §4 discrepancy)', () => {
    expect(lppValueSize(LppType.RELATIVE_HUMIDITY)).toBe(1);
    expect(lppHelperDataSize(LppType.RELATIVE_HUMIDITY)).toBe(2);
    expect(lppValueSize(LppType.GPS)).toBe(9);
    expect(lppValueSize(200)).toBeUndefined();
  });

  it('sensor AVG_MIN_MAX uses helper sizes/multipliers (humidity 2 bytes ×10, temp signed)', () => {
    const pt = x('01000000 02000000  01 68 01f4 0258 0226  01 67 ff9c 00c8 0032  0000');
    expect(decodeAvgMinMax(pt)).toEqual({
      tag: 1,
      now: 2,
      entries: [
        { channel: 1, type: 104, name: 'RELATIVE_HUMIDITY', min: 50, max: 60, avg: 55 },
        { channel: 1, type: 103, name: 'TEMPERATURE', min: -10, max: 20, avg: 5 },
      ],
    });
    expect(decodeAvgMinMax(x('0100'))).toBeNull();
  });
});

// docs/mesh-packet-format.md §4 (end): sensor AVG_MIN_MAX reply body `[tag u32][now u32]` then
// {channel u8, lpp_type u8, min, max, avg}, each getDataSize(type) bytes big-endian, / getMultiplier(type),
// two's complement if isSigned(type). LPPDataHelpers.h `LPPData::getFloat` accumulates into a uint32,
// so values wider than 4 bytes keep only their low 32 bits.
describe('decodeAvgMinMax value sizes (mesh-packet-format.md §4, LPPData::getFloat)', () => {
  const header = '2a000000 64000000'; // tag 42, now 100

  it('4-byte unsigned ENERGY ×1000', () => {
    const r = decodeAvgMinMax(x(`${header} 03 83 00003039 0001e240 00000000`));
    expect(r).toEqual({ tag: 42, now: 100, entries: [{ channel: 3, type: LppType.ENERGY, name: 'ENERGY', min: 12.345, max: 123.456, avg: 0 }] });
  });

  it('>4-byte GPS (9 bytes): only the low 32 bits count', () => {
    const r = decodeAvgMinMax(x(`${header} 01 88 ffffffffff0000002a 00000000000000002a 123456789a00000001`));
    expect(r!.entries).toEqual([{ channel: 1, type: LppType.GPS, name: 'GPS', min: 42, max: 42, avg: 1 }]);
  });

  it("signed 6-byte ACCELEROMETER: two's complement of the low 32 bits", () => {
    const r = decodeAvgMinMax(x(`${header} 02 71 fffffffffffe 000000000005 0000ffffff9c  0000`));
    expect(r!.entries).toEqual([{ channel: 2, type: LppType.ACCELEROMETER, name: 'ACCELEROMETER', min: -2, max: 5, avg: -100 }]);
  });

  it('unknown types are unnamed with size 1; a truncated entry ends the list', () => {
    const r = decodeAvgMinMax(x(`${header} 04 c8 01 02 03  05 83 00000001`));
    expect(r!.entries).toEqual([{ channel: 4, type: 200, min: 1, max: 2, avg: 3 }]);
  });
});

describe('lppTypeName', () => {
  it('maps known codes to names, unknown to undefined', () => {
    expect(lppTypeName(116)).toBe('VOLTAGE');
    expect(lppTypeName(LppType.GPS)).toBe('GPS');
    expect(lppTypeName(0)).toBe('DIGITAL_INPUT');
    expect(lppTypeName(200)).toBeUndefined();
    for (const [name, code] of Object.entries(LppType)) expect(lppTypeName(code)).toBe(name);
  });
});
