/**
 * Web Mercator / slippy-map math (EPSG:3857, 256 px tiles, OSM tile numbering) and great-circle
 * helpers. Pure functions; "world pixels" are pixels at a given (possibly fractional) zoom, with
 * (0, 0) at the north-west corner of the world (lon -180, lat +MAX_LAT).
 */

export const TILE_SIZE = 256;
/** Latitude where Web Mercator is square: atan(sinh(π)). */
export const MAX_LATITUDE = 85.0511287798066;
/** Mean Earth radius (m), as used by the haversine formula. */
export const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

const RAD = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function clampLatitude(lat: number): number {
  return clamp(lat, -MAX_LATITUDE, MAX_LATITUDE);
}

/** Wraps a longitude into [-180, 180). */
export function wrapLongitude(lon: number): number {
  const w = ((((lon + 180) % 360) + 360) % 360) - 180;
  return w === -180 && lon > 0 ? 180 : w;
}

/** World size in pixels at `zoom`. */
export function worldSize(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

/** Lat/lon → world pixels at `zoom` (latitude clamped to the Mercator range). */
export function latLonToWorld(lat: number, lon: number, zoom: number): Point {
  const size = worldSize(zoom);
  const sin = Math.sin(clampLatitude(lat) * RAD);
  return {
    x: ((lon + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

/** World pixels at `zoom` → lat/lon (no longitude wrapping). */
export function worldToLatLon(x: number, y: number, zoom: number): LatLon {
  const size = worldSize(zoom);
  const n = Math.PI - (2 * Math.PI * y) / size;
  return { lat: Math.atan(Math.sinh(n)) / RAD, lon: (x / size) * 360 - 180 };
}

/** The tile (integer x / y at integer zoom `z`) containing a point. */
export function latLonToTile(lat: number, lon: number, z: number): Point {
  const p = latLonToWorld(lat, lon, z);
  const n = 2 ** z;
  return { x: clamp(Math.floor(p.x / TILE_SIZE), 0, n - 1), y: clamp(Math.floor(p.y / TILE_SIZE), 0, n - 1) };
}

/** North-west corner of tile (x, y) at zoom z. */
export function tileToLatLon(x: number, y: number, z: number): LatLon {
  return worldToLatLon(x * TILE_SIZE, y * TILE_SIZE, z);
}

/** Fills a `{z}/{x}/{y}` tile URL template (`{s}` → "a"). */
export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace('{s}', 'a');
}

/** Great-circle distance in metres (haversine). */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from `a` to `b`, degrees clockwise from north in [0, 360). */
export function bearingDegrees(a: LatLon, b: LatLon): number {
  const φ1 = a.lat * RAD;
  const φ2 = b.lat * RAD;
  const Δλ = (b.lon - a.lon) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const deg = Math.atan2(y, x) / RAD;
  return (deg + 360) % 360;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type CompassPoint = (typeof COMPASS)[number];

/** 8-point compass name of a bearing. */
export function compassPoint(bearing: number): CompassPoint {
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;
}

/** "850 m", "1.2 km", "37 km". */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/**
 * Whether a lat/lon is a usable position. The firmware reports 0, 0 for "not set"
 * (companion-protocol.md §7.1 / §6.2), so the exact origin counts as no location.
 */
export function hasLocation(p: { lat: number; lon: number } | null | undefined): p is LatLon {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return false;
  if (p.lat === 0 && p.lon === 0) return false;
  return Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

/** Bounding box of points (null for none). */
export function boundsOf(points: readonly LatLon[]): Bounds | null {
  if (points.length === 0) return null;
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const p of points) {
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
  }
  return { south, west, north, east };
}

/** Centre of a bounding box in projected (Mercator) space. */
export function boundsCenter(b: Bounds): LatLon {
  const sw = latLonToWorld(b.south, b.west, 0);
  const ne = latLonToWorld(b.north, b.east, 0);
  return worldToLatLon((sw.x + ne.x) / 2, (sw.y + ne.y) / 2, 0);
}

export interface FitBoundsOptions {
  /** Padding on every side (px). Default 32. */
  padding?: number;
  minZoom?: number;
  /** Default 18 (also used for a single point). */
  maxZoom?: number;
  /** Round down to an integer zoom (default true). */
  integer?: boolean;
}

/** The largest zoom at which `b` fits into width × height (minus padding). */
export function fitBoundsZoom(b: Bounds, width: number, height: number, opts: FitBoundsOptions = {}): number {
  const { padding = 32, minZoom = 0, maxZoom = 18, integer = true } = opts;
  const w = Math.max(1, width - 2 * padding);
  const hgt = Math.max(1, height - 2 * padding);
  const sw = latLonToWorld(b.south, b.west, 0);
  const ne = latLonToWorld(b.north, b.east, 0);
  const dx = Math.abs(ne.x - sw.x);
  const dy = Math.abs(sw.y - ne.y);
  if (dx === 0 && dy === 0) return maxZoom;
  const z = Math.log2(Math.min(dx > 0 ? w / dx : Infinity, dy > 0 ? hgt / dy : Infinity));
  return clamp(integer ? Math.floor(z + 1e-9) : z, minZoom, maxZoom);
}
