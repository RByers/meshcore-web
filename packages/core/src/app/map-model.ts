/**
 * Node map state: markers for contacts that advertised a location, this radio's own location
 * (SELF_INFO lat/lon; never browser GPS), type / max-age filters, the selected marker and
 * distance / bearing from the own position. Pure derived state over ContactsModel views and the
 * connection's selfInfo; the only persisted values are the tile URL template and the filters
 * (preferences). With `estimates` (issue #7, `position-estimator.ts`) contacts without a location
 * get an `approximate` marker near the repeater they were last heard through.
 */

import type { SelfInfo } from '../protocol/types.js';
import type { ContactView } from './contacts-model.js';
import type { PreferencesStore } from './connection.js';
import type { ContactKind } from './messaging.js';
import type { PositionEstimate } from './position-estimator.js';
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
  /** An estimated position (issue #7): drawn dashed with "?". */
  approximate?: boolean;
  /** For an approximate marker: the repeater it was last heard through and when. */
  estimate?: PositionEstimate;
}

export interface MapModelOptions {
  preferences?: PreferencesStore;
  /** Clock for the max-age filter (default Date.now). */
  now?: () => number;
  /** Approximate positions of contacts without a location (empty / absent = none shown). */
  estimates?: ReadonlySignal<readonly PositionEstimate[]>;
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
  /** Every contact with a location, plus approximate markers (unfiltered). */
  readonly allMarkers: ReadonlySignal<readonly MapMarker[]>;
  /** Markers passing the kind and age filters. */
  readonly markers: ReadonlySignal<readonly MapMarker[]>;
  /** Contacts without a location and without an approximate marker (not on the map). */
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
    const estimates = opts.estimates;
    this.allMarkers = computed(() => {
      const me = this.self.value;
      const out: MapMarker[] = [];
      const est = new Map((estimates?.value ?? []).map((e) => [e.key, e]));
      for (const v of views.value) {
        const { lat: rl, lon: rlon } = v.record;
        const has = hasLocation({ lat: rl, lon: rlon });
        const e = has ? undefined : est.get(v.key);
        if (!has && !e) continue;
        const lat = e ? e.lat : rl;
        const lon = e ? e.lon : rlon;
        const p = { lat, lon };
        const bearing = me ? bearingDegrees(me, p) : undefined;
        out.push({
          key: v.key,
          name: v.name,
          kind: v.typeName,
          lat,
          lon,
          lastSeen: e ? Math.max(v.lastSeen, e.observedAt) : v.lastSeen,
          distanceM: me ? haversineMeters(me, p) : undefined,
          bearing,
          compass: bearing === undefined ? undefined : compassPoint(bearing),
          view: v,
          ...(e ? { approximate: true, estimate: e } : {}),
        });
      }
      return out;
    });
    // approximate markers are on the map, so they do not count as "not shown"
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

  /**
   * Selects a contact's marker so the map can centre on it (issue #13: "Show on map"). Turns its
   * kind back on and clears the age filter if they would hide it. Returns the marker, or null
   * when the contact has no location (nor an approximate one).
   */
  focus(key: string): MapMarker | null {
    const k = key.toLowerCase();
    const marker = this.allMarkers.peek().find((m) => m.key === k);
    if (!marker) return null;
    if (!this.#kinds.peek().has(marker.kind)) this.setKindVisible(marker.kind, true);
    if (!this.markers.peek().some((m) => m.key === k)) this.setMaxAge('any');
    this.#selected.value = k;
    return marker;
  }

  /**
   * Whether a contact has a marker (a location, or an approximate one while that setting is on),
   * i.e. "Show on map" can focus it. Reads the markers signal, so it re-renders callers.
   */
  hasMarker(key: string): boolean {
    const k = key.toLowerCase();
    return this.allMarkers.value.some((m) => m.key === k);
  }

  /** Sets the tile URL template; empty restores OpenStreetMap. Throws on an invalid template. */
  setTileUrl(template: string): void {
    const t = template.trim() ? validateTileUrl(template) : OSM_TILE_URL;
    this.#tileUrl.value = t;
    this.#prefs?.setItem(PREF_MAP_TILE_URL, t === OSM_TILE_URL ? '' : t);
  }
}
