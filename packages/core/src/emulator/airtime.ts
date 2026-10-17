/**
 * LoRa time-on-air estimate for the emulator (SENT est_timeout, §10; virtual mesh airtime), in
 * whole ms like the firmware's `getEstAirtimeFor()` (RadioLib `getTimeOnAir(len) / 1000`). The
 * formula and MeshCore's preamble lengths live in app/airtime.ts.
 */
import { loraAirtimeMs as timeOnAirMs } from '../app/airtime.js';

export function loraAirtimeMs(lenBytes: number, sf: number, bwHz: number, cr: number): number {
  return Math.floor(timeOnAirMs(lenBytes, { sf, bwKhz: bwHz / 1000, cr: Math.min(Math.max(cr, 5), 8) }));
}
