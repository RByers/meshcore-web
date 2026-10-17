/**
 * Local storage usage per known radio (the Connect page's known-radios list): record counts and
 * an approximate size of each radio's IndexedDB database (`store/db-stats.ts`).
 */

import { radioDbStats, type RadioDbStats } from '../store/db-stats.js';
import type { StoreOpenOptions } from '../store/devices.js';
import type { DeviceRecord } from '../store/schema.js';
import { computed, signal, type ReadonlySignal } from './signal.js';

export type DeviceStorageStatus = 'loading' | 'ready' | 'error';

export interface DeviceStorage {
  pubKey: string;
  status: DeviceStorageStatus;
  /** The latest stats (kept from the previous refresh while `loading`). */
  stats: RadioDbStats | null;
  error: string | null;
}

export interface StorageModelDeps {
  /** Known radios (`AppModel.devices`). */
  devices: ReadonlySignal<readonly DeviceRecord[]>;
  /** IndexedDB factory / key range the app uses. */
  storeOptions: () => StoreOpenOptions;
  /** Stats function (tests); default {@link radioDbStats}. */
  stats?: (pubKey: string, opts: StoreOpenOptions) => Promise<RadioDbStats>;
}

export class StorageModel {
  readonly #deps: StorageModelDeps;
  readonly #byDevice = signal<Readonly<Record<string, DeviceStorage>>>({});
  /**
   * Storage per known radio, keyed by pubkey hex. Only radios still in `devices` are listed: a
   * forgotten radio drops out at once, without waiting for the next refresh.
   */
  readonly byDevice: ReadonlySignal<Readonly<Record<string, DeviceStorage>>>;
  /** True while any radio's stats are being computed. */
  readonly loading: ReadonlySignal<boolean>;
  /** Approximate bytes over every radio with stats. */
  readonly totalBytes: ReadonlySignal<number>;

  #running: Promise<void> | undefined;
  #again = false;

  constructor(deps: StorageModelDeps) {
    this.#deps = deps;
    this.byDevice = computed(() => {
      const all = this.#byDevice.value;
      const out: Record<string, DeviceStorage> = {};
      for (const d of deps.devices.value) {
        const e = all[d.pubKey];
        if (e) out[d.pubKey] = e;
      }
      return out;
    });
    this.loading = computed(() => Object.values(this.byDevice.value).some((d) => d.status === 'loading'));
    this.totalBytes = computed(() =>
      Object.values(this.byDevice.value).reduce((sum, d) => sum + (d.stats?.approxBytes ?? 0), 0),
    );
  }

  /**
   * Recomputes the stats of every known radio (sequentially; each walks its whole database).
   * A call while a refresh runs schedules one more pass after it; the returned promise settles
   * when the stats are up to date. Never rejects: failures are per radio (`status: 'error'`).
   */
  refresh(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    const run = async (): Promise<void> => {
      do {
        this.#again = false;
        await this.#refreshOnce();
      } while (this.#again);
    };
    this.#running = run().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #refreshOnce(): Promise<void> {
    const keys = this.#deps.devices.peek().map((d) => d.pubKey);
    const prev = this.#byDevice.peek();
    const next: Record<string, DeviceStorage> = {};
    for (const k of keys) next[k] = { pubKey: k, status: 'loading', stats: prev[k]?.stats ?? null, error: null };
    this.#byDevice.value = next;
    const statsFn = this.#deps.stats ?? radioDbStats;
    for (const k of keys) {
      // forgotten while this pass ran (its database may be gone): skip it
      if (!this.#deps.devices.peek().some((d) => d.pubKey === k)) continue;
      let entry: DeviceStorage;
      try {
        entry = { pubKey: k, status: 'ready', stats: await statsFn(k, this.#deps.storeOptions()), error: null };
      } catch (err) {
        entry = { pubKey: k, status: 'error', stats: null, error: err instanceof Error ? err.message : String(err) };
      }
      this.#byDevice.value = { ...this.#byDevice.peek(), [k]: entry };
    }
  }
}
