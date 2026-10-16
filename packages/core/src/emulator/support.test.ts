import { describe, expect, it } from 'vitest';
import { loraAirtimeMs } from './airtime.js';
import { ManualClock } from './clock.js';
import { createSeededRng, randomBytes } from './rng.js';

describe('ManualClock', () => {
  it('runs timers in due order (FIFO on ties), including timers added while advancing', () => {
    const c = new ManualClock(1000);
    const log: string[] = [];
    c.setTimeout(() => log.push('b@20'), 20);
    c.setTimeout(() => {
      log.push('a@10');
      c.setTimeout(() => log.push('c@15'), 5);
    }, 10);
    c.setTimeout(() => log.push('d@20'), 20);
    const cancelled = c.setTimeout(() => log.push('never'), 5);
    c.clearTimeout(cancelled);
    c.advance(19);
    expect(log).toEqual(['a@10', 'c@15']);
    expect(c.now()).toBe(1019);
    c.advance(100);
    expect(log).toEqual(['a@10', 'c@15', 'b@20', 'd@20']);
    expect(c.pendingTimers).toBe(0);
  });

  it('timers observe the time they were due', () => {
    const c = new ManualClock(0);
    let seen = -1;
    c.setTimeout(() => (seen = c.now()), 30);
    c.advance(100);
    expect(seen).toBe(30);
  });
});

describe('seeded rng', () => {
  it('is deterministic per seed', () => {
    expect(randomBytes(createSeededRng(1), 16)).toEqual(randomBytes(createSeededRng(1), 16));
    expect(randomBytes(createSeededRng(1), 16)).not.toEqual(randomBytes(createSeededRng(2), 16));
  });
});

describe('loraAirtimeMs (Semtech formula)', () => {
  it('matches the reference value for SF7/125 kHz/CR4/5, and grows with SF and length', () => {
    // 20 bytes, SF7, BW125 (Tsym 1.024 ms), CR4/5, 32-symbol preamble:
    // payload = 8 + ceil((160 − 28 + 28 + 16) / 28) × 5 = 43 symbols; (36.25 + 43) × 1.024 = 81.15 ms
    expect(loraAirtimeMs(20, 7, 125000, 5)).toBe(81);
    expect(loraAirtimeMs(50, 11, 250000, 5)).toBeGreaterThan(loraAirtimeMs(50, 9, 250000, 5));
    expect(loraAirtimeMs(100, 9, 125000, 5)).toBeGreaterThan(loraAirtimeMs(10, 9, 125000, 5));
  });
});
