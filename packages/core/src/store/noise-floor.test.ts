import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { RadioStore } from './radio-store.js';
import type { NoiseFloorSample } from './schema.js';
import { freshFactory, key32 } from './test-helpers.js';

const s = (t: number, noiseFloorDbm = -110): NoiseFloorSample => ({ t, noiseFloorDbm });

describe('NoiseFloorLog', () => {
  it('stores samples keyed by time and answers inclusive range queries in time order', async () => {
    const store = await RadioStore.open(key32(1), { factory: freshFactory() });
    const seen: NoiseFloorSample[] = [];
    store.events.on('noiseFloor', (x) => seen.push(x));
    for (const t of [300, 100, 200, 400]) await store.noiseFloor.add(s(t, -100 - t / 100));
    await store.noiseFloor.add({ t: 500, noiseFloorDbm: -105, lastRssiDbm: -90, lastSnr: 4.25 });
    expect(seen.map((x) => x.t)).toEqual([300, 100, 200, 400, 500]);

    expect((await store.noiseFloor.range()).map((x) => x.t)).toEqual([100, 200, 300, 400, 500]);
    expect((await store.noiseFloor.range({ from: 200, to: 400 })).map((x) => x.t)).toEqual([200, 300, 400]);
    expect((await store.noiseFloor.range({ from: 401 })).map((x) => x.t)).toEqual([500]);
    expect((await store.noiseFloor.range({ to: 100 })).map((x) => x.t)).toEqual([100]);
    expect((await store.noiseFloor.range({ from: 300 }))[0]).toEqual({ t: 300, noiseFloorDbm: -103 });
    expect((await store.noiseFloor.range({ from: 500 }))[0]).toEqual({ t: 500, noiseFloorDbm: -105, lastRssiDbm: -90, lastSnr: 4.25 });

    // a sample at the same time replaces the previous one
    await store.noiseFloor.add(s(100, -120));
    expect(await store.noiseFloor.count()).toBe(5);
    expect((await store.noiseFloor.range({ to: 100 }))[0]?.noiseFloorDbm).toBe(-120);
    store.close();
  });

  it('prunes before a cutoff and clears, emitting noiseFloorChanged when something went', async () => {
    const store = await RadioStore.open(key32(2), { factory: freshFactory() });
    for (const t of [10, 20, 30]) await store.noiseFloor.add(s(t));
    const changes: number[] = [];
    store.events.on('noiseFloorChanged', (e) => changes.push(e.removed));
    expect(await store.noiseFloor.prune(20)).toBe(1);
    expect(await store.noiseFloor.prune(5)).toBe(0);
    expect((await store.noiseFloor.range()).map((x) => x.t)).toEqual([20, 30]);
    expect(await store.noiseFloor.clear()).toBe(2);
    expect(await store.noiseFloor.count()).toBe(0);
    expect(changes).toEqual([1, 2]);
    store.close();
  });

  it('survives reopening the database', async () => {
    const factory = freshFactory();
    const a = await RadioStore.open(key32(3), { factory });
    await a.noiseFloor.add(s(1000, -111));
    a.close();
    const b = await RadioStore.open(key32(3), { factory });
    expect(await b.noiseFloor.range()).toEqual([s(1000, -111)]);
    b.close();
  });
});
