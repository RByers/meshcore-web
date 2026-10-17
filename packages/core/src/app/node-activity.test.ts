import { describe, expect, it } from 'vitest';
import { bucketActivity } from './node-activity.js';

const H = 3_600_000;

describe('bucketActivity', () => {
  it('fills aligned slots covering the window, oldest first', () => {
    const now = 100 * H + 30 * 60_000; // 100:30
    const sightings = [
      { id: 1, ts: 100 * H + 5, direction: 'rx' as const, payloadType: 4, keyed: true },
      { id: 2, ts: 100 * H + 10, direction: 'rx' as const, payloadType: 2, keyed: false },
      { id: 3, ts: 90 * H, direction: 'rx' as const, payloadType: 4, keyed: true },
      { id: 4, ts: 77 * H, direction: 'rx' as const, payloadType: 4, keyed: true }, // first slot
      { id: 5, ts: 77 * H - 1, direction: 'rx' as const, payloadType: 4, keyed: true }, // before the window
    ];
    const a = bucketActivity(sightings, '24h', now);
    expect(a.from).toBe(77 * H);
    expect(a.to).toBe(101 * H);
    expect(a.buckets).toHaveLength(24);
    expect(a.buckets[0]).toEqual({ start: 77 * H, end: 78 * H, count: 1 });
    expect(a.buckets[23]).toEqual({ start: 100 * H, end: 101 * H, count: 2 });
    expect(a.buckets[13]!.count).toBe(1);
    expect(a.total).toBe(4);
    expect(a.hashOnly).toBe(1);
    expect(a.max).toBe(2);
    expect(a.last).toBe(100 * H + 10);
  });

  it('uses 6-hour slots for 7 days and day slots for 30 days', () => {
    expect(bucketActivity([], '7d', 1000 * H).buckets).toHaveLength(28);
    const m = bucketActivity([], '30d', 1000 * H);
    expect(m.buckets).toHaveLength(30);
    expect(m.max).toBe(0);
    expect(m.last).toBeUndefined();
  });
});
