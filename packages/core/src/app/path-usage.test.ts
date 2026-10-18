import { describe, expect, it } from 'vitest';
import type { PathGeoNode } from './path-geometry.js';
import { buildPathUsageMap, buildRouteUsageMap } from './path-usage.js';

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

describe('buildRouteUsageMap', () => {
  const ECHO = node('ee05'.padEnd(64, '0'), 'Echo', 'chat', 47.9, -122.0);
  const ALL = [...NODES, ECHO];

  describe('directed', () => {
    // Delta → Alpha → me, and me → Alpha → Delta: the same hops in opposite directions
    const ROUTES = [
      { hashes: ['aa'], from: { kind: 'contact', key: CONTACT.key }, to: { kind: 'self' }, count: 3 },
      { hashes: ['aa'], from: { kind: 'self' }, to: { kind: 'contact', key: CONTACT.key }, count: 2 },
    ] as const;
    const edges = (m: ReturnType<typeof buildRouteUsageMap>) => m.edges.map((e) => ({ id: e.id, a: e.a.label, b: e.b.label, count: e.count }));

    it('merges both directions into one edge by default', () => {
      const m = buildRouteUsageMap(ROUTES, ALL, SELF);
      expect(counts(m)).toEqual({ 'Alpha-Delta': 5, 'Alpha-Me (you)': 5 });
      expect(m.edges.every((e) => e.id === `${e.a.id}|${e.b.id}` && e.a.id < e.b.id)).toBe(true);
    });

    it('keeps A→B and B→A apart, a = from and b = to', () => {
      const m = buildRouteUsageMap(ROUTES, ALL, SELF, { directed: true });
      expect(edges(m)).toEqual([
        { id: `${ALPHA.key}>${SELF.key}`, a: 'Alpha', b: 'Me (you)', count: 3 },
        { id: `${CONTACT.key}>${ALPHA.key}`, a: 'Delta', b: 'Alpha', count: 3 },
        { id: `${SELF.key}>${ALPHA.key}`, a: 'Me (you)', b: 'Alpha', count: 2 },
        { id: `${ALPHA.key}>${CONTACT.key}`, a: 'Alpha', b: 'Delta', count: 2 },
      ]);
      expect(m.maxCount).toBe(3);
      expect(m.total).toBe(5);
      expect(m.stops.find((s) => s.node === ALPHA)!.count).toBe(5);
    });
  });

  it('merges routes from different origins through a shared hop into one map', () => {
    const m = buildRouteUsageMap(
      [
        { hashes: ['aa'], from: { kind: 'contact', key: CONTACT.key }, to: { kind: 'self' }, count: 3 },
        { hashes: ['bb', 'aa'], from: { kind: 'hash', hash: 'ee' }, to: { kind: 'self' }, count: 2 },
      ],
      ALL,
      SELF,
    );
    expect(counts(m)).toEqual({ 'Alpha-Delta': 3, 'Alpha-Me (you)': 5, 'Bravo-Echo': 2, 'Alpha-Bravo': 2 });
    expect(m.stops.find((s) => s.node === ALPHA)!.count).toBe(5);
    expect(m.total).toBe(5);
    expect(m.incomplete).toBe(0);
  });

  it('merges this radio whether it starts or ends a route', () => {
    const m = buildRouteUsageMap(
      [
        { hashes: ['aa'], from: { kind: 'contact', key: CONTACT.key }, to: { kind: 'self' }, count: 1 }, // rx flood
        { hashes: ['aa'], from: { kind: 'self' }, to: { kind: 'hash', hash: 'dd' }, count: 2 }, // tx direct
      ],
      ALL,
      SELF,
    );
    expect(counts(m)).toEqual({ 'Alpha-Delta': 3, 'Alpha-Me (you)': 3 });
    expect(m.stops.filter((s) => s.node === SELF)).toHaveLength(1);
    expect(m.stops.find((s) => s.node === SELF)!.count).toBe(3);
  });

  it('never draws an unknown endpoint or counts it as incomplete, even with estimate', () => {
    for (const estimate of [false, true]) {
      const m = buildRouteUsageMap(
        [
          { hashes: ['aa'], from: { kind: 'unknown', label: 'Origin' }, to: { kind: 'self' }, count: 2 },
          { hashes: ['bb'], from: { kind: 'unknown', label: 'Origin' }, to: { kind: 'unknown', label: 'Destination' }, count: 1 },
        ],
        ALL,
        SELF,
        { estimate },
      );
      expect(m.stops.map((s) => s.label).sort()).toEqual(['Alpha', 'Bravo', 'Me (you)']);
      expect(counts(m)).toEqual({ 'Alpha-Me (you)': 2 });
      expect(m.incomplete).toBe(0);
      expect(m.total).toBe(3);
    }
  });

  it('places a hash endpoint without candidates only when estimating', () => {
    const route = [{ hashes: ['aa'], from: { kind: 'self' as const }, to: { kind: 'hash' as const, hash: '77' }, count: 1 }];
    const off = buildRouteUsageMap(route, ALL, SELF);
    expect(off.stops.find((s) => s.label === '77')).toBeUndefined();
    expect(off.incomplete).toBe(1);
    expect(counts(off)).toEqual({ 'Alpha-Me (you)': 1 });
    const on = buildRouteUsageMap(route, ALL, SELF, { estimate: true });
    expect(on.stops.find((s) => s.label === '77')).toMatchObject({ approximate: true, role: 'to' });
    expect(on.incomplete).toBe(0);
    expect(on.edges.find((e) => [e.a.label, e.b.label].includes('77'))).toMatchObject({ count: 1, approximate: true });
  });
});
