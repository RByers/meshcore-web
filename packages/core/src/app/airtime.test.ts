import { describe, expect, it } from 'vitest';
import { loraAirtimeMs, loraDecodeLimit, loraParamsFromSelfInfo, loraSnrFloorDb, loraSymbolMs, meshcorePreambleSymbols } from './airtime.js';

/*
 * Expected values computed by hand with the Semtech time-on-air formula (airtime.ts header;
 * SX127x datasheet §4.1.1.7, SX126x datasheet §6.1.4):
 *   T_sym = 2^SF / BW, n = preamble + 4.25 + 8 + max(ceil((8PL − 4SF + 28 + 16CRC − 20IH) / (4(SF − 2DE))), 0)·(CR + 4)
 * MeshCore preamble (firmware src/helpers/radiolib/RadioLibWrappers.h preambleLengthForSF): 32 symbols for SF ≤ 8, else 16.
 */
describe('loraAirtimeMs', () => {
  it('uses MeshCore preamble lengths', () => {
    expect(meshcorePreambleSymbols(7)).toBe(32);
    expect(meshcorePreambleSymbols(8)).toBe(32);
    expect(meshcorePreambleSymbols(9)).toBe(16);
    expect(meshcorePreambleSymbols(12)).toBe(16);
    expect(loraSymbolMs(10, 250)).toBeCloseTo(4.096, 12);
  });

  it('SF10 / BW250 / CR4/5, 20 B: 53.25 symbols × 4.096 ms = 218.112 ms', () => {
    // T_sym = 1024/250 = 4.096 ms (DE 0); ceil((160 − 40 + 44) / 40) = ceil(4.1) = 5 blocks × 5 = 25
    // n = 16 + 4.25 + 8 + 25 = 53.25
    expect(loraAirtimeMs(20, { sf: 10, bwKhz: 250, cr: 5 })).toBeCloseTo(218.112, 9);
  });

  it('SF7 / BW125 / CR4/5, 10 B: 64.25 symbols × 1.024 ms = 65.792 ms', () => {
    // T_sym = 128/125 = 1.024 ms; ceil((80 − 28 + 44) / 28) = ceil(3.43) = 4 × 5 = 20; n = 32 + 4.25 + 8 + 20
    expect(loraAirtimeMs(10, { sf: 7, bwKhz: 125, cr: 5 })).toBeCloseTo(65.792, 9);
  });

  it('SF12 / BW125 / CR4/8, 50 B with low data rate optimisation: 108.25 × 32.768 ms = 3547.136 ms', () => {
    // T_sym = 4096/125 = 32.768 ms ≥ 16 → DE 1; ceil((400 − 48 + 44) / 40) = ceil(9.9) = 10 × 8 = 80; n = 16 + 4.25 + 8 + 80
    expect(loraAirtimeMs(50, { sf: 12, bwKhz: 125, cr: 8 })).toBeCloseTo(3547.136, 9);
    // DE forced off: ceil(396 / 48) = 9 × 8 = 72; n = 100.25
    expect(loraAirtimeMs(50, { sf: 12, bwKhz: 125, cr: 8, lowDataRateOptimize: false })).toBeCloseTo(100.25 * 32.768, 9);
  });

  it('SF8 / BW62.5 / CR4/8, 0 B: 52.25 × 4.096 ms = 214.016 ms', () => {
    // T_sym = 256/62.5 = 4.096; ceil((0 − 32 + 44) / 32) = 1 × 8 = 8; n = 32 + 4.25 + 8 + 8
    expect(loraAirtimeMs(0, { sf: 8, bwKhz: 62.5, cr: 8 })).toBeCloseTo(214.016, 9);
  });

  it('implicit header, no CRC, explicit preamble', () => {
    // SF9 / BW125: T_sym = 4.096; ceil((80 − 36 + 28 − 20) / 36) = ceil(1.44) = 2 × 5 = 10; n = 8 + 4.25 + 8 + 10 = 30.25
    expect(loraAirtimeMs(10, { sf: 9, bwKhz: 125, cr: 5, preambleSymbols: 8, explicitHeader: false, crc: false })).toBeCloseTo(30.25 * 4.096, 9);
  });

  it('SF6 (SX126x formula): 66.25 × 0.512 ms = 33.92 ms', () => {
    // T_sym = 64/125 = 0.512; ceil((80 + 16 − 24 + 20) / 24) = ceil(3.83) = 4 × 5 = 20; n = 32 + 6.25 + 8 + 20
    expect(loraAirtimeMs(10, { sf: 6, bwKhz: 125, cr: 5 })).toBeCloseTo(33.92, 9);
  });

  it('rejects invalid parameters', () => {
    expect(() => loraAirtimeMs(10, { sf: 13, bwKhz: 125, cr: 5 })).toThrow(RangeError);
    expect(() => loraAirtimeMs(10, { sf: 9, bwKhz: 0, cr: 5 })).toThrow(RangeError);
    expect(() => loraAirtimeMs(10, { sf: 9, bwKhz: 125, cr: 1 })).toThrow(RangeError);
    expect(() => loraAirtimeMs(-1, { sf: 9, bwKhz: 125, cr: 5 })).toThrow(RangeError);
  });

  it('reads the radio params from SELF_INFO (bandwidth in Hz)', () => {
    expect(loraParamsFromSelfInfo({ radioSf: 10, radioBwHz: 250_000, radioCr: 5 })).toEqual({ sf: 10, bwKhz: 250, cr: 5 });
    expect(loraParamsFromSelfInfo({ radioSf: 0, radioBwHz: 0, radioCr: 0 })).toBeNull();
    expect(loraParamsFromSelfInfo(null)).toBeNull();
  });
});

describe('loraSnrFloorDb', () => {
  // Semtech SX126x datasheet table 6-1 / SX127x table 13: −2.5 dB per SF step
  it('gives the demodulation floor per spreading factor', () => {
    expect([5, 6, 7, 8, 9, 10, 11, 12].map(loraSnrFloorDb)).toEqual([-2.5, -5, -7.5, -10, -12.5, -15, -17.5, -20]);
  });

  it('is null for an unknown spreading factor', () => {
    for (const sf of [0, 4, 13, 7.5, Number.NaN]) expect(loraSnrFloorDb(sf)).toBeNull();
  });

  it('loraDecodeLimit pairs the SF with its floor; null without parameters', () => {
    expect(loraDecodeLimit({ sf: 10 })).toEqual({ sf: 10, snrDb: -15 });
    expect(loraDecodeLimit({ sf: 3 })).toBeNull();
    expect(loraDecodeLimit(null)).toBeNull();
  });
});
