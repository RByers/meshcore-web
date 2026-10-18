/**
 * `<mc-packet-stats>`: the Stats tab of `/packets` (docs/packet-stats.md §3). Renders the core
 * `PacketStatsModel` (`app.packetStats`) as tiles and charts: packet rate (stacked), packets per
 * source node, packets over time (dot plot with y / colour selectors), network utilisation, text compression, the hop
 * count distribution, then the paths: a "Packet paths" map (on demand: each hop's line as thick as the packets
 * that crossed it, each node's dot sized by use), the most common first and final nodes in the path and the signal (mean SNR) by last hop. The bin size lives in the model (`<mc-stats-range parts="bin">`); only
 * the chart selectors are local state. Everything here maps model output to chart props.
 *
 * Drill-down (§6): clicking a source bar, first / final path node bar, last-hop signal bar, hop-count bar or breakdown segment adds a model filter
 * for that value (clicking the active one again removes it). The filter, date range included, is
 * shared with the List tab (owned by the packet log) and edited in the filter area above the
 * tabs (`<mc-packet-filters>`); here a "Showing X of Y packets" line notes when it narrows the range.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import {
  formatDistance,
  nodeId,
  placeNodeCounts,
  untracked,
  timelineSeriesDescription,
  packetFilterChips,
  type Breakdown,
  type CompressionCounts,
  type CompressionStats,
  type ChannelMessageCount,
  type HopCount,
  type LastHopStats,
  type LoraParams,
  type NodeRef,
  type Bounds,
  type PathUsageMap,
  type PathUsageRoute,
  type PlacedNodeCounts,
  type SourceStats,
  type StatPacket,
  type StatsFilter,
  type StatsFilterField,
  type TextCompression,
  type Timeline,
} from '@meshcore-web/core/app';
import { packetTypeNameDescription } from '@meshcore-web/core/packet';
import { AppElement } from '../../app-context.js';
import { hrefFor } from '../../router.js';
import { nodeHref } from '../../components/node-link.js';
import { shared } from '../../styles.js';
import { formatDuration, formatRelative, formatSnr } from '../../format.js';
import {
  assignSlots,
  fixedSlots,
  formatNumber,
  formatPercent,
  keysByCount,
  MAX_SERIES,
  OTHER_KEY,
  type BarItem,
  type BarSelectDetail,
  type BreakdownSegment,
  type SegmentSelectDetail,
  type DotPoint,
  type Describe,
  type DotSelectDetail,
  type LineSeries,
  type SeriesPalette,
} from '../../charts/index.js';
import type { McTileMap } from '../../components/tile-map.js';
import { directedUsageLines, usageMarkerSize } from '../../components/path-usage-lines.js';
import '../../components/stats-range.js';
import '../../components/tile-map.js';

// ------------------------------------------------------------------------------ selectors

function sameBounds(a: Bounds | null, b: Bounds | null): boolean {
  return a === b || (!!a && !!b && a.south === b.south && a.west === b.west && a.north === b.north && a.east === b.east);
}

export type YField = 'snr' | 'rssi' | 'distance' | 'hops' | 'size';
export type ColorField = 'type' | 'route' | 'lastHop' | 'source' | 'channel' | 'direction' | 'compression';

interface YOption {
  id: YField;
  label: string;
  /** Text after "n packets without …". */
  missing: string;
  value: (p: StatPacket) => number | null;
  format?: (v: number) => string;
}

export const Y_OPTIONS: readonly YOption[] = [
  { id: 'snr', label: 'SNR (dB)', missing: 'SNR', value: (p) => p.snr },
  { id: 'rssi', label: 'RSSI (dBm)', missing: 'RSSI', value: (p) => p.rssi },
  { id: 'distance', label: 'Distance', missing: 'a known distance', value: (p) => p.distanceM, format: formatDistance },
  { id: 'hops', label: 'Hops', missing: 'a hop count', value: (p) => p.hops },
  { id: 'size', label: 'Size (bytes)', missing: 'a known size', value: (p) => (p.bytes > 0 ? p.bytes : null) },
];

export const COLOR_OPTIONS: readonly { id: ColorField; label: string }[] = [
  { id: 'type', label: 'Packet type' },
  { id: 'route', label: 'Route type' },
  { id: 'lastHop', label: 'Last hop' },
  { id: 'source', label: 'Source' },
  { id: 'channel', label: 'Channel' },
  { id: 'direction', label: 'Direction' },
  { id: 'compression', label: 'Compression' },
];

/** Payload type → fixed palette slot (docs/packet-stats.md §3); other types are "Other". */
export const TYPE_SLOTS: Readonly<Record<string, number>> = { TXT_MSG: 1, GRP_TXT: 2, ADVERT: 3, ACK: 4, PATH: 5, TRACE: 6, REQ: 7, RESPONSE: 7, CONTROL: 8 };

const DIRECTION_LABEL: Readonly<Record<string, string>> = { in: 'Received', out: 'Sent' };

/** Compression filter value → label (chip text, breakdown segment, dot plot legend). */
export const COMPRESSION_LABEL: Readonly<Record<TextCompression, string>> = { smaz: 'Compressed', plain: 'Plain', unknown: 'Not decrypted' };
const COMPRESSION_ORDER: readonly TextCompression[] = ['smaz', 'plain', 'unknown'];
const COMPRESSION_KEY_SLOTS: Readonly<Record<string, number>> = { smaz: 1, plain: 2, unknown: 0 };
const COMPRESSION_LABELS = new Map(COMPRESSION_ORDER.map((k) => [k, COMPRESSION_LABEL[k]]));
/** Breakdown palettes are keyed by segment label: Compressed / Plain get slots, Not decrypted is grey. */
const COMPRESSION_SEGMENT_PALETTE = fixedSlots({ [COMPRESSION_LABEL.smaz]: 1, [COMPRESSION_LABEL.plain]: 2, [COMPRESSION_LABEL.unknown]: 0 });
const NOT_DECRYPTED_HINT =
  'Not decrypted: no key for the message, so its compression is unknown. Channel texts need the channel added; DMs need the radio private key stored (Settings) and must be to or from a known contact.';

// ------------------------------------------------------------------------------ mapping helpers

/** Series key of a point under a colouring, plus its legend label; `null` key = folds into "Other". */
export function colorKey(p: StatPacket, by: ColorField): { key: string | null; label: string } {
  switch (by) {
    case 'type':
      return { key: p.typeName, label: p.typeName };
    case 'route':
      return { key: p.routeName || 'unknown', label: p.routeName || 'unknown' };
    case 'direction':
      return { key: p.direction, label: DIRECTION_LABEL[p.direction] ?? p.direction };
    case 'channel':
      return { key: p.channel, label: p.channel ?? '' };
    case 'source':
      return nodeKey(p.source);
    case 'lastHop':
      return nodeKey(p.lastHop);
    case 'compression':
      return p.compression ? { key: p.compression, label: COMPRESSION_LABEL[p.compression] } : { key: null, label: 'Not text' };
  }
}

function nodeKey(n: NodeRef | null): { key: string | null; label: string } {
  return n ? { key: nodeId(n), label: n.label } : { key: null, label: '' };
}

/** Palette for a colouring: fixed slots for payload types, else the top 8 keys by count. */
export function dotPalette(points: readonly StatPacket[], by: ColorField): SeriesPalette {
  if (by === 'type') return fixedSlots(TYPE_SLOTS);
  if (by === 'compression') return fixedSlots(COMPRESSION_KEY_SLOTS, COMPRESSION_LABELS);
  const labels = new Map<string, string>();
  const keys: string[] = [];
  for (const p of points) {
    const { key, label } = colorKey(p, by);
    if (key === null) continue;
    labels.set(key, label);
    keys.push(key);
  }
  return assignSlots(keysByCount(keys), labels);
}

/** Dot plot points: x = time, y per the selector, size = bytes, colour key per the colouring. */
export function dotPoints(points: readonly StatPacket[], y: YField, by: ColorField): DotPoint[] {
  const opt = Y_OPTIONS.find((o) => o.id === y) ?? Y_OPTIONS[0]!;
  return points.map((p) => {
    const c = colorKey(p, by);
    const src = p.source ? ` from ${p.source.label}` : '';
    return {
      x: p.ts,
      y: opt.value(p),
      size: p.bytes,
      color: c.key ?? OTHER_KEY,
      ...(c.label ? { label: c.label } : {}),
      id: p.id,
      title: `${p.typeName}${p.routeName ? ` ${p.routeName}` : ''}${src}, ${p.bytes} B`,
    };
  });
}

/**
 * Source bar items: a contact link only for nodes resolved to a contact (not this radio); every
 * bar is a source filter keyed by `nodeId`, `selected` when it is the active one.
 */
export function sourceItems(s: SourceStats, active?: string): BarItem[] {
  return s.top.map(({ node, count, bytes }) => {
    const key = nodeId(node);
    return {
      label: node.label,
      value: count,
      key,
      selected: key === active,
      ...(node.resolved && node.key && !node.self ? { href: nodeHref(node.key) } : {}),
      title: `${formatNumber(bytes, 0)} B${node.resolved ? '' : ' (not uniquely resolved)'}`,
    };
  });
}

/** "n packets could not be attributed, m more nodes" (empty when both are 0). */
export function sourceFooter(s: SourceStats): string {
  return nodeFooter(s, (n) => `${n} ${n === 1 ? 'packet' : 'packets'} could not be attributed`);
}

/** "n packets had no path, m more nodes" for the first / last path node charts (empty when both are 0). */
export function pathNodeFooter(s: SourceStats): string {
  return nodeFooter(s, (n) => `${n} ${n === 1 ? 'packet' : 'packets'} had no path`);
}

/**
 * Signal-by-last-hop bars: value = mean SNR (null when none of its packets had one), a contact
 * link like the source chart, keyed by `nodeId` (the lastHop filter value); `now` for "last heard".
 */
export function lastHopItems(s: LastHopStats, now: number, active?: string): BarItem[] {
  return s.top.map((h) => {
    const key = nodeId(h.node);
    const parts = [`${formatNumber(h.count, 0)} ${h.count === 1 ? 'packet' : 'packets'} (${formatNumber(h.direct, 0)} direct, ${formatNumber(h.relayed, 0)} relayed)`];
    if (h.minSnr !== null && h.maxSnr !== null) parts.push(`SNR ${formatSnr(h.minSnr)} – ${formatSnr(h.maxSnr)}`);
    if (h.meanRssi !== null) parts.push(`mean RSSI ${formatNumber(h.meanRssi, 0)} dBm`);
    parts.push(`last heard ${formatRelative(h.lastTs, now)}`);
    return {
      label: h.node.label,
      value: h.meanSnr,
      key,
      selected: key === active,
      ...(h.node.resolved && h.node.key && !h.node.self ? { href: nodeHref(h.node.key) } : {}),
      title: `${parts.join(' · ')}${h.node.resolved ? '' : ' (not uniquely resolved)'}`,
    };
  });
}

/** "n received packets had no last hop, m more nodes" (empty when both are 0). */
export function lastHopFooter(s: LastHopStats): string {
  return nodeFooter(s, (n) => `${n} received ${n === 1 ? 'packet' : 'packets'} had no last hop`);
}

function nodeFooter(s: SourceStats | LastHopStats, none: (n: number) => string): string {
  const parts: string[] = [];
  if (s.unattributed > 0) parts.push(none(s.unattributed));
  if (s.others > 0) parts.push(`${s.others} more ${s.others === 1 ? 'node' : 'nodes'} (${s.othersPackets} packets)`);
  return parts.join(', ');
}

/** Timeline series beyond the {@link MAX_SERIES} biggest (plus "Other" itself): summed into one "Other" line. */
function foldedSeries(t: Timeline): string[] {
  const own = new Set(t.series.filter((k) => k !== OTHER_KEY).slice(0, MAX_SERIES));
  return t.series.filter((k) => !own.has(k));
}

/**
 * Line chart series from the model timeline (series order as given, biggest first): the first
 * {@link MAX_SERIES} get their own line, the rest are summed into "Other".
 */
export function timelineSeries(t: Timeline): LineSeries[] {
  const folded = foldedSeries(t);
  const out: LineSeries[] = t.series
    .filter((k) => !folded.includes(k))
    .map((key) => ({ key, label: key, points: t.bins.map((b) => ({ t: b.t, v: b.series[key] ?? 0 })) }));
  if (folded.length > 0) {
    out.push({ key: OTHER_KEY, label: OTHER_KEY, points: t.bins.map((b) => ({ t: b.t, v: folded.reduce((n, k) => n + (b.series[k] ?? 0), 0) })) });
  }
  return out;
}

/** Legend hover text for {@link timelineSeries}: which packets each line counts. */
export function timelineDescribe(t: Timeline): Describe {
  const folded = foldedSeries(t);
  return (key) => {
    if (key !== OTHER_KEY) return timelineSeriesDescription(key);
    const parts = folded.filter((k) => k !== OTHER_KEY).map((k) => `${k} (${timelineSeriesDescription(k)})`);
    if (folded.includes(OTHER_KEY) || parts.length === 0) parts.push(timelineSeriesDescription(OTHER_KEY));
    return parts.length === 1 ? parts[0] : `The smaller series, summed:\n${parts.map((p) => `• ${p}`).join('\n')}`;
  };
}

/** Palette for {@link timelineSeries}. */
export function timelinePalette(series: readonly LineSeries[]): SeriesPalette {
  return assignSlots(series.map((s) => s.key));
}

/**
 * Breakdown segments: airtime share, or bytes when airtime is unknown. Keyed by the row name (the
 * filter value) when `keyed`; `active` marks the selected one.
 */
export function breakdownSegments(
  rows: readonly Breakdown[],
  airtime: boolean,
  label: (name: string) => string = (n) => n,
  opts: { keyed?: boolean; active?: string | undefined } = {},
): BreakdownSegment[] {
  return rows.map((r) => ({
    label: label(r.name),
    value: airtime ? r.airtimeMs : r.bytes,
    title: `${formatNumber(r.count, 0)} ${r.count === 1 ? 'packet' : 'packets'}, ${formatBytes(r.bytes)}`,
    ...(opts.keyed ? { key: r.name, selected: r.name === opts.active } : {}),
  }));
}

/** Compression breakdown segments (message counts), keyed by the compression filter value. */
export function compressionSegments(c: CompressionCounts, active?: string): BreakdownSegment[] {
  return COMPRESSION_ORDER.map((k) => ({
    label: COMPRESSION_LABEL[k],
    value: c[k],
    title: `${formatNumber(c[k], 0)} text ${c[k] === 1 ? 'message' : 'messages'}`,
    key: k,
    selected: k === active,
  }));
}

/** "N bytes saved (X%) across M compressed messages · Y% of decrypted texts compressed · S senders". */
export function compressionSummary(c: CompressionStats): string {
  const parts: string[] = [];
  parts.push(c.compressedShare === null ? 'No decrypted text messages' : `${formatPercent(c.compressedShare)} of decrypted text messages compressed`);
  if (c.smaz > 0) {
    const msgs = `${formatNumber(c.smaz, 0)} compressed ${c.smaz === 1 ? 'message' : 'messages'}`;
    parts.push(c.savingsRatio === null ? msgs : `${formatBytes(c.bytesSaved)} saved (${formatPercent(c.savingsRatio)}) across ${msgs}`);
    parts.push(`${formatNumber(c.compressedSources, 0)} ${c.compressedSources === 1 ? 'sender' : 'senders'} using compression`);
  }
  return parts.join(' · ');
}

function hopLabel(hops: number): string {
  return hops === 0 ? '0 (direct)' : String(hops);
}

/** Hop count bars, keyed by `String(hops)` (the hops filter value). */
/** Group-message bars, one per channel (name, or `channel xx` by hash), keyed by the channel filter value. */
export function channelMessageItems(rows: readonly ChannelMessageCount[], active?: string): BarItem[] {
  return rows.map((r) => ({
    label: r.channel,
    value: r.count,
    key: r.channel,
    selected: r.channel === active,
    title: `${formatNumber(r.count - r.sent, 0)} received, ${formatNumber(r.sent, 0)} sent · ${formatBytes(r.bytes)}`,
  }));
}

export function hopItems(hops: readonly HopCount[], active?: string): BarItem[] {
  return hops.map((h) => ({ label: hopLabel(h.hops), value: h.count, key: String(h.hops), selected: String(h.hops) === active }));
}

/**
 * The `data-chip` / `data-remove-filter` hook of a shared filter chip: the drill-down field for
 * direction / types / routes / `drill-<field>` chips, else the chip key (src, node, text).
 */
export function chipHook(key: string): string {
  if (key === 'types') return 'type';
  if (key === 'routes') return 'route';
  return key.startsWith('drill-') ? key.slice('drill-'.length) : key;
}

export function formatBytes(b: number): string {
  return `${formatNumber(b)} B`;
}

export function radioText(r: LoraParams | null): string {
  return r ? `Estimated at SF${r.sf}, ${r.bwKhz} kHz, CR 4/${r.cr}` : 'Radio parameters unknown';
}

const percent = (v: number): string => formatPercent(v);

// ------------------------------------------------------------------------------ element

/** The first / final path node cards (their `data-section`). */
type PathNodeSection = 'path-starts' | 'path-ends';
/** The cards with a map. */
type MapSection = 'paths' | PathNodeSection;
const MAP_SECTIONS: readonly MapSection[] = ['paths', 'path-starts', 'path-ends'];


export class McPacketStats extends AppElement {
  static override properties = {
    yField: { state: true },
    colorField: { state: true },
    showMap: { state: true },
    nodeMaps: { state: true },
  };
  declare yField: YField;
  declare colorField: ColorField;
  /** The "Packet paths" card shows its map (else a one-line summary). */
  declare showMap: boolean;
  /** The first / final path node cards showing their map. */
  declare nodeMaps: ReadonlySet<PathNodeSection>;

  static override styles = [
    shared,
    css`
      :host {
        display: grid;
        gap: var(--mc-gap);
        min-width: 0;
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
        gap: 8px;
      }
      h3 {
        margin: 0 0 8px;
        font-size: 1rem;
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 12px;
        align-items: center;
        margin-block-end: 8px;
        font-size: 13px;
        color: var(--mc-text-muted);
      }
      .controls label {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      select {
        font: inherit;
        color: var(--mc-text);
        background: var(--mc-surface);
        border: 1px solid var(--mc-border);
        border-radius: 6px;
        padding: 3px 6px;
      }
      .note {
        margin: 6px 0 0;
        font-size: 13px;
      }
      .note.intro {
        margin: 0 0 8px;
      }
      .breakdowns {
        display: grid;
        gap: 12px;
        margin-block-start: 12px;
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-block-end: 8px;
      }
      .head h3 {
        margin: 0;
      }
      mc-tile-map {
        height: clamp(260px, 50dvh, 460px);
      }
      label.estimate {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-block-start: 6px;
        font-size: 13px;
        color: var(--mc-text-muted);
      }
      mc-bar-chart.sources {
        --mc-bar-label-width: 40%;
      }
      .count {
        margin: 0;
        font-size: 14px;
      }
    `,
  ];

  constructor() {
    super();
    this.yField = 'snr';
    this.colorField = 'type';
    this.showMap = false;
    this.nodeMaps = new Set();
  }

  /**
   * Per map (keyed by its card's `data-section`): fit it on the next update (map opened, estimate
   * toggled), and the bounds it was last fitted to (new packets re-fit only when they move them).
   */
  #fits = new Map<MapSection, { pending: boolean; bounds: Bounds | null }>();

  #requestFit(section: MapSection): void {
    this.#fits.set(section, { pending: true, bounds: this.#fits.get(section)?.bounds ?? null });
  }

  /** The paths map of the shown packets (memoised in `PathModel`, shared by every map here). */
  #usage(): PathUsageMap {
    return this.app.paths.routesUsage(this.app.packetStats.routes.value, { directed: true });
  }

  #placed(section: PathNodeSection): PlacedNodeCounts {
    const stats = this.app.packetStats;
    return placeNodeCounts(section === 'path-starts' ? stats.pathStarts.value : stats.pathEnds.value, this.#usage());
  }

  /** The "Approximate positions" checkbox (one app setting for every map), when it can matter. */
  #estimateToggle(show: boolean): TemplateResult | typeof nothing {
    const estimate = this.app.appSettings.approximatePositions.value;
    return estimate || show
      ? html`<label class="estimate"
          ><input
            type="checkbox"
            data-approximate
            .checked=${estimate}
            @change=${(e: Event) => {
              this.app.appSettings.setApproximatePositions((e.target as HTMLInputElement).checked);
              for (const s of MAP_SECTIONS) this.#requestFit(s);
            }}
          />
          Approximate positions of nodes without a location</label
        >`
      : nothing;
  }

  #mapButton(open: boolean, action: string, onClick: () => void): TemplateResult {
    return html`<button class="small" data-action=${action} aria-pressed=${open ? 'true' : 'false'} @click=${onClick}>${open ? 'Hide map' : 'Map'}</button>`;
  }

  #pathsCard(routes: readonly PathUsageRoute[]): TemplateResult {
    const packets = routes.reduce((n, r) => n + r.count, 0);
    return html`<section class="card" data-section="paths">
      <div class="head">
        <h3>Packet paths</h3>
        ${this.#mapButton(this.showMap, 'paths-map', () => {
          this.showMap = !this.showMap;
          if (this.showMap) this.#requestFit('paths');
        })}
      </div>
      ${this.showMap
        ? this.#pathsMap(routes)
        : html`<p class="note muted" data-field="paths-summary">
            ${formatNumber(packets, 0)} ${packets === 1 ? 'packet' : 'packets'} with a known route, ${formatNumber(routes.length, 0)}
            distinct ${routes.length === 1 ? 'path' : 'paths'}.
          </p>`}
    </section>`;
  }

  #pathsMap(routes: readonly PathUsageRoute[]): TemplateResult {
    const m: PathUsageMap = this.app.paths.routesUsage(routes, { directed: true });
    const toggle = this.#estimateToggle(m.incomplete > 0);
    if (m.edges.length === 0) {
      return html`<p class="note muted" data-field="no-map">None of these paths can be drawn: the nodes on them have no known location.</p>
        ${toggle}`;
    }
    const maxStop = m.stops.reduce((n, st) => Math.max(n, st.count), 0);
    return html`
      <mc-tile-map .tileUrl=${this.app.map.tileUrl.value} .lines=${directedUsageLines(m)} label="Packet paths" data-field="paths-map">
        ${m.stops.map(
          (st) => html`<mc-map-marker
            data-stop=${st.id}
            data-count=${st.count}
            kind=${st.node?.kind ?? ''}
            style=${`--marker-size: ${usageMarkerSize(st.count, maxStop).toFixed(2)}rem`}
            lat=${st.lat}
            lon=${st.lon}
            label=${st.label}
            description=${`${formatNumber(st.count, 0)} packet${st.count === 1 ? '' : 's'}${st.approximate ? ', approximate location' : ''}`}
            ?approximate=${st.approximate}
          ></mc-map-marker>`,
        )}
      </mc-tile-map>
      <p class="note muted" data-field="paths-map-note">
        Line thickness shows how many of the ${formatNumber(m.total, 0)} packets crossed each hop that way (busiest: ${formatNumber(m.maxCount, 0)}), arrows show travel direction and dot size shows
        how many passed through each node. Dashed lines lead to estimated positions or skip hops with no known location.${m.incomplete
          ? ` ${formatNumber(m.incomplete, 0)} packet${m.incomplete === 1 ? '' : 's'} came over hops with no known location.`
          : ''}
      </p>
      ${toggle}
    `;
  }

  protected override updated(): void {
    for (const section of MAP_SECTIONS) {
      const open = section === 'paths' ? this.showMap : this.nodeMaps.has(section);
      const map = open ? this.renderRoot.querySelector<McTileMap>(`[data-section="${section}"] mc-tile-map`) : null;
      if (!map) continue;
      const b = untracked(() => (section === 'paths' ? this.#usage().bounds : this.#placed(section).bounds));
      // a live packet over already-drawn nodes keeps the user's pan / zoom; a filter that moves the
      // bounds (or opening the map, toggling estimates) re-fits
      const fit = this.#fits.get(section) ?? { pending: true, bounds: null };
      if (!fit.pending && sameBounds(b, fit.bounds)) continue;
      if (b) map.fitBounds(b, { maxZoom: 15, padding: 40 });
      this.#fits.set(section, { pending: false, bounds: b });
    }
  }

  /** Dot plot props for the last (points, y, colour): a new array would re-lay-out every dot. */
  #dots: { key: readonly unknown[]; points: DotPoint[]; palette: SeriesPalette } | undefined;

  #dotProps(points: readonly StatPacket[]): { points: DotPoint[]; palette: SeriesPalette } {
    const key = [points, this.yField, this.colorField];
    const prev = this.#dots;
    if (prev && key.every((k, i) => k === prev.key[i])) return prev;
    this.#dots = { key, points: dotPoints(points, this.yField, this.colorField), palette: dotPalette(points, this.colorField) };
    return this.#dots;
  }

  #onDot = (e: CustomEvent<DotSelectDetail>): void => {
    location.hash = hrefFor(`/packets/${e.detail.id}`);
  };

  /** Adds the filter, or removes it when that exact value is already the active one (toggle). */
  #toggle(field: StatsFilterField, value: string, label: string): void {
    const stats = this.app.packetStats;
    if (stats.filters.value.some((f) => f.field === field && f.value === value)) void stats.removeFilter(field);
    else void stats.addFilter({ field, value, label });
  }

  #onSource = (e: CustomEvent<BarSelectDetail>): void => {
    const node = this.app.packetStats.bySource.value.top.find((s) => nodeId(s.node) === e.detail.key)?.node;
    this.#toggle('source', e.detail.key, node?.label ?? e.detail.key);
  };

  #onPathStart = (e: CustomEvent<BarSelectDetail>): void => {
    const node = this.app.packetStats.pathStarts.value.top.find((s) => nodeId(s.node) === e.detail.key)?.node;
    this.#toggle('pathStart', e.detail.key, node?.label ?? e.detail.key);
  };

  #onPathEnd = (e: CustomEvent<BarSelectDetail>): void => {
    const node = this.app.packetStats.pathEnds.value.top.find((s) => nodeId(s.node) === e.detail.key)?.node;
    this.#toggle('pathEnd', e.detail.key, node?.label ?? e.detail.key);
  };

  #onLastHop = (e: CustomEvent<BarSelectDetail>): void => {
    const node = this.app.packetStats.lastHops.value.top.find((s) => nodeId(s.node) === e.detail.key)?.node;
    this.#toggle('lastHop', e.detail.key, node?.label ?? e.detail.key);
  };

  /** Mean SNR per last hop: how well this radio hears each neighbour. */
  #lastHops(s: LastHopStats, active: string | undefined): TemplateResult {
    const footer = lastHopFooter(s);
    return html`<section class="card" data-section="last-hops">
      <h3>Signal by last hop</h3>
      <p class="note muted intro">Mean SNR of the received packets each node was the last to transmit (its own, heard directly, or relayed).</p>
      <mc-bar-chart
        class="sources"
        .items=${lastHopItems(s, this.app.clock.now(), active)}
        .format=${formatSnr}
        empty-text="No received packets with a known last hop in the shown packets."
        @bar-select=${this.#onLastHop}
      ></mc-bar-chart>
      ${footer ? html`<p class="note muted" data-field="last-hops-footer">${footer}</p>` : nothing}
    </section>`;
  }

  /** A bar chart of packets per path node (first or last entry), with its footer line. */
  #pathNodes(id: PathNodeSection, title: string, s: SourceStats, active: string | undefined, onSelect: (e: CustomEvent<BarSelectDetail>) => void): TemplateResult {
    const footer = pathNodeFooter(s);
    const open = this.nodeMaps.has(id);
    return html`<section class="card" data-section=${id}>
      <div class="head">
        <h3>${title}</h3>
        ${s.top.length
          ? this.#mapButton(open, `${id}-map`, () => {
              const next = new Set(this.nodeMaps);
              if (open) next.delete(id);
              else {
                next.add(id);
                this.#requestFit(id);
              }
              this.nodeMaps = next;
            })
          : nothing}
      </div>
      ${open && s.top.length ? this.#pathNodesMap(id, title) : nothing}
      <mc-bar-chart class="sources" .items=${sourceItems(s, active)} empty-text="No packets with a path in the shown packets." @bar-select=${onSelect}></mc-bar-chart>
      ${footer ? html`<p class="note muted" data-field=${`${id}-footer`}>${footer}</p>` : nothing}
    </section>`;
  }

  /** The nodes of a first / final path node card on a map, each dot's area ∝ its packet count. */
  #pathNodesMap(id: PathNodeSection, title: string): TemplateResult {
    const p = this.#placed(id);
    const which = id === 'path-starts' ? 'first' : 'final';
    const lost = p.unplaced
      ? ` ${formatNumber(p.unplaced, 0)} ${p.unplaced === 1 ? 'node' : 'nodes'} (${formatNumber(p.unplacedPackets, 0)} ${p.unplacedPackets === 1 ? 'packet' : 'packets'}) ${p.unplaced === 1 ? 'has' : 'have'} no known location.`
      : '';
    const toggle = this.#estimateToggle(p.unplaced > 0 || p.markers.some((m) => m.approximate));
    if (p.markers.length === 0) {
      return html`<p class="note muted" data-field="no-map">None of these nodes can be placed: they have no known location.</p>
        ${toggle}`;
    }
    return html`<mc-tile-map .tileUrl=${this.app.map.tileUrl.value} label=${title} data-field="node-map">
        ${p.markers.map(
          (m) => html`<mc-map-marker
            data-node=${m.id}
            data-count=${m.count}
            kind=${m.kind ?? ''}
            style=${`--marker-size: ${usageMarkerSize(m.count, p.maxCount).toFixed(2)}rem`}
            lat=${m.lat}
            lon=${m.lon}
            label=${m.node.label}
            description=${`${formatNumber(m.count, 0)} packet${m.count === 1 ? '' : 's'}${m.approximate ? ', approximate location' : ''}`}
            ?approximate=${m.approximate}
          ></mc-map-marker>`,
        )}
      </mc-tile-map>
      <p class="note muted" data-field="node-map-note">
        Dot size shows how many packets had each node ${which} in their path (most: ${formatNumber(p.maxCount, 0)}).${lost}
      </p>
      ${toggle}`;
  }

  #onChannel = (e: CustomEvent<BarSelectDetail>): void => {
    this.#toggle('channel', e.detail.key, e.detail.key);
  };

  #onHops = (e: CustomEvent<BarSelectDetail>): void => {
    this.#toggle('hops', e.detail.key, hopLabel(Number(e.detail.key)));
  };

  /** `segment-select` handler for a breakdown of `field`; `label` maps the key to chip text. */
  #onSegment(field: StatsFilterField, label: (key: string) => string = (k) => k) {
    return (e: CustomEvent<SegmentSelectDetail>): void => this.#toggle(field, e.detail.key, label(e.detail.key));
  }

  #compression(c: CompressionStats, active: string | undefined): TemplateResult {
    const label = (k: string): string => COMPRESSION_LABEL[k as TextCompression] ?? k;
    const describe = (l: string): string => (l === COMPRESSION_LABEL.unknown ? NOT_DECRYPTED_HINT : '');
    const onSeg = this.#onSegment('compression', label);
    const row = (id: string, name: string, counts: CompressionCounts): TemplateResult | typeof nothing =>
      counts.text > 0
        ? html`<mc-breakdown
            data-breakdown=${`compression-${id}`}
            label=${name}
            .segments=${compressionSegments(counts, active)}
            .palette=${COMPRESSION_SEGMENT_PALETTE}
            .describe=${describe}
            .format=${(v: number) => formatNumber(v, 0)}
            @segment-select=${onSeg}
          ></mc-breakdown>`
        : nothing;
    return html`<section class="card" data-section="compression">
      <h3>Text compression</h3>
      ${c.text === 0
        ? html`<p class="note muted" data-empty="compression">No text messages in these packets.</p>`
        : html`<p class="note" data-field="compression-summary">${compressionSummary(c)}</p>
            ${c.unknown > 0
              ? html`<p class="note muted" data-field="compression-unknown" title=${NOT_DECRYPTED_HINT}>
                  ${formatNumber(c.unknown, 0)} ${c.unknown === 1 ? 'message' : 'messages'} could not be decrypted (no key), so ${c.unknown === 1 ? 'its' : 'their'} compression is unknown.
                </p>`
              : nothing}
            <div class="breakdowns">
              ${row('all', 'Text messages', c)} ${row('dm', 'DMs', c.byCategory.dm)} ${row('channel', 'Channels', c.byCategory.channel)}
              ${row('out', 'Sent', c.byDirection.out)} ${row('in', 'Received', c.byDirection.in)}
            </div>`}
    </section>`;
  }

  override render(): TemplateResult {
    const stats = this.app.packetStats;
    const points = stats.points.value;
    const filters = stats.filters.value;
    // any criterion of the shared filter other than the date range narrows the points
    const filtered = packetFilterChips(this.app.packetLog.packets.filter.value).length > 0;
    const total = stats.unfilteredCount.value;
    let body: TemplateResult;
    if (points.length > 0) body = this.#content(points, filters);
    else if (filtered && total > 0) body = html`<p class="muted" data-empty="filtered">No packets match these filters.</p>`;
    else body = html`<p class="muted" data-empty>${stats.loading.value ? 'Loading…' : 'No packets logged in this range.'}</p>`;
    return html`<mc-stats-range parts="bin"></mc-stats-range>
      ${filtered
        ? html`<p class="count muted" data-field="filter-count" role="status">Showing ${formatNumber(points.length, 0)} of ${formatNumber(total, 0)} packets</p>`
        : nothing}
      ${body}`;
  }

  #content(points: readonly StatPacket[], filters: readonly StatsFilter[]): TemplateResult {
    const stats = this.app.packetStats;
    const active = (field: StatsFilterField): string | undefined => filters.find((f) => f.field === field)?.value;
    const seg = (field: StatsFilterField) => ({ keyed: true, active: active(field) });
    const dirLabel = (n: string): string => DIRECTION_LABEL[n] ?? n;
    const s = stats.summary.value;
    const radio = stats.radio.value;
    const win = stats.window.value;
    const xDomain = win ? ([win.from, win.to] as const) : undefined;
    const bySource = stats.bySource.value;
    const footer = sourceFooter(bySource);
    const yOpt = Y_OPTIONS.find((o) => o.id === this.yField) ?? Y_OPTIONS[0]!;
    const timeline = stats.timeline.value;
    const rateSeries = timelineSeries(timeline);
    const util = stats.utilization.value;
    const airtimeKnown = s.airtimeMs !== null;
    const fmtShare = airtimeKnown ? formatDuration : formatBytes;
    const typePalette = fixedSlots(TYPE_SLOTS);
    const dots = this.#dotProps(points);

    return html`<div class="tiles" data-tiles>
        <mc-stat-tile data-tile="packets" label="Packets" .value=${s.packets}></mc-stat-tile>
        <mc-stat-tile data-tile="bytes" label="Bytes" .value=${s.bytes}></mc-stat-tile>
        <mc-stat-tile
          data-tile="airtime"
          label="Airtime"
          .value=${s.airtimeFraction === null ? null : formatPercent(s.airtimeFraction, 2)}
          sub=${s.airtimeMs === null ? '' : `${formatDuration(s.airtimeMs)} on air`}
          hint=${radioText(radio)}
        ></mc-stat-tile>
        <mc-stat-tile data-tile="sources" label="Unique sources" .value=${s.sources}></mc-stat-tile>
        <mc-stat-tile data-tile="span" label="Span" .value=${formatDuration(s.spanMs)}></mc-stat-tile>
      </div>

      <section class="card" data-section="rate">
        <h3>Packet rate</h3>
        <div class="controls">
          <span>Packets per ${formatDuration(timeline.binMs)}</span>
        </div>
        <mc-line-chart
          data-chart-id="rate"
          .series=${rateSeries}
          .palette=${timelinePalette(rateSeries)}
          .describe=${timelineDescribe(timeline)}
          .xDomain=${xDomain}
          stacked
          y-label="Packets"
        ></mc-line-chart>
      </section>

      <section class="card" data-section="sources">
        <h3>Packets per source node</h3>
        <mc-bar-chart class="sources" .items=${sourceItems(bySource, active('source'))} @bar-select=${this.#onSource}></mc-bar-chart>
        ${footer ? html`<p class="note muted" data-field="source-footer">${footer}</p>` : nothing}
      </section>

      <section class="card" data-section="channels">
        <h3>Group messages per channel</h3>
        <mc-bar-chart
          .items=${channelMessageItems(stats.channelMessages.value, active('channel'))}
          empty-text="No group messages in the shown packets."
          @bar-select=${this.#onChannel}
        ></mc-bar-chart>
      </section>

      <section class="card" data-section="dots">
        <h3>Packets over time</h3>
        <div class="controls">
          <label
            >Y
            <select data-select="y" @change=${(e: Event) => (this.yField = (e.target as HTMLSelectElement).value as YField)}>
              ${Y_OPTIONS.map((o) => html`<option value=${o.id} ?selected=${o.id === this.yField}>${o.label}</option>`)}
            </select></label
          >
          <label
            >Colour
            <select data-select="color" @change=${(e: Event) => (this.colorField = (e.target as HTMLSelectElement).value as ColorField)}>
              ${COLOR_OPTIONS.map((o) => html`<option value=${o.id} ?selected=${o.id === this.colorField}>${o.label}</option>`)}
            </select></label
          >
          <span>Dot area ∝ bytes</span>
        </div>
        <mc-dot-plot
          .points=${dots.points}
          .xDomain=${xDomain}
          y-label=${yOpt.label}
          .yFormat=${yOpt.format}
          .palette=${dots.palette}
          .describe=${this.colorField === 'type' || this.colorField === 'route' ? packetTypeNameDescription : undefined}
          series-label=${COLOR_OPTIONS.find((o) => o.id === this.colorField)?.label ?? ''}
          missing-label=${yOpt.missing}
          @dot-select=${this.#onDot}
        ></mc-dot-plot>
      </section>

      <section class="card" data-section="utilization">
        <h3>Network utilisation</h3>
        ${airtimeKnown
          ? html`<mc-line-chart
              data-chart-id="utilization"
              .series=${[{ key: 'Airtime', points: util.overTime.map((o) => ({ t: o.t, v: o.fraction })) }]}
              .xDomain=${xDomain}
              y-label="Airtime"
              .yFormat=${percent}
            ></mc-line-chart>`
          : nothing}
        <p class="note muted" data-field="utilization-note">
          ${airtimeKnown ? `Share of estimated airtime. ${radioText(radio)}.` : 'Radio parameters unknown: shares below are by bytes, not airtime.'}
        </p>
        <div class="breakdowns">
          <mc-breakdown
            data-breakdown="type"
            label="Packet type"
            .describe=${packetTypeNameDescription}
            .segments=${breakdownSegments(util.byType, airtimeKnown, undefined, seg('type'))}
            .palette=${typePalette}
            .format=${fmtShare}
            @segment-select=${this.#onSegment('type')}
          ></mc-breakdown>
          <mc-breakdown
            data-breakdown="route"
            label="Route type"
            .describe=${packetTypeNameDescription}
            .segments=${breakdownSegments(util.byRoute, airtimeKnown, undefined, seg('route'))}
            .format=${fmtShare}
            @segment-select=${this.#onSegment('route')}
          ></mc-breakdown>
          <mc-breakdown
            data-breakdown="direction"
            label="Direction"
            .segments=${breakdownSegments(util.byDirection, airtimeKnown, dirLabel, seg('direction'))}
            .format=${fmtShare}
            @segment-select=${this.#onSegment('direction', dirLabel)}
          ></mc-breakdown>
          <mc-breakdown
            data-breakdown="category"
            label="Category"
            .segments=${breakdownSegments(util.byCategory, airtimeKnown, undefined, seg('category'))}
            .format=${fmtShare}
            @segment-select=${this.#onSegment('category')}
          ></mc-breakdown>
          ${util.byChannel.length
            ? html`<mc-breakdown
                data-breakdown="channel"
                label="Channel"
                .segments=${breakdownSegments(util.byChannel, airtimeKnown, undefined, seg('channel'))}
                .format=${fmtShare}
                @segment-select=${this.#onSegment('channel')}
              ></mc-breakdown>`
            : nothing}
        </div>
      </section>

      ${this.#compression(stats.compression.value, active('compression'))}

      <section class="card" data-section="hops">
        <h3>Hop count</h3>
        <mc-bar-chart .items=${hopItems(stats.hops.value, active('hops'))} @bar-select=${this.#onHops}></mc-bar-chart>
      </section>

      ${this.#pathsCard(stats.routes.value)}
      ${this.#pathNodes('path-starts', 'Most common first nodes in path', stats.pathStarts.value, active('pathStart'), this.#onPathStart)}
      ${this.#pathNodes('path-ends', 'Most common final nodes in path', stats.pathEnds.value, active('pathEnd'), this.#onPathEnd)}
      ${this.#lastHops(stats.lastHops.value, active('lastHop'))}`;
  }
}

customElements.define('mc-packet-stats', McPacketStats);

declare global {
  interface HTMLElementTagNameMap {
    'mc-packet-stats': McPacketStats;
  }
}
