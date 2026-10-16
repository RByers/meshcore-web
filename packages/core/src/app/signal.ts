/**
 * A tiny reactive primitive for the app models (no DOM, no dependencies).
 *
 * - `signal(v)`: a writable value. Reading `.value` inside `computed` / `effect` tracks it.
 * - `computed(fn)`: a derived value; recomputed lazily, and eagerly while it has watchers so
 *   watchers fire only when the derived value actually changes.
 * - `effect(fn)`: runs `fn` now and again whenever a signal it read changes; `fn` may return a
 *   cleanup that runs before the next run and on dispose.
 * - `batch(fn)`: defers notifications until `fn` returns; each watcher runs at most once.
 * - `.subscribe(listener)`: plain change listener (not called immediately), used by the Lit
 *   controller in the web package.
 *
 * Equality is `Object.is` by default; pass `{ equals }` to change it. Mutate by assigning a new
 * value (arrays/objects are not deep-watched).
 */

import type { Unsubscribe } from '../util/events.js';

export interface ReadonlySignal<T> {
  /** Current value; tracked when read inside computed/effect. */
  readonly value: T;
  /** Current value without tracking. */
  peek(): T;
  /** Calls `listener` with the new value after each change. Not called immediately. */
  subscribe(listener: (value: T) => void): Unsubscribe;
}

export interface Signal<T> extends ReadonlySignal<T> {
  value: T;
  /** `value = fn(value)`. */
  update(fn: (value: T) => T): void;
  /** A read-only view of this signal. */
  readonly readonly: ReadonlySignal<T>;
}

export interface SignalOptions<T> {
  equals?: (a: T, b: T) => boolean;
}

/** Internal: anything that can be tracked. */
interface Source {
  watch(cb: () => void): Unsubscribe;
}

interface Tracker {
  track(source: Source): void;
}

let currentTracker: Tracker | undefined;
let batchDepth = 0;
const pending = new Set<() => void>();

function runWatchers(watchers: Iterable<() => void>): void {
  if (batchDepth > 0) {
    for (const w of watchers) pending.add(w);
    return;
  }
  let firstError: unknown;
  let failed = false;
  for (const w of [...watchers]) {
    try {
      w();
    } catch (err) {
      if (!failed) {
        failed = true;
        firstError = err;
      }
    }
  }
  if (failed) throw firstError;
}

/** Runs `fn`, deferring watcher notifications until it returns. Nested batches flush once. */
export function batch<R>(fn: () => R): R {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0 && pending.size > 0) {
      const ws = [...pending];
      pending.clear();
      runWatchers(ws);
    }
  }
}

/** Reads signals inside `fn` without tracking them. */
export function untracked<R>(fn: () => R): R {
  const prev = currentTracker;
  currentTracker = undefined;
  try {
    return fn();
  } finally {
    currentTracker = prev;
  }
}

class WritableSignal<T> implements Signal<T>, Source {
  #value: T;
  readonly #equals: (a: T, b: T) => boolean;
  readonly #watchers = new Set<() => void>();
  #readonly: ReadonlySignal<T> | undefined;

  constructor(value: T, opts: SignalOptions<T> = {}) {
    this.#value = value;
    this.#equals = opts.equals ?? Object.is;
  }

  get value(): T {
    currentTracker?.track(this);
    return this.#value;
  }

  set value(v: T) {
    if (this.#equals(this.#value, v)) return;
    this.#value = v;
    runWatchers(this.#watchers);
  }

  peek(): T {
    return this.#value;
  }

  update(fn: (value: T) => T): void {
    this.value = fn(this.#value);
  }

  watch(cb: () => void): Unsubscribe {
    // wrap so the same callback can be registered by several watchers independently
    const entry = (): void => cb();
    this.#watchers.add(entry);
    return () => {
      this.#watchers.delete(entry);
    };
  }

  subscribe(listener: (value: T) => void): Unsubscribe {
    return this.watch(() => listener(this.#value));
  }

  get readonly(): ReadonlySignal<T> {
    if (!this.#readonly) {
      const self = this;
      this.#readonly = {
        get value() {
          return self.value;
        },
        peek: () => self.peek(),
        subscribe: (l) => self.subscribe(l),
        watch: (cb: () => void) => self.watch(cb),
      } as ReadonlySignal<T> & Source;
    }
    return this.#readonly;
  }
}

class ComputedSignal<T> implements ReadonlySignal<T>, Source {
  readonly #fn: () => T;
  readonly #equals: (a: T, b: T) => boolean;
  readonly #watchers = new Set<() => void>();
  #deps = new Map<Source, Unsubscribe>();
  #value: T | undefined;
  #hasValue = false;
  #dirty = true;
  #computing = false;

  constructor(fn: () => T, opts: SignalOptions<T> = {}) {
    this.#fn = fn;
    this.#equals = opts.equals ?? Object.is;
  }

  get value(): T {
    currentTracker?.track(this);
    return this.peek();
  }

  peek(): T {
    if (this.#dirty || this.#watchers.size === 0) this.#recompute();
    return this.#value as T;
  }

  #recompute(): void {
    if (this.#computing) throw new Error('computed: cycle detected');
    this.#computing = true;
    const seen = new Set<Source>();
    const prev = currentTracker;
    currentTracker = { track: (s) => seen.add(s) };
    let next: T;
    try {
      next = this.#fn();
    } finally {
      currentTracker = prev;
      this.#computing = false;
    }
    this.#dirty = false;
    if (this.#watchers.size > 0) this.#syncDeps(seen);
    if (!this.#hasValue || !this.#equals(this.#value as T, next)) this.#value = next;
    this.#hasValue = true;
  }

  #syncDeps(seen: Set<Source>): void {
    for (const [s, off] of this.#deps) {
      if (!seen.has(s)) {
        off();
        this.#deps.delete(s);
      }
    }
    for (const s of seen) if (!this.#deps.has(s)) this.#deps.set(s, s.watch(() => this.#onDepChange()));
  }

  #onDepChange(): void {
    const had = this.#hasValue;
    const old = this.#value;
    this.#dirty = true;
    this.#recompute();
    if (!had || !Object.is(old, this.#value)) runWatchers(this.#watchers);
  }

  watch(cb: () => void): Unsubscribe {
    const entry = (): void => cb();
    if (this.#watchers.size === 0) {
      this.#watchers.add(entry);
      this.#dirty = true;
      this.#recompute(); // subscribes to deps
    } else {
      this.#watchers.add(entry);
    }
    return () => {
      this.#watchers.delete(entry);
      if (this.#watchers.size === 0) {
        for (const off of this.#deps.values()) off();
        this.#deps.clear();
        this.#dirty = true;
      }
    };
  }

  subscribe(listener: (value: T) => void): Unsubscribe {
    return this.watch(() => listener(this.#value as T));
  }
}

export function signal<T>(value: T, opts?: SignalOptions<T>): Signal<T> {
  return new WritableSignal(value, opts);
}

export function computed<T>(fn: () => T, opts?: SignalOptions<T>): ReadonlySignal<T> {
  return new ComputedSignal(fn, opts);
}

/**
 * Runs `fn` now and whenever a signal it read changes. Returns a dispose function. If `fn`
 * returns a function, it is called before the next run and on dispose.
 */
export function effect(fn: () => void | (() => void)): Unsubscribe {
  const deps = new Map<Source, Unsubscribe>();
  let cleanup: void | (() => void);
  let disposed = false;
  let running = false;
  let rerun = false;

  const run = (): void => {
    if (disposed) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        if (typeof cleanup === 'function') cleanup();
        cleanup = undefined;
        const seen = new Set<Source>();
        const prev = currentTracker;
        // subscribe as soon as a dependency is read, so writes made by fn itself are seen
        currentTracker = {
          track: (s) => {
            seen.add(s);
            if (!deps.has(s)) deps.set(s, s.watch(run));
          },
        };
        try {
          cleanup = fn();
        } finally {
          currentTracker = prev;
          for (const [s, off] of deps) {
            if (!seen.has(s)) {
              off();
              deps.delete(s);
            }
          }
        }
      } while (rerun && !disposed);
    } finally {
      running = false;
    }
  };

  run();
  return () => {
    if (disposed) return;
    disposed = true;
    for (const off of deps.values()) off();
    deps.clear();
    if (typeof cleanup === 'function') cleanup();
    cleanup = undefined;
  };
}

/** Resolves with the first value (including the current one) for which `pred` is true. */
export function when<T>(s: ReadonlySignal<T>, pred: (v: T) => boolean): Promise<T> {
  const now = s.peek();
  if (pred(now)) return Promise.resolve(now);
  return new Promise((resolve) => {
    const off = s.subscribe((v) => {
      if (pred(v)) {
        off();
        resolve(v);
      }
    });
  });
}

/**
 * Low-level dependency tracker for UI bindings: signals read between `begin()` and `end()` (or
 * inside `run(fn)`) are watched, and `onChange` is called (synchronously) when any of them
 * changes. Each begin/end pass replaces the previous dependency set. Used by the Lit
 * `SignalController` to re-render an element when anything its render read changes.
 */
export class Watcher {
  readonly #deps = new Map<Source, Unsubscribe>();
  #seen: Set<Source> | null = null;
  #prev: Tracker | undefined;
  #disposed = false;

  constructor(private readonly onChange: () => void) {}

  /** Starts tracking. An unmatched begin is ended automatically on the next microtask. */
  begin(): void {
    if (this.#seen) this.end();
    this.#disposed = false;
    const seen = new Set<Source>();
    this.#seen = seen;
    this.#prev = currentTracker;
    currentTracker = { track: (s) => seen.add(s) };
    queueMicrotask(() => {
      if (this.#seen === seen) this.end();
    });
  }

  /** Stops tracking and subscribes to exactly what was read since `begin()`. */
  end(): void {
    const seen = this.#seen;
    if (!seen) return;
    this.#seen = null;
    currentTracker = this.#prev;
    this.#prev = undefined;
    if (this.#disposed) return;
    for (const [s, off] of this.#deps) {
      if (!seen.has(s)) {
        off();
        this.#deps.delete(s);
      }
    }
    for (const s of seen) if (!this.#deps.has(s)) this.#deps.set(s, s.watch(() => this.onChange()));
  }

  run<R>(fn: () => R): R {
    this.begin();
    try {
      return fn();
    } finally {
      this.end();
    }
  }

  /** Number of signals currently watched. */
  get size(): number {
    return this.#deps.size;
  }

  /** Unsubscribes from everything (tracking can start again with `begin()`). */
  dispose(): void {
    this.#disposed = true;
    if (this.#seen) this.end();
    for (const off of this.#deps.values()) off();
    this.#deps.clear();
  }
}
