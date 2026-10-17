/**
 * Battery / temperature history of one remote node, rebuilt from the frame log (every
 * TELEMETRY_RESPONSE and STATUS_RESPONSE we received from it is archived there).
 *
 * Frames (docs/companion-protocol.md §6.8, firmware MyMesh.cpp onContactResponse):
 *  - STATUS_RESPONSE    `[0x87][reserved][pubkey prefix 6][status struct]`; the struct's
 *    `batt_milli_volts` u16 at offset 0 is common to RepeaterStats and ServerStats
 *    (mesh-packet-format.md §3.2);
 *  - TELEMETRY_RESPONSE `[0x8b][reserved][pubkey prefix 6][CayenneLPP]`.
 *
 * Battery points: status `batteryMv` (0 = not measured, skipped) and the LPP VOLTAGE reading on
 * channel 1 (TELEM_CHANNEL_SELF: the node's own battery; voltages on other channels are external
 * sensors and are not the battery). Temperature points: every LPP TEMPERATURE reading, tagged
 * with its channel (1 = MCU, others = sensors). Timestamps are the frame record's `ts` (our
 * clock when the frame arrived), never the node's clock.
 */

import { decodeLpp } from '../packet/lpp.js';
import { PUSH, REPEATER_STATS_LEGACY_SIZE, TELEM_CHANNEL_SELF } from '../protocol/constants.js';
import { decodeFrame } from '../protocol/decode.js';
import type { FrameLog } from '../store/frame-log.js';
import type { FrameRecord } from '../store/schema.js';
import { readU16LE } from '../util/bytes.js';

export type BatterySource = 'telemetry' | 'status';

export interface BatteryPoint {
  /** Epoch ms (our clock, when the response arrived). */
  ts: number;
  volts: number;
  source: BatterySource;
}

export interface TemperaturePoint {
  ts: number;
  celsius: number;
  /** LPP channel (1 = the node's MCU, others = attached sensors). */
  channel: number;
}

export interface TelemetryHistory {
  /** Oldest first. */
  battery: BatteryPoint[];
  /** Oldest first; several channels interleaved (group by `channel` for one line each). */
  temperature: TemperaturePoint[];
}

/** Frame codes that carry history points. */
export const TELEMETRY_HISTORY_CODES: readonly number[] = [PUSH.STATUS_RESPONSE, PUSH.TELEMETRY_RESPONSE];

const PREFIX_OFFSET = 2;
const PREFIX_LEN = 6;

/** True for an incoming status / telemetry response from the node whose key starts with `pubKey[0..6]`. */
export function isHistoryFrameFor(r: Pick<FrameRecord, 'direction' | 'code' | 'bytes'>, pubKey: Uint8Array): boolean {
  if (r.direction !== 'in' || !TELEMETRY_HISTORY_CODES.includes(r.code)) return false;
  if (r.bytes.length < PREFIX_OFFSET + PREFIX_LEN || pubKey.length < PREFIX_LEN) return false;
  for (let i = 0; i < PREFIX_LEN; i++) if (r.bytes[PREFIX_OFFSET + i] !== pubKey[i]) return false;
  return true;
}

/** Points carried by one frame record (empty when it is not a matching response or is malformed). */
export function historyPoints(r: FrameRecord, pubKey: Uint8Array): TelemetryHistory {
  const out: TelemetryHistory = { battery: [], temperature: [] };
  if (!isHistoryFrameFor(r, pubKey)) return out;
  let f;
  try {
    f = decodeFrame(r.bytes);
  } catch {
    return out;
  }
  if (f.kind === 'statusResponse') {
    // a struct of unrecognised size (newer firmware) still starts with the 48 common bytes
    const mv = f.stats?.batteryMv ?? (f.raw.length >= REPEATER_STATS_LEGACY_SIZE ? readU16LE(f.raw, 0) : 0);
    if (mv > 0) out.battery.push({ ts: r.ts, volts: mv / 1000, source: 'status' });
  } else if (f.kind === 'telemetryResponse') {
    for (const x of decodeLpp(f.lpp).readings) {
      if (x.kind !== 'scalar') continue;
      if (x.name === 'VOLTAGE' && x.channel === TELEM_CHANNEL_SELF) out.battery.push({ ts: r.ts, volts: x.value, source: 'telemetry' });
      else if (x.name === 'TEMPERATURE') out.temperature.push({ ts: r.ts, celsius: x.value, channel: x.channel });
    }
  }
  return out;
}

const byTs = (a: { ts: number }, b: { ts: number }): number => a.ts - b.ts;

/** Builds a history from frame records (any order, unrelated records ignored). */
export function buildTelemetryHistory(records: Iterable<FrameRecord>, pubKey: Uint8Array): TelemetryHistory {
  const h: TelemetryHistory = { battery: [], temperature: [] };
  for (const r of records) mergeInto(h, historyPoints(r, pubKey));
  return h;
}

/** Appends `add` into `h` (mutating), keeping both series sorted by time (stable for ties). */
export function mergeInto(h: TelemetryHistory, add: TelemetryHistory): TelemetryHistory {
  if (add.battery.length) {
    h.battery.push(...add.battery);
    h.battery.sort(byTs);
  }
  if (add.temperature.length) {
    h.temperature.push(...add.temperature);
    h.temperature.sort(byTs);
  }
  return h;
}

/** Reads the node's whole archived history from the frame log. */
export async function loadTelemetryHistory(frames: FrameLog, pubKey: Uint8Array): Promise<TelemetryHistory> {
  const pages = await Promise.all(
    TELEMETRY_HISTORY_CODES.map((code) =>
      frames.query({ code, direction: 'in', order: 'asc', limit: Infinity, match: (r) => isHistoryFrameFor(r, pubKey) }),
    ),
  );
  return buildTelemetryHistory(
    pages.flatMap((p) => p.items),
    pubKey,
  );
}
