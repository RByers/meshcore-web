/**
 * The one time source for core: wall-clock milliseconds plus timers. Everything that needs "now"
 * or a delay (client timeouts, emulator behaviour, store timestamps, cooldowns, toast dismissal)
 * receives a `Clock` instead of calling `Date.now()` / `setTimeout` directly, so tests can
 * substitute {@link ManualClock} (virtual time, advanced by hand) or {@link SkippableClock}
 * (real time that a test can jump forward past a timeout).
 */

export type TimerHandle = unknown;

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Real time: `Date.now()` and the global timers. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Timer {
  id: number;
  due: number;
  fn: () => void;
}

/** Default start of the test clocks: 2026-10-15T12:00:00Z. */
export const TEST_EPOCH_MS = Date.UTC(2026, 9, 15, 12, 0, 0);

/** Picks the earliest-due timer (FIFO for ties) at or before `limit`. */
function nextDue(timers: readonly Timer[], limit: number): Timer | undefined {
  let next: Timer | undefined;
  for (const t of timers) {
    if (t.due <= limit && (next === undefined || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
  }
  return next;
}

/**
 * Deterministic clock for tests: time only moves when `advance` / `advanceTo` is called, and
 * timers run in due order (FIFO for equal times) during the advance, including ones they add.
 */
export class ManualClock implements Clock {
  #now: number;
  #seq = 0;
  #timers: Timer[] = [];

  constructor(startMs = TEST_EPOCH_MS) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const t: Timer = { id: ++this.#seq, due: this.#now + Math.max(0, ms), fn };
    this.#timers.push(t);
    return t.id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
  }

  /** Number of timers not yet run. */
  get pendingTimers(): number {
    return this.#timers.length;
  }

  /** Due time of the earliest pending timer. */
  nextDue(): number | undefined {
    let best: number | undefined;
    for (const t of this.#timers) if (best === undefined || t.due < best) best = t.due;
    return best;
  }

  /** Runs every timer due at or before `target` (in due order), then sets now = target. */
  advanceTo(target: number): void {
    for (;;) {
      const run = nextDue(this.#timers, target);
      if (!run) break;
      this.#timers = this.#timers.filter((t) => t !== run);
      this.#now = Math.max(this.#now, run.due);
      run.fn();
    }
    this.#now = Math.max(this.#now, target);
  }

  /** Moves time forward by `ms`, running every timer that becomes due. */
  advance(ms: number): void {
    this.advanceTo(this.#now + Math.max(0, ms));
  }

  /** Sets the wall clock without running timers (simulates an RTC jump, not elapsed time). */
  set(ms: number): void {
    this.#now = ms;
  }

  /** Drops every pending timer. */
  clearAll(): void {
    this.#timers = [];
  }
}

/**
 * Real time that a test can jump forward: `now()` is `Date.now()` plus an offset, timers run on
 * the real event loop, and `skip(ms)` moves the offset and fires (in due order) every timer that
 * falls due, synchronously. Models keep real pacing (IndexedDB, rendering) while timeout paths —
 * ACK timeouts, remote-admin timeouts, cooldowns — are elapsed instantly instead of waited for.
 */
export class SkippableClock implements Clock {
  #offset = 0;
  #seq = 0;
  #timers: Timer[] = [];
  #real: TimerHandle | undefined;
  readonly #base: Clock;

  constructor(base: Clock = systemClock) {
    this.#base = base;
  }

  now(): number {
    return this.#base.now() + this.#offset;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const t: Timer = { id: ++this.#seq, due: this.now() + Math.max(0, ms), fn };
    this.#timers.push(t);
    this.#arm();
    return t.id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
    this.#arm();
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }

  /** Due time of a pending timer (undefined once it ran or was cleared). */
  dueOf(handle: TimerHandle): number | undefined {
    return this.#timers.find((t) => t.id === handle)?.due;
  }

  /**
   * Jumps `ms` into the future, running every timer that becomes due before returning. Time moves
   * timer by timer (as in {@link ManualClock}), so a timer sees `now()` equal to its due time and a
   * timer it schedules within the skipped span runs too.
   */
  skip(ms: number): void {
    const target = this.now() + Math.max(0, ms);
    for (;;) {
      const run = nextDue(this.#timers, target);
      if (!run) break;
      this.#timers = this.#timers.filter((t) => t !== run);
      this.#offset += Math.max(0, run.due - this.now());
      run.fn();
    }
    this.#offset += Math.max(0, target - this.now());
    this.#arm();
  }

  /** Drops every pending timer (teardown). */
  clearAll(): void {
    this.#timers = [];
    this.#arm();
  }

  #fireDue(): void {
    for (;;) {
      const run = nextDue(this.#timers, this.now());
      if (!run) break;
      this.#timers = this.#timers.filter((t) => t !== run);
      run.fn();
    }
    this.#arm();
  }

  /** (Re)schedules one real timer for the earliest pending due time. */
  #arm(): void {
    if (this.#real !== undefined) {
      this.#base.clearTimeout(this.#real);
      this.#real = undefined;
    }
    const next = nextDue(this.#timers, Number.POSITIVE_INFINITY);
    if (!next) return;
    this.#real = this.#base.setTimeout(() => {
      this.#real = undefined;
      this.#fireDue();
    }, Math.max(0, next.due - this.now()));
  }
}
