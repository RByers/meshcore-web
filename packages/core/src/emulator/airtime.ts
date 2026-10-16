/**
 * LoRa time-on-air estimate (Semtech AN1200.13 formula: explicit header, CRC on, low data rate
 * optimisation when the symbol time exceeds 16 ms). The firmware asks RadioLib
 * (`getTimeOnAir(len) / 1000`); preamble = 32 symbols for SF ≤ 8, else 16
 * (`RadioLibWrapper::preambleLengthForSF`). Used for SENT est_timeout (§10); approximate for
 * SX126x chips, whose formula differs slightly.
 */
export function loraAirtimeMs(lenBytes: number, sf: number, bwHz: number, cr: number): number {
  const tSym = (2 ** sf) / bwHz; // seconds
  const preamble = sf <= 8 ? 32 : 16;
  const de = tSym > 0.016 ? 1 : 0;
  const crDenom = Math.min(Math.max(cr, 5), 8) - 4; // 4/5 → 1 … 4/8 → 4
  const num = 8 * lenBytes - 4 * sf + 28 + 16;
  const payloadSymbols = 8 + Math.max(Math.ceil(num / (4 * (sf - 2 * de))) * (crDenom + 4), 0);
  const total = (preamble + 4.25) * tSym + payloadSymbols * tSym;
  return Math.floor(total * 1000);
}
