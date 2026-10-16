import { describe, expect, it } from 'vitest';
import {
  MAX_LATITUDE,
  bearingDegrees,
  boundsCenter,
  boundsOf,
  compassPoint,
  fitBoundsZoom,
  formatDistance,
  hasLocation,
  haversineMeters,
  latLonToTile,
  latLonToWorld,
  tileToLatLon,
  tileUrl,
  worldToLatLon,
  wrapLongitude,
} from './geo.js';

const london = { lat: 51.5074, lon: -0.1278 };
const paris = { lat: 48.8566, lon: 2.3522 };

describe('Web Mercator', () => {
  it('maps the origin and the corners of the world', () => {
    expect(latLonToWorld(0, 0, 0)).toEqual({ x: 128, y: 128 });
    const nw = latLonToWorld(MAX_LATITUDE, -180, 1);
    expect(nw.x).toBe(0);
    expect(nw.y).toBeCloseTo(0, 6);
    const se = latLonToWorld(-MAX_LATITUDE, 180, 1);
    expect(se.x).toBe(512);
    expect(se.y).toBeCloseTo(512, 6);
    // latitudes beyond the Mercator range are clamped
    expect(latLonToWorld(89.9, 0, 0).y).toBeCloseTo(0, 6);
  });

  it('round-trips lat/lon through world pixels at fractional zoom', () => {
    for (const z of [0, 3.5, 12, 18]) {
      const p = latLonToWorld(47.6062, -122.3321, z);
      const back = worldToLatLon(p.x, p.y, z);
      expect(back.lat).toBeCloseTo(47.6062, 9);
      expect(back.lon).toBeCloseTo(-122.3321, 9);
    }
  });

  it('numbers tiles like OpenStreetMap (Seattle z10 = 164/357)', () => {
    expect(latLonToTile(47.6062, -122.3321, 10)).toEqual({ x: 164, y: 357 });
    expect(latLonToTile(0, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(latLonToTile(-MAX_LATITUDE, 180, 2)).toEqual({ x: 3, y: 3 });
    const nw = tileToLatLon(164, 357, 10);
    expect(nw.lon).toBeCloseTo(-122.34375, 9);
    expect(nw.lat).toBeCloseTo(47.754098, 5);
    expect(tileUrl('https://tile.openstreetmap.org/{z}/{x}/{y}.png', 10, 164, 357)).toBe('https://tile.openstreetmap.org/10/164/357.png');
    expect(tileUrl('data:image/gif;base64,R0lGOD', 1, 0, 0)).toBe('data:image/gif;base64,R0lGOD');
  });

  it('wraps longitudes', () => {
    expect(wrapLongitude(190)).toBe(-170);
    expect(wrapLongitude(-190)).toBe(170);
    expect(wrapLongitude(180)).toBe(180);
    expect(wrapLongitude(45)).toBe(45);
  });
});

describe('great-circle helpers', () => {
  it('haversine distance', () => {
    expect(haversineMeters(london, paris) / 1000).toBeCloseTo(343.56, 1);
    // one degree of longitude on the equator = 2πR / 360
    expect(haversineMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(111_195.08, 1);
    expect(haversineMeters(paris, paris)).toBe(0);
  });

  it('initial bearing and compass point', () => {
    expect(bearingDegrees(london, paris)).toBeCloseTo(148.12, 1);
    expect(bearingDegrees({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 9);
    expect(bearingDegrees({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 9);
    expect(bearingDegrees({ lat: 0, lon: 0 }, { lat: -1, lon: 0 })).toBeCloseTo(180, 9);
    expect(bearingDegrees({ lat: 0, lon: 0 }, { lat: 0, lon: -1 })).toBeCloseTo(270, 9);
    expect(compassPoint(148)).toBe('SE');
    expect(compassPoint(350)).toBe('N');
    expect(compassPoint(-90)).toBe('W');
    expect(compassPoint(315)).toBe('NW');
  });

  it('formats distances', () => {
    expect(formatDistance(849.6)).toBe('850 m');
    expect(formatDistance(1234)).toBe('1.2 km');
    expect(formatDistance(37_400)).toBe('37 km');
  });

  it('treats 0,0 and out-of-range values as no location', () => {
    expect(hasLocation({ lat: 0, lon: 0 })).toBe(false);
    expect(hasLocation({ lat: 91, lon: 0 })).toBe(false);
    expect(hasLocation({ lat: Number.NaN, lon: 1 })).toBe(false);
    expect(hasLocation(null)).toBe(false);
    expect(hasLocation({ lat: 0, lon: 0.0001 })).toBe(true);
  });
});

describe('bounds', () => {
  it('bounding box and centre', () => {
    expect(boundsOf([])).toBeNull();
    const b = boundsOf([london, paris])!;
    expect(b).toEqual({ south: 48.8566, west: -0.1278, north: 51.5074, east: 2.3522 });
    const c = boundsCenter(b);
    expect(c.lon).toBeCloseTo((2.3522 - 0.1278) / 2, 9);
    // the projected centre lies north of the arithmetic mean latitude
    expect(c.lat).toBeGreaterThan((48.8566 + 51.5074) / 2);
  });

  it('fit-bounds zoom', () => {
    const world = { south: -MAX_LATITUDE, west: -180, north: MAX_LATITUDE, east: 180 };
    expect(fitBoundsZoom(world, 512, 512, { padding: 0 })).toBe(1);
    expect(fitBoundsZoom(world, 511, 511, { padding: 0 })).toBe(0);
    expect(fitBoundsZoom(world, 1024, 512, { padding: 0, integer: false })).toBeCloseTo(1, 9);
    // a small area: 0.04° of longitude ≈ 0.0284 world px at z0; 736 px wide → z14
    expect(fitBoundsZoom({ south: 47.6, west: -122.36, north: 47.63, east: -122.32 }, 800, 600)).toBe(14);
    // a single point uses maxZoom; clamping
    expect(fitBoundsZoom({ south: 1, west: 1, north: 1, east: 1 }, 800, 600, { maxZoom: 15 })).toBe(15);
    expect(fitBoundsZoom(world, 100, 100, { minZoom: 2 })).toBe(2);
  });
});
