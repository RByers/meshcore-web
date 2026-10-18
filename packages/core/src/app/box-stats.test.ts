import { describe, expect, it } from 'vitest';
import { boxStats, quantileSorted } from './box-stats.js';

// Quartiles: R type 7 / numpy default — h = (n − 1)·p, interpolate between x[⌊h⌋] and x[⌊h⌋+1].
describe('boxStats', () => {
  it('is null for an empty sample (non-finite values ignored)', () => {
    expect(boxStats([])).toBeNull();
    expect(boxStats([NaN, Infinity])).toBeNull();
  });

  it('odd n: quartiles land on data points', () => {
    expect(boxStats([5, 1, 4, 2, 3])).toEqual({ n: 5, min: 1, q1: 2, median: 3, q3: 4, max: 5, mean: 3, whiskerLow: 1, whiskerHigh: 5, outliers: [] });
  });

  it('even n: quartiles interpolate (h = 0.75, 1.5, 2.25)', () => {
    expect(boxStats([4, 1, 3, 2])).toEqual({ n: 4, min: 1, q1: 1.75, median: 2.5, q3: 3.25, max: 4, mean: 2.5, whiskerLow: 1, whiskerHigh: 4, outliers: [] });
  });

  it('n = 1 and all-equal samples collapse to a point', () => {
    expect(boxStats([7])).toEqual({ n: 1, min: 7, q1: 7, median: 7, q3: 7, max: 7, mean: 7, whiskerLow: 7, whiskerHigh: 7, outliers: [] });
    expect(boxStats([-3, -3, -3])).toEqual({ n: 3, min: -3, q1: -3, median: -3, q3: -3, max: -3, mean: -3, whiskerLow: -3, whiskerHigh: -3, outliers: [] });
  });

  it('outliers on both sides; whiskers stop at the most extreme points inside 1.5·IQR', () => {
    // sorted: -20 1 2 3 4 5 6 7 8 30; q1 h=2.25 → 2.25, median h=4.5 → 4.5, q3 h=6.75 → 6.75
    // IQR 4.5 → fences -4.5 / 13.5
    expect(boxStats([30, 8, 7, 6, 5, 4, 3, 2, 1, -20, NaN])).toEqual({
      n: 10,
      min: -20,
      q1: 2.25,
      median: 4.5,
      q3: 6.75,
      max: 30,
      mean: 4.6,
      whiskerLow: 1,
      whiskerHigh: 8,
      outliers: [-20, 30],
    });
  });

  it('a value exactly on the fence is a whisker, not an outlier; zero IQR flags any spread', () => {
    // 1 2 3 4 5 9: q1 h=1.25 → 2.25, q3 h=3.75 → 4.75, IQR 2.5 → upper fence 8.5; 9 is out
    expect(boxStats([1, 2, 3, 4, 5, 9])).toMatchObject({ q1: 2.25, q3: 4.75, whiskerHigh: 5, outliers: [9] });
    // 0 1 2 3 4 7.5: q1 1.25, q3 3.75, IQR 2.5 → upper fence exactly 7.5, so 7.5 is the whisker
    expect(boxStats([0, 1, 2, 3, 4, 7.5])).toMatchObject({ q1: 1.25, q3: 3.75, whiskerHigh: 7.5, outliers: [] });
    expect(boxStats([0, 0, 0, 0, 10])).toMatchObject({ q1: 0, median: 0, q3: 0, whiskerLow: 0, whiskerHigh: 0, outliers: [10] });
  });

  it('quantileSorted clamps p and rejects an empty array', () => {
    expect(quantileSorted([1, 3], 0)).toBe(1);
    expect(quantileSorted([1, 3], 1)).toBe(3);
    expect(quantileSorted([1, 3], 2)).toBe(3);
    expect(() => quantileSorted([], 0.5)).toThrow(RangeError);
  });
});
