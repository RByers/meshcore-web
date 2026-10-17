/**
 * Deterministic time for client ↔ emulator tests: `drive()` alternates "let microtasks settle"
 * with "jump the ManualClock to its next timer" until a promise settles. Not part of the client barrel.
 */

import { ManualClock } from '../util/clock.js';

/** @deprecated the manual clock now lives in util/clock.ts; kept so existing tests read naturally. */
export { ManualClock as SteppingClock };

/** Lets every queued microtask (and microtask-delivered loopback frame) run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

/**
 * Settles microtasks, then jumps the clock to the next timer, until `p` settles. Throws if `p`
 * is still pending with no timers left, or after `maxMs` of virtual time.
 */
export async function drive<T>(clock: ManualClock, p: Promise<T>, maxMs = 10 * 60_000): Promise<T> {
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
export async function runFor(clock: ManualClock, ms: number): Promise<void> {
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
