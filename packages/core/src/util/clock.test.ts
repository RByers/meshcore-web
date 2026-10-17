import { describe, expect, it } from 'vitest';
import { ManualClock, SkippableClock, systemClock, type Clock } from './clock.js';

describe('ManualClock', () => {
  it('advanceTo runs due timers in order and reports the next due time', () => {
    const c = new ManualClock(1000);
    const log: string[] = [];
    c.setTimeout(() => log.push('b'), 20);
    c.setTimeout(() => log.push('a'), 10);
    expect(c.nextDue()).toBe(1010);
    c.advanceTo(1015);
    expect(log).toEqual(['a']);
    expect(c.now()).toBe(1015);
    expect(c.nextDue()).toBe(1020);
    c.clearAll();
    expect(c.pendingTimers).toBe(0);
    c.advance(100);
    expect(log).toEqual(['a']);
  });

  it('set jumps the wall clock without running timers', () => {
    const c = new ManualClock(0);
    let fired = false;
    c.setTimeout(() => (fired = true), 10);
    c.set(5000);
    expect(fired).toBe(false);
    expect(c.now()).toBe(5000);
  });
});

describe('SkippableClock', () => {
  /** A manual base clock stands in for real time so the test itself never waits. */
  function clocks(): { base: ManualClock; c: SkippableClock } {
    const base = new ManualClock(0);
    return { base, c: new SkippableClock(base) };
  }

  it('now() is the base time plus the skipped offset', () => {
    const { base, c } = clocks();
    expect(c.now()).toBe(0);
    base.advance(100);
    c.skip(1000);
    expect(c.now()).toBe(1100);
  });

  it('timers fire on real time when not skipped, in due order', () => {
    const { base, c } = clocks();
    const log: string[] = [];
    c.setTimeout(() => log.push('b@20'), 20);
    c.setTimeout(() => log.push('a@10'), 10);
    expect(base.pendingTimers).toBe(1); // one real timer armed for the earliest due
    base.advance(10);
    expect(log).toEqual(['a@10']);
    base.advance(10);
    expect(log).toEqual(['a@10', 'b@20']);
    expect(c.pendingTimers).toBe(0);
    expect(base.pendingTimers).toBe(0);
  });

  it('skip() fires every timer that falls due, synchronously and in order, including ones they add', () => {
    const { c } = clocks();
    const log: string[] = [];
    c.setTimeout(() => log.push('late'), 5000);
    c.setTimeout(() => {
      log.push('first');
      c.setTimeout(() => log.push('chained'), 100);
    }, 1000);
    c.setTimeout(() => log.push('never'), 10_000);
    c.skip(1500);
    expect(log).toEqual(['first', 'chained']);
    c.skip(5000);
    expect(log).toEqual(['first', 'chained', 'late']);
    expect(c.pendingTimers).toBe(1);
  });

  it('clearTimeout and clearAll drop timers and re-arm the real timer', () => {
    const { base, c } = clocks();
    const log: string[] = [];
    const h = c.setTimeout(() => log.push('x'), 10);
    c.setTimeout(() => log.push('y'), 50);
    c.clearTimeout(h);
    base.advance(10);
    expect(log).toEqual([]);
    base.advance(40);
    expect(log).toEqual(['y']);
    c.setTimeout(() => log.push('z'), 10);
    c.clearAll();
    base.advance(100);
    expect(log).toEqual(['y']);
    expect(base.pendingTimers).toBe(0);
  });

  it('is a Clock backed by the system clock by default', async () => {
    const c: Clock = new SkippableClock();
    expect(Math.abs(c.now() - systemClock.now())).toBeLessThan(50);
    await new Promise<void>((r) => c.setTimeout(r, 0));
  });
});
