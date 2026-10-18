/**
 * Per-radio noise-floor samples (`noiseFloor` store, schema v4): one {@link NoiseFloorSample} per
 * GET_STATS radio poll (app/noise-floor.ts), keyed by host time so a date range is a key range.
 * Small (~60 bytes a sample, 1440 a day of connection), kept alongside the packet log: `prune`
 * drops samples older than a cutoff (RadioStore.prune passes the oldest remaining packet).
 */

import type { TypedEmitter } from '../util/events.js';
import type { IdbDatabase } from './idb.js';
import { STORE, type NoiseFloorSample } from './schema.js';
import { safeEmit, type RadioStoreEvents } from './events.js';

export class NoiseFloorLog {
  constructor(
    private readonly db: IdbDatabase,
    private readonly emitter: TypedEmitter<RadioStoreEvents>,
  ) {}

  /** Stores a sample (a second sample at the same `t` replaces the first); emits `noiseFloor`. */
  async add(sample: NoiseFloorSample): Promise<NoiseFloorSample> {
    const rec: NoiseFloorSample = { ...sample };
    await this.db.put<NoiseFloorSample>(STORE.noiseFloor, rec);
    safeEmit(this.emitter, 'noiseFloor', rec);
    return rec;
  }

  /** Samples with `from <= t <= to` (inclusive, open when omitted), ascending `t`. */
  range(opts: { from?: number; to?: number } = {}): Promise<NoiseFloorSample[]> {
    return this.db.getAll<NoiseFloorSample>(STORE.noiseFloor, { query: this.db.range(opts.from, opts.to) });
  }

  count(): Promise<number> {
    return this.db.count(STORE.noiseFloor);
  }

  /** Deletes samples with `t < before`; returns how many. Emits `noiseFloorChanged` when any went. */
  async prune(before: number): Promise<number> {
    const q = this.db.range(undefined, before, false, true);
    const removed = await this.db.transaction(STORE.noiseFloor, 'readwrite', async (t) => {
      const s = t.store<NoiseFloorSample>(STORE.noiseFloor);
      const n = await s.count(q);
      if (n > 0 && q) await s.delete(q);
      return n;
    });
    if (removed > 0) safeEmit(this.emitter, 'noiseFloorChanged', { removed });
    return removed;
  }

  async clear(): Promise<number> {
    const removed = await this.db.transaction(STORE.noiseFloor, 'readwrite', async (t) => {
      const s = t.store(STORE.noiseFloor);
      const n = await s.count();
      await s.clear();
      return n;
    });
    if (removed > 0) safeEmit(this.emitter, 'noiseFloorChanged', { removed });
    return removed;
  }
}
