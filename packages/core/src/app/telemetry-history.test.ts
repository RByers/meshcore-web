import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { openStore } from '../store/test-helpers.js';
import type { FrameRecord } from '../store/schema.js';
import { concatBytes, fromHex, u16le } from '../util/bytes.js';
import { connectedApp } from './testing.js';
import { when } from './signal.js';
import { buildTelemetryHistory, historyPoints, isHistoryFrameFor, loadTelemetryHistory } from './telemetry-history.js';

const KEY = fromHex('a1b2c3d4e5f6'.padEnd(64, '7'));
const OTHER = fromHex('a1b2c3d4e5f0'.padEnd(64, '7'));
const PREFIX = KEY.slice(0, 6);

/** STATUS_RESPONSE `[0x87][reserved][prefix 6][status struct]` (companion-protocol.md §6.8); batt_milli_volts u16 at struct offset 0. */
function statusFrame(mv: number, structLen = 56, prefix = PREFIX): Uint8Array {
  const struct = new Uint8Array(structLen);
  struct.set(u16le(mv), 0);
  return concatBytes(Uint8Array.of(0x87, 0x00), prefix, struct);
}

/** TELEMETRY_RESPONSE `[0x8b][reserved][prefix 6][CayenneLPP]` (companion-protocol.md §6.8). */
function telemetryFrame(lpp: Uint8Array, prefix = PREFIX): Uint8Array {
  return concatBytes(Uint8Array.of(0x8b, 0x00), prefix, lpp);
}

function rec(ts: number, bytes: Uint8Array, direction: 'in' | 'out' = 'in'): FrameRecord {
  return { id: ts, ts, direction, bytes, code: bytes[0]!, kind: 'x', size: bytes.length };
}

// LPP (big-endian): ch1 VOLTAGE (116) 0x018B /100 = 3.95 V; ch1 TEMPERATURE (103) 0x00B8 /10 = 18.4 °C;
// ch2 TEMPERATURE -2.0 °C (0xFFEC); ch3 VOLTAGE 12.00 V (0x04B0, external sensor, not the battery)
const LPP = Uint8Array.of(1, 116, 0x01, 0x8b, 1, 103, 0x00, 0xb8, 2, 103, 0xff, 0xec, 3, 116, 0x04, 0xb0);

describe('telemetry history (pure)', () => {
  it('extracts battery (status mV, LPP ch1 voltage) and temperatures by channel', () => {
    expect(historyPoints(rec(100, statusFrame(4100)), KEY)).toEqual({ battery: [{ ts: 100, volts: 4.1, source: 'status' }], temperature: [] });
    expect(historyPoints(rec(200, telemetryFrame(LPP)), KEY)).toEqual({
      battery: [{ ts: 200, volts: 3.95, source: 'telemetry' }],
      temperature: [
        { ts: 200, celsius: 18.4, channel: 1 },
        { ts: 200, celsius: -2, channel: 2 },
      ],
    });
  });

  it('room (52-byte) and unrecognised-length status structs; 0 mV means not measured', () => {
    expect(historyPoints(rec(1, statusFrame(3700, 52)), KEY).battery).toEqual([{ ts: 1, volts: 3.7, source: 'status' }]);
    expect(historyPoints(rec(1, statusFrame(3600, 60)), KEY).battery).toEqual([{ ts: 1, volts: 3.6, source: 'status' }]);
    expect(historyPoints(rec(1, statusFrame(3600, 2)), KEY).battery).toEqual([]);
    expect(historyPoints(rec(1, statusFrame(0)), KEY).battery).toEqual([]);
  });

  it('matches only incoming responses from the node (6-byte prefix)', () => {
    expect(isHistoryFrameFor(rec(1, statusFrame(4100)), KEY)).toBe(true);
    expect(isHistoryFrameFor(rec(1, statusFrame(4100)), OTHER)).toBe(false);
    expect(isHistoryFrameFor(rec(1, statusFrame(4100), 'out'), KEY)).toBe(false);
    expect(isHistoryFrameFor(rec(1, Uint8Array.of(0x8b, 0, 1, 2)), KEY)).toBe(false);
    expect(isHistoryFrameFor(rec(1, concatBytes(Uint8Array.of(0x85, 0), PREFIX)), KEY)).toBe(false);
  });

  it('sorts by time and ignores malformed / unrelated records', () => {
    const h = buildTelemetryHistory(
      [rec(300, statusFrame(4000)), rec(100, telemetryFrame(LPP)), rec(200, statusFrame(4100, 56, OTHER.slice(0, 6))), rec(50, telemetryFrame(Uint8Array.of(9)))],
      KEY,
    );
    expect(h.battery.map((p) => [p.ts, p.source])).toEqual([
      [100, 'telemetry'],
      [300, 'status'],
    ]);
    expect(h.temperature.map((p) => p.ts)).toEqual([100, 100]);
  });

  it('loads from the frame log', async () => {
    const s = await openStore();
    await s.frames.appendMany([
      { direction: 'in', bytes: telemetryFrame(LPP), ts: 20 },
      { direction: 'in', bytes: statusFrame(4200), ts: 10 },
      { direction: 'in', bytes: statusFrame(3000, 56, OTHER.slice(0, 6)), ts: 15 },
      { direction: 'in', bytes: Uint8Array.of(0x00), ts: 16 },
    ]);
    const h = await loadTelemetryHistory(s.frames, KEY);
    expect(h.battery).toEqual([
      { ts: 10, volts: 4.2, source: 'status' },
      { ts: 20, volts: 3.95, source: 'telemetry' },
    ]);
    expect(h.temperature).toHaveLength(2);
    s.close();
  });
});

describe('RemoteNodeModel.telemetryHistory', () => {
  it('loads archived responses, appends new ones, reloads on clear and drops on disconnect', async () => {
    const t = await connectedApp();
    const { app, keys: k } = t;
    const rep = app.remoteAdmin.node(k.repeater);
    expect(rep.telemetryHistory.value).toBeNull();
    await rep.login('password');
    await rep.refreshStatus();
    await app.connection.capture!.idle();
    const t0 = app.clock.now();

    const h = await rep.loadTelemetryHistory();
    expect(h?.battery).toEqual([{ ts: expect.any(Number) as number, volts: 4.1, source: 'status' }]);
    expect(rep.telemetryHistory.value).toBe(h);
    expect(h!.battery[0]!.ts).toBeLessThanOrEqual(t0);
    expect(await rep.loadTelemetryHistory()).toBe(h); // idempotent

    await t.elapse(60_000);
    await rep.refreshStatus();
    const h2 = await when(rep.telemetryHistory, (x) => (x?.battery.length ?? 0) === 2);
    expect(h2!.battery[1]!.ts).toBeGreaterThanOrEqual(t0 + 60_000);

    // the sensor's telemetry does not leak into the repeater's history
    const sensor = app.remoteAdmin.node(k.sensor);
    await sensor.login('password');
    await sensor.refreshTelemetry();
    await app.connection.capture!.idle();
    expect(rep.telemetryHistory.value!.battery).toHaveLength(2);
    const sh = await sensor.loadTelemetryHistory();
    expect(sh!.battery).toMatchObject([{ volts: 3.95, source: 'telemetry' }]);
    expect(sh!.temperature.map((p) => [p.channel, p.celsius])).toEqual([
      [1, 18.4],
      [2, 12.5],
    ]);

    await t.store.frames.clear();
    await when(rep.telemetryHistory, (x) => x?.battery.length === 0);

    await app.connection.disconnect();
    expect(rep.telemetryHistory.value).toBeNull();
    expect(await rep.loadTelemetryHistory()).toBeNull();
  });
});
