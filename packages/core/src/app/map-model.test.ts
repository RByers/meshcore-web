import { describe, expect, it } from 'vitest';
import { ContactType } from '../protocol/constants.js';
import type { SelfInfo } from '../protocol/types.js';
import type { ContactRecord } from '../store/schema.js';
import { memoryPreferences } from './connection.js';
import type { ContactView } from './contacts-model.js';
import { contactTypeName, pathDisplay } from './messaging.js';
import { MapModel, OSM_TILE_URL, PREF_MAP_KINDS, PREF_MAP_TILE_URL, validateTileUrl } from './map-model.js';
import { signal } from './signal.js';

const NOW = 1_800_000_000_000;

function view(name: string, type: number, lat: number, lon: number, lastSeen = NOW - 60_000): ContactView {
  const key = name.toLowerCase().padEnd(64, '0');
  const record = { key, name, type, lat, lon, lastSeen } as unknown as ContactRecord;
  return {
    key,
    record,
    name,
    typeName: contactTypeName(type),
    lastSeen,
    lastMessage: undefined,
    lastActivity: 0,
    unread: 0,
    path: pathDisplay(0xff),
    directSnr: undefined,
    directSnrAt: 0,
    lastSnr: undefined,
    favourite: false,
    onDevice: true,
  };
}

const self = (lat: number, lon: number): SelfInfo => ({ lat, lon, name: 'Me' }) as unknown as SelfInfo;

function setup(prefs = memoryPreferences()) {
  const views = signal<readonly ContactView[]>([
    view('Alice', ContactType.CHAT, 47.61, -122.33),
    view('Hilltop', ContactType.REPEATER, 47.62, -122.35, NOW - 3 * 86_400_000),
    view('Room', ContactType.ROOM, 0, 0),
    view('Sensor', ContactType.SENSOR, 47.5, -122.2, 0),
  ]);
  const si = signal<SelfInfo | null>(self(47.6062, -122.3321));
  const m = new MapModel(views.readonly, si.readonly, { preferences: prefs, now: () => NOW });
  return { views, si, m, prefs };
}

describe('MapModel', () => {
  it('builds markers for contacts with a location, with distance and bearing from self', () => {
    const { m } = setup();
    expect(m.allMarkers.value.map((x) => x.name)).toEqual(['Alice', 'Hilltop', 'Sensor']);
    expect(m.withoutLocation.value).toBe(1);
    expect(m.counts.value).toEqual({ chat: 1, repeater: 1, room: 0, sensor: 1 });
    const alice = m.allMarkers.value[0]!;
    expect(alice.kind).toBe('chat');
    expect(alice.distanceM).toBeGreaterThan(400);
    expect(alice.distanceM).toBeLessThan(500);
    expect(alice.compass).toBe('N');
    expect(alice.bearing).toBeCloseTo(20.3, 0);
    expect(m.allMarkers.value[1]!.compass).toBe('NW');
    expect(m.self.value).toEqual({ lat: 47.6062, lon: -122.3321, name: 'Me' });
  });

  it('has no own location (and no distances) when selfInfo is 0,0 or missing', () => {
    const { m, si } = setup();
    si.value = self(0, 0);
    expect(m.self.value).toBeNull();
    expect(m.allMarkers.value[0]!.distanceM).toBeUndefined();
    si.value = null;
    expect(m.self.value).toBeNull();
    expect(m.bounds.value).toEqual({ south: 47.5, west: -122.35, north: 47.62, east: -122.2 });
  });

  it('filters by type and persists the choice', () => {
    const { m, prefs } = setup();
    m.toggleKind('repeater');
    expect(m.isKindVisible('repeater')).toBe(false);
    expect(m.markers.value.map((x) => x.name)).toEqual(['Alice', 'Sensor']);
    expect(prefs.getItem(PREF_MAP_KINDS)).toBe('chat,room,sensor');
    const again = new MapModel(signal<readonly ContactView[]>([]).readonly, signal<SelfInfo | null>(null).readonly, { preferences: prefs });
    expect(again.isKindVisible('repeater')).toBe(false);
    expect(again.isKindVisible('chat')).toBe(true);
    m.setKindVisible('repeater', true);
    expect(m.markers.value).toHaveLength(3);
  });

  it('filters by max age (never-seen contacts are hidden by any age limit)', () => {
    const { m } = setup();
    m.setMaxAge('24h');
    expect(m.markers.value.map((x) => x.name)).toEqual(['Alice']);
    m.setMaxAge('7d');
    expect(m.markers.value.map((x) => x.name)).toEqual(['Alice', 'Hilltop']);
    m.setMaxAge('any');
    expect(m.markers.value).toHaveLength(3);
  });

  it('selection follows visibility', () => {
    const { m } = setup();
    m.select('HILLTOP'.padEnd(64, '0'));
    expect(m.selected.value?.name).toBe('Hilltop');
    m.toggleKind('repeater');
    expect(m.selected.value).toBeNull();
    m.toggleKind('repeater');
    expect(m.selected.value?.name).toBe('Hilltop');
    m.select(null);
    expect(m.selected.value).toBeNull();
  });

  it('bounds include self and the visible markers', () => {
    const { m } = setup();
    m.toggleKind('sensor');
    expect(m.bounds.value).toEqual({ south: 47.6062, west: -122.35, north: 47.62, east: -122.33 });
  });

  it('tile URL template: default OSM, validated, persisted', () => {
    const { m, prefs } = setup();
    expect(m.tileUrl.value).toBe(OSM_TILE_URL);
    expect(() => m.setTileUrl('ftp://x/{z}/{x}/{y}')).toThrow(/https/);
    expect(() => m.setTileUrl('https://x/{z}/{x}.png')).toThrow(/\{y\}/);
    m.setTileUrl('https://tiles.example/{z}/{x}/{y}.png');
    expect(prefs.getItem(PREF_MAP_TILE_URL)).toBe('https://tiles.example/{z}/{x}/{y}.png');
    expect(setup(prefs).m.tileUrl.value).toBe('https://tiles.example/{z}/{x}/{y}.png');
    m.setTileUrl('');
    expect(m.tileUrl.value).toBe(OSM_TILE_URL);
    expect(validateTileUrl(' data:image/png;base64,AA ')).toBe('data:image/png;base64,AA');
  });

  it('focus selects a contact, re-enabling filters that hide it (issue #13)', () => {
    const { m } = setup();
    const hill = m.allMarkers.value[1]!;
    m.toggleKind('repeater');
    m.setMaxAge('24h'); // Hilltop was heard 3 days ago
    expect(m.focus(hill.key.toUpperCase())?.name).toBe('Hilltop');
    expect(m.isKindVisible('repeater')).toBe(true);
    expect(m.maxAge.value).toBe('any');
    expect(m.selected.value?.key).toBe(hill.key);
    // Alice passes the filters: they are left alone
    m.setMaxAge('24h');
    expect(m.focus(m.allMarkers.value[0]!.key)?.name).toBe('Alice');
    expect(m.maxAge.value).toBe('24h');
    // no location → nothing to focus
    expect(m.focus('room'.padEnd(64, '0'))).toBeNull();
    expect(m.selected.value?.name).toBe('Alice');
  });
});
