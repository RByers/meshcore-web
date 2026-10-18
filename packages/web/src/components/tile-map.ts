/**
 * `<mc-tile-map>`: a compact slippy map (Web Mercator raster tiles, no dependency).
 *
 *   <mc-tile-map .tileUrl=${'https://tile.openstreetmap.org/{z}/{x}/{y}.png'} lat=47.6 lon=-122.3 zoom=12>
 *     <mc-map-marker lat=47.61 lon=-122.33 label="Alice" kind="chat" @click=${…}></mc-map-marker>
 *   </mc-tile-map>
 *
 * - Children with `lat` / `lon` attributes are positioned over the map (any element works;
 *   `<mc-map-marker>` below is a labelled, focusable pin; `approximate` draws it dashed with "?").
 * - `.lines` draws polylines (SVG, under the markers): `[{ points: [{lat, lon}, …], dashed?, color?, width?, arrow?, offset? }]`;
 *   `arrow` adds a direction arrowhead per segment.
 * - Drag / touch pan, wheel / pinch zoom (fractional zoom; tiles from the nearest integer level,
 *   scaled), zoom buttons, arrow / +/- keys. Emits `mc-view-change` ({lat, lon, zoom}) after user
 *   interaction. `fitBounds()`, `setView()`, `project()` for callers.
 * - Tiles come only from `tileUrl` ({z}/{x}/{y} template; a data: URL in tests), so nothing is
 *   fetched unless the caller supplies a network template. Attribution is always shown.
 *
 * Math lives in `@meshcore-web/core/app` (geo.ts).
 */
import { LitElement, css, html, nothing, svg, unsafeCSS, type PropertyValues } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import {
  OSM_ATTRIBUTION,
  OSM_ATTRIBUTION_URL,
  OSM_TILE_URL,
  TILE_SIZE,
  boundsCenter,
  clamp,
  clampLatitude,
  fitBoundsZoom,
  latLonToWorld,
  tileUrl,
  worldToLatLon,
  wrapLongitude,
  type Bounds,
  type FitBoundsOptions,
  type LatLon,
  type Point,
} from '@meshcore-web/core/app';
import { shared } from '../styles.js';

export interface TileMapView {
  lat: number;
  lon: number;
  zoom: number;
}

export const VIEW_CHANGE_EVENT = 'mc-view-change';

/** A polyline drawn under the markers. */
export interface MapLine {
  points: readonly LatLon[];
  /** Dashed stroke (e.g. a leg to or from an approximate position). */
  dashed?: boolean;
  /** Stroke colour (default the accent colour). */
  color?: string;
  /** Stroke width in px (default 4, 3 when dashed). */
  width?: number;
  /** Exposed as `data-line` on the SVG path (tests, styling). */
  id?: string;
  /**
   * Draw an arrowhead at the middle of each segment pointing in point order (travel direction).
   * A reverse line over the same hop should set `offset` so the two sit side by side. Segments
   * too short on screen get none.
   */
  arrow?: boolean;
  /**
   * Shift the line sideways by this many px, to the right of its point order (e.g. so A→B and
   * B→A over one hop sit side by side). Default 0.
   */
  offset?: number;
}

/** Where along a segment (0…1) an arrowhead's centre sits: the middle, see {@link MapLine.arrow}. */
export const ARROW_POSITION = 0.5;

/** Arrowhead size for a stroke of width `w` px: length along the line and half its base width. */
export function arrowSize(w: number): { length: number; halfWidth: number } {
  return { length: Math.max(10, 1.6 * w + 4), halfWidth: w / 2 + Math.max(4, 0.55 * w) };
}

/**
 * Screen polyline `pts` shifted `offset` px to the right of its direction (y down): each vertex
 * moves along the mean of its adjacent segments' normals.
 */
function offsetPolyline(pts: readonly Point[], offset: number): Point[] {
  if (!offset || pts.length < 2) return [...pts];
  const normals = pts.slice(1).map((b, i) => {
    const a = pts[i]!;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    return l ? { x: -(b.y - a.y) / l, y: (b.x - a.x) / l } : { x: 0, y: 0 };
  });
  return pts.map((p, i) => {
    const n1 = normals[i - 1];
    const n2 = normals[i];
    let nx = (n1?.x ?? 0) + (n2?.x ?? 0);
    let ny = (n1?.y ?? 0) + (n2?.y ?? 0);
    const l = Math.hypot(nx, ny);
    if (!l) return p;
    nx /= l;
    ny /= l;
    return { x: p.x + nx * offset, y: p.y + ny * offset };
  });
}

/** Arrowhead triangle (SVG `points`) on segment a→b, or null when the segment is too short for one. */
function arrowHead(a: Point, b: Point, width: number): string | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const { length, halfWidth } = arrowSize(width);
  if (len < length * 2.5) return null;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const cx = a.x + ux * len * ARROW_POSITION;
  const cy = a.y + uy * len * ARROW_POSITION;
  const tip = { x: cx + (ux * length) / 2, y: cy + (uy * length) / 2 };
  const bx = cx - (ux * length) / 2;
  const by = cy - (uy * length) / 2;
  const f = (x: number, y: number): string => `${x.toFixed(1)},${y.toFixed(1)}`;
  return [f(tip.x, tip.y), f(bx - uy * halfWidth, by + ux * halfWidth), f(bx + uy * halfWidth, by - ux * halfWidth)].join(' ');
}

interface Tile {
  key: string;
  src: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Marker colours by kind (MeshCore Open convention: chat blue, repeater green, room purple, sensor orange). */
export const KIND_COLORS: Readonly<Record<'chat' | 'repeater' | 'room' | 'sensor' | 'self', string>> = {
  chat: '#1e6fd9',
  repeater: '#1f9d55',
  room: '#8a4fd8',
  sensor: '#e07b12',
  self: '#d6336c',
};

const kindRules = unsafeCSS(
  Object.entries(KIND_COLORS)
    .map(([k, c]) => `:host([kind='${k}']) { --marker-color: ${c}; }`)
    .join('\n'),
);

const DRAG_THRESHOLD_PX = 4;
const KEY_PAN_PX = 80;

export class McTileMap extends LitElement {
  static override properties = {
    lat: { type: Number },
    lon: { type: Number },
    zoom: { type: Number },
    tileUrl: { attribute: 'tile-url' },
    attribution: {},
    attributionUrl: { attribute: 'attribution-url' },
    minZoom: { type: Number, attribute: 'min-zoom' },
    maxZoom: { type: Number, attribute: 'max-zoom' },
    labelZoom: { type: Number, attribute: 'label-zoom' },
    label: {},
    lines: { attribute: false },
  };

  static override styles = [
    shared,
    css`
      :host {
        display: block;
        position: relative;
        overflow: hidden;
        min-height: 200px;
        background: light-dark(#dfe5ea, #20262d);
        border-radius: var(--mc-radius);
        contain: strict;
      }
      .viewport {
        position: absolute;
        inset: 0;
        touch-action: none;
        cursor: grab;
        user-select: none;
        -webkit-user-select: none;
      }
      .viewport[data-dragging] {
        cursor: grabbing;
      }
      .viewport:focus-visible {
        outline-offset: -3px;
      }
      .tiles img {
        position: absolute;
        max-width: none;
        pointer-events: none;
        user-select: none;
      }
      .tiles img[data-failed] {
        visibility: hidden;
      }
      .markers {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }
      svg.lines {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        overflow: visible;
      }
      svg.lines path {
        fill: none;
        stroke-width: 4;
        stroke-linecap: round;
        stroke-linejoin: round;
        filter: drop-shadow(0 0 1.5px rgb(255 255 255 / 0.9));
      }
      svg.lines path[data-dashed] {
        stroke-dasharray: 8 7;
        stroke-width: 3;
      }
      svg.lines polygon {
        stroke: none;
        filter: drop-shadow(0 0 1.5px rgb(255 255 255 / 0.9));
      }
      ::slotted(*) {
        position: absolute;
        left: 0;
        top: 0;
        pointer-events: auto;
      }
      .controls {
        position: absolute;
        inset-block-start: 10px;
        inset-inline-end: 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .controls button {
        width: 2.5rem;
        height: 2.5rem;
        padding: 0;
        font-size: 1.25rem;
        line-height: 1;
        box-shadow: 0 1px 4px rgb(0 0 0 / 0.2);
      }
      .attribution {
        position: absolute;
        inset-block-end: 0;
        inset-inline-end: 0;
        padding: 1px 6px;
        font-size: 0.7rem;
        background: color-mix(in srgb, var(--mc-surface) 80%, transparent);
        color: var(--mc-text);
        border-start-start-radius: 6px;
      }
    `,
  ];

  declare lat: number;
  declare lon: number;
  declare zoom: number;
  declare tileUrl: string;
  declare attribution: string;
  declare attributionUrl: string;
  declare minZoom: number;
  declare maxZoom: number;
  /** Markers get `data-show-label` at or above this zoom. */
  declare labelZoom: number;
  /** Accessible name of the map. */
  declare label: string;
  declare lines: readonly MapLine[];

  #w = 0;
  #h = 0;
  #ro: ResizeObserver | undefined;
  #mo: MutationObserver | undefined;
  #pendingFit: { bounds: Bounds; opts: FitBoundsOptions } | undefined;
  readonly #pointers = new Map<number, Point>();
  #dragDistance = 0;
  #dragging = false;
  #suppressClick = false;
  #pinch: { dist: number; zoom: number; anchor: { lat: number; lon: number } } | undefined;

  constructor() {
    super();
    this.lat = 0;
    this.lon = 0;
    this.zoom = 2;
    this.tileUrl = OSM_TILE_URL;
    this.attribution = OSM_ATTRIBUTION;
    this.attributionUrl = OSM_ATTRIBUTION_URL;
    this.minZoom = 1;
    this.maxZoom = 19;
    this.labelZoom = 13;
    this.label = 'Map';
    this.lines = [];
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#ro = new ResizeObserver(() => this.#measure());
    this.#ro.observe(this);
    this.#mo = new MutationObserver(() => this.#positionMarkers());
    this.#mo.observe(this, { childList: true, subtree: true, attributes: true, attributeFilter: ['lat', 'lon'] });
    // a drag that ends over a marker must not also click it
    this.addEventListener('click', this.#onClickCapture, { capture: true });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#ro?.disconnect();
    this.#mo?.disconnect();
    this.removeEventListener('click', this.#onClickCapture, { capture: true });
  }

  /** Viewport size in CSS px (0 before the first layout). */
  get size(): { width: number; height: number } {
    return { width: this.#w, height: this.#h };
  }

  get view(): TileMapView {
    return { lat: this.lat, lon: this.lon, zoom: this.zoom };
  }

  /** Container pixel position of a lat/lon at the current view. */
  project(lat: number, lon: number): Point {
    const c = latLonToWorld(this.lat, this.lon, this.zoom);
    const p = latLonToWorld(lat, lon, this.zoom);
    return { x: p.x - c.x + this.#w / 2, y: p.y - c.y + this.#h / 2 };
  }

  /** Lat/lon under a container pixel. */
  unproject(x: number, y: number): { lat: number; lon: number } {
    const c = latLonToWorld(this.lat, this.lon, this.zoom);
    return worldToLatLon(c.x + x - this.#w / 2, c.y + y - this.#h / 2, this.zoom);
  }

  setView(lat: number, lon: number, zoom: number = this.zoom): void {
    this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
    this.lat = clampLatitude(lat);
    this.lon = wrapLongitude(lon);
  }

  /** Centres and zooms to fit `bounds` (deferred until the element has a size). */
  fitBounds(bounds: Bounds, opts: FitBoundsOptions = {}): void {
    if (!this.#w || !this.#h) {
      this.#pendingFit = { bounds, opts };
      return;
    }
    this.#pendingFit = undefined;
    const z = fitBoundsZoom(bounds, this.#w, this.#h, { minZoom: this.minZoom, maxZoom: Math.min(this.maxZoom, 16), ...opts });
    const c = boundsCenter(bounds);
    this.setView(c.lat, c.lon, z);
  }

  zoomIn(): void {
    this.#zoomAround(this.#w / 2, this.#h / 2, Math.round(this.zoom) + 1);
    this.#emit();
  }

  zoomOut(): void {
    this.#zoomAround(this.#w / 2, this.#h / 2, Math.round(this.zoom) - 1);
    this.#emit();
  }

  /** Pans by a pixel offset (positive dx moves the map content right). */
  panBy(dx: number, dy: number): void {
    const c = latLonToWorld(this.lat, this.lon, this.zoom);
    const ll = worldToLatLon(c.x - dx, c.y - dy, this.zoom);
    this.setView(ll.lat, ll.lon);
  }

  #zoomAround(x: number, y: number, zoom: number, anchor = this.unproject(x, y)): void {
    const z = clamp(zoom, this.minZoom, this.maxZoom);
    const a = latLonToWorld(anchor.lat, anchor.lon, z);
    const ll = worldToLatLon(a.x - (x - this.#w / 2), a.y - (y - this.#h / 2), z);
    this.setView(ll.lat, ll.lon, z);
  }

  #emit(): void {
    this.dispatchEvent(new CustomEvent<TileMapView>(VIEW_CHANGE_EVENT, { detail: this.view, bubbles: true, composed: true }));
  }

  #measure(): void {
    const r = this.getBoundingClientRect();
    if (r.width === this.#w && r.height === this.#h) return;
    this.#w = r.width;
    this.#h = r.height;
    if (this.#pendingFit && this.#w && this.#h) this.fitBounds(this.#pendingFit.bounds, this.#pendingFit.opts);
    this.requestUpdate();
  }

  #tiles(): Tile[] {
    const w = this.#w;
    const h = this.#h;
    if (!w || !h || !this.tileUrl) return [];
    const tz = clamp(Math.round(this.zoom), 0, Math.ceil(this.maxZoom));
    const scale = 2 ** (this.zoom - tz);
    const c = latLonToWorld(this.lat, this.lon, tz);
    const x0 = c.x - w / 2 / scale;
    const y0 = c.y - h / 2 / scale;
    const n = 2 ** tz;
    const out: Tile[] = [];
    const px = (v: number): number => Math.round(v * scale);
    for (let ty = Math.max(0, Math.floor(y0 / TILE_SIZE)); ty <= Math.min(n - 1, Math.floor((y0 + h / scale) / TILE_SIZE)); ty++) {
      for (let tx = Math.floor(x0 / TILE_SIZE); tx <= Math.floor((x0 + w / scale) / TILE_SIZE); tx++) {
        const wx = ((tx % n) + n) % n;
        const left = px(tx * TILE_SIZE - x0);
        const top = px(ty * TILE_SIZE - y0);
        out.push({
          key: `${tz}/${tx}/${ty}`,
          src: tileUrl(this.tileUrl, tz, wx, ty),
          left,
          top,
          width: px((tx + 1) * TILE_SIZE - x0) - left,
          height: px((ty + 1) * TILE_SIZE - y0) - top,
        });
      }
    }
    return out;
  }

  override render() {
    const tiles = this.#tiles();
    return html`
      <div
        class="viewport"
        tabindex="0"
        role="application"
        aria-roledescription="map"
        aria-label=${this.label}
        aria-describedby="keys"
        ?data-dragging=${this.#dragging}
        @pointerdown=${this.#onPointerDown}
        @pointermove=${this.#onPointerMove}
        @pointerup=${this.#onPointerUp}
        @pointercancel=${this.#onPointerUp}
        @wheel=${this.#onWheel}
        @keydown=${this.#onKey}
      >
        <div class="tiles" aria-hidden="true">
          ${repeat(
            tiles,
            (t) => t.key,
            (t) => html`<img
              alt=""
              draggable="false"
              decoding="async"
              src=${t.src}
              style=${`left:${t.left}px;top:${t.top}px;width:${t.width}px;height:${t.height}px`}
              @error=${(e: Event) => (e.target as HTMLElement).setAttribute('data-failed', '')}
            />`,
          )}
        </div>
        ${this.#lines()}
        <div class="markers"><slot @slotchange=${() => this.#positionMarkers()}></slot></div>
      </div>
      <span id="keys" class="visually-hidden">Arrow keys pan, plus and minus zoom.</span>
      <div class="controls">
        <button type="button" data-zoom="in" aria-label="Zoom in" ?disabled=${this.zoom >= this.maxZoom} @click=${() => this.zoomIn()}>+</button>
        <button type="button" data-zoom="out" aria-label="Zoom out" ?disabled=${this.zoom <= this.minZoom} @click=${() => this.zoomOut()}>−</button>
      </div>
      ${this.attribution
        ? html`<div class="attribution">
            ${this.attributionUrl
              ? html`<a href=${this.attributionUrl} target="_blank" rel="noopener noreferrer">${this.attribution}</a>`
              : this.attribution}
          </div>`
        : nothing}
    `;
  }

  #lines() {
    if (!this.lines.length || !this.#w || !this.#h) return nothing;
    const d = (pts: readonly Point[]): string => pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' ');
    const drawn = this.lines.map((l) => {
      const pts = offsetPolyline(
        l.points.map((p) => this.project(p.lat, p.lon)),
        l.offset ?? 0,
      );
      const width = l.width ?? (l.dashed ? 3 : 4);
      const heads = l.arrow ? pts.slice(1).flatMap((b, i) => arrowHead(pts[i]!, b, width) ?? []) : [];
      return { l, color: l.color ?? 'var(--mc-accent)', pts, heads };
    });
    // arrowheads after every line, so another line never covers one
    return svg`<svg class="lines" aria-hidden="true">${drawn.map(
      ({ l, color, pts }) =>
        svg`<path d=${d(pts)} stroke=${color} style=${l.width ? `stroke-width:${l.width}px` : nothing} ?data-dashed=${!!l.dashed} data-line=${l.id ?? nothing}></path>`,
    )}${drawn.flatMap(({ l, color, heads }) => heads.map((h) => svg`<polygon points=${h} fill=${color} data-arrow=${l.id ?? ''}></polygon>`))}</svg>`;
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    this.#positionMarkers();
  }

  #positionMarkers(): void {
    const slot = this.renderRoot.querySelector('slot');
    if (!slot) return;
    const showLabels = this.zoom >= this.labelZoom;
    for (const el of slot.assignedElements()) {
      const lat = Number(el.getAttribute('lat'));
      const lon = Number(el.getAttribute('lon'));
      if (!(el instanceof HTMLElement) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const p = this.project(lat, lon);
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      el.toggleAttribute('data-show-label', showLabels);
    }
  }

  // ---- interaction ----

  #local(e: PointerEvent | WheelEvent): Point {
    const r = this.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #pinchInfo(): { dist: number; mid: Point } | undefined {
    const [a, b] = [...this.#pointers.values()];
    if (!a || !b) return undefined;
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  readonly #onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.#pointers.set(e.pointerId, this.#local(e));
    if (this.#pointers.size === 1) {
      this.#dragDistance = 0;
      this.#suppressClick = false;
    }
    if (this.#pointers.size === 2) {
      const info = this.#pinchInfo()!;
      this.#pinch = { dist: info.dist, zoom: this.zoom, anchor: this.unproject(info.mid.x, info.mid.y) };
      this.#capture(e);
    }
  };

  #capture(e: PointerEvent): void {
    const vp = e.currentTarget as HTMLElement;
    for (const id of this.#pointers.keys()) {
      try {
        vp.setPointerCapture(id);
      } catch {
        /* pointer already gone */
      }
    }
  }

  readonly #onPointerMove = (e: PointerEvent): void => {
    const prev = this.#pointers.get(e.pointerId);
    if (!prev) return;
    const cur = this.#local(e);
    this.#pointers.set(e.pointerId, cur);
    if (this.#pinch && this.#pointers.size >= 2) {
      const info = this.#pinchInfo()!;
      this.#zoomAround(info.mid.x, info.mid.y, this.#pinch.zoom + Math.log2(info.dist / this.#pinch.dist), this.#pinch.anchor);
      this.#suppressClick = true;
      return;
    }
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    this.#dragDistance += Math.hypot(dx, dy);
    if (!this.#dragging && this.#dragDistance < DRAG_THRESHOLD_PX) return;
    if (!this.#dragging) {
      // capture only once it is a drag, so a tap still clicks the marker under it
      this.#dragging = true;
      this.#suppressClick = true;
      this.#capture(e);
    }
    this.panBy(dx, dy);
  };

  readonly #onPointerUp = (e: PointerEvent): void => {
    if (!this.#pointers.delete(e.pointerId)) return;
    if (this.#pointers.size < 2) this.#pinch = undefined;
    if (this.#pointers.size === 0) {
      const moved = this.#dragging || this.#suppressClick;
      this.#dragging = false;
      if (moved) {
        this.requestUpdate();
        this.#emit();
      }
    }
  };

  readonly #onClickCapture = (e: Event): void => {
    if (this.#suppressClick) {
      this.#suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  };

  readonly #onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 0.05 : e.ctrlKey ? 0.01 : 0.0025;
    const p = this.#local(e);
    this.#zoomAround(p.x, p.y, this.zoom - clamp(e.deltaY, -200, 200) * unit);
    this.#emit();
  };

  readonly #onKey = (e: KeyboardEvent): void => {
    const pan: Record<string, Point> = {
      ArrowLeft: { x: KEY_PAN_PX, y: 0 },
      ArrowRight: { x: -KEY_PAN_PX, y: 0 },
      ArrowUp: { x: 0, y: KEY_PAN_PX },
      ArrowDown: { x: 0, y: -KEY_PAN_PX },
    };
    const d = pan[e.key];
    if (d) this.panBy(d.x, d.y);
    else if (e.key === '+' || e.key === '=') this.#zoomAround(this.#w / 2, this.#h / 2, Math.round(this.zoom) + 1);
    else if (e.key === '-' || e.key === '_') this.#zoomAround(this.#w / 2, this.#h / 2, Math.round(this.zoom) - 1);
    else return;
    e.preventDefault();
    this.#emit();
  };
}

/**
 * A labelled, focusable map pin. Colour from `kind` or the `--marker-color` custom property; size
 * from `--marker-size` (default 1.5rem).
 */
export class McMapMarker extends LitElement {
  static override properties = {
    lat: { type: Number, reflect: true },
    lon: { type: Number, reflect: true },
    label: {},
    kind: { reflect: true },
    selected: { type: Boolean, reflect: true },
    approximate: { type: Boolean, reflect: true },
    glyph: {},
    description: {},
  };

  static override styles = [
    shared,
    css`
      :host {
        --marker-color: var(--mc-accent);
        z-index: 1;
      }
    `,
    kindRules,
    css`
      :host([kind='self']) {
        z-index: 2;
      }
      :host([selected]) {
        z-index: 3;
      }
      .wrap {
        position: absolute;
        transform: translate(-50%, -50%);
        display: flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }
      button {
        min-height: 0;
        width: var(--marker-size, 1.5rem);
        height: var(--marker-size, 1.5rem);
        padding: 0;
        border-radius: 50%;
        border: 3px solid #fff;
        background: var(--marker-color);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 1px 4px rgb(0 0 0 / 0.45);
      }
      button:hover:not(:disabled) {
        background: var(--marker-color);
        filter: brightness(1.1);
      }
      :host([selected]) button {
        outline: 3px solid var(--marker-color);
        outline-offset: 2px;
      }
      button .glyph {
        color: #fff;
        font-size: 0.7rem;
        font-weight: 700;
        line-height: 1;
      }
      /* an estimated position: dashed outline, translucent fill and a "?" */
      :host([approximate]) button {
        border-style: dashed;
        border-color: var(--marker-color);
        background: color-mix(in srgb, var(--marker-color) 25%, #fff);
      }
      :host([approximate]) button .glyph {
        color: var(--marker-color);
        font-size: 0.8rem;
      }
      .label {
        display: none;
        position: absolute;
        inset-inline-start: calc(var(--marker-size, 1.5rem) + 0.25rem);
        padding: 1px 6px;
        border-radius: 6px;
        font-size: 0.75rem;
        font-weight: 600;
        background: color-mix(in srgb, var(--mc-surface) 90%, transparent);
        color: var(--mc-text);
        box-shadow: 0 1px 3px rgb(0 0 0 / 0.25);
        pointer-events: none;
      }
      :host([data-show-label]) .label,
      :host([selected]) .label,
      :host(:hover) .label,
      :host(:focus-within) .label {
        display: block;
      }
    `,
  ];

  declare lat: number;
  declare lon: number;
  declare label: string;
  declare kind: string;
  declare selected: boolean;
  /** Position is an estimate: drawn dashed with a "?" (path views). */
  declare approximate: boolean;
  /** Short text inside the pin (e.g. a hop number); replaced by "?" when approximate. */
  declare glyph: string;
  /** Extra accessible description (e.g. "Repeater, 1.2 km NW"). */
  declare description: string;

  constructor() {
    super();
    this.lat = 0;
    this.lon = 0;
    this.label = '';
    this.kind = '';
    this.selected = false;
    this.approximate = false;
    this.glyph = '';
    this.description = '';
  }

  override render() {
    const name = this.description ? `${this.label}, ${this.description}` : this.label;
    return html`<div class="wrap">
      <button type="button" aria-label=${name} aria-pressed=${this.selected ? 'true' : 'false'}>
        ${this.glyph || this.approximate ? html`<span class="glyph" aria-hidden="true">${this.approximate ? '?' : this.glyph}</span>` : nothing}
      </button>
      <span class="label" aria-hidden="true">${this.label}</span>
    </div>`;
  }
}

customElements.define('mc-tile-map', McTileMap);
customElements.define('mc-map-marker', McMapMarker);

declare global {
  interface HTMLElementTagNameMap {
    'mc-tile-map': McTileMap;
    'mc-map-marker': McMapMarker;
  }
}
