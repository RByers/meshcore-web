/**
 * LoRa time on air, for the packet log's network utilisation statistics (docs/packet-stats.md §1.5).
 *
 * Semtech's formula (SX127x datasheet §4.1.1.7 "Time on air"; SX126x datasheet §6.1.4, which is
 * what RadioLib's `getTimeOnAir()` — used by the MeshCore firmware's `getEstAirtimeFor()` —
 * implements):
 *
 *   T_sym      = 2^SF / BW
 *   DE         = 1 when low data rate optimisation is on (auto: T_sym ≥ 16 ms)
 *   n_preamble = preamble + 4.25            (SF5 / SF6 on SX126x: preamble + 6.25)
 *   n_payload  = 8 + max(ceil((8·PL − 4·SF + 28 + 16·CRC − 20·IH) / (4·(SF − 2·DE))), 0) · (CR + 4)
 *                (SF5 / SF6: 8 + ceil(max(8·PL + 16·CRC − 4·SF + 20·(1 − IH), 0) / (4·SF)) · (CR + 4))
 *   T_air      = (n_preamble + n_payload) · T_sym
 *
 * with PL the payload (= MeshCore packet) length in bytes, IH = 1 for an implicit header, CRC = 1
 * when the payload CRC is on, CR = 1..4 for coding rate 4/5..4/8.
 *
 * Preamble: MeshCore does not use the LoRa default (8 symbols). Every RadioLib-based driver calls
 * `updatePreamble(sf)` → `preambleLengthForSF(sf)`: 32 symbols for SF ≤ 8, else 16
 * (firmware `src/helpers/radiolib/RadioLibWrappers.h`, companion-v1.18.0). Packets go out with an
 * explicit header and CRC on (RadioLib defaults the drivers keep).
 */

import type { SelfInfo } from '../protocol/types.js';

export interface LoraParams {
  /** Spreading factor, 5..12. */
  sf: number;
  /** Bandwidth in kHz (e.g. 62.5, 125, 250). */
  bwKhz: number;
  /** Coding rate denominator, 5..8 (4/5..4/8), as SELF_INFO reports it. */
  cr: number;
  /** Preamble length in symbols. Default: MeshCore's {@link meshcorePreambleSymbols}(sf). */
  preambleSymbols?: number;
  /** Explicit header (default true). */
  explicitHeader?: boolean;
  /** Payload CRC (default true). */
  crc?: boolean;
  /** Low data rate optimisation (default 'auto': on when the symbol time is ≥ 16 ms). */
  lowDataRateOptimize?: boolean | 'auto';
}

/** MeshCore's preamble length for a spreading factor (firmware RadioLibWrappers.h `preambleLengthForSF`). */
export function meshcorePreambleSymbols(sf: number): number {
  return sf <= 8 ? 32 : 16;
}

/** Symbol time in ms: 2^SF / BW. */
export function loraSymbolMs(sf: number, bwKhz: number): number {
  return 2 ** sf / bwKhz;
}

/** True when the parameters can be used for an airtime estimate. */
export function validLoraParams(p: Pick<LoraParams, 'sf' | 'bwKhz' | 'cr'>): boolean {
  return Number.isInteger(p.sf) && p.sf >= 5 && p.sf <= 12 && Number.isFinite(p.bwKhz) && p.bwKhz > 0 && Number.isInteger(p.cr) && p.cr >= 5 && p.cr <= 8;
}

/** Time on air (ms) of a `bytes`-long LoRa payload. Throws RangeError for invalid parameters. */
export function loraAirtimeMs(bytes: number, p: LoraParams): number {
  if (!validLoraParams(p)) throw new RangeError(`invalid LoRa parameters SF${p.sf} BW${p.bwKhz} CR4/${p.cr}`);
  if (!Number.isInteger(bytes) || bytes < 0) throw new RangeError(`invalid payload length ${bytes}`);
  const { sf, bwKhz } = p;
  const tSym = loraSymbolMs(sf, bwKhz);
  const ih = p.explicitHeader === false ? 1 : 0;
  const crc = p.crc === false ? 0 : 1;
  const ldro = p.lowDataRateOptimize ?? 'auto';
  const de = (ldro === 'auto' ? tSym >= 16 : ldro) ? 1 : 0;
  const cr = p.cr - 4;
  const preamble = p.preambleSymbols ?? meshcorePreambleSymbols(sf);
  let nPreamble: number;
  let blocks: number;
  if (sf < 7) {
    nPreamble = preamble + 6.25;
    blocks = Math.ceil(Math.max(8 * bytes + 16 * crc - 4 * sf + 20 * (1 - ih), 0) / (4 * sf));
  } else {
    nPreamble = preamble + 4.25;
    blocks = Math.max(Math.ceil((8 * bytes - 4 * sf + 28 + 16 * crc - 20 * ih) / (4 * (sf - 2 * de))), 0);
  }
  const nPayload = 8 + blocks * (cr + 4);
  return (nPreamble + nPayload) * tSym;
}

/** The radio's current LoRa parameters from SELF_INFO, or null when unknown / invalid. */
export function loraParamsFromSelfInfo(si: Pick<SelfInfo, 'radioSf' | 'radioBwHz' | 'radioCr'> | null | undefined): LoraParams | null {
  if (!si) return null;
  const p: LoraParams = { sf: si.radioSf, bwKhz: si.radioBwHz / 1000, cr: si.radioCr };
  return validLoraParams(p) ? p : null;
}
