/**
 * `<mc-packets-map>`: the Packets tab's "Map" panel. Draws the paths of the newest
 * `MAP_PACKET_LIMIT` packets the list shows (core `PacketStatsModel.recentRoutes`: its points are
 * exactly the packets matching the shared filter) as a directed usage map: one arrowed line per
 * hop and direction, as thick as the packets that crossed it that way, and a dot per node sized
 * by use. Mirrors the Stats tab's "Packet paths" map (packet-stats.ts), including the approximate
 * positions toggle and its fit-bounds rules.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { type Bounds, type PathUsageMap, type PathUsageRoute } from '@meshcore-web/core/app';
import { AppElement } from '../../app-context.js';
import { shared } from '../../styles.js';
import { formatNumber } from '../../charts/index.js';
import type { McTileMap } from '../../components/tile-map.js';
import { directedUsageLines, usageMarkerSize } from '../../components/path-usage-lines.js';
import '../../components/tile-map.js';

function sameBounds(a: Bounds | null, b: Bounds | null): boolean {
  return a === b || (!!a && !!b && a.south === b.south && a.west === b.west && a.north === b.north && a.east === b.east);
}

const plural = (n: number, one: string, many = `${one}s`): string => `${formatNumber(n, 0)} ${n === 1 ? one : many}`;

export class McPacketsMap extends AppElement {
  static override styles = [
    shared,
    css`
      :host {
        display: block;
        margin-block-end: 8px;
      }
      mc-tile-map {
        height: clamp(240px, 45dvh, 420px);
      }
      .note {
        margin: 6px 0 0;
        font-size: 13px;
      }
      label.estimate {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-block-start: 6px;
        font-size: 13px;
        color: var(--mc-text-muted);
      }
    `,
  ];

  /** Fit to the routes on the next update (first render, estimate toggled). */
  #fitPending = true;
  /** The bounds last fitted to: new routes re-fit only when they move them. */
  #fittedBounds: Bounds | null = null;
  /** The map element last fitted (a new one, after the map was empty, starts unfitted). */
  #fittedMap: McTileMap | null = null;

  #usage(routes: readonly PathUsageRoute[]): PathUsageMap {
    return this.app.paths.routesUsage(routes, { directed: true });
  }

  override render(): TemplateResult {
    const stats = this.app.packetStats;
    const listed = stats.points.value.length;
    const { routes, packets, mapped } = stats.recentRoutes.value;
    if (stats.loading.value && listed === 0) return html`<p class="note muted" data-field="packets-map-empty">Loading packets…</p>`;
    if (listed === 0) return html`<p class="note muted" data-field="packets-map-empty">No packets listed to map.</p>`;
    const m = this.#usage(routes);
    const estimate = this.app.appSettings.approximatePositions.value;
    const toggle =
      estimate || m.incomplete > 0
        ? html`<label class="estimate"
            ><input
              type="checkbox"
              data-approximate
              .checked=${estimate}
              @change=${(e: Event) => {
                this.app.appSettings.setApproximatePositions((e.target as HTMLInputElement).checked);
                this.#fitPending = true;
              }}
            />
            Approximate positions of nodes without a location</label
          >`
        : nothing;
    const scope =
      listed > packets
        ? `Paths of the newest ${formatNumber(packets, 0)} of the ${plural(listed, 'packet')} listed`
        : `Paths of the ${plural(listed, 'packet')} listed`;
    const known = `${formatNumber(mapped, 0)} ${mapped === 1 ? 'has' : 'have'} a known path`;
    if (m.edges.length === 0) {
      return html`<p class="note muted" data-field="packets-map-empty">
          ${scope} (${known}). None can be drawn: ${mapped ? 'the nodes on them have no known location.' : 'no packet has a known path.'}
        </p>
        ${toggle}`;
    }
    const maxStop = m.stops.reduce((n, st) => Math.max(n, st.count), 0);
    return html`
      <mc-tile-map .tileUrl=${this.app.map.tileUrl.value} .lines=${directedUsageLines(m)} label="Paths of listed packets" data-field="packets-map">
        ${m.stops.map(
          (st) => html`<mc-map-marker
            data-stop=${st.id}
            data-count=${st.count}
            kind=${st.node?.kind ?? ''}
            style=${`--marker-size: ${usageMarkerSize(st.count, maxStop).toFixed(2)}rem`}
            lat=${st.lat}
            lon=${st.lon}
            label=${st.label}
            description=${`${plural(st.count, 'packet')}${st.approximate ? ', approximate location' : ''}`}
            ?approximate=${st.approximate}
          ></mc-map-marker>`,
        )}
      </mc-tile-map>
      <p class="note muted" data-field="packets-map-note">
        ${scope} (${known}). Arrows show travel direction; line thickness shows how many packets crossed each hop that way (busiest:
        ${formatNumber(m.maxCount, 0)}); dot size shows how many passed through each node. Dashed lines lead to estimated positions or skip
        hops with no known location.${m.incomplete ? ` ${plural(m.incomplete, 'packet')} came over hops with no known location.` : ''}
      </p>
      ${toggle}
    `;
  }

  protected override updated(): void {
    const map = this.renderRoot.querySelector<McTileMap>('mc-tile-map');
    if (!map) return;
    const b = this.#usage(this.app.packetStats.recentRoutes.peek().routes).bounds;
    // a live packet over already-drawn nodes keeps the user's pan / zoom; a filter that moves the
    // bounds (or opening the map, toggling estimates) re-fits
    if (!this.#fitPending && map === this.#fittedMap && sameBounds(b, this.#fittedBounds)) return;
    if (b) map.fitBounds(b, { maxZoom: 15, padding: 40 });
    this.#fittedBounds = b;
    this.#fittedMap = map;
    this.#fitPending = false;
  }
}

customElements.define('mc-packets-map', McPacketsMap);

declare global {
  interface HTMLElementTagNameMap {
    'mc-packets-map': McPacketsMap;
  }
}
