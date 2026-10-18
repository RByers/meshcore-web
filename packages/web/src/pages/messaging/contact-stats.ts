/**
 * `<mc-contact-stats>`: the *Stats* tab of the node page (`/node/:key/stats`) (docs/packet-stats.md §5). Maps
 * `app.packetStats.forContact(key)` onto the chart elements: tiles, packets heard over time, the
 * paths they arrived over (bar chart, or a map with each hop's line as thick as its packet count), signal over time (coloured by path), and the hop count distribution.
 * Uses the same global date range as the packet log Stats tab (`<mc-stats-range>`).
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import type { ContactPathStats, HopCount, NodeRef, PathUsageMap, StatPacket, Timeline } from '@meshcore-web/core/app';
import { AppElement } from '../../app-context.js';
import { formatRelative, formatSnr } from '../../format.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { assignSlots, type BarItem, type Describe, type DotPoint, type DotSelectDetail, type LineSeries, type SeriesPalette } from '../../charts/index.js';
import { timelineDescribe, timelinePalette, timelineSeries } from '../packets/packet-stats.js';
import type { McTileMap } from '../../components/tile-map.js';
import { directedUsageLines } from '../../components/path-usage-lines.js';
import '../../components/stats-range.js';
import '../../components/tile-map.js';
import { nodeHref } from '../../components/node-link.js';

/** Paths that get their own colour in the signal plot (the rest are "Other"). */
const TOP_PATHS = 8;
export type YField = 'snr' | 'rssi' | 'hops';

const Y_FIELDS: Record<YField, { option: string; label: string; format: (v: number) => string; missing: string }> = {
  snr: { option: 'SNR', label: 'SNR (dB)', format: (v) => formatSnr(v), missing: 'SNR' },
  rssi: { option: 'RSSI', label: 'RSSI (dBm)', format: (v) => `${Number.isInteger(v) ? v : v.toFixed(1)} dBm`, missing: 'RSSI' },
  hops: { option: 'Hops', label: 'Hops', format: (v) => (Number.isInteger(v) ? String(v) : ''), missing: 'a known hop count' },
};

/** "direct", or the hop labels joined with " > ". */
export function pathLabel(pathKey: string, hops: readonly NodeRef[]): string {
  return pathKey === '' ? 'direct' : hops.map((n) => n.label).join(' > ');
}

interface Derived {
  timeline: LineSeries[];
  timelinePalette: SeriesPalette;
  timelineDescribe: Describe;
  paths: BarItem[];
  pathPalette: SeriesPalette;
  dots: Record<YField, DotPoint[]>;
  hops: BarItem[];
}

export class McContactStats extends AppElement {
  static override properties = { key: { type: String }, yField: { state: true }, pathView: { state: true } };
  declare key: string;
  declare yField: YField;
  declare pathView: 'chart' | 'map';

  static override styles = [
    shared,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
        gap: 8px;
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      section.card h3 {
        margin-top: 0;
      }
      .head h3 {
        margin: 0;
      }
      label {
        color: var(--mc-text-muted);
        font-size: 13px;
      }
      mc-tile-map {
        height: clamp(260px, 50dvh, 460px);
      }
      .map-note {
        margin: 8px 0 0;
        font-size: 0.85rem;
      }
      label.estimate {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-block-start: 6px;
      }
      select {
        font: inherit;
        color: var(--mc-text);
        background: var(--mc-surface);
        border: 1px solid var(--mc-border);
        border-radius: 6px;
        padding: 3px 6px;
      }
    `,
  ];

  // chart props derived from the model output; rebuilt only when it changes, so the charts keep
  // their cached layouts across unrelated re-renders
  #memoKey: readonly unknown[] = [];
  #memo: Derived | undefined;

  constructor() {
    super();
    this.key = '';
    this.yField = 'snr';
    this.pathView = 'chart';
  }

  #fitPending = false;

  /** pathKey of the contact's current out_path ('' = direct), null when flood / unknown. */
  #currentPathKey(): string | null {
    const cur = this.app.contactPaths.current(this.key);
    if (cur?.kind === 'hops') return cur.hops.map((h) => h.hex).join('>');
    if (cur?.kind === 'direct') return '';
    return null;
  }

  #derive(from: readonly StatPacket[], paths: readonly ContactPathStats[], timeline: Timeline, hops: readonly HopCount[], curPath: string | null): Derived {
    const key = [from, paths, timeline, hops, curPath, this.key];
    if (this.#memo && key.every((k, i) => k === this.#memoKey[i])) return this.#memo;
    this.#memoKey = key;
    const now = this.app.clock.now();

    const timeline_ = timelineSeries(timeline);
    const timelinePalette_ = timelinePalette(timeline_);

    const labels = new Map(paths.map((p) => [p.pathKey, pathLabel(p.pathKey, p.hops)]));
    const paths_: BarItem[] = paths.map((p) => ({
      label: labels.get(p.pathKey) ?? p.pathKey,
      value: p.count,
      title: `last heard ${formatRelative(p.lastTs, now)}${p.meanSnr !== null ? `, mean SNR ${formatSnr(p.meanSnr)}` : ''}`,
      ...(p.pathKey === curPath ? { href: nodeHref(this.key, 'path') } : {}),
    }));
    // paths are count desc: the first 8 get slots, the rest fold into "Other"
    const pathPalette = assignSlots(
      paths.slice(0, TOP_PATHS).map((p) => p.pathKey),
      labels,
    );
    const dot = (p: StatPacket, y: number | null): DotPoint => ({
      x: p.ts,
      y,
      size: p.bytes,
      color: p.pathKey,
      label: labels.get(p.pathKey) ?? p.pathKey,
      id: p.id,
      title: p.typeName,
    });
    const dots: Record<YField, DotPoint[]> = {
      snr: from.map((p) => dot(p, p.snr)),
      rssi: from.map((p) => dot(p, p.rssi)),
      hops: from.map((p) => dot(p, p.hops)),
    };
    const hopItems: BarItem[] = hops.map((h) => ({ label: h.hops === 0 ? 'direct' : `${h.hops} hop${h.hops === 1 ? '' : 's'}`, value: h.count }));
    this.#memo = { timeline: timeline_, timelinePalette: timelinePalette_, timelineDescribe: timelineDescribe(timeline), paths: paths_, pathPalette, dots, hops: hopItems };
    return this.#memo;
  }

  override render(): TemplateResult {
    const stats = this.app.packetStats;
    const s = stats.forContact(this.key).value;
    const win = stats.window.value;
    const range = html`<section class="card"><mc-stats-range></mc-stats-range></section>`;
    if (s.from.length === 0 && s.via.length === 0) {
      return html`${range}
        <p class="muted" data-empty>${stats.loading.value ? 'Loading…' : 'No packets from or via this contact in the selected range.'}</p>`;
    }
    const d = this.#derive(s.from, s.paths, s.timeline, s.hops, this.#currentPathKey());
    const snrs = s.from.flatMap((p) => (p.snr !== null ? [p.snr] : []));
    const meanSnr = snrs.length ? snrs.reduce((a, b) => a + b, 0) / snrs.length : null;
    const direct = s.paths.find((p) => p.pathKey === '');
    const y = Y_FIELDS[this.yField];
    const xDomain: [number, number] | undefined = win ? [win.from, win.to] : undefined;
    return html`
      ${range}
      <div class="tiles" data-section="tiles">
        <mc-stat-tile data-tile="from" label="Packets from" .value=${s.from.length} hint="Packets this contact originated"></mc-stat-tile>
        <mc-stat-tile data-tile="via" label="Forwarded via" .value=${s.via.length} hint="Packets from others that this contact relayed"></mc-stat-tile>
        <mc-stat-tile data-tile="paths" label="Distinct paths" .value=${s.paths.length}></mc-stat-tile>
        <mc-stat-tile
          data-tile="direct"
          label="Heard directly"
          .value=${s.from.length ? `${Math.round((direct?.share ?? 0) * 100)}%` : '—'}
          hint="Share of its packets heard with an empty path"
        ></mc-stat-tile>
        <mc-stat-tile data-tile="snr" label="Mean SNR" .value=${meanSnr !== null ? formatSnr(meanSnr) : '—'}></mc-stat-tile>
      </div>
      ${s.from.length === 0
        ? nothing
        : html`
            <section class="card" data-section="timeline">
              <h3>Heard over time</h3>
              <mc-line-chart .series=${d.timeline} .palette=${d.timelinePalette} .describe=${d.timelineDescribe} .xDomain=${xDomain} stacked y-label="Packets"></mc-line-chart>
            </section>
            <section class="card" data-section="paths">
              <div class="head">
                <h3>Paths heard via</h3>
                <button
                  class="small"
                  data-action="paths-map"
                  aria-pressed=${this.pathView === 'map' ? 'true' : 'false'}
                  @click=${() => {
                    this.pathView = this.pathView === 'map' ? 'chart' : 'map';
                    this.#fitPending = this.pathView === 'map';
                  }}
                >
                  ${this.pathView === 'map' ? 'Chart' : 'Map'}
                </button>
              </div>
              ${this.pathView === 'map' ? this.#pathsMap(s.paths) : html`<mc-bar-chart .items=${d.paths}></mc-bar-chart>`}
            </section>
            <section class="card" data-section="signal">
              <div class="head">
                <h3>Signal over time</h3>
                <label
                  >Show
                  <select data-y @change=${(e: Event) => (this.yField = (e.target as HTMLSelectElement).value as YField)}>
                    ${(Object.keys(Y_FIELDS) as YField[]).map((f) => html`<option value=${f} ?selected=${f === this.yField}>${Y_FIELDS[f].option}</option>`)}
                  </select>
                </label>
              </div>
              <mc-dot-plot
                .points=${d.dots[this.yField]}
                .xDomain=${xDomain}
                y-label=${y.label}
                .yFormat=${y.format}
                .palette=${d.pathPalette}
                series-label="Path"
                missing-label=${y.missing}
                @dot-select=${(e: CustomEvent<DotSelectDetail>) => {
                  location.hash = hrefFor(`/packets/${e.detail.id}`);
                }}
              ></mc-dot-plot>
            </section>
            <section class="card" data-section="hops">
              <h3>Hop count</h3>
              <mc-bar-chart .items=${d.hops}></mc-bar-chart>
            </section>
          `}
    `;
  }
  #usage(paths: readonly ContactPathStats[]): PathUsageMap {
    return this.app.paths.usage(
      paths.map((p) => ({ hashes: p.pathKey === '' ? [] : p.pathKey.split('>'), count: p.count })),
      this.key,
      { directed: true },
    );
  }

  #pathsMap(paths: readonly ContactPathStats[]): TemplateResult {
    const m = this.#usage(paths);
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
    if (m.edges.length === 0) {
      return html`<p class="muted" data-field="no-map">None of these paths can be drawn: the nodes on them have no known location.</p>
        ${toggle}`;
    }
    return html`
      <mc-tile-map .tileUrl=${this.app.map.tileUrl.value} .lines=${directedUsageLines(m)} label="Paths heard via" data-field="paths-map">
        ${m.stops.map(
          (st) => html`<mc-map-marker
            data-stop=${st.id}
            kind=${st.role === 'to' ? 'self' : (st.node?.kind ?? '')}
            lat=${st.lat}
            lon=${st.lon}
            label=${st.label}
            description=${`${st.count} packet${st.count === 1 ? '' : 's'}${st.approximate ? ', approximate location' : ''}`}
            ?approximate=${st.approximate}
          ></mc-map-marker>`,
        )}
      </mc-tile-map>
      <p class="muted map-note" data-field="paths-map-note">
        Line thickness shows how many of the ${m.total} packets crossed each hop (busiest: ${m.maxCount}); arrows show travel direction. Dashed lines lead to
        estimated positions or skip hops with no known location.${m.incomplete
          ? ` ${m.incomplete} packet${m.incomplete === 1 ? '' : 's'} came over hops with no known location.`
          : ''}
      </p>
      ${toggle}
    `;
  }

  protected override updated(): void {
    if (!this.#fitPending) return;
    const map = this.renderRoot.querySelector<McTileMap>('mc-tile-map');
    if (!map) return;
    const b = this.#usage(this.app.packetStats.forContact(this.key).peek().paths).bounds;
    if (b) map.fitBounds(b, { maxZoom: 15, padding: 40 });
    this.#fitPending = false;
  }
}

customElements.define('mc-contact-stats', McContactStats);

declare global {
  interface HTMLElementTagNameMap {
    'mc-contact-stats': McContactStats;
  }
}
