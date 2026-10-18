/**
 * Weighted path maps: the "paths heard via" map (contact Stats tab) merges every path a contact's
 * packets arrived over, and the "packet paths" map (packet Stats tab) every route of the selected
 * packets ({@link buildRouteUsageMap}), into one set of hop segments, each weighted by how many
 * packets crossed it, so the UI can draw line thickness proportional to use.
 *
 * Each path is placed with {@link buildPathGeometry} (e.g. contact → hops → this radio), so hop
 * resolution, ambiguous picks and interpolated positions match the single-path dialog. Stops are
 * merged by node (public key) when resolved, otherwise by hash + position, so the same unknown
 * repeater estimated at two different spots stays two stops. Estimated positions are only placed
 * with `estimate: true` (the "approximate positions" setting); a segment that skips over a stop
 * left off the map joins its neighbours and is flagged approximate. Pure function, no store access.
 */

import { boundsOf, type Bounds, type LatLon } from './geo.js';
import { buildPathGeometry, isApproximate, type PathEndpoint, type PathGeoNode, type PathGeometryOptions, type PathStop } from './path-geometry.js';

/** One observed path: hop hashes in travel order (empty = direct) and how many packets used it. */
export interface PathUsageInput {
  hashes: readonly string[];
  count: number;
}

export interface PathUsageStop extends LatLon {
  id: string;
  role: PathStop['role'];
  label: string;
  /** The resolved node, when exactly one matches. */
  node?: PathGeoNode;
  /** Position is an estimate (ambiguous / interpolated / extrapolated). */
  approximate: boolean;
  /** Packets whose path passed through (or started / ended at) this stop. */
  count: number;
}

export interface PathUsageEdge {
  /** `${a.id}|${b.id}` with the ids sorted, so both directions merge. */
  id: string;
  a: PathUsageStop;
  b: PathUsageStop;
  /** Packets that crossed this segment. */
  count: number;
  /**
   * Every path over it had an approximate end here, or skipped a stop that could not be placed
   * (one path crossing it between two known stops makes it firm).
   */
  approximate: boolean;
}

export interface PathUsageMap {
  stops: PathUsageStop[];
  /** Busiest first. */
  edges: PathUsageEdge[];
  /** Largest edge count (0 when there are no edges). */
  maxCount: number;
  /** Packets across all inputs. */
  total: number;
  /** Packets whose path had a stop that could not be placed (drawn partially or not at all). */
  incomplete: number;
  bounds: Bounds | null;
}

const posKey = (s: LatLon): string => `${s.lat.toFixed(5)},${s.lon.toFixed(5)}`;

function stopId(s: PathStop & LatLon): string {
  if (s.node) return s.node.key;
  return `${s.hash ?? s.role}@${posKey(s)}`;
}

/** One route to merge: `from` → each of `hashes` (travel order) → `to`, taken by `count` packets. */
export interface PathUsageRoute {
  hashes: readonly string[];
  from: PathEndpoint;
  to: PathEndpoint;
  count: number;
}

/** Aggregates the paths packets from `contactKey` took to this radio into weighted segments. */
export function buildPathUsageMap(
  paths: readonly PathUsageInput[],
  contactKey: string,
  nodes: readonly PathGeoNode[],
  self: PathGeoNode | null,
  opts: PathGeometryOptions = {},
): PathUsageMap {
  const from: PathEndpoint = { kind: 'contact', key: contactKey };
  const to: PathEndpoint = { kind: 'self' };
  return buildRouteUsageMap(
    paths.map((p) => ({ hashes: p.hashes, from, to, count: p.count })),
    nodes,
    self,
    opts,
  );
}

/**
 * Aggregates routes with arbitrary ends into weighted segments. Stop ids are global, so a node
 * (this radio included) merges across routes whichever end or hop it appears as. An endpoint of
 * kind `unknown` (the origin of a direct packet we only relay, an unknown destination…) is never
 * drawn and never makes a route incomplete, even when `estimate` could extrapolate it.
 */
export function buildRouteUsageMap(
  routes: readonly PathUsageRoute[],
  nodes: readonly PathGeoNode[],
  self: PathGeoNode | null,
  opts: PathGeometryOptions = {},
): PathUsageMap {
  const stops = new Map<string, PathUsageStop>();
  const edges = new Map<string, PathUsageEdge>();
  let total = 0;
  let incomplete = 0;
  for (const p of routes) {
    if (p.count <= 0) continue;
    total += p.count;
    const g = buildPathGeometry({ title: '', hashes: p.hashes, from: p.from, to: p.to }, nodes, self, opts);
    const first = p.from.kind === 'unknown' ? 1 : 0;
    const end = g.stops.length - (p.to.kind === 'unknown' ? 1 : 0);
    const drawn = g.stops.slice(first, Math.max(first, end));
    if (drawn.some((s) => s.lat === undefined || s.lon === undefined)) incomplete += p.count;
    let prev: PathUsageStop | undefined;
    let skipped = false;
    for (const s of drawn) {
      if (s.lat === undefined || s.lon === undefined) {
        skipped = true;
        continue;
      }
      const placed = s as PathStop & LatLon;
      const id = stopId(placed);
      let u = stops.get(id);
      if (!u) {
        u = { id, role: s.role, label: s.label, lat: placed.lat, lon: placed.lon, approximate: isApproximate(s.position), count: 0, ...(s.node ? { node: s.node } : {}) };
        stops.set(id, u);
      }
      u.count += p.count;
      if (prev && prev.id !== u.id) {
        const [a, b] = prev.id < u.id ? [prev, u] : [u, prev];
        const eid = `${a.id}|${b.id}`;
        const approximate = skipped || a.approximate || b.approximate;
        let e = edges.get(eid);
        if (!e) {
          e = { id: eid, a, b, count: 0, approximate };
          edges.set(eid, e);
        }
        e.count += p.count;
        e.approximate &&= approximate;
      }
      prev = u;
      skipped = false;
    }
  }
  const edgeList = [...edges.values()].sort((x, y) => y.count - x.count || x.id.localeCompare(y.id));
  const stopList = [...stops.values()];
  return {
    stops: stopList,
    edges: edgeList,
    maxCount: edgeList[0]?.count ?? 0,
    total,
    incomplete,
    bounds: boundsOf(stopList),
  };
}
