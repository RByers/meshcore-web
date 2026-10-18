/**
 * Per-radio database statistics: record counts per object store and an approximate size.
 *
 * IndexedDB has no API for the size of one database (`navigator.storage.estimate()` is per
 * origin), so the size is estimated by walking every record once with a cursor and summing
 * {@link approxValueBytes} of each value. Index entries, key-generator state and the browser's
 * on-disk overhead / compression are ignored, so treat it as "roughly how much data is stored",
 * not as the disk footprint.
 */

import { defaultFactory, openDatabase, type IdbDatabase, type Migration } from './idb.js';
import { RADIO_DB_MIGRATIONS, RADIO_DB_VERSION, STORE, pubKeyHex, radioDbName, type RadioStoreName } from './schema.js';
import type { StoreOpenOptions } from './devices.js';

export interface RadioDbStats {
  /** Lowercase pubkey hex of the radio. */
  pubKey: string;
  /** False when the radio has no database (nothing was opened or created). */
  exists: boolean;
  /** Records per object store. */
  counts: Record<RadioStoreName, number>;
  /** Approximate bytes per object store ({@link approxValueBytes} of every record). */
  bytesByStore: Record<RadioStoreName, number>;
  /** Sum of `bytesByStore`. */
  approxBytes: number;
}

export const RADIO_STORE_NAMES: readonly RadioStoreName[] = Object.values(STORE);

function zeroes(): Record<RadioStoreName, number> {
  return { frames: 0, packets: 0, contacts: 0, messages: 0, channels: 0, settings: 0, noiseFloor: 0 };
}

/**
 * Approximate structured-clone size of a value: binary data (typed arrays, `DataView`,
 * `ArrayBuffer`) counts its byte length, strings 2 bytes per UTF-16 code unit, numbers, bigints
 * and dates 8, booleans 1, `null` / `undefined` 0; arrays sum their elements, plain objects
 * (and Maps / Sets) their keys and values. Serialisation tags and headers are not counted.
 */
export function approxValueBytes(value: unknown): number {
  switch (typeof value) {
    case 'string':
      return value.length * 2;
    case 'number':
    case 'bigint':
      return 8;
    case 'boolean':
      return 1;
    case 'object':
      break;
    default:
      return 0;
  }
  if (value === null) return 0;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (value instanceof Date) return 8;
  let n = 0;
  if (Array.isArray(value)) {
    for (const v of value as unknown[]) n += approxValueBytes(v);
    return n;
  }
  if (value instanceof Map) {
    for (const [k, v] of value as Map<unknown, unknown>) n += approxValueBytes(k) + approxValueBytes(v);
    return n;
  }
  if (value instanceof Set) {
    for (const v of value as Set<unknown>) n += approxValueBytes(v);
    return n;
  }
  for (const [k, v] of Object.entries(value)) n += k.length * 2 + approxValueBytes(v);
  return n;
}

class MissingDatabase extends Error {}

/**
 * The radio migrations, except that creating the database (oldVersion 0) aborts the upgrade, so
 * a stats pass never creates a database (an aborted upgrade of a new database deletes it).
 */
const STATS_MIGRATIONS: readonly Migration[] = RADIO_DB_MIGRATIONS.map((m, i) =>
  i === 0
    ? (ctx) => {
        if (ctx.oldVersion === 0) throw new MissingDatabase('no database');
        m(ctx);
      }
    : m,
);

/** Whether `name` exists, or `undefined` when the factory can't list databases. */
async function databaseExists(factory: IDBFactory, name: string): Promise<boolean | undefined> {
  if (typeof factory.databases !== 'function') return undefined;
  try {
    const dbs = await factory.databases();
    return dbs.some((d) => d.name === name);
  } catch {
    return undefined;
  }
}

/**
 * Counts and sizes every store of one radio's database in a single read-only transaction (one
 * cursor pass per store). A database that does not exist is reported with `exists: false` and
 * zeroes, without being created (also where the factory can't list databases, or the database
 * is deleted concurrently: an open that would create it is aborted). An existing older-version
 * database is migrated the way `RadioStore.open` would. The connection is closed afterwards.
 */
export async function radioDbStats(pubKey: Uint8Array | string, opts: StoreOpenOptions = {}): Promise<RadioDbStats> {
  const hex = pubKeyHex(pubKey);
  const name = radioDbName(hex);
  const factory = defaultFactory(opts.factory);
  const counts = zeroes();
  const bytesByStore = zeroes();
  if ((await databaseExists(factory, name)) === false) {
    return { pubKey: hex, exists: false, counts, bytesByStore, approxBytes: 0 };
  }
  let db: IdbDatabase;
  try {
    db = await openDatabase({
      name,
      version: RADIO_DB_VERSION,
      migrations: STATS_MIGRATIONS,
      factory,
      ...(opts.keyRange ? { keyRange: opts.keyRange } : {}),
    });
  } catch (err) {
    // the database vanished (e.g. deleted by "Remove") between the check above and this open:
    // the aborted upgrade leaves nothing behind
    if (err instanceof MissingDatabase) return { pubKey: hex, exists: false, counts, bytesByStore, approxBytes: 0 };
    throw err;
  }
  try {
    const stores = RADIO_STORE_NAMES.filter((s) => db.storeNames.includes(s));
    await db.transaction(stores, 'readonly', (t) =>
      Promise.all(
        stores.map((s) =>
          t.store<unknown>(s).each({}, (v) => {
            counts[s]++;
            bytesByStore[s] += approxValueBytes(v);
          }),
        ),
      ),
    );
  } finally {
    db.close();
  }
  const approxBytes = RADIO_STORE_NAMES.reduce((sum, s) => sum + bytesByStore[s], 0);
  return { pubKey: hex, exists: true, counts, bytesByStore, approxBytes };
}
