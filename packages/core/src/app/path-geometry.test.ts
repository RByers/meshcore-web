import { describe, expect, it } from 'vitest';
import { latLonToWorld } from './geo.js';
import { buildPathGeometry, interpolatePositions, isApproximate, matchPathHash, resolvePathEndpoint, type PathGeoNode } from './path-geometry.js';

const node = (key: string, name: string, kind: PathGeoNode['kind'], lat?: number, lon?: number): PathGeoNode =>
  lat === undefined || lon === undefined ? { key, name, kind } : { key, name, kind, lat, lon };

const SELF = node('5e1f'.padEnd(64, '0'), 'Me', 'self', 47.6, -122.3);
const NODES: PathGeoNode[] = [
  node('aa01'.padEnd(64, '0'), 'Alpha', 'repeater', 47.7, -122.3),
  node('bb02'.padEnd(64, '0'), 'Bravo', 'repeater'), // no location
  node('cc03'.padEnd(64, '0'), 'Charlie', 'repeater', 47.9, -122.3),
  node('dd04'.padEnd(64, '0'), 'Delta', 'chat', 48.0, -122.3),
  node('ee05'.padEnd(64, '0'), 'Echo One', 'repeater', 47.8, -122.0),
  node('ee06'.padEnd(64, '0'), 'Echo Two', 'repeater', 47.8, -122.6),
  node('ee07'.padEnd(64, '0'), 'Echo Chat', 'chat', 47.8, -122.3),
];

/** Mercator x/y at zoom 0, for checking straight-line placement. */
const w = (p: { lat?: number; lon?: number }) => latLonToWorld(p.lat!, p.lon!, 0);

describe('matchPathHash', () => {
  it('matches public key prefixes case-insensitively, repeaters first', () => {
    expect(matchPathHash('AA', NODES).map((n) => n.name)).toEqual(['Alpha']);
    expect(matchPathHash('ee', NODES).map((n) => n.name)).toEqual(['Echo One', 'Echo Two', 'Echo Chat']);
    expect(matchPathHash('ee05', NODES).map((n) => n.name)).toEqual(['Echo One']);
    expect(matchPathHash('12', NODES)).toEqual([]);
    expect(matchPathHash('', NODES)).toEqual([]);
  });

  it('restricts hops to repeaters when any repeater matches', () => {
    expect(matchPathHash('ee', NODES, { preferRepeaters: true }).map((n) => n.name)).toEqual(['Echo One', 'Echo Two']);
    expect(matchPathHash('dd', NODES, { preferRepeaters: true }).map((n) => n.name)).toEqual(['Delta']);
    // room servers forward too (same rule as path-resolver.ts)
    const room = node('ee08'.padEnd(64, '0'), 'Echo Room', 'room');
    expect(matchPathHash('ee', [NODES[6]!, room], { preferRepeaters: true }).map((n) => n.name)).toEqual(['Echo Room']);
    expect(matchPathHash('e', NODES)).toEqual([]); // not whole bytes
  });
});

describe('resolvePathEndpoint', () => {
  it('resolves self, contacts, hashes, names and points', () => {
    expect(resolvePathEndpoint({ kind: 'self' }, 'to', NODES, SELF)).toMatchObject({ label: 'Me (you)', node: SELF });
    expect(resolvePathEndpoint({ kind: 'self' }, 'to', NODES, null)).toMatchObject({ label: 'This radio', candidates: [] });
    expect(resolvePathEndpoint({ kind: 'contact', key: 'DD04'.padEnd(64, '0') }, 'from', NODES, SELF).label).toBe('Delta');
    expect(resolvePathEndpoint({ kind: 'contact', key: '99'.padEnd(64, '0') }, 'from', NODES, SELF)).toMatchObject({ label: '990000000000', candidates: [] });
    expect(resolvePathEndpoint({ kind: 'hash', hash: 'cc' }, 'from', NODES, SELF).label).toBe('Charlie');
    expect(resolvePathEndpoint({ kind: 'hash', hash: 'ee' }, 'from', NODES, SELF).label).toBe('Echo One / Echo Two / Echo Chat');
    expect(resolvePathEndpoint({ kind: 'name', name: 'Delta' }, 'from', NODES, SELF).node?.key).toBe(NODES[3]!.key);
    expect(resolvePathEndpoint({ kind: 'name', name: 'Nobody' }, 'from', NODES, SELF)).toMatchObject({ label: 'Nobody', candidates: [] });
    expect(resolvePathEndpoint({ kind: 'point', name: 'Advert', lat: 1, lon: 2 }, 'from', NODES, SELF).node).toMatchObject({ lat: 1, lon: 2 });
  });
});

describe('interpolatePositions', () => {
  it('interpolates between located entries linearly in Mercator space', () => {
    const out = interpolatePositions([{ lat: 10, lon: 0 }, undefined, undefined, { lat: 40, lon: 30 }]);
    expect(out.map((p) => p?.kind)).toEqual(['known', 'interpolated', 'interpolated', 'known']);
    const a = latLonToWorld(10, 0, 0);
    const b = latLonToWorld(40, 30, 0);
    const p1 = w(out[1]!);
    expect(p1.x).toBeCloseTo(a.x + (b.x - a.x) / 3, 9);
    expect(p1.y).toBeCloseTo(a.y + (b.y - a.y) / 3, 9);
    expect(out[1]!.lon).toBeCloseTo(10, 9); // longitude is linear in Mercator x
    expect(out[0]).toEqual({ lat: 10, lon: 0, kind: 'known' });
  });

  it('extrapolates before the first and after the last located entry along the line', () => {
    const out = interpolatePositions([undefined, { lat: 0, lon: 10 }, { lat: 0, lon: 20 }, undefined, undefined]);
    expect(out.map((p) => p?.kind)).toEqual(['extrapolated', 'known', 'known', 'extrapolated', 'extrapolated']);
    expect(out[0]!.lon).toBeCloseTo(0, 9);
    expect(out[3]!.lon).toBeCloseTo(30, 9);
    expect(out[4]!.lon).toBeCloseTo(40, 9);
    expect(out[4]!.lat).toBeCloseTo(0, 9);
  });

  it('extends using the two nearest located entries at each end', () => {
    const out = interpolatePositions([undefined, { lat: 0, lon: 0 }, { lat: 0, lon: 1 }, undefined, { lat: 0, lon: 5 }, undefined]);
    expect(out[0]!.lon).toBeCloseTo(-1, 9); // step of the first pair (1° per index)
    expect(out[3]!.lon).toBeCloseTo(3, 9);
    expect(out[5]!.lon).toBeCloseTo(7, 9); // step of the last pair (2° per index)
  });

  it('leaves gaps when fewer than two entries are located', () => {
    expect(interpolatePositions([undefined, undefined])).toEqual([undefined, undefined]);
    expect(interpolatePositions([undefined, { lat: 1, lon: 1 }, undefined])).toEqual([undefined, { lat: 1, lon: 1, kind: 'known' }, undefined]);
    expect(interpolatePositions([])).toEqual([]);
  });
});

describe('buildPathGeometry', () => {
  it('lists the stops in order with names, hashes and positions', () => {
    // Delta (48.0) → cc (Charlie 47.9) → bb (Bravo, no location) → aa (Alpha 47.7) → me (47.6)
    const g = buildPathGeometry({ title: 't', hashes: ['cc', 'bb', 'aa'], from: { kind: 'contact', key: NODES[3]!.key }, to: { kind: 'self' } }, NODES, SELF);
    expect(g.stops.map((s) => [s.role, s.label, s.hash, s.position])).toEqual([
      ['from', 'Delta', undefined, 'known'],
      ['hop', 'Charlie', 'cc', 'known'],
      ['hop', 'Bravo', 'bb', 'interpolated'],
      ['hop', 'Alpha', 'aa', 'known'],
      ['to', 'Me (you)', undefined, 'known'],
    ]);
    const bravo = g.stops[2]!;
    expect(bravo.node?.name).toBe('Bravo');
    expect(bravo.lon).toBeCloseTo(-122.3, 9);
    expect(bravo.lat!).toBeGreaterThan(47.7);
    expect(bravo.lat!).toBeLessThan(47.9);
    expect(isApproximate(bravo.position)).toBe(true);
    expect(g.placed).toBe(5);
    expect(g.known).toBe(4);
    expect(g.bounds!.south).toBeCloseTo(47.6, 9);
    expect(g.bounds!.north).toBeCloseTo(48.0, 9);
    expect(g.bounds!.east).toBeCloseTo(-122.3, 9);
    expect(g.distanceM).toBeGreaterThan(44_000);
    expect(g.distanceM).toBeLessThan(45_000); // 0.4° of latitude ≈ 44.5 km
  });

  it('shows unknown hashes as hex and extrapolates past the last located stop', () => {
    const g = buildPathGeometry({ title: 't', hashes: ['aa', '42'], from: { kind: 'self' }, to: { kind: 'unknown', label: 'Somewhere' } }, NODES, SELF);
    expect(g.stops.map((s) => [s.label, s.position])).toEqual([
      ['Me (you)', 'known'],
      ['Alpha', 'known'],
      ['42', 'extrapolated'],
      ['Somewhere', 'extrapolated'],
    ]);
    expect(g.stops[2]!.candidates).toEqual([]);
    expect(g.stops[2]!.lat).toBeCloseTo(47.8, 1);
    expect(g.stops[3]!.lat).toBeCloseTo(47.9, 1);
  });

  it('picks the ambiguous candidate nearest the line and marks it approximate', () => {
    // Me (47.6, -122.3) → ee (Echo One at -122.0 / Echo Two at -122.6) → West (48.0, -122.9):
    // the estimate halfway is about (47.8, -122.6), right on Echo Two
    const g = buildPathGeometry(
      { title: 't', hashes: ['ee'], from: { kind: 'self' }, to: { kind: 'point', name: 'West', lat: 48.0, lon: -122.9 } },
      NODES,
      SELF,
    );
    const hop = g.stops[1]!;
    expect(hop.node).toBeUndefined();
    expect(hop.candidates.map((c) => c.name)).toEqual(['Echo One', 'Echo Two']);
    expect(hop.label).toBe('Echo One / Echo Two');
    expect(hop.position).toBe('ambiguous');
    expect([hop.lat, hop.lon]).toEqual([47.8, -122.6]); // Echo Two, the western one
  });

  it('places nothing when no stop has a location', () => {
    const g = buildPathGeometry({ title: 't', hashes: ['bb', '42'], from: { kind: 'unknown', label: 'Origin' }, to: { kind: 'self' } }, NODES, null);
    expect(g.placed).toBe(0);
    expect(g.bounds).toBeNull();
    expect(g.stops.every((s) => s.position === 'none' && s.lat === undefined)).toBe(true);
    expect(g.distanceM).toBe(0);
  });

  it('a direct route is just the two endpoints', () => {
    const g = buildPathGeometry({ title: 't', hashes: [], from: { kind: 'self' }, to: { kind: 'contact', key: NODES[0]!.key } }, NODES, SELF);
    expect(g.stops.map((s) => s.label)).toEqual(['Me (you)', 'Alpha']);
    expect(g.known).toBe(2);
  });
});
