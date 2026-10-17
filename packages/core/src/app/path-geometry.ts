/**
 * Path visualisation maths (issue #2): turns a route — an origin, the hop hashes a packet
 * carried, and a destination — into an ordered list of stops with names and map positions.
 *
 * Path entries are the first `hash_size` bytes of each repeater's public key
 * (docs/mesh-packet-format.md §1.3), so a hop resolves to every known node whose key starts with
 * that hex (several → ambiguous). Hops without a known location get a position interpolated
 * between the neighbouring located stops (or extrapolated along the line before the first /
 * after the last located stop), flagged so the UI can draw them as approximate.
 *
 * Pure functions, no store access. Interpolation is linear in Web Mercator space so the
 * interpolated points sit on the straight segments the map draws.
 */

import { ContactType } from '../protocol/constants.js';
import { fromHex } from '../util/bytes.js';
import type { ContactKind } from './messaging.js';
import { resolveHop, type PathContact } from './path-resolver.js';
import { boundsOf, haversineMeters, hasLocation, latLonToWorld, worldToLatLon, type Bounds, type LatLon } from './geo.js';

/** A node that can appear on a path (a contact, or this radio). */
export interface PathGeoNode {
  /** Public key hex (lower case). */
  key: string;
  name: string;
  kind: ContactKind | 'self';
  /** Present only when the node advertised a usable location. */
  lat?: number;
  lon?: number;
}

/** One end of a path. */
export type PathEndpoint =
  | { kind: 'self' }
  /** A known contact by public key. */
  | { kind: 'contact'; key: string }
  /** A node hash / key prefix hex (e.g. a payload's src hash). */
  | { kind: 'hash'; hash: string }
  /** A display name (channel senders are only known by name). */
  | { kind: 'name'; name: string }
  /** A named position (e.g. the location inside an advert). */
  | { kind: 'point'; name: string; lat: number; lon: number; key?: string }
  | { kind: 'unknown'; label: string };

/** A route to show: `from` → each of `hashes` → `to`. */
export interface PathSpec {
  title: string;
  /** Hop hashes as hex, in travel order (empty for a direct / zero-hop route). */
  hashes: readonly string[];
  from: PathEndpoint;
  to: PathEndpoint;
  /** Hop count when the hashes are not known (e.g. a message whose packet was not logged). */
  hopCount?: number;
  /** Shown above the list (why hashes are missing, how the path was found, …). */
  note?: string;
}

export type PathStopRole = 'from' | 'hop' | 'to';

/**
 * How a stop's map position was found: `known` (its node's advertised location), `ambiguous`
 * (one of several matching nodes, picked as the closest to the line), `interpolated` /
 * `extrapolated` (estimated from neighbouring stops), or `none` (not drawn).
 */
export type PathPositionKind = 'known' | 'ambiguous' | 'interpolated' | 'extrapolated' | 'none';

export interface PathStop {
  role: PathStopRole;
  /** Hop hash hex (hops; and hash endpoints). */
  hash?: string;
  /** Display label: the node name, a list of candidates, or the hex hash. */
  label: string;
  /** The node, when exactly one known node matches. */
  node?: PathGeoNode;
  /** Every known node matching the hash (hops prefer repeaters; see {@link matchPathHash}). */
  candidates: readonly PathGeoNode[];
  /** Map position (absent when `position` is 'none'). */
  lat?: number;
  lon?: number;
  position: PathPositionKind;
}

export interface PathGeometry {
  stops: PathStop[];
  /** Stops with a position (known, ambiguous or estimated). */
  placed: number;
  /** Stops whose position is a node's advertised location. */
  known: number;
  /** Bounds of the placed stops (null when none). */
  bounds: Bounds | null;
  /** Sum of the great-circle legs between consecutive placed stops (m), 0 for fewer than two. */
  distanceM: number;
}

/** Whether a position is an estimate (drawn with the "approximate" decoration). */
export function isApproximate(kind: PathPositionKind): boolean {
  return kind === 'ambiguous' || kind === 'interpolated' || kind === 'extrapolated';
}

const KIND_RANK: Record<PathGeoNode['kind'], number> = { repeater: 0, room: 1, chat: 2, sensor: 3, self: 4 };

const KIND_TYPE: Record<PathGeoNode['kind'], number> = {
  chat: ContactType.CHAT,
  repeater: ContactType.REPEATER,
  room: ContactType.ROOM,
  sensor: ContactType.SENSOR,
  self: ContactType.NONE,
};

const HEX_BYTES = /^(?:[0-9a-f]{2})+$/i;

/** A {@link PathGeoNode} in the shape path-resolver.ts matches on. */
interface ResolvableNode extends PathContact {
  node: PathGeoNode;
}

/** Per node list (lists are recomputed, not mutated, when contacts change). */
const resolvable = new WeakMap<readonly PathGeoNode[], ResolvableNode[]>();

function resolvableNodes(nodes: readonly PathGeoNode[]): ResolvableNode[] {
  let out = resolvable.get(nodes);
  if (!out) {
    out = nodes.flatMap((n) => (HEX_BYTES.test(n.key) ? [{ pubKey: fromHex(n.key), name: n.name, type: KIND_TYPE[n.kind], node: n }] : []));
    resolvable.set(nodes, out);
  }
  return out;
}

/**
 * Known nodes whose public key starts with `hash` (hex, case-insensitive), matched by
 * path-resolver.ts's {@link resolveHop} (the resolver behind "Show path as node names"). With
 * `preferRepeaters` (path hops: only repeaters and room servers forward floods), their matches
 * win when there are any. Results are ordered repeaters first, then by name.
 */
export function matchPathHash(hash: string, nodes: readonly PathGeoNode[], opts: { preferRepeaters?: boolean } = {}): PathGeoNode[] {
  if (!HEX_BYTES.test(hash)) return [];
  const hop = resolveHop(fromHex(hash), resolvableNodes(nodes), { preferForwarders: opts.preferRepeaters === true });
  return hop.candidates.map((c) => c.node).sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name));
}

function located(n: PathGeoNode | undefined): n is PathGeoNode & LatLon {
  return !!n && hasLocation({ lat: n.lat ?? NaN, lon: n.lon ?? NaN });
}

function stopFor(role: PathStopRole, hash: string, nodes: readonly PathGeoNode[], preferRepeaters: boolean): PathStop {
  const candidates = matchPathHash(hash, nodes, { preferRepeaters });
  const stop: PathStop = { role, hash: hash.toLowerCase(), label: hash.toLowerCase(), candidates, position: 'none' };
  if (candidates.length === 1) {
    stop.node = candidates[0]!;
    stop.label = stop.node.name;
  } else if (candidates.length > 1) {
    stop.label = candidates.map((c) => c.name).join(' / ');
  }
  return stop;
}

/** Resolves an endpoint against the known nodes (`self` is this radio, null when unknown). */
export function resolvePathEndpoint(ep: PathEndpoint, role: 'from' | 'to', nodes: readonly PathGeoNode[], self: PathGeoNode | null): PathStop {
  switch (ep.kind) {
    case 'self':
      return self
        ? { role, label: `${self.name} (you)`, node: self, candidates: [self], position: 'none' }
        : { role, label: 'This radio', candidates: [], position: 'none' };
    case 'contact': {
      const key = ep.key.toLowerCase();
      const n = nodes.find((x) => x.key.toLowerCase() === key);
      return n ? { role, label: n.name, node: n, candidates: [n], position: 'none' } : { role, hash: key.slice(0, 2), label: key.slice(0, 12), candidates: [], position: 'none' };
    }
    case 'hash':
      return stopFor(role, ep.hash, nodes, false);
    case 'name': {
      const matches = nodes.filter((n) => n.kind !== 'self' && n.name === ep.name);
      const stop: PathStop = { role, label: ep.name, candidates: matches, position: 'none' };
      if (matches.length === 1) stop.node = matches[0]!;
      return stop;
    }
    case 'point': {
      const n: PathGeoNode = { key: ep.key?.toLowerCase() ?? '', name: ep.name, kind: nodes.find((x) => ep.key && x.key === ep.key.toLowerCase())?.kind ?? 'chat', lat: ep.lat, lon: ep.lon };
      return { role, label: ep.name, node: n, candidates: [n], position: 'none' };
    }
    case 'unknown':
      return { role, label: ep.label, candidates: [], position: 'none' };
  }
}

/** Interpolated / extrapolated point estimate for each index (Mercator-linear). */
export interface EstimatedPoint extends LatLon {
  kind: 'known' | 'interpolated' | 'extrapolated';
}

/**
 * Fills the gaps in a sequence of optional positions:
 * - between two located entries: linear interpolation by index;
 * - before the first / after the last located entry: extrapolation along the line through the
 *   two nearest located entries, one step per index;
 * - with a single located entry, the others stay undefined (no direction to extend along);
 * - with none, everything stays undefined.
 */
export function interpolatePositions(points: readonly (LatLon | undefined)[]): (EstimatedPoint | undefined)[] {
  const out: (EstimatedPoint | undefined)[] = points.map((p) => (p ? { lat: p.lat, lon: p.lon, kind: 'known' } : undefined));
  const idx: number[] = [];
  points.forEach((p, i) => {
    if (p) idx.push(i);
  });
  if (idx.length === 0) return out;
  const w = points.map((p) => (p ? latLonToWorld(p.lat, p.lon, 0) : undefined));
  const at = (i: number, j: number, k: number, kind: EstimatedPoint['kind']): EstimatedPoint => {
    const a = w[i]!;
    const b = w[j]!;
    const t = (k - i) / (j - i);
    const ll = worldToLatLon(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 0);
    return { lat: ll.lat, lon: ll.lon, kind };
  };
  for (let n = 0; n + 1 < idx.length; n++) {
    const i = idx[n]!;
    const j = idx[n + 1]!;
    for (let k = i + 1; k < j; k++) out[k] = at(i, j, k, 'interpolated');
  }
  if (idx.length >= 2) {
    const first = idx[0]!;
    const second = idx[1]!;
    for (let k = 0; k < first; k++) out[k] = at(first, second, k, 'extrapolated');
    const last = idx[idx.length - 1]!;
    const prev = idx[idx.length - 2]!;
    for (let k = last + 1; k < points.length; k++) out[k] = at(prev, last, k, 'extrapolated');
  }
  return out;
}

/**
 * Builds the stops of a path (origin, hops, destination) with labels and map positions.
 * Ambiguous hops whose candidates have locations take the candidate closest to the position
 * estimated from the unambiguous stops.
 */
export function buildPathGeometry(spec: PathSpec, nodes: readonly PathGeoNode[], self: PathGeoNode | null): PathGeometry {
  const stops: PathStop[] = [
    resolvePathEndpoint(spec.from, 'from', nodes, self),
    ...spec.hashes.map((h) => stopFor('hop', h, nodes, true)),
    resolvePathEndpoint(spec.to, 'to', nodes, self),
  ];
  // pass 1: stops resolved to a single located node
  const firm: (LatLon | undefined)[] = stops.map((s) => (located(s.node) ? { lat: s.node.lat, lon: s.node.lon } : undefined));
  const guess = interpolatePositions(firm);
  // pass 2: ambiguous stops pick the located candidate nearest the estimate
  const anchors: (LatLon | undefined)[] = [...firm];
  const ambiguous = new Set<number>();
  stops.forEach((s, i) => {
    if (s.node || s.candidates.length < 2) return;
    const options = s.candidates.filter(located);
    if (options.length === 0) return;
    const g = guess[i];
    const best = g ? options.reduce((a, b) => (haversineMeters(g, b) < haversineMeters(g, a) ? b : a)) : options[0]!;
    anchors[i] = { lat: best.lat, lon: best.lon };
    ambiguous.add(i);
  });
  const est = interpolatePositions(anchors);
  let placed = 0;
  let known = 0;
  stops.forEach((s, i) => {
    const e = est[i];
    if (!e) return;
    s.lat = e.lat;
    s.lon = e.lon;
    s.position = ambiguous.has(i) ? 'ambiguous' : e.kind;
    placed++;
    if (s.position === 'known') known++;
  });
  const pts = stops.filter((s): s is PathStop & LatLon => s.lat !== undefined && s.lon !== undefined);
  let distanceM = 0;
  for (let i = 1; i < pts.length; i++) distanceM += haversineMeters(pts[i - 1]!, pts[i]!);
  return { stops, placed, known, bounds: boundsOf(pts), distanceM };
}
