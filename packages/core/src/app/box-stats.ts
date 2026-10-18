/**
 * Box-and-whisker statistics (Tukey). Pure; used for the SNR box plots (docs/packet-stats.md §1.6).
 */

/** Five-number summary plus Tukey whiskers / outliers of a sample ({@link boxStats}). */
export interface BoxStats {
  /** Sample size. */
  n: number;
  min: number;
  /** First quartile (linear interpolation, R type 7 / numpy default). */
  q1: number;
  median: number;
  /** Third quartile. */
  q3: number;
  max: number;
  mean: number;
  /** Smallest value ≥ q1 − 1.5·IQR. */
  whiskerLow: number;
  /** Largest value ≤ q3 + 1.5·IQR. */
  whiskerHigh: number;
  /** Values beyond the whiskers, ascending (uncapped). */
  outliers: number[];
}

/**
 * Quantile `p` (0..1) of an ascending, non-empty array by linear interpolation between the closest
 * ranks: h = (n − 1)·p, Q = x[⌊h⌋] + (h − ⌊h⌋)·(x[⌊h⌋+1] − x[⌊h⌋]) (R type 7, numpy's default).
 */
export function quantileSorted(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) throw new RangeError('quantileSorted: empty');
  const h = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const a = sorted[lo]!;
  const b = sorted[Math.min(lo + 1, n - 1)]!;
  return a + (h - lo) * (b - a);
}

/**
 * Tukey box statistics of `values` (null when empty; non-finite values are ignored). Quartiles by
 * {@link quantileSorted}; whiskers reach the most extreme data points within 1.5·IQR of the box;
 * points beyond are outliers.
 */
export function boxStats(values: readonly number[]): BoxStats | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return null;
  const q1 = quantileSorted(xs, 0.25);
  const median = quantileSorted(xs, 0.5);
  const q3 = quantileSorted(xs, 0.75);
  const fence = 1.5 * (q3 - q1);
  const loFence = q1 - fence;
  const hiFence = q3 + fence;
  let whiskerLow = q1;
  let whiskerHigh = q3;
  let sum = 0;
  const outliers: number[] = [];
  for (const v of xs) {
    sum += v;
    if (v < loFence || v > hiFence) outliers.push(v);
    else {
      whiskerLow = Math.min(whiskerLow, v);
      whiskerHigh = Math.max(whiskerHigh, v);
    }
  }
  return { n, min: xs[0]!, q1, median, q3, max: xs[n - 1]!, mean: sum / n, whiskerLow, whiskerHigh, outliers };
}
