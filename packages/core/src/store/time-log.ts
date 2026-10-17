/**
 * Shared machinery for the append-only, time-ordered logs (frames, packets): filtered paged
 * queries, counts, retention pruning, JSON export/import (bytes as hex).
 */

import { TypedEmitter } from '../util/events.js';
import { fromHex, toHex } from '../util/bytes.js';
import type { IdbDatabase, TxStore } from './idb.js';
import { safeEmit, type LogStoreName, type RadioStoreEvents } from './events.js';

export interface RetentionPolicy {
  /** Keep at most this many records (oldest by `ts` are removed first). */
  maxCount?: number;
  /** Remove records with `ts` older than `now - maxAgeMs`. */
  maxAgeMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Defaults used by `prune()` without arguments. */
export const DEFAULT_RETENTION: Readonly<Record<LogStoreName, Readonly<RetentionPolicy>>> = {
  frames: { maxCount: 200_000, maxAgeMs: 30 * DAY_MS },
  packets: { maxCount: 200_000, maxAgeMs: 90 * DAY_MS },
};

export interface LogQueryBase {
  /** Inclusive lower bound on `ts` (epoch ms). */
  from?: number;
  /** Inclusive upper bound on `ts` (epoch ms). */
  to?: number;
  /** Page size; default 100. */
  limit?: number;
  /** Records to skip (after filtering); default 0. */
  offset?: number;
  /** 'desc' (newest first, default) or 'asc'. Ties on `ts` are ordered by id. */
  order?: 'asc' | 'desc';
}

export interface LogPage<R> {
  items: R[];
  /** True when more records match beyond this page. */
  hasMore: boolean;
}

export interface QueryPlan<R> {
  index: string;
  query: IDBKeyRange | null;
  /** Residual filter for conditions the index cannot express. */
  filter?: (r: R) => boolean;
}

/** `bytes` as hex, everything else as stored. */
export type Exported<R> = Omit<R, 'bytes'> & { bytes: string };

export interface LogExport<R> {
  format: string;
  version: 1;
  exportedAt: number;
  count: number;
  items: Exported<R>[];
}

export interface ImportOptions {
  /** Keep the exported ids (overwriting records with the same id). Default false: new ids. */
  preserveIds?: boolean;
}

export interface LogRecordBase {
  id: number;
  ts: number;
  bytes: Uint8Array;
}

export class ImportError extends Error {
  override readonly name = 'ImportError';
}

export abstract class TimeLog<R extends LogRecordBase, Q extends LogQueryBase> {
  protected abstract readonly storeName: LogStoreName;
  protected abstract readonly tsIndex: string;
  protected abstract readonly exportFormat: string;

  retention: RetentionPolicy;

  constructor(
    protected readonly db: IdbDatabase,
    protected readonly emitter: TypedEmitter<RadioStoreEvents>,
    retention: RetentionPolicy,
    /** Host time (epoch ms) for default timestamps and pruning. */
    protected readonly now: () => number,
  ) {
    this.retention = { ...retention };
  }

  /** Chooses the index and residual filter for a query. */
  protected abstract plan(q: Q): QueryPlan<R>;

  /** Validates one imported item (bytes already decoded) and returns it without `id`. */
  protected abstract validateImported(item: Record<string, unknown>, bytes: Uint8Array): Omit<R, 'id'>;

  /** Range on `[...prefix, ts]` (or plain `ts` when prefix is empty) for `from`..`to`. */
  protected tsRange(prefix: readonly (string | number)[], q: LogQueryBase): IDBKeyRange | null {
    if (prefix.length === 0) return this.db.range(q.from, q.to);
    return this.db.range([...prefix, q.from ?? -Infinity], [...prefix, q.to ?? Infinity]);
  }

  /** A filter for the ts window, for plans whose index is not ts-ordered. */
  protected tsFilter(q: LogQueryBase): ((r: R) => boolean) | undefined {
    if (q.from === undefined && q.to === undefined) return undefined;
    const from = q.from ?? -Infinity;
    const to = q.to ?? Infinity;
    return (r) => r.ts >= from && r.ts <= to;
  }

  /** Emits the per-record event ('frame' / 'packet'). */
  protected abstract emitRecord(record: R): void;

  protected async insert(records: readonly Omit<R, 'id'>[]): Promise<R[]> {
    if (records.length === 0) return [];
    const out = await this.db.transaction(this.storeName, 'readwrite', async (t) => {
      const s = t.store<Omit<R, 'id'>>(this.storeName);
      const done: R[] = [];
      for (const rec of records) {
        const id = (await s.add(rec)) as number;
        done.push({ ...rec, id } as R);
      }
      return done;
    });
    for (const r of out) this.emitRecord(r);
    return out;
  }

  get(id: number): Promise<R | undefined> {
    return this.db.get<R>(this.storeName, id);
  }

  async query(q: Q = {} as Q): Promise<LogPage<R>> {
    const plan = this.plan(q);
    const limit = q.limit ?? 100;
    const items = await this.db.iterate<R>(this.storeName, {
      index: plan.index,
      query: plan.query,
      direction: (q.order ?? 'desc') === 'desc' ? 'prev' : 'next',
      offset: q.offset ?? 0,
      limit: limit + 1,
      ...(plan.filter ? { filter: plan.filter } : {}),
    });
    const hasMore = items.length > limit;
    if (hasMore) items.length = limit;
    return { items, hasMore };
  }

  /** Newest `n` records, newest first. */
  async latest(n = 100): Promise<R[]> {
    return (await this.query({ limit: n } as Q)).items;
  }

  async count(q: Omit<Q, 'limit' | 'offset' | 'order'> = {} as Q): Promise<number> {
    const plan = this.plan(q as Q);
    return this.db.transaction(this.storeName, 'readonly', async (t) => {
      const s = t.store<R>(this.storeName);
      if (!plan.filter) return s.count(plan.query, plan.index);
      let n = 0;
      const filter = plan.filter;
      await s.each({ index: plan.index, query: plan.query }, (r) => {
        if (filter(r)) n++;
      });
      return n;
    });
  }

  async clear(): Promise<number> {
    const removed = await this.db.transaction(this.storeName, 'readwrite', async (t) => {
      const s = t.store(this.storeName);
      const n = await s.count();
      await s.clear();
      return n;
    });
    safeEmit(this.emitter, 'logChanged', { store: this.storeName, reason: 'clear', removed, added: 0 });
    return removed;
  }

  /**
   * Applies a retention policy (default: `this.retention`). Age first, then count (oldest by `ts`
   * first). Returns the number of records removed.
   */
  async prune(policy: RetentionPolicy = this.retention, now: number = this.now()): Promise<number> {
    const { maxAgeMs, maxCount } = policy;
    const removed = await this.db.transaction(this.storeName, 'readwrite', async (t) => {
      const s = t.store<R>(this.storeName);
      let n = 0;
      if (maxAgeMs !== undefined && Number.isFinite(maxAgeMs)) {
        n += await deleteWhile(s, this.tsIndex, this.db.range(undefined, now - maxAgeMs, false, true), Infinity);
      }
      if (maxCount !== undefined && Number.isFinite(maxCount)) {
        const excess = (await s.count()) - Math.max(0, maxCount);
        if (excess > 0) n += await deleteWhile(s, this.tsIndex, null, excess);
      }
      return n;
    });
    if (removed > 0) safeEmit(this.emitter, 'logChanged', { store: this.storeName, reason: 'prune', removed, added: 0 });
    return removed;
  }

  /** Exports matching records (all by default) oldest-first as a JSON-safe object. */
  async export(q: Omit<Q, 'limit' | 'offset' | 'order'> = {} as Q): Promise<LogExport<R>> {
    const plan = this.plan(q as Q);
    const records = await this.db.iterate<R>(this.storeName, {
      index: plan.index,
      query: plan.query,
      direction: 'next',
      ...(plan.filter ? { filter: plan.filter } : {}),
    });
    const items = records.map((r) => ({ ...r, bytes: toHex(r.bytes) }) as Exported<R>);
    return { format: this.exportFormat, version: 1, exportedAt: this.now(), count: items.length, items };
  }

  /** Imports an export (object or JSON string). Validates everything before writing. */
  async import(data: unknown, opts: ImportOptions = {}): Promise<number> {
    const parsed: unknown = typeof data === 'string' ? JSON.parse(data) : data;
    if (!isObject(parsed) || parsed['format'] !== this.exportFormat || parsed['version'] !== 1 || !Array.isArray(parsed['items'])) {
      throw new ImportError(`not a ${this.exportFormat} v1 export`);
    }
    const records: { rec: Omit<R, 'id'>; id?: number }[] = [];
    (parsed['items'] as unknown[]).forEach((item, i) => {
      if (!isObject(item)) throw new ImportError(`item ${i}: not an object`);
      const hex = item['bytes'];
      if (typeof hex !== 'string') throw new ImportError(`item ${i}: bytes must be a hex string`);
      let bytes: Uint8Array;
      try {
        bytes = fromHex(hex);
      } catch (err) {
        throw new ImportError(`item ${i}: ${err instanceof Error ? err.message : String(err)}`);
      }
      let rec: Omit<R, 'id'>;
      try {
        rec = this.validateImported(item, bytes);
      } catch (err) {
        throw new ImportError(`item ${i}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const id = item['id'];
      records.push(opts.preserveIds && typeof id === 'number' && Number.isInteger(id) && id > 0 ? { rec, id } : { rec });
    });
    await this.db.transaction(this.storeName, 'readwrite', async (t) => {
      const s = t.store<Omit<R, 'id'> & { id?: number }>(this.storeName);
      for (const { rec, id } of records) {
        if (id !== undefined) await s.put({ ...rec, id });
        else await s.add(rec);
      }
    });
    safeEmit(this.emitter, 'logChanged', { store: this.storeName, reason: 'import', removed: 0, added: records.length });
    return records.length;
  }
}

async function deleteWhile<R>(s: TxStore<R>, index: string, query: IDBKeyRange | null, max: number): Promise<number> {
  let n = 0;
  if (max <= 0) return 0;
  await s.each({ index, query, direction: 'next' }, (_v, cursor) => {
    cursor.delete();
    n++;
    return n < max;
  });
  return n;
}

// ---- validation helpers for imports ----

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function reqNumber(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${k} must be a finite number`);
  return v;
}

export function optNumber(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${k} must be a number`);
  return v;
}

export function reqString(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new Error(`${k} must be a string`);
  return v;
}

export function optString(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${k} must be a string`);
  return v;
}

export function reqOneOf<T extends string>(o: Record<string, unknown>, k: string, allowed: readonly T[]): T {
  const v = o[k];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new Error(`${k} must be one of ${allowed.join(', ')}`);
  }
  return v as T;
}
