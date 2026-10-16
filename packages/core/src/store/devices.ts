/** Global list of known radios (`meshcore-web:devices`). */

import type { DeviceInfo, SelfInfo } from '../protocol/types.js';
import { TypedEmitter } from '../util/events.js';
import { deleteDatabase, openDatabase, type IdbDatabase } from './idb.js';
import {
  DEVICES_DB_MIGRATIONS,
  DEVICES_DB_NAME,
  DEVICES_DB_VERSION,
  DEVICES_STORE,
  INDEX,
  pubKeyHex,
  radioDbName,
  type DeviceRecord,
  type StoredTransportKind,
} from './schema.js';
import { safeEmit, type DevicesEvents } from './events.js';

export interface StoreOpenOptions {
  /** Defaults to `globalThis.indexedDB`. */
  factory?: IDBFactory;
  /** Defaults to `globalThis.IDBKeyRange`. */
  keyRange?: typeof IDBKeyRange;
}

export interface DeviceConnectInput {
  pubKey: Uint8Array | string;
  name?: string;
  transport?: StoredTransportKind;
  deviceInfo?: DeviceInfo;
  selfInfo?: SelfInfo;
}

export class DevicesRepo {
  readonly events = new TypedEmitter<DevicesEvents>();

  private constructor(readonly db: IdbDatabase) {}

  static async open(opts: StoreOpenOptions = {}): Promise<DevicesRepo> {
    const db = await openDatabase({
      name: DEVICES_DB_NAME,
      version: DEVICES_DB_VERSION,
      migrations: DEVICES_DB_MIGRATIONS,
      ...(opts.factory ? { factory: opts.factory } : {}),
      ...(opts.keyRange ? { keyRange: opts.keyRange } : {}),
    });
    return new DevicesRepo(db);
  }

  get(pubKey: Uint8Array | string): Promise<DeviceRecord | undefined> {
    return this.db.get<DeviceRecord>(DEVICES_STORE, pubKeyHex(pubKey));
  }

  /** Known radios, most recently connected first. */
  list(): Promise<DeviceRecord[]> {
    return this.db.iterate<DeviceRecord>(DEVICES_STORE, { index: INDEX.devices.lastConnected, direction: 'prev' });
  }

  /** Records a connection (creates the radio on first connect; merges given fields). */
  async recordConnection(input: DeviceConnectInput, now = Date.now()): Promise<DeviceRecord> {
    const key = pubKeyHex(input.pubKey);
    const rec = await this.db.transaction(DEVICES_STORE, 'readwrite', async (t) => {
      const s = t.store<DeviceRecord>(DEVICES_STORE);
      const prev = await s.get(key);
      const next: DeviceRecord = {
        pubKey: key,
        name: input.name ?? input.selfInfo?.name ?? prev?.name ?? '',
        firstConnected: prev?.firstConnected ?? now,
        lastConnected: now,
        transport: input.transport ?? prev?.transport ?? 'serial',
      };
      const deviceInfo = input.deviceInfo ?? prev?.deviceInfo;
      const selfInfo = input.selfInfo ?? prev?.selfInfo;
      if (deviceInfo) next.deviceInfo = deviceInfo;
      if (selfInfo) next.selfInfo = selfInfo;
      await s.put(next);
      return next;
    });
    safeEmit(this.events, 'device', { type: 'put', record: rec });
    return rec;
  }

  /** Updates fields without touching `lastConnected` (e.g. after a rename). */
  async update(pubKey: Uint8Array | string, patch: Partial<Omit<DeviceRecord, 'pubKey'>>): Promise<DeviceRecord | undefined> {
    const key = pubKeyHex(pubKey);
    const rec = await this.db.transaction(DEVICES_STORE, 'readwrite', async (t) => {
      const s = t.store<DeviceRecord>(DEVICES_STORE);
      const prev = await s.get(key);
      if (!prev) return undefined;
      const next: DeviceRecord = { ...prev, ...patch, pubKey: key };
      await s.put(next);
      return next;
    });
    if (rec) safeEmit(this.events, 'device', { type: 'put', record: rec });
    return rec;
  }

  /**
   * Forgets a radio. With `deleteData`, also deletes its per-radio database (close any open
   * RadioStore for it first, or the delete waits for it to close).
   */
  async forget(pubKey: Uint8Array | string, opts: { deleteData?: boolean } = {}): Promise<void> {
    const key = pubKeyHex(pubKey);
    await this.db.delete(DEVICES_STORE, key);
    if (opts.deleteData) await deleteDatabase(radioDbName(key), this.db.factory);
    safeEmit(this.events, 'device', { type: 'delete', pubKey: key });
  }

  close(): void {
    this.db.close();
  }
}
