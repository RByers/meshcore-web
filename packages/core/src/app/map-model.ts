/**
 * Node map state: markers for contacts that advertised a location, this radio's own location
 * (SELF_INFO lat/lon; never browser GPS), type / max-age filters, the selected marker and
 * distance / bearing from the own position. Pure derived state over ContactsModel views and the
 * connection's selfInfo; the only persisted value is the tile URL template (preferences).
 */

import type { SelfInfo } from '../protocol/types.js';
import type { ContactView } from './contacts-model.js';
import type { PreferencesStore } from './connection.js';
import type { ContactKind } from './messaging.js';
import { computed, signal, type ReadonlySignal, type Signal } from './signal.js';
import { bearingDegrees, boundsOf, compassPoint, haversineMeters, hasLocation, type Bounds, type CompassPoint, type LatLon } from './geo.js';

export const MAP_KINDS: readonly ContactKind[] = ['chat', 'repeater', 'room', 'sensor'];

export type MapMaxAge = 'any' | '1h' | '24h' | '7d' | '30d';
export const MAP_MAX_AGES: readonly MapMaxAge[] = ['any', '1h', '24h', '7d', '30d'];
export const MAP_MAX_AGE_MS: Record<MapMaxAge, number> = {
  any: Infinity,
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

/** OpenStreetMap standard tiles (https://operations.osmfoundation.org/policies/tiles/). */
export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const OSM_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';

export const PREF_MAP_TILE_URL = 'meshcore-web.map.tileUrl';
export const PREF_MAP_KINDS = 'meshcore-web.map.kinds';
export const PREF_MAP_MAX_AGE = 'meshcore-web.map.maxAge';

export interface MapMarker extends LatLon {
  key: string;
  name: string;
  kind: ContactKind;
  /** Epoch ms (0 = never). */
  lastSeen: number;
  /** From the own location; undefined when this radio has no location. */
  distanceM: number | undefined;
  bearing: number | undefined;
  compass: CompassPoint | undefined;
  view: ContactView;
}

export interface MapModelOptions {
  preferences?: PreferencesStore;
  /** Clock for the max-age filter (default Date.now). */
  now?: () => number;
}

/** Validates a tile URL template: http(s) with {z}/{x}/{y}, or a data: URL (tests, offline). */
export function validateTileUrl(template: string): string {
  const t = template.trim();
  if (t.startsWith('data:')) return t;
  if (!/^https?:\/\//.test(t)) throw new Error('Tile URL must start with https://');
  for (const p of ['{z}', '{x}', '{y}']) if (!t.includes(p)) throw new Error(`Tile URL must contain ${p}`);
  return t;
}

export class MapModel {
  readonly #kinds: Signal<ReadonlySet<ContactKind>>;
  readonly #maxAge: Signal<MapMaxAge>;
  readonly #selected = signal<string | null>(null);
  readonly #now = signal(0);
  readonly #tileUrl: Signal<string>;
  readonly #prefs: PreferencesStore | undefined;
  readonly #clock: () => number;

  /** Visible contact kinds. */
  readonly kinds: ReadonlySignal<ReadonlySet<ContactKind>>;
  readonly maxAge: ReadonlySignal<MapMaxAge>;
  readonly selectedKey: ReadonlySignal<string | null> = this.#selected.readonly;
  /** Tile URL template ({z}/{x}/{y}). */
  readonly tileUrl: ReadonlySignal<string>;

  /** This radio's advertised location, or null when unset / disconnected. */
  readonly self: ReadonlySignal<(LatLon & { name: string }) | null>;
  /** Every contact with a location (unfiltered). */
  readonly allMarkers: ReadonlySignal<readonly MapMarker[]>;
  /** Markers passing the kind and age filters. */
  readonly markers: ReadonlySignal<readonly MapMarker[]>;
  /** Contacts without a location (not on the map). */
  readonly withoutLocation: ReadonlySignal<number>;
  /** Marker counts per kind (before filtering). */
  readonly counts: ReadonlySignal<Readonly<Record<ContactKind, number>>>;
  /** The selected marker if it is still visible. */
  readonly selected: ReadonlySignal<MapMarker | null>;
  /** Bounds of the visible markers plus the own location. */
  readonly bounds: ReadonlySignal<Bounds | null>;

  constructor(
    views: ReadonlySignal<readonly ContactView[]>,
    selfInfo: ReadonlySignal<SelfInfo | null>,
    opts: MapModelOptions = {},
  ) {
    this.#prefs = opts.preferences;
    this.#clock = opts.now ?? Date.now;
    this.#now.value = this.#clock();
    const storedKinds = this.#readKinds();
    this.#kinds = signal<ReadonlySet<ContactKind>>(storedKinds);
    const age = this.#prefs?.getItem(PREF_MAP_MAX_AGE);
    this.#maxAge = signal<MapMaxAge>(age && (MAP_MAX_AGES as readonly string[]).includes(age) ? (age as MapMaxAge) : 'any');
    let tile = OSM_TILE_URL;
    try {
      const t = this.#prefs?.getItem(PREF_MAP_TILE_URL);
      if (t) tile = validateTileUrl(t);
    } catch {
      /* ignore a bad stored value */
    }
    this.#tileUrl = signal(tile);
    this.kinds = this.#kinds.readonly;
    this.maxAge = this.#maxAge.readonly;
    this.tileUrl = this.#tileUrl.readonly;

    this.self = computed(() => {
      const si = selfInfo.value;
      return si && hasLocation(si) ? { lat: si.lat, lon: si.lon, name: si.name } : null;
    });
    this.allMarkers = computed(() => {
      const me = this.self.value;
      const out: MapMarker[] = [];
      for (const v of views.value) {
        const { lat, lon } = v.record;
        if (!hasLocation({ lat, lon })) continue;
        const p = { lat, lon };
        const bearing = me ? bearingDegrees(me, p) : undefined;
        out.push({
          key: v.key,
          name: v.name,
          kind: v.typeName,
          lat,
          lon,
          lastSeen: v.lastSeen,
          distanceM: me ? haversineMeters(me, p) : undefined,
          bearing,
          compass: bearing === undefined ? undefined : compassPoint(bearing),
          view: v,
        });
      }
      return out;
    });
    this.withoutLocation = computed(() => views.value.length - this.allMarkers.value.length);
    this.counts = computed(() => {
      const c: Record<ContactKind, number> = { chat: 0, repeater: 0, room: 0, sensor: 0 };
      for (const m of this.allMarkers.value) c[m.kind]++;
      return c;
    });
    this.markers = computed(() => {
      const kinds = this.#kinds.value;
      const maxMs = MAP_MAX_AGE_MS[this.#maxAge.value];
      const now = this.#now.value;
      return this.allMarkers.value.filter((m) => kinds.has(m.kind) && (maxMs === Infinity || (m.lastSeen > 0 && now - m.lastSeen <= maxMs)));
    });
    this.selected = computed(() => {
      const k = this.#selected.value;
      return k ? (this.markers.value.find((m) => m.key === k) ?? null) : null;
    });
    this.bounds = computed(() => {
      const pts: LatLon[] = [...this.markers.value];
      const me = this.self.value;
      if (me) pts.push(me);
      return boundsOf(pts);
    });
  }

  #readKinds(): Set<ContactKind> {
    const raw = this.#prefs?.getItem(PREF_MAP_KINDS);
    if (raw === null || raw === undefined) return new Set(MAP_KINDS);
    return new Set(raw.split(',').filter((k): k is ContactKind => (MAP_KINDS as readonly string[]).includes(k)));
  }

  isKindVisible(kind: ContactKind): boolean {
    return this.#kinds.value.has(kind);
  }

  setKindVisible(kind: ContactKind, visible: boolean): void {
    const next = new Set(this.#kinds.peek());
    if (visible) next.add(kind);
    else next.delete(kind);
    this.#kinds.value = next;
    this.#prefs?.setItem(PREF_MAP_KINDS, [...next].join(','));
  }

  toggleKind(kind: ContactKind): void {
    this.setKindVisible(kind, !this.#kinds.peek().has(kind));
  }

  setMaxAge(age: MapMaxAge): void {
    this.#now.value = this.#clock();
    this.#maxAge.value = age;
    this.#prefs?.setItem(PREF_MAP_MAX_AGE, age);
  }

  /** Re-evaluates the age filter against the current time. */
  refreshNow(): void {
    this.#now.value = this.#clock();
  }

  select(key: string | null): void {
    this.#selected.value = key ? key.toLowerCase() : null;
  }

  /** Sets the tile URL template; empty restores OpenStreetMap. Throws on an invalid template. */
  setTileUrl(template: string): void {
    const t = template.trim() ? validateTileUrl(template) : OSM_TILE_URL;
    this.#tileUrl.value = t;
    this.#prefs?.setItem(PREF_MAP_TILE_URL, t === OSM_TILE_URL ? '' : t);
  }
}
