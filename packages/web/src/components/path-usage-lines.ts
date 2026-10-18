/**
 * Shared drawing helpers for weighted "paths usage" maps (`PathUsageMap` from core): the contact
 * Stats tab's "Paths heard via" map and the packet Stats tab's "Packet paths" map.
 */
import type { PathUsageMap } from '@meshcore-web/core/app';
import type { MapLine } from './tile-map.js';

/** Line widths (px) on a paths map: the busiest hop gets MAX, others scale linearly down to MIN. */
export const MIN_LINE = 2;
export const MAX_LINE = 14;
/** Marker diameters (rem) when sized by use: the busiest stop gets MAX, others scale by area. */
export const MIN_MARKER = 1.1;
export const MAX_MARKER = 2;

/** Map lines for a paths-usage map: width proportional to how many packets crossed each hop. */
export function usageLines(m: PathUsageMap): MapLine[] {
  return m.edges.map((e) => ({
    points: [e.a, e.b],
    width: m.maxCount ? Math.max(MIN_LINE, (MAX_LINE * e.count) / m.maxCount) : MIN_LINE,
    dashed: e.approximate,
    id: e.id,
  }));
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
