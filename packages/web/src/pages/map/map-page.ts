/**
 * Node map: contacts that advertised a location plus this radio's own location, coloured by type,
 * with type / last-heard filters, a details card for the selected node and "Centre on me". With the
 * "approximate positions" setting, nodes without a location are drawn dashed with "?" near the
 * repeater they were last heard through (issue #7).
 * State lives in `app.map` (core MapModel); `<mc-tile-map>` renders tiles and positions markers.
 */
import { css, html, nothing, type PropertyValues } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import {
  MAP_KINDS,
  MAP_MAX_AGES,
  OSM_TILE_URL,
  formatDistance,
  type AppModel,
  type ContactKind,
  type MapMarker,
  type MapMaxAge,
} from '@meshcore-web/core/app';
import { AppElement } from '../../app-context.js';
import '../../components/tile-map.js';
import { KIND_COLORS, type McTileMap, type TileMapView } from '../../components/tile-map.js';
import { hopsLink } from '../../components/path-dialog.js';
import { formatRelative } from '../../format.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { TYPE_LABEL, errorText, listStyles } from '../messaging/common.js';

const KIND_LABEL: Record<ContactKind, string> = { chat: 'Users', repeater: 'Repeaters', room: 'Rooms', sensor: 'Sensors' };
const AGE_LABEL: Record<MapMaxAge, string> = {
  any: 'Any time',
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};
/** Zoom used by "Centre on me" when the map is zoomed further out. */
const CENTRE_ZOOM = 13;
/** Zoom used when focusing one node (`/map/node/:key`, "Show on map"). */
export const FOCUS_ZOOM = 14;

/** The last map view per AppModel, so leaving and returning keeps the view. */
const lastView = new WeakMap<AppModel, TileMapView>();

function describe(m: MapMarker): string {
  const parts: string[] = [TYPE_LABEL[m.kind]];
  if (m.estimate) parts.push(`approximate position near ${m.estimate.viaName}`);
  if (m.distanceM !== undefined) parts.push(`${formatDistance(m.distanceM)} ${m.compass ?? ''}`.trim());
  return parts.join(', ');
}

export class McMapPage extends AppElement {
  static override properties = { params: { attribute: false } };

  static override styles = [
    shared,
    listStyles,
    css`
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 0.3em 0.8em;
        min-height: 2.25rem;
      }
      .chip[aria-pressed='false'] {
        opacity: 0.6;
        text-decoration: line-through;
      }
      .chip[aria-pressed='true'] {
        background: var(--mc-accent-soft);
        border-color: var(--mc-accent);
      }
      .swatch {
        width: 0.75rem;
        height: 0.75rem;
        border-radius: 50%;
        border: 2px solid #fff;
        box-shadow: 0 0 0 1px rgb(0 0 0 / 0.3);
      }
      .chip .n {
        font-size: 0.8rem;
        color: var(--mc-text-muted);
      }
      .stage {
        position: relative;
      }
      .toolbar label.check {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      mc-tile-map {
        height: clamp(320px, calc(100dvh - 260px), 900px);
      }
      .info {
        position: absolute;
        inset-block-end: 28px;
        inset-inline-start: 10px;
        width: min(22rem, calc(100% - 20px));
        box-shadow: 0 6px 24px rgb(0 0 0 / 0.25);
        z-index: 5;
      }
      .info header {
        display: flex;
        align-items: start;
        gap: 8px;
      }
      .info h3 {
        flex: 1;
        margin: 0;
        overflow-wrap: anywhere;
      }
      .info .close {
        min-height: 2rem;
        padding: 0 0.6em;
      }
      .info dl {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 2px 12px;
        margin: 8px 0 12px;
      }
      .info dt {
        color: var(--mc-text-muted);
      }
      .info dd {
        margin: 0;
      }
      a.button {
        display: inline-flex;
        align-items: center;
        min-height: 2.5rem;
        padding: 0.5em 1em;
        border-radius: 8px;
        border: 1px solid var(--mc-accent);
        background: var(--mc-accent);
        color: var(--mc-accent-text);
        text-decoration: none;
      }
      .empty-overlay {
        position: absolute;
        inset-block-start: 10px;
        inset-inline-start: 10px;
        max-width: calc(100% - 80px);
        z-index: 4;
      }
      .foot {
        margin-block-start: 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px 16px;
        align-items: baseline;
      }
      details form {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-block-start: 8px;
      }
      details input {
        flex: 1 1 20rem;
        font-family: var(--mc-mono);
        font-size: 0.85rem;
      }
    `,
  ];

  declare params: Readonly<Record<string, string>> | undefined;
  /** Node to centre on (from `/map/node/:key`) until it has been focused. */
  #focusKey: string | undefined;

  /** Bounds the view was last fitted to; refits follow new data until the user moves the map. */
  #fittedFor = '';
  #userMoved = false;
  #tileError = '';

  get #map(): McTileMap | null {
    return this.renderRoot.querySelector('mc-tile-map');
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.app.map.refreshNow();
    this.addEventListener('keydown', this.#onKey);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('keydown', this.#onKey);
  }

  readonly #onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.app.map.selected.peek()) {
      this.app.map.select(null);
      e.preventDefault();
    }
  };

  /** Centres on this radio's location. */
  centreOnMe(): void {
    const me = this.app.map.self.peek();
    const map = this.#map;
    if (!me || !map) return;
    map.setView(me.lat, me.lon, Math.max(map.zoom, CENTRE_ZOOM));
    this.#userMoved = true;
    lastView.set(this.app, map.view);
  }

  /** Fits every visible marker (and self). */
  fitAll(): void {
    const b = this.app.map.bounds.peek();
    const map = this.#map;
    if (!b || !map) return;
    map.fitBounds(b);
    this.#fittedFor = JSON.stringify(b);
  }

  override firstUpdated(): void {
    const v = lastView.get(this.app);
    const map = this.#map;
    if (v && map) {
      map.setView(v.lat, v.lon, v.zoom);
      this.#userMoved = true;
    }
  }

  override willUpdate(changed: PropertyValues): void {
    if (changed.has('params')) this.#focusKey = this.params?.['key']?.toLowerCase();
  }

  /** Selects a node and centres the map on it; false when it has no location (yet). */
  focusNode(key: string): boolean {
    const map = this.#map;
    const marker = this.app.map.focus(key);
    if (!marker || !map) return false;
    map.setView(marker.lat, marker.lon, Math.max(map.zoom, FOCUS_ZOOM));
    this.#userMoved = true;
    lastView.set(this.app, map.view);
    return true;
  }

  override updated(): void {
    const key = this.#focusKey;
    if (key) {
      // contacts (and approximate positions) load asynchronously: retry on each update until the marker exists
      const loaded = !this.app.contacts.loading.peek() && this.app.contacts.views.peek().length > 0 && !this.app.positions.loading.peek();
      if (this.focusNode(key) || loaded) this.#focusKey = undefined;
    }
    const b = this.app.map.bounds.peek();
    if (b && !this.#userMoved && JSON.stringify(b) !== this.#fittedFor) this.fitAll();
  }

  #select(key: string): void {
    this.app.map.select(this.app.map.selectedKey.peek() === key ? null : key);
  }

  #saveTiles(e: SubmitEvent): void {
    e.preventDefault();
    const input = (e.target as HTMLFormElement).elements.namedItem('tileUrl') as HTMLInputElement;
    try {
      this.app.map.setTileUrl(input.value);
      this.#tileError = '';
      this.app.notifications.success('Tile source saved');
    } catch (err) {
      this.#tileError = errorText(err);
    }
    this.requestUpdate();
  }

  override render() {
    const m = this.app.map;
    const markers = m.markers.value;
    const me = m.self.value;
    const sel = m.selected.value;
    const counts = m.counts.value;
    const total = m.allMarkers.value.length;
    return html`
      <div class="page-head">
        <h2>Map</h2>
        <button data-action="centre" ?disabled=${!me} title=${me ? '' : 'Set this radio’s location in Settings'} @click=${() => this.centreOnMe()}>
          Centre on me
        </button>
        <button data-action="fit" ?disabled=${!m.bounds.value} @click=${() => this.fitAll()}>Fit all</button>
      </div>
      <div class="toolbar">
        <div class="chips" role="group" aria-label="Node types">
          ${MAP_KINDS.map(
            (k) => html`<button class="chip" data-filter=${k} aria-pressed=${m.isKindVisible(k) ? 'true' : 'false'} @click=${() => m.toggleKind(k)}>
              <span class="swatch" style=${`background:${KIND_COLORS[k]}`} aria-hidden="true"></span>${KIND_LABEL[k]}
              <span class="n" aria-label=${`${counts[k]} on map`}>${counts[k]}</span>
            </button>`,
          )}
        </div>
        <label
          >Heard
          <select data-age @change=${(e: Event) => m.setMaxAge((e.target as HTMLSelectElement).value as MapMaxAge)}>
            ${MAP_MAX_AGES.map((a) => html`<option value=${a} ?selected=${m.maxAge.value === a}>${AGE_LABEL[a]}</option>`)}
          </select>
        </label>
        <label class="check" title="Show nodes without a location near the repeater they were last heard through (dashed, with “?”)"
          ><input type="checkbox" data-approximate .checked=${this.app.appSettings.approximatePositions.value}
            @change=${(e: Event) => this.app.appSettings.setApproximatePositions((e.target as HTMLInputElement).checked)} />
          Approximate unknown positions</label
        >
      </div>
      <div class="stage">
        <mc-tile-map
          .tileUrl=${m.tileUrl.value}
          label="Node map"
          @mc-view-change=${(e: CustomEvent<TileMapView>) => {
            this.#userMoved = true;
            lastView.set(this.app, e.detail);
          }}
        >
          ${me
            ? html`<mc-map-marker data-self kind="self" lat=${me.lat} lon=${me.lon} label=${`${me.name} (you)`} description="This radio"
                @click=${() => m.select(null)}></mc-map-marker>`
            : nothing}
          ${repeat(
            markers,
            (x) => x.key,
            (x) => html`<mc-map-marker
              data-key=${x.key}
              kind=${x.kind}
              lat=${x.lat}
              lon=${x.lon}
              label=${x.name}
              description=${describe(x)}
              ?approximate=${!!x.approximate}
              ?selected=${sel?.key === x.key}
              @click=${() => this.#select(x.key)}
            ></mc-map-marker>`,
          )}
        </mc-tile-map>
        ${markers.length === 0
          ? html`<p class="card empty-overlay muted" data-empty>
              ${total === 0 ? 'No contacts with a location yet. Nodes appear here once their adverts include a position.' : 'No nodes match the filters.'}
            </p>`
          : nothing}
        ${sel ? this.#card(sel) : nothing}
      </div>
      <div class="foot muted">
        ${m.withoutLocation.value > 0 ? html`<span data-without>${m.withoutLocation.value} contacts without a location are not shown.</span>` : nothing}
        ${me ? nothing : html`<span>This radio has no location; <a href=${hrefFor('/settings')}>set it in Settings</a> to see distances.</span>`}
      </div>
      <details class="foot">
        <summary>Tile source</summary>
        <form @submit=${this.#saveTiles}>
          <input name="tileUrl" aria-label="Tile URL template" .value=${m.tileUrl.value === OSM_TILE_URL ? '' : m.tileUrl.value}
            placeholder=${OSM_TILE_URL} />
          <button type="submit">Save</button>
        </form>
        <p class="muted">An XYZ template with {z}, {x} and {y}; empty for OpenStreetMap. Tiles are fetched by your browser from that server.</p>
        ${this.#tileError ? html`<p role="alert">${this.#tileError}</p>` : nothing}
      </details>
    `;
  }

  #card(x: MapMarker) {
    const m = this.app.map;
    return html`<section class="card info" data-card aria-labelledby="card-title">
      <header>
        <h3 id="card-title">${x.name}</h3>
        <button class="close" aria-label="Close details" @click=${() => m.select(null)}>✕</button>
      </header>
      <dl>
        <dt>Type</dt>
        <dd data-field="type">${TYPE_LABEL[x.kind]}</dd>
        <dt>Last heard</dt>
        <dd data-field="seen">${x.lastSeen ? formatRelative(x.lastSeen) : 'Never'}</dd>
        ${x.distanceM !== undefined
          ? html`<dt>Distance</dt>
              <dd data-field="distance">${formatDistance(x.distanceM)} ${x.compass} (${Math.round(x.bearing ?? 0)}°)</dd>`
          : nothing}
        <dt>Path</dt>
        <dd data-field="path">${hopsLink(x.view.path.label, x.view.path.kind === 'hops' ? { kind: 'contact', key: x.key } : null)}</dd>
        <dt>Position</dt>
        ${x.estimate
          ? html`<dd data-field="approximate">
              Approximate: near ${x.estimate.viaName}, last heard ${formatRelative(x.estimate.observedAt)}
            </dd>`
          : html`<dd class="mono">${x.lat.toFixed(5)}, ${x.lon.toFixed(5)}</dd>`}
      </dl>
      <div class="actions">
        ${x.kind === 'chat'
          ? html`<a class="button" data-action="chat" href=${hrefFor(`/chat/${x.key}`)}>Chat</a>`
          : html`<a class="button" data-action="node" href=${hrefFor(`/node/${x.key}`)}>Node</a>`}
      </div>
    </section>`;
  }
}

customElements.define('mc-map-page', McMapPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-map-page': McMapPage;
  }
}
