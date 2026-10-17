/**
 * `<mc-packet-stats>`: the Stats tab of `/packets` (docs/packet-stats.md §3). Renders the core
 * `PacketStatsModel` (`app.packetStats`) as tiles and charts: packets per source node, packets
 * over time (dot plot with y / colour selectors), packet rate, network utilisation and the hop
 * count distribution. The date range and bin size live in the model (`<mc-stats-range>`); only
 * the chart selectors are local state. Everything here maps model output to chart props.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { formatDistance, nodeId, type Breakdown, type HopCount, type LoraParams, type NodeRef, type SourceStats, type StatPacket, type Timeline } from '@meshcore-web/core/app';
import { packetTypeNameDescription } from '@meshcore-web/core/packet';
import { AppElement } from '../../app-context.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { formatDuration } from '../../format.js';
import {
  assignSlots,
  fixedSlots,
  formatNumber,
  formatPercent,
  keysByCount,
  MAX_SERIES,
  OTHER_KEY,
  type BarItem,
  type BreakdownSegment,
  type DotPoint,
  type DotSelectDetail,
  type LineSeries,
  type SeriesPalette,
} from '../../charts/index.js';
import '../../components/stats-range.js';

// ------------------------------------------------------------------------------ selectors

export type YField = 'snr' | 'rssi' | 'distance' | 'hops' | 'size';
export type ColorField = 'type' | 'route' | 'lastHop' | 'source' | 'channel' | 'direction';

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
];

/** Payload type → fixed palette slot (docs/packet-stats.md §3); other types are "Other". */
export const TYPE_SLOTS: Readonly<Record<string, number>> = { TXT_MSG: 1, GRP_TXT: 2, ADVERT: 3, ACK: 4, PATH: 5, TRACE: 6, REQ: 7, RESPONSE: 7, CONTROL: 8 };

const DIRECTION_LABEL: Readonly<Record<string, string>> = { in: 'Received', out: 'Sent' };

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
  }
}

function nodeKey(n: NodeRef | null): { key: string | null; label: string } {
  return n ? { key: nodeId(n), label: n.label } : { key: null, label: '' };
}

/** Palette for a colouring: fixed slots for payload types, else the top 8 keys by count. */
export function dotPalette(points: readonly StatPacket[], by: ColorField): SeriesPalette {
  if (by === 'type') return fixedSlots(TYPE_SLOTS);
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

/** Source bar items: a contact link only for nodes resolved to a contact (not this radio). */
export function sourceItems(s: SourceStats): BarItem[] {
  return s.top.map(({ node, count, bytes }) => ({
    label: node.label,
    value: count,
    ...(node.resolved && node.key && !node.self ? { href: hrefFor(`/contact/${node.key}`) } : {}),
    title: `${formatNumber(bytes, 0)} B${node.resolved ? '' : ' (not uniquely resolved)'}`,
  }));
}

/** "n packets could not be attributed, m more nodes" (empty when both are 0). */
export function sourceFooter(s: SourceStats): string {
  const parts: string[] = [];
  if (s.unattributed > 0) parts.push(`${s.unattributed} ${s.unattributed === 1 ? 'packet' : 'packets'} could not be attributed`);
  if (s.others > 0) parts.push(`${s.others} more ${s.others === 1 ? 'node' : 'nodes'} (${s.othersPackets} packets)`);
  return parts.join(', ');
}

/**
 * Line chart series from the model timeline (series order as given, biggest first): the first
 * {@link MAX_SERIES} get their own line, the rest are summed into "Other".
 */
export function timelineSeries(t: Timeline): LineSeries[] {
  const own = t.series.filter((k) => k !== OTHER_KEY).slice(0, MAX_SERIES);
  const folded = t.series.filter((k) => !own.includes(k));
  const out: LineSeries[] = own.map((key) => ({ key, label: key, points: t.bins.map((b) => ({ t: b.t, v: b.series[key] ?? 0 })) }));
  if (folded.length > 0) {
    out.push({ key: OTHER_KEY, label: OTHER_KEY, points: t.bins.map((b) => ({ t: b.t, v: folded.reduce((n, k) => n + (b.series[k] ?? 0), 0) })) });
  }
  return out;
}

/** Palette for {@link timelineSeries}. */
export function timelinePalette(series: readonly LineSeries[]): SeriesPalette {
  return assignSlots(series.map((s) => s.key));
}

/** Breakdown segments: airtime share, or bytes when airtime is unknown. */
export function breakdownSegments(rows: readonly Breakdown[], airtime: boolean, label: (name: string) => string = (n) => n): BreakdownSegment[] {
  return rows.map((r) => ({
    label: label(r.name),
    value: airtime ? r.airtimeMs : r.bytes,
    title: `${formatNumber(r.count, 0)} ${r.count === 1 ? 'packet' : 'packets'}, ${formatBytes(r.bytes)}`,
  }));
}

export function hopItems(hops: readonly HopCount[]): BarItem[] {
  return hops.map((h) => ({ label: h.hops === 0 ? '0 (direct)' : String(h.hops), value: h.count }));
}

export function formatBytes(b: number): string {
  return `${formatNumber(b)} B`;
}

export function radioText(r: LoraParams | null): string {
  return r ? `Estimated at SF${r.sf}, ${r.bwKhz} kHz, CR 4/${r.cr}` : 'Radio parameters unknown';
}

const percent = (v: number): string => formatPercent(v);

// ------------------------------------------------------------------------------ element

export class McPacketStats extends AppElement {
  static override properties = {
    yField: { state: true },
    colorField: { state: true },
    stacked: { state: true },
  };
  declare yField: YField;
  declare colorField: ColorField;
  declare stacked: boolean;

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
      .breakdowns {
        display: grid;
        gap: 12px;
        margin-block-start: 12px;
      }
      mc-bar-chart.sources {
        --mc-bar-label-width: 40%;
      }
    `,
  ];

  constructor() {
    super();
    this.yField = 'snr';
    this.colorField = 'type';
    this.stacked = false;
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

  override render(): TemplateResult {
    const stats = this.app.packetStats;
    const points = stats.points.value;
    return html`<mc-stats-range></mc-stats-range>
      ${points.length === 0
        ? html`<p class="muted" data-empty>${stats.loading.value ? 'Loading…' : 'No packets logged in this range.'}</p>`
        : this.#content(points)}`;
  }

  #content(points: readonly StatPacket[]): TemplateResult {
    const stats = this.app.packetStats;
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

      <section class="card" data-section="sources">
        <h3>Packets per source node</h3>
        <mc-bar-chart class="sources" .items=${sourceItems(bySource)}></mc-bar-chart>
        ${footer ? html`<p class="note muted" data-field="source-footer">${footer}</p>` : nothing}
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

      <section class="card" data-section="rate">
        <h3>Packet rate</h3>
        <div class="controls">
          <label
            ><input type="checkbox" data-action="stacked" .checked=${this.stacked} @change=${(e: Event) => (this.stacked = (e.target as HTMLInputElement).checked)} />
            Stacked</label
          >
          <span>Packets per ${formatDuration(timeline.binMs)}</span>
        </div>
        <mc-line-chart
          data-chart-id="rate"
          .series=${rateSeries}
          .palette=${timelinePalette(rateSeries)}
          .xDomain=${xDomain}
          ?stacked=${this.stacked}
          y-label="Packets"
        ></mc-line-chart>
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
          <mc-breakdown label="Packet type" .describe=${packetTypeNameDescription} .segments=${breakdownSegments(util.byType, airtimeKnown)} .palette=${typePalette} .format=${fmtShare}></mc-breakdown>
          <mc-breakdown label="Route type" .describe=${packetTypeNameDescription} .segments=${breakdownSegments(util.byRoute, airtimeKnown)} .format=${fmtShare}></mc-breakdown>
          <mc-breakdown
            label="Direction"
            .segments=${breakdownSegments(util.byDirection, airtimeKnown, (n) => DIRECTION_LABEL[n] ?? n)}
            .format=${fmtShare}
          ></mc-breakdown>
          <mc-breakdown label="Category" .segments=${breakdownSegments(util.byCategory, airtimeKnown)} .format=${fmtShare}></mc-breakdown>
          ${util.byChannel.length
            ? html`<mc-breakdown label="Channel" .segments=${breakdownSegments(util.byChannel, airtimeKnown)} .format=${fmtShare}></mc-breakdown>`
            : nothing}
        </div>
      </section>

      <section class="card" data-section="hops">
        <h3>Hop count</h3>
        <mc-bar-chart .items=${hopItems(stats.hops.value)}></mc-bar-chart>
      </section>`;
  }
}

customElements.define('mc-packet-stats', McPacketStats);

declare global {
  interface HTMLElementTagNameMap {
    'mc-packet-stats': McPacketStats;
  }
}
