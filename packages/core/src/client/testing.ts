/**
 * Deterministic time for client ↔ emulator tests: a clock whose timers only run when the test
 * advances it, and `drive()`, which alternates "let microtasks settle" with "jump to the next
 * timer" until a promise settles. Not part of the client barrel.
 */

import type { ClientClock } from './types.js';

interface Timer {
  id: number;
  due: number;
  fn: () => void;
}

/** Manual clock (compatible with ClientClock and the emulator's EmulatorClock) that knows its next due timer. */
export class SteppingClock implements ClientClock {
  #now: number;
  #seq = 0;
  #timers: Timer[] = [];

  constructor(startMs = Date.UTC(2026, 9, 15, 12, 0, 0)) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const t: Timer = { id: ++this.#seq, due: this.#now + Math.max(0, ms), fn };
    this.#timers.push(t);
    return t.id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }

  /** Due time of the earliest pending timer. */
  nextDue(): number | undefined {
    let best: number | undefined;
    for (const t of this.#timers) if (best === undefined || t.due < best) best = t.due;
    return best;
  }

  /** Runs every timer due at or before `target` (in due order, FIFO for ties), then sets now = target. */
  advanceTo(target: number): void {
    for (;;) {
      let next: Timer | undefined;
      for (const t of this.#timers) {
        if (t.due <= target && (next === undefined || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
      }
      if (!next) break;
      const run = next;
      this.#timers = this.#timers.filter((t) => t !== run);
      this.#now = Math.max(this.#now, run.due);
      run.fn();
    }
    this.#now = Math.max(this.#now, target);
  }

  advance(ms: number): void {
    this.advanceTo(this.#now + Math.max(0, ms));
  }
}

/** Lets every queued microtask (and microtask-delivered loopback frame) run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

/**
 * Settles microtasks, then jumps the clock to the next timer, until `p` settles. Throws if `p`
 * is still pending with no timers left, or after `maxMs` of virtual time.
 */
export async function drive<T>(clock: SteppingClock, p: Promise<T>, maxMs = 10 * 60_000): Promise<T> {
  let state: 'pending' | 'ok' | 'err' = 'pending';
  let value: T | undefined;
  let error: unknown;
  p.then(
    (v) => {
      state = 'ok';
      value = v;
    },
    (e: unknown) => {
      state = 'err';
      error = e;
    },
  );
  const end = clock.now() + maxMs;
  for (;;) {
    await settle();
    if (state !== 'pending') break;
    const next = clock.nextDue();
    if (next === undefined) throw new Error('drive: promise pending and no timers left');
    if (next > end) throw new Error(`drive: still pending after ${maxMs} ms of virtual time`);
    clock.advanceTo(next);
  }
  if (state === 'err') throw error;
  return value as T;
}

/** Runs timers up to `ms` of virtual time from now, settling microtasks between them. */
export async function runFor(clock: SteppingClock, ms: number): Promise<void> {
  const end = clock.now() + ms;
  for (;;) {
    await settle();
    const next = clock.nextDue();
    if (next === undefined || next > end) break;
    clock.advanceTo(next);
  }
  clock.advanceTo(end);
  await settle();
}
