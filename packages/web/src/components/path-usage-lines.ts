/**
 * Shared drawing helpers for directed, weighted "paths usage" maps (`PathUsageMap` from core): the contact
 * Stats tab's "Paths heard via" map, the packet Stats tab's "Packet paths" map and the Packets
 * list's "Map". Each line carries an arrow showing travel direction.
 */
import type { PathUsageMap } from '@meshcore-web/core/app';
import type { MapLine } from './tile-map.js';

/** Line widths (px) on a paths map: the busiest hop gets MAX, others scale linearly down to MIN. */
export const MIN_LINE = 2;
export const MAX_LINE = 14;
/** Marker diameters (rem) when sized by use: the busiest stop gets MAX, others scale by area. */
export const MIN_MARKER = 1.1;
export const MAX_MARKER = 2;

/** Line width (px) of a hop crossed by `count` packets when the busiest has `maxCount`. */
function usageWidth(count: number, maxCount: number): number {
  return maxCount ? Math.max(MIN_LINE, (MAX_LINE * count) / maxCount) : MIN_LINE;
}

/**
 * Map lines for a directed paths-usage map (`usage` / `routesUsage(…, { directed: true })`: `e.a`
 * → `e.b` in travel order): width proportional to how many packets crossed each hop that way, and
 * a direction arrow at the middle. A hop crossed both ways draws
 * its two lines side by side (each shifted to its right of travel) instead of on top of each other.
 */
export function directedUsageLines(m: PathUsageMap): MapLine[] {
  const hops = new Set(m.edges.map((e) => `${e.a.id}\n${e.b.id}`));
  return m.edges.map((e) => {
    const width = usageWidth(e.count, m.maxCount);
    const twoWay = hops.has(`${e.b.id}\n${e.a.id}`);
    return { points: [e.a, e.b], width, dashed: e.approximate, id: e.id, arrow: true, ...(twoWay ? { offset: width / 2 + 1 } : {}) };
  });
}

/**
 * Marker diameter (rem) for a stop used by `count` packets when the busiest stop has `maxCount`:
 * area proportional to use (diameter ∝ √count), between MIN_MARKER and MAX_MARKER.
 */
export function usageMarkerSize(count: number, maxCount: number): number {
  if (maxCount <= 0) return MIN_MARKER;
  const f = Math.sqrt(Math.max(0, Math.min(1, count / maxCount)));
  return MIN_MARKER + (MAX_MARKER - MIN_MARKER) * f;
}
