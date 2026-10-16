/**
 * A small typed, promise-based wrapper over the IndexedDB API (no dependencies, no DOM access
 * beyond the injected `IDBFactory`).
 *
 * Transaction lifetime: an IndexedDB transaction auto-commits as soon as no request is pending
 * at the end of a task. Awaiting the promises returned by {@link TxStore} methods keeps the
 * transaction alive (their callbacks run in microtasks), but awaiting anything else (timers,
 * WebCrypto, fetch) inside a {@link IdbDatabase.transaction} callback will let it commit and the
 * next request will fail with `TransactionInactiveError`. Do async preparation first.
 */

export type IdbKey = IDBValidKey;
export type IdbQuery = IDBValidKey | IDBKeyRange;
export type TxMode = 'readonly' | 'readwrite';

/** Called inside the `versionchange` transaction for one schema step. */
export interface MigrationContext {
  db: IDBDatabase;
  tx: IDBTransaction;
  /** Version the database had before this open (0 = new). */
  oldVersion: number;
  /** The version this step migrates to. */
  version: number;
}

/** Migration for version N is `migrations[N - 1]`; steps run in order from oldVersion + 1. */
export type Migration = (ctx: MigrationContext) => void;

export interface OpenOptions {
  name: string;
  /** Target version; defaults to `migrations.length`. */
  version?: number;
  migrations: readonly Migration[];
  /** Defaults to `globalThis.indexedDB`. */
  factory?: IDBFactory;
  /** Called when another connection wants to upgrade/delete this database (we close by default). */
  onVersionChange?: (db: IdbDatabase) => void;
  /** Called if the open is blocked by another connection that does not close. */
  onBlocked?: () => void;
  /** `IDBKeyRange` matching `factory`; defaults to `globalThis.IDBKeyRange`. */
  keyRange?: typeof IDBKeyRange;
}

export function defaultFactory(factory?: IDBFactory): IDBFactory {
  const f = factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!f) throw new Error('IndexedDB is not available (no indexedDB global and no factory given)');
  return f;
}

/** Promisifies a single request. */
export function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves when the transaction completes; rejects on error or abort. */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new DOMExceptionLike('IndexedDB transaction aborted', 'AbortError'));
  });
}

class DOMExceptionLike extends Error {
  constructor(message: string, override readonly name: string) {
    super(message);
  }
}

/** Opens `name`, running migrations `oldVersion+1 .. version` inside the upgrade transaction. */
export async function openDatabase(opts: OpenOptions): Promise<IdbDatabase> {
  const factory = defaultFactory(opts.factory);
  const version = opts.version ?? opts.migrations.length;
  if (version < 1 || version > opts.migrations.length) {
    throw new RangeError(`openDatabase: version ${version} needs ${version} migrations, have ${opts.migrations.length}`);
  }
  const req = factory.open(opts.name, version);
  let migrationError: unknown;
  req.onupgradeneeded = (ev) => {
    const db = req.result;
    const tx = req.transaction;
    if (!tx) return;
    const oldVersion = ev.oldVersion;
    try {
      for (let v = oldVersion + 1; v <= version; v++) {
        const step = opts.migrations[v - 1];
        if (step) step({ db, tx, oldVersion, version: v });
      }
    } catch (err) {
      migrationError = err;
      tx.abort();
    }
  };
  req.onblocked = () => opts.onBlocked?.();
  let raw: IDBDatabase;
  try {
    raw = await promisifyRequest(req);
  } catch (err) {
    throw migrationError ?? err;
  }
  const db = new IdbDatabase(raw, factory, defaultKeyRange(opts.keyRange));
  raw.onversionchange = () => {
    if (opts.onVersionChange) opts.onVersionChange(db);
    else db.close();
  };
  return db;
}

export async function deleteDatabase(name: string, factory?: IDBFactory): Promise<void> {
  await promisifyRequest(defaultFactory(factory).deleteDatabase(name) as IDBRequest<unknown>);
}

export interface IterateOptions {
  /** Index name; omit to iterate the object store by primary key. */
  index?: string;
  query?: IdbQuery | null;
  /** Default 'next' (ascending). */
  direction?: IDBCursorDirection;
  /** Number of matching records to skip. */
  offset?: number;
  /** Maximum number of records to return. */
  limit?: number;
}

export interface CursorIterateOptions<T> extends IterateOptions {
  /** Only records passing the filter count toward offset/limit. */
  filter?: (value: T) => boolean;
}

export interface GetAllOptions {
  index?: string;
  query?: IdbQuery | null;
  count?: number;
}

/** One object store bound to a live transaction. All methods are promise-based. */
export class TxStore<T> {
  constructor(readonly store: IDBObjectStore) {}

  get(key: IdbQuery): Promise<T | undefined> {
    return promisifyRequest(this.store.get(key) as IDBRequest<T | undefined>);
  }

  getFromIndex(index: string, key: IdbQuery): Promise<T | undefined> {
    return promisifyRequest(this.store.index(index).get(key) as IDBRequest<T | undefined>);
  }

  /** Upsert; returns the primary key (the generated one for auto-increment stores). */
  put(value: T, key?: IdbKey): Promise<IdbKey> {
    return promisifyRequest(key === undefined ? this.store.put(value) : this.store.put(value, key));
  }

  /** Insert; fails with ConstraintError if the key exists. */
  add(value: T, key?: IdbKey): Promise<IdbKey> {
    return promisifyRequest(key === undefined ? this.store.add(value) : this.store.add(value, key));
  }

  delete(query: IdbQuery): Promise<void> {
    return promisifyRequest(this.store.delete(query)).then(() => undefined);
  }

  clear(): Promise<void> {
    return promisifyRequest(this.store.clear()).then(() => undefined);
  }

  count(query?: IdbQuery | null, index?: string): Promise<number> {
    const src = index ? this.store.index(index) : this.store;
    return promisifyRequest(query == null ? src.count() : src.count(query));
  }

  getAll(opts: GetAllOptions = {}): Promise<T[]> {
    const src = opts.index ? this.store.index(opts.index) : this.store;
    return promisifyRequest(src.getAll(opts.query ?? null, opts.count) as IDBRequest<T[]>);
  }

  getAllKeys(opts: GetAllOptions = {}): Promise<IdbKey[]> {
    const src = opts.index ? this.store.index(opts.index) : this.store;
    return promisifyRequest(
      (opts.index
        ? (src as IDBIndex).getAllKeys(opts.query ?? null, opts.count)
        : (src as IDBObjectStore).getAllKeys(opts.query ?? null, opts.count)) as IDBRequest<IdbKey[]>,
    );
  }

  /**
   * Walks a cursor, calling `visit` for each record. `visit` may return `false` to stop. The
   * cursor is passed so callers can `update()` / `delete()` (readwrite only).
   */
  each(opts: IterateOptions, visit: (value: T, cursor: IDBCursorWithValue) => boolean | void): Promise<void> {
    const src = opts.index ? this.store.index(opts.index) : this.store;
    const req = src.openCursor(opts.query ?? null, opts.direction ?? 'next');
    return new Promise<void>((resolve, reject) => {
      let skipped = false;
      req.onerror = () => reject(req.error ?? new Error('IndexedDB cursor failed'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        if (!skipped && opts.offset && opts.offset > 0) {
          skipped = true;
          cursor.advance(opts.offset);
          return;
        }
        skipped = true;
        let stop: boolean | void;
        try {
          stop = visit(cursor.value as T, cursor) === false;
        } catch (err) {
          return reject(err);
        }
        if (stop) resolve();
        else cursor.continue();
      };
    });
  }

  /** Collects records via a cursor with direction, offset, limit and optional filter. */
  async iterate(opts: CursorIterateOptions<T> = {}): Promise<T[]> {
    const out: T[] = [];
    const limit = opts.limit ?? Infinity;
    if (limit <= 0) return out;
    const filter = opts.filter;
    if (!filter) {
      await this.each(opts, (v) => {
        out.push(v);
        return out.length < limit;
      });
      return out;
    }
    let toSkip = opts.offset ?? 0;
    await this.each({ ...opts, offset: 0 }, (v) => {
      if (!filter(v)) return true;
      if (toSkip > 0) {
        toSkip--;
        return true;
      }
      out.push(v);
      return out.length < limit;
    });
    return out;
  }
}

/** Scope handed to {@link IdbDatabase.transaction} callbacks. */
export class TxScope {
  constructor(readonly tx: IDBTransaction) {}

  store<T>(name: string): TxStore<T> {
    return new TxStore<T>(this.tx.objectStore(name));
  }

  abort(): void {
    this.tx.abort();
  }
}

/** An open database connection. */
export class IdbDatabase {
  #closed = false;

  constructor(
    readonly raw: IDBDatabase,
    readonly factory: IDBFactory,
    readonly keyRangeCtor: typeof IDBKeyRange = defaultKeyRange(),
  ) {}

  /** Builds a key range; `undefined` bounds are open-ended. Returns null for an unbounded range. */
  range(lower: IdbKey | undefined, upper: IdbKey | undefined, lowerOpen = false, upperOpen = false): IDBKeyRange | null {
    return keyRange(this.keyRangeCtor, lower, upper, lowerOpen, upperOpen);
  }

  only(key: IdbKey): IDBKeyRange {
    return this.keyRangeCtor.only(key);
  }

  get name(): string {
    return this.raw.name;
  }

  get version(): number {
    return this.raw.version;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get storeNames(): string[] {
    return Array.from(this.raw.objectStoreNames);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.raw.close();
  }

  /**
   * Runs `fn` in one transaction over `stores` and resolves with its result once the transaction
   * has committed. If `fn` throws/rejects the transaction is aborted and the error re-thrown.
   */
  async transaction<R>(stores: string | readonly string[], mode: TxMode, fn: (tx: TxScope) => Promise<R> | R): Promise<R> {
    const tx = this.raw.transaction(typeof stores === 'string' ? [stores] : [...stores], mode);
    const done = transactionDone(tx);
    done.catch(() => undefined); // observed below; avoid spurious unhandled-rejection reports
    let result: R;
    try {
      result = await fn(new TxScope(tx));
    } catch (err) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      await done.catch(() => undefined);
      throw err;
    }
    await done;
    return result;
  }

  get<T>(store: string, key: IdbQuery): Promise<T | undefined> {
    return this.transaction(store, 'readonly', (t) => t.store<T>(store).get(key));
  }

  put<T>(store: string, value: T, key?: IdbKey): Promise<IdbKey> {
    return this.transaction(store, 'readwrite', (t) => t.store<T>(store).put(value, key));
  }

  add<T>(store: string, value: T, key?: IdbKey): Promise<IdbKey> {
    return this.transaction(store, 'readwrite', (t) => t.store<T>(store).add(value, key));
  }

  delete(store: string, query: IdbQuery): Promise<void> {
    return this.transaction(store, 'readwrite', (t) => t.store(store).delete(query));
  }

  clear(store: string): Promise<void> {
    return this.transaction(store, 'readwrite', (t) => t.store(store).clear());
  }

  count(store: string, query?: IdbQuery | null, index?: string): Promise<number> {
    return this.transaction(store, 'readonly', (t) => t.store(store).count(query, index));
  }

  getAll<T>(store: string, opts: GetAllOptions = {}): Promise<T[]> {
    return this.transaction(store, 'readonly', (t) => t.store<T>(store).getAll(opts));
  }

  iterate<T>(store: string, opts: CursorIterateOptions<T> = {}): Promise<T[]> {
    return this.transaction(store, 'readonly', (t) => t.store<T>(store).iterate(opts));
  }
}

export function defaultKeyRange(ctor?: typeof IDBKeyRange): typeof IDBKeyRange {
  const KR = ctor ?? (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange;
  if (!KR) throw new Error('IDBKeyRange is not available (no global and none given)');
  return KR;
}

export function keyRange(
  KR: typeof IDBKeyRange,
  lower: IdbKey | undefined,
  upper: IdbKey | undefined,
  lowerOpen = false,
  upperOpen = false,
): IDBKeyRange | null {
  if (lower !== undefined && upper !== undefined) return KR.bound(lower, upper, lowerOpen, upperOpen);
  if (lower !== undefined) return KR.lowerBound(lower, lowerOpen);
  if (upper !== undefined) return KR.upperBound(upper, upperOpen);
  return null;
}
