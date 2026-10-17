/**
 * Packets heard from one node over time (contact page chart): the packet log's source-node scan
 * (`PacketLog.sourceActivity`, srcHash_ts index) bucketed into fixed time slots.
 */

import type { SourceSighting } from '../store/packet-log.js';

export type ActivityRange = '24h' | '7d' | '30d';

const HOUR = 3_600_000;

/** Window length and slot size per range. */
export const ACTIVITY_RANGES: Readonly<Record<ActivityRange, { spanMs: number; bucketMs: number; label: string }>> = {
  '24h': { spanMs: 24 * HOUR, bucketMs: HOUR, label: '24 hours' },
  '7d': { spanMs: 7 * 24 * HOUR, bucketMs: 6 * HOUR, label: '7 days' },
  '30d': { spanMs: 30 * 24 * HOUR, bucketMs: 24 * HOUR, label: '30 days' },
};

export interface ActivityBucket {
  /** Slot start, epoch ms (inclusive). */
  start: number;
  /** Slot end, epoch ms (exclusive). */
  end: number;
  count: number;
}

export interface NodeActivity {
  range: ActivityRange;
  from: number;
  to: number;
  bucketMs: number;
  /** Oldest first; covers `from`..`to` without gaps. */
  buckets: ActivityBucket[];
  total: number;
  /**
   * Packets matched only by the 1-byte source hash (no full key in the packet): another node whose
   * key starts with the same byte would be counted too.
   */
  hashOnly: number;
  /** Largest bucket count (0 when empty). */
  max: number;
  /** Newest packet in the window, epoch ms. */
  last?: number;
}

/**
 * Buckets `sightings` into the `range` window ending at `now`. Slots are aligned to the bucket size
 * (local time is not considered: hours / 6 h / UTC days) so the chart does not shift every minute.
 */
export function bucketActivity(sightings: readonly SourceSighting[], range: ActivityRange, now: number): NodeActivity {
  const { spanMs, bucketMs } = ACTIVITY_RANGES[range];
  const to = Math.floor(now / bucketMs) * bucketMs + bucketMs;
  const n = Math.round(spanMs / bucketMs);
  const from = to - n * bucketMs;
  const buckets: ActivityBucket[] = Array.from({ length: n }, (_, i) => ({ start: from + i * bucketMs, end: from + (i + 1) * bucketMs, count: 0 }));
  let total = 0;
  let hashOnly = 0;
  let last: number | undefined;
  for (const s of sightings) {
    if (s.ts < from || s.ts >= to) continue;
    const b = buckets[Math.floor((s.ts - from) / bucketMs)];
    if (!b) continue;
    b.count++;
    total++;
    if (!s.keyed) hashOnly++;
    if (last === undefined || s.ts > last) last = s.ts;
  }
  const out: NodeActivity = { range, from, to, bucketMs, buckets, total, hashOnly, max: Math.max(0, ...buckets.map((b) => b.count)) };
  if (last !== undefined) out.last = last;
  return out;
}
