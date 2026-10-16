/**
 * Time sources for the emulator. `now()` is wall-clock milliseconds (Unix epoch); timers drive
 * deferred device behaviour (ACKs, remote responses, contact streaming).
 */

export type TimerHandle = unknown;

export interface EmulatorClock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Real time (Date.now / global setTimeout). */
export const systemClock: EmulatorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface ManualTimer {
  id: number;
  due: number;
  fn: () => void;
}

/**
 * Deterministic clock for tests: time only moves when `advance` is called, and timers run in
 * due-time order (FIFO for equal times) during the advance.
 */
export class ManualClock implements EmulatorClock {
  #now: number;
  #seq = 0;
  #timers: ManualTimer[] = [];

  /** Default start: 2026-10-15T12:00:00Z. */
  constructor(startMs = Date.UTC(2026, 9, 15, 12, 0, 0)) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const t: ManualTimer = { id: ++this.#seq, due: this.#now + Math.max(0, ms), fn };
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

  /** Moves time forward by `ms`, running every timer that becomes due (including ones they add). */
  advance(ms: number): void {
    const target = this.#now + Math.max(0, ms);
    for (;;) {
      let next: ManualTimer | undefined;
      for (const t of this.#timers) {
        if (t.due <= target && (next === undefined || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
      }
      if (!next) break;
      const run = next;
      this.#timers = this.#timers.filter((t) => t !== run);
      this.#now = Math.max(this.#now, run.due);
      run.fn();
    }
    this.#now = target;
  }

  /** Sets the wall clock without running timers (simulates an RTC jump, not elapsed time). */
  set(ms: number): void {
    this.#now = ms;
  }
}
