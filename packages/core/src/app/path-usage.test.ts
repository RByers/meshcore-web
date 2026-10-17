import { describe, expect, it } from 'vitest';
import type { PathGeoNode } from './path-geometry.js';
import { buildPathUsageMap } from './path-usage.js';

const node = (key: string, name: string, kind: PathGeoNode['kind'], lat?: number, lon?: number): PathGeoNode =>
  lat === undefined || lon === undefined ? { key, name, kind } : { key, name, kind, lat, lon };

const SELF = node('5e1f'.padEnd(64, '0'), 'Me', 'self', 47.6, -122.3);
const ALPHA = node('aa01'.padEnd(64, '0'), 'Alpha', 'repeater', 47.7, -122.3);
const BRAVO = node('bb02'.padEnd(64, '0'), 'Bravo', 'repeater', 47.7, -122.1);
const CONTACT = node('dd04'.padEnd(64, '0'), 'Delta', 'chat', 48.0, -122.3);
const NODES = [ALPHA, BRAVO, CONTACT];

const counts = (m: ReturnType<typeof buildPathUsageMap>) => Object.fromEntries(m.edges.map((e) => [[e.a.label, e.b.label].sort().join('-'), e.count]));

describe('buildPathUsageMap', () => {
  it('sums packets per hop segment across paths', () => {
    const m = buildPathUsageMap(
      [
        { hashes: ['aa'], count: 5 },
        { hashes: ['bb', 'aa'], count: 3 },
        { hashes: [], count: 2 },
      ],
      CONTACT.key,
      NODES,
      SELF,
    );
    expect(counts(m)).toEqual({ 'Alpha-Delta': 5, 'Alpha-Me (you)': 8, 'Bravo-Delta': 3, 'Alpha-Bravo': 3, 'Delta-Me (you)': 2 });
    expect(m.edges[0]!.count).toBe(8); // busiest first
    expect(m.maxCount).toBe(8);
    expect(m.total).toBe(10);
    expect(m.incomplete).toBe(0);
    expect(m.stops.find((s) => s.node === ALPHA)!.count).toBe(8);
    expect(m.stops.find((s) => s.role === 'from')!.count).toBe(10);
    expect(m.bounds).toEqual({ south: 47.6, west: -122.3, north: 48.0, east: -122.1 });
  });

  const UNKNOWN_HOPS = [
    { hashes: ['99'], count: 1 }, // unknown hop: interpolated between Delta and Me
    { hashes: ['aa', '99'], count: 1 }, // the same hash, estimated elsewhere
  ];

  it('leaves estimated hops off by default, dashing the segments that skip them', () => {
    const m = buildPathUsageMap(UNKNOWN_HOPS, CONTACT.key, NODES, SELF);
    expect(m.stops.filter((s) => s.label === '99')).toHaveLength(0);
    expect(m.incomplete).toBe(2);
    expect(m.edges.map((e) => [[e.a.label, e.b.label].sort().join('-'), e.count, e.approximate]).sort()).toEqual([
      ['Alpha-Delta', 1, false],
      ['Alpha-Me (you)', 1, true],
      ['Delta-Me (you)', 1, true],
    ]);
  });

  it('keeps a segment firm when any path crossed it between known stops', () => {
    const m = buildPathUsageMap([{ hashes: ['aa'], count: 2 }, { hashes: ['99', 'aa'], count: 1 }], CONTACT.key, NODES, SELF);
    expect(m.edges.find((x) => [x.a.label, x.b.label].includes('Delta'))).toMatchObject({ count: 3, approximate: false });
  });

  it('with estimate, marks estimated hops approximate and keeps them apart by position', () => {
    const m = buildPathUsageMap(UNKNOWN_HOPS, CONTACT.key, NODES, SELF, { estimate: true });
    const unknown = m.stops.filter((s) => s.label === '99');
    expect(unknown).toHaveLength(2);
    expect(unknown.every((s) => s.approximate)).toBe(true);
    expect(m.edges.filter((e) => e.approximate)).toHaveLength(4); // both legs of each estimated hop
  });

  it('counts packets whose path cannot be fully placed', () => {
    const m = buildPathUsageMap([{ hashes: ['aa'], count: 4 }], 'ff'.repeat(32), NODES, null, { estimate: true });
    expect(m.incomplete).toBe(4);
    expect(counts(m)).toEqual({}); // only Alpha has a position: nothing to connect
    expect(buildPathUsageMap([], CONTACT.key, NODES, SELF)).toMatchObject({ edges: [], maxCount: 0, total: 0, bounds: null });
  });
});
