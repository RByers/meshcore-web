/**
 * CayenneLPP telemetry decoder. docs/mesh-packet-format.md §4.
 *
 * Stream of `[channel u8][type u8][value, big-endian]`. Decoding stops at `channel == 0 && type ==
 * 0` (trailing padding), at an unknown type (sizes are implicit, so it cannot be skipped) and at a
 * truncated value.
 *
 * Humidity discrepancy (§4): the CayenneLPP wire format — and the firmware's own `LPPReader` —
 * encode RELATIVE_HUMIDITY (104) as 1 byte, /2 %. But `LPPDataHelpers.h` `getDataSize()` /
 * `getMultiplier()` say 2 bytes / ×10, and the sensor AVG_MIN_MAX reply is written with those, so
 * {@link decodeAvgMinMax} uses 2 bytes ×10 for humidity while {@link decodeLpp} uses 1 byte /2.
 */

import { readU32LE } from '../util/bytes.js';

export const LppType = {
  DIGITAL_INPUT: 0,
  DIGITAL_OUTPUT: 1,
  ANALOG_INPUT: 2,
  ANALOG_OUTPUT: 3,
  GENERIC_SENSOR: 100,
  LUMINOSITY: 101,
  PRESENCE: 102,
  TEMPERATURE: 103,
  RELATIVE_HUMIDITY: 104,
  ACCELEROMETER: 113,
  BAROMETRIC_PRESSURE: 115,
  VOLTAGE: 116,
  CURRENT: 117,
  FREQUENCY: 118,
  PERCENTAGE: 120,
  ALTITUDE: 121,
  LOAD: 122,
  CONCENTRATION: 125,
  POWER: 128,
  DISTANCE: 130,
  ENERGY: 131,
  DIRECTION: 132,
  UNIXTIME: 133,
  GYROMETER: 134,
  COLOUR: 135,
  GPS: 136,
  SWITCH: 142,
} as const;
export type LppTypeName = keyof typeof LppType;

interface ScalarSpec {
  shape: 'scalar';
  size: number;
  signed: boolean;
  divisor: number;
  unit: string;
}
interface Spec3 {
  shape: 'xyz';
  divisor: number;
  unit: string;
}
type Spec = ScalarSpec | Spec3 | { shape: 'gps' } | { shape: 'colour' };

const s = (size: number, signed: boolean, divisor: number, unit = ''): ScalarSpec => ({
  shape: 'scalar',
  size,
  signed,
  divisor,
  unit,
});

/** Wire sizes/encodings (§4 table). Voltage/current are read signed, as meshcore.js does. */
const SPECS: ReadonlyMap<number, Spec> = new Map<number, Spec>([
  [LppType.DIGITAL_INPUT, s(1, false, 1)],
  [LppType.DIGITAL_OUTPUT, s(1, false, 1)],
  [LppType.ANALOG_INPUT, s(2, true, 100)],
  [LppType.ANALOG_OUTPUT, s(2, true, 100)],
  [LppType.GENERIC_SENSOR, s(4, false, 1)],
  [LppType.LUMINOSITY, s(2, false, 1, 'lux')],
  [LppType.PRESENCE, s(1, false, 1)],
  [LppType.TEMPERATURE, s(2, true, 10, '°C')],
  [LppType.RELATIVE_HUMIDITY, s(1, false, 2, '%')],
  [LppType.ACCELEROMETER, { shape: 'xyz', divisor: 1000, unit: 'G' }],
  [LppType.BAROMETRIC_PRESSURE, s(2, false, 10, 'hPa')],
  [LppType.VOLTAGE, s(2, true, 100, 'V')],
  [LppType.CURRENT, s(2, true, 1000, 'A')],
  [LppType.FREQUENCY, s(4, false, 1, 'Hz')],
  [LppType.PERCENTAGE, s(1, false, 1, '%')],
  [LppType.ALTITUDE, s(2, true, 1, 'm')],
  // UNVERIFIED (doc §4): 3-byte signed /1000 kg; not emitted by firmware sensors.
  [LppType.LOAD, s(3, true, 1000, 'kg')],
  [LppType.CONCENTRATION, s(2, false, 1, 'ppm')],
  [LppType.POWER, s(2, false, 1, 'W')],
  [LppType.DISTANCE, s(4, false, 1000, 'm')],
  [LppType.ENERGY, s(4, false, 1000, 'kWh')],
  [LppType.DIRECTION, s(2, false, 1, '°')],
  [LppType.UNIXTIME, s(4, false, 1, 's')],
  [LppType.GYROMETER, { shape: 'xyz', divisor: 100, unit: '°/s' }],
  [LppType.COLOUR, { shape: 'colour' }],
  [LppType.GPS, { shape: 'gps' }],
  [LppType.SWITCH, s(1, false, 1)],
]);

const NAMES = new Map<number, LppTypeName>(Object.entries(LppType).map(([k, v]) => [v, k as LppTypeName]));

export function lppTypeName(type: number): LppTypeName | undefined {
  return NAMES.get(type);
}

/** Value size in bytes on the CayenneLPP wire, or undefined for unknown types. */
export function lppValueSize(type: number): number | undefined {
  const sp = SPECS.get(type);
  if (!sp) return undefined;
  switch (sp.shape) {
    case 'scalar':
      return sp.size;
    case 'xyz':
      return 6;
    case 'gps':
      return 9;
    case 'colour':
      return 3;
  }
}

interface ReadingBase {
  channel: number;
  type: number;
  name: LppTypeName;
  /** Offset of the channel byte within the input. */
  offset: number;
  /** Total bytes (2-byte header + value). */
  length: number;
}
export type LppReading =
  | (ReadingBase & { kind: 'scalar'; value: number; unit: string })
  | (ReadingBase & { kind: 'xyz'; x: number; y: number; z: number; unit: string })
  | (ReadingBase & { kind: 'gps'; latitude: number; longitude: number; altitude: number })
  | (ReadingBase & { kind: 'colour'; r: number; g: number; b: number });

export interface LppDecodeResult {
  readings: LppReading[];
  /** Bytes consumed by complete readings. */
  consumed: number;
  /** Set when decoding stopped early for a reason other than end-of-data padding. */
  error?: string;
}

/** Reads a big-endian integer of `size` bytes (≤ 4), optionally two's complement. */
function readBE(b: Uint8Array, off: number, size: number, signed: boolean): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + b[off + i]!;
  if (signed && v >= 2 ** (size * 8 - 1)) v -= 2 ** (size * 8);
  return v;
}

/** Decodes a CayenneLPP stream into typed readings. Never throws. */
export function decodeLpp(bytes: Uint8Array): LppDecodeResult {
  const readings: LppReading[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (i + 2 > bytes.length) {
      if (bytes[i] === 0) i = bytes.length; // single trailing pad byte
      else return { readings, consumed: i, error: `truncated header at ${i}` };
      break;
    }
    const channel = bytes[i]!;
    const type = bytes[i + 1]!;
    if (channel === 0 && type === 0) break; // end of data / zero padding
    const sp = SPECS.get(type);
    const name = NAMES.get(type);
    if (!sp || !name) return { readings, consumed: i, error: `unknown LPP type ${type} at ${i}` };
    const size = lppValueSize(type)!;
    if (i + 2 + size > bytes.length) return { readings, consumed: i, error: `truncated ${name} at ${i}` };
    const v = i + 2;
    const base: ReadingBase = { channel, type, name, offset: i, length: 2 + size };
    switch (sp.shape) {
      case 'scalar':
        readings.push({ ...base, kind: 'scalar', value: readBE(bytes, v, sp.size, sp.signed) / sp.divisor, unit: sp.unit });
        break;
      case 'xyz':
        readings.push({
          ...base,
          kind: 'xyz',
          x: readBE(bytes, v, 2, true) / sp.divisor,
          y: readBE(bytes, v + 2, 2, true) / sp.divisor,
          z: readBE(bytes, v + 4, 2, true) / sp.divisor,
          unit: sp.unit,
        });
        break;
      case 'gps':
        readings.push({
          ...base,
          kind: 'gps',
          latitude: readBE(bytes, v, 3, true) / 10000,
          longitude: readBE(bytes, v + 3, 3, true) / 10000,
          altitude: readBE(bytes, v + 6, 3, true) / 100,
        });
        break;
      case 'colour':
        readings.push({ ...base, kind: 'colour', r: bytes[v]!, g: bytes[v + 1]!, b: bytes[v + 2]! });
        break;
    }
    i += 2 + size;
  }
  return { readings, consumed: i };
}

// ---------------------------------------------------------------------------
// Sensor AVG_MIN_MAX reply (§4 end, `SENS` L165-197), using LPPDataHelpers' own size table.
// ---------------------------------------------------------------------------

/** `LPPData::getDataSize` (note humidity = 2, unknown → 1). */
export function lppHelperDataSize(type: number): number {
  switch (type) {
    case LppType.GPS:
      return 9;
    case 240: // POLYLINE (minimum)
      return 8;
    case LppType.GYROMETER:
    case LppType.ACCELEROMETER:
      return 6;
    case LppType.GENERIC_SENSOR:
    case LppType.FREQUENCY:
    case LppType.DISTANCE:
    case LppType.ENERGY:
    case LppType.UNIXTIME:
      return 4;
    case LppType.COLOUR:
      return 3;
    case LppType.ANALOG_INPUT:
    case LppType.ANALOG_OUTPUT:
    case LppType.LUMINOSITY:
    case LppType.TEMPERATURE:
    case LppType.CONCENTRATION:
    case LppType.BAROMETRIC_PRESSURE:
    case LppType.RELATIVE_HUMIDITY:
    case LppType.ALTITUDE:
    case LppType.VOLTAGE:
    case LppType.CURRENT:
    case LppType.DIRECTION:
    case LppType.POWER:
      return 2;
    default:
      return 1;
  }
}

/** `LPPData::getMultiplier` (note humidity = 10). */
export function lppHelperMultiplier(type: number): number {
  switch (type) {
    case LppType.CURRENT:
    case LppType.DISTANCE:
    case LppType.ENERGY:
      return 1000;
    case LppType.VOLTAGE:
    case LppType.ANALOG_INPUT:
    case LppType.ANALOG_OUTPUT:
      return 100;
    case LppType.TEMPERATURE:
    case LppType.BAROMETRIC_PRESSURE:
    case LppType.RELATIVE_HUMIDITY:
      return 10;
    default:
      return 1;
  }
}

/** `LPPData::isSigned`. */
export function lppHelperIsSigned(type: number): boolean {
  return (
    type === LppType.ALTITUDE ||
    type === LppType.TEMPERATURE ||
    type === LppType.GYROMETER ||
    type === LppType.ANALOG_INPUT ||
    type === LppType.ANALOG_OUTPUT ||
    type === LppType.GPS ||
    type === LppType.ACCELEROMETER
  );
}

/** `LPPData::getFloat`: big-endian, sign-magnitude via two's complement, / multiplier. Sizes > 4 use the low 32 bits. */
function helperFloat(b: Uint8Array, off: number, size: number, mult: number, signed: boolean): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = ((v << 8) + b[off + i]!) >>> 0;
  const bits = Math.min(size * 8, 32);
  if (signed) {
    const bit = 2 ** (bits - 1);
    if (v >= bit) return -(2 * bit - v) / mult;
  }
  return v / mult;
}

export interface AvgMinMaxEntry {
  channel: number;
  type: number;
  name?: LppTypeName;
  min: number;
  max: number;
  avg: number;
}

/** Sensor GET_AVG_MIN_MAX RESPONSE plaintext: `[tag u32][now u32]` + entries {ch, type, min, max, avg}. */
export function decodeAvgMinMax(pt: Uint8Array): { tag: number; now: number; entries: AvgMinMaxEntry[] } | null {
  if (pt.length < 8) return null;
  const entries: AvgMinMaxEntry[] = [];
  let i = 8;
  while (i + 2 <= pt.length) {
    const channel = pt[i]!;
    const type = pt[i + 1]!;
    if (channel === 0 && type === 0) break;
    const sz = lppHelperDataSize(type);
    if (i + 2 + 3 * sz > pt.length) break;
    const mult = lppHelperMultiplier(type);
    const sg = lppHelperIsSigned(type);
    const v = i + 2;
    const e: AvgMinMaxEntry = {
      channel,
      type,
      min: helperFloat(pt, v, sz, mult, sg),
      max: helperFloat(pt, v + sz, sz, mult, sg),
      avg: helperFloat(pt, v + 2 * sz, sz, mult, sg),
    };
    const name = NAMES.get(type);
    if (name) e.name = name;
    entries.push(e);
    i += 2 + 3 * sz;
  }
  return { tag: readU32LE(pt, 0), now: readU32LE(pt, 4), entries };
}
