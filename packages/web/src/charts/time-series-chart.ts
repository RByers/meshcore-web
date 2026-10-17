/**
 * `<mc-time-series-chart>`: measured values over time — one line per series through its own
 * points (no shared bins, no zero fill), every point marked, the y range fitted to the data (it
 * need not include 0, e.g. a battery at 3.7–4.2 V). A point may be `hollow` (a second kind of
 * sample in the same series); `markerLegend` names the two kinds. Each point has a native
 * `<title>` tooltip with its value and time. ≥ 2 series get a legend.
 *
 * Several charts stacked on one time axis: pass them the same `xDomain`.
 *
 * Test hooks: `[data-chart="time-series"]`, `[data-mark="line"][data-series]`,
 * `[data-mark="point"][data-series]` (`data-hollow` on hollow ones), `[data-legend-key]`.
 */
import { css, html, nothing, svg, type SVGTemplateResult, type TemplateResult } from 'lit';
import { scaleLinear, scaleTime } from 'd3-scale';
import { line } from 'd3-shape';
import { extent } from 'd3-array';
import { ChartBase, chartStyles, formatDateTime, formatNumber, legend, tickCount, xTimeAxis, yAxis } from './chart-base.js';
import { assignSlots, colorOf, legendFor, type SeriesPalette } from './palette.js';

export interface SeriesPoint {
  /** Epoch ms. */
  t: number;
  v: number;
  /** Drawn as an outline instead of a filled dot. */
  hollow?: boolean;
}

export interface TimeSeries {
  key: string;
  /** Legend / tooltip label; default `key`. */
  label?: string;
  /** Any order (sorted by time for drawing). */
  points: readonly SeriesPoint[];
}

const MARGIN = { top: 20, right: 24, bottom: 24, left: 48 };
const HOUR = 3_600_000;

const DAY_TICK = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const TIME_TICK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** Midnight ticks show the date, others the time of day (ticks may be hours apart on a multi-day axis). */
function timeTick(d: Date): string {
  return d.getHours() === 0 && d.getMinutes() === 0 ? DAY_TICK.format(d) : TIME_TICK.format(d);
}

/** [min, max] of `values`, widened so a flat series still gets a visible range. */
function valueDomain(values: readonly number[]): [number, number] {
  const [lo = 0, hi = 1] = extent(values);
  if (hi > lo) return [lo, hi];
  const pad = Math.max(Math.abs(lo) * 0.02, 0.1);
  return [lo - pad, hi + pad];
}

export class McTimeSeriesChart extends ChartBase {
  static override properties = {
    series: { attribute: false },
    xDomain: { attribute: false },
    yLabel: { type: String, attribute: 'y-label' },
    yFormat: { attribute: false },
    markerLegend: { attribute: false },
    palette: { attribute: false },
    height: { type: Number },
  };

  static override styles = [
    chartStyles,
    css`
      .line {
        fill: none;
        stroke-width: 1.5;
        stroke-linejoin: round;
        stroke-linecap: round;
      }
      .point {
        stroke-width: 1.5;
      }
      .point:hover {
        stroke-width: 3;
      }
      .marker-legend {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .marker-legend svg {
        overflow: visible;
      }
    `,
  ];

  declare series: readonly TimeSeries[];
  declare xDomain: readonly [number, number] | undefined;
  declare yLabel: string;
  /** Formats y ticks and tooltip values (default: locale number). */
  declare yFormat: ((v: number) => string) | undefined;
  /** Legend labels for filled vs hollow points; shown when both kinds are present. */
  declare markerLegend: { filled: string; hollow: string } | undefined;
  /** Series key → colour + legend; default: slots in series order. */
  declare palette: SeriesPalette | undefined;
  declare height: number;

  constructor() {
    super();
    this.series = [];
    this.xDomain = undefined;
    this.yLabel = '';
    this.yFormat = undefined;
    this.markerLegend = undefined;
    this.palette = undefined;
    this.height = 140;
  }

  #fmt(v: number): string {
    return this.yFormat ? this.yFormat(v) : formatNumber(v, 2);
  }

  override render(): TemplateResult {
    const series = this.series.filter((s) => s.points.length > 0);
    if (series.length === 0) return html`<p class="empty" data-chart="time-series" data-empty>No data</p>`;
    const palette = this.palette ?? assignSlots(series.map((s) => s.key), new Map(series.map((s) => [s.key, s.label ?? s.key])));
    const sorted = series.map((s) => ({ ...s, points: [...s.points].sort((a, b) => a.t - b.t) }));
    const all = sorted.flatMap((s) => s.points);

    const w = Math.max(this.width, MARGIN.left + MARGIN.right + 10);
    const h = this.height;
    const x0 = MARGIN.left;
    const x1 = w - MARGIN.right;
    const y0 = h - MARGIN.bottom;
    const y1 = MARGIN.top;

    let [dx0, dx1] = this.xDomain ?? (extent(all, (p) => p.t) as [number, number]);
    if (dx0 === dx1) [dx0, dx1] = [dx0 - HOUR / 2, dx1 + HOUR / 2];
    const x = scaleTime().domain([dx0, dx1]).range([x0, x1]);
    const y = scaleLinear()
      .domain(valueDomain(all.map((p) => p.v)))
      .nice()
      .range([y0, y1]);
    const r = all.length > 120 ? 2 : 3;

    const marks: SVGTemplateResult[] = sorted.map((s) => {
      const color = colorOf(palette, s.key);
      const label = s.label ?? s.key;
      const d = line<SeriesPoint>()
        .x((p) => x(p.t))
        .y((p) => y(p.v))(s.points);
      return svg`<g data-series-group=${s.key}>
        ${s.points.length > 1 ? svg`<path class="line" data-mark="line" data-series=${s.key} d=${d ?? ''} stroke=${color}></path>` : nothing}
        ${s.points.map(
          (p) => svg`<circle
            class="point"
            data-mark="point"
            data-series=${s.key}
            ?data-hollow=${p.hollow}
            cx=${x(p.t)}
            cy=${y(p.v)}
            r=${r}
            fill=${p.hollow ? 'var(--chart-surface)' : color}
            stroke=${color}
          ><title>${label}: ${this.#fmt(p.v)}${p.hollow && this.markerLegend ? ` (${this.markerLegend.hollow})` : ''} · ${formatDateTime(p.t)}</title></circle>`,
        )}
      </g>`;
    });

    const shown = legendFor(palette, new Set(sorted.map((s) => s.key)));
    const ml = this.markerLegend;
    const bothKinds = ml && all.some((p) => p.hollow) && all.some((p) => !p.hollow);
    const dot = (hollow: boolean): TemplateResult =>
      html`<svg width="8" height="8" aria-hidden="true"
        ><circle cx="4" cy="4" r="3" fill=${hollow ? 'var(--chart-surface)' : 'var(--chart-muted)'} stroke="var(--chart-muted)" stroke-width="1.5"></circle
      ></svg>`;
    return html`<div data-chart="time-series">
      <div class="plot" data-measure>
        <svg width=${Math.max(this.width, 0)} height=${h} role="img" aria-label=${this.yLabel ? `${this.yLabel} over time` : 'Time series chart'}>
          ${this.width > 0
            ? svg`${yAxis(y, x0, x1, tickCount(y0 - y1, 30), (v) => this.#fmt(v))}
                ${xTimeAxis(x, y0, tickCount(x1 - x0, 90), timeTick)}`
            : nothing}
          ${this.yLabel ? svg`<text class="axis-label" x=${x0 - 6} y=${y1 - 8} data-field="y-label">${this.yLabel}</text>` : nothing}
          ${this.width > 0 ? marks : nothing}
        </svg>
      </div>
      ${shown.length >= 2 || bothKinds
        ? html`<div class="legends">
            ${shown.length >= 2 ? legend(shown, 'line') : nothing}
            ${bothKinds
              ? html`<ul class="legend" data-marker-legend>
                  <li class="marker-legend">${dot(false)}<span>${ml.filled}</span></li>
                  <li class="marker-legend">${dot(true)}<span>${ml.hollow}</span></li>
                </ul>`
              : nothing}
          </div>`
        : nothing}
    </div>`;
  }
}

customElements.define('mc-time-series-chart', McTimeSeriesChart);

declare global {
  interface HTMLElementTagNameMap {
    'mc-time-series-chart': McTimeSeriesChart;
  }
}
