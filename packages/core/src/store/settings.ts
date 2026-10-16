/** Per-radio key/value settings. */

import type { TypedEmitter } from '../util/events.js';
import type { IdbDatabase } from './idb.js';
import { STORE, type SettingRecord } from './schema.js';
import { safeEmit, type RadioStoreEvents } from './events.js';

export class SettingsRepo {
  constructor(
    private readonly db: IdbDatabase,
    private readonly emitter: TypedEmitter<RadioStoreEvents>,
  ) {}

  /** The stored value, or `fallback` when unset. Values are structured-cloned, not validated. */
  async get<T>(key: string, fallback: T): Promise<T>;
  async get<T>(key: string): Promise<T | undefined>;
  async get<T>(key: string, fallback?: T): Promise<T | undefined> {
    const rec = await this.db.get<SettingRecord>(STORE.settings, key);
    return rec ? (rec.value as T) : fallback;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.db.put<SettingRecord>(STORE.settings, { key, value });
    safeEmit(this.emitter, 'setting', { key, value });
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(STORE.settings, key);
    safeEmit(this.emitter, 'setting', { key, value: undefined });
  }

  async all(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const r of await this.db.getAll<SettingRecord>(STORE.settings)) out[r.key] = r.value;
    return out;
  }
}
