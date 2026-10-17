/**
 * Local storage usage per known radio (the Device page's "Stored data" card): record counts and
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
  /** Storage per known radio, keyed by pubkey hex. */
  readonly byDevice: ReadonlySignal<Readonly<Record<string, DeviceStorage>>> = this.#byDevice.readonly;
  /** True while any radio's stats are being computed. */
  readonly loading = computed(() => Object.values(this.#byDevice.value).some((d) => d.status === 'loading'));
  /** Approximate bytes over every radio with stats. */
  readonly totalBytes = computed(() =>
    Object.values(this.#byDevice.value).reduce((sum, d) => sum + (d.stats?.approxBytes ?? 0), 0),
  );

  #running: Promise<void> | undefined;
  #again = false;

  constructor(deps: StorageModelDeps) {
    this.#deps = deps;
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
