/**
 * `<mc-line-chart>`: one 2 px line per series over time (epoch-ms `t`), or stacked bands when
 * `stacked`. A crosshair snaps to the nearest bin and the tooltip lists every series there.
 * A single series gets a faint area wash; ≥ 2 series get a legend. y starts at 0.
 */
import { css, html, nothing, svg, type SVGTemplateResult, type TemplateResult } from 'lit';
import { scaleLinear, scaleTime } from 'd3-scale';
import { area, curveMonotoneX, line } from 'd3-shape';
import { bisectCenter, extent, max, min } from 'd3-array';
import { ChartBase, chartStyles, formatDateTime, formatNumber, legend, tickCount, tipKey, xTimeAxis, yAxis } from './chart-base.js';
import { assignSlots, colorOf, legendFor, type SeriesPalette } from './palette.js';

export interface LinePoint {
  /** Epoch ms (bin start). */
  t: number;
  v: number;
}

export interface LineSeries {
  key: string;
  /** Legend / tooltip label; default `key`. */
  label?: string;
  points: readonly LinePoint[];
}

const MARGIN = { top: 20, right: 12, bottom: 24, left: 48 };
const HOUR = 3_600_000;

interface Row {
  key: string;
  label: string;
  color: string;
  /** Value per shared t (0 when the series has no point there). */
  v: Float64Array;
  /** Stack base / top per t (non-stacked: 0 / v). */
  lo: Float64Array;
  hi: Float64Array;
}

export class McLineChart extends ChartBase {
  static override properties = {
    series: { attribute: false },
    xDomain: { attribute: false },
    stacked: { type: Boolean },
    yLabel: { type: String, attribute: 'y-label' },
    yFormat: { attribute: false },
    palette: { attribute: false },
    height: { type: Number },
    hover: { state: true },
  };

  static override styles = [
    chartStyles,
    css`
      .line {
        fill: none;
        stroke-width: 2;
        stroke-linejoin: round;
        stroke-linecap: round;
      }
      .band {
        fill-opacity: 0.3;
      }
      .wash {
        fill-opacity: 0.1;
      }
      .crosshair {
        stroke: var(--chart-muted);
        stroke-width: 1;
      }
      .marker {
        stroke: var(--chart-surface);
        stroke-width: 2;
      }
    `,
  ];

  declare series: readonly LineSeries[];
  declare xDomain: readonly [number, number] | undefined;
  declare stacked: boolean;
  declare yLabel: string;
  declare yFormat: ((v: number) => string) | undefined;
  /** Series key → colour + legend; default: slots in series order. */
  declare palette: SeriesPalette | undefined;
  declare height: number;
  /** Index into the shared t list under the crosshair. */
  declare hover: number | null;

  constructor() {
    super();
    this.series = [];
    this.xDomain = undefined;
    this.stacked = false;
    this.yLabel = '';
    this.yFormat = undefined;
    this.palette = undefined;
    this.height = 220;
    this.hover = null;
  }

  #fmtY(v: number): string {
    return this.yFormat ? this.yFormat(v) : formatNumber(v);
  }

  #ts: number[] = [];
  #x: ((t: number) => number) | undefined;

  #onMove = (ev: PointerEvent): void => {
    const x = this.#x;
    if (!x || this.#ts.length === 0) return;
    const p = this.pointerIn(ev, ev.currentTarget as Element);
    const xs = this.#ts.map(x);
    const i = bisectCenter(xs, p.x);
    if (i !== this.hover) this.hover = i;
  };

  #onLeave = (): void => {
    this.hover = null;
  };

  override render(): TemplateResult {
    const series = this.series;
    if (series.length === 0 || series.every((s) => s.points.length === 0)) {
      this.#ts = [];
      return html`<p class="empty" data-chart="line" data-empty>No data</p>`;
    }
    const palette = this.palette ?? assignSlots(series.map((s) => s.key), new Map(series.map((s) => [s.key, s.label ?? s.key])));
    const ts = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
    this.#ts = ts;
    const index = new Map(ts.map((t, i) => [t, i]));
    const rows: Row[] = [];
    const base = new Float64Array(ts.length);
    for (const s of series) {
      const v = new Float64Array(ts.length);
      for (const p of s.points) {
        const i = index.get(p.t);
        if (i !== undefined) v[i] = (v[i] ?? 0) + p.v;
      }
      const lo = new Float64Array(ts.length);
      const hi = new Float64Array(ts.length);
      for (let i = 0; i < ts.length; i++) {
        lo[i] = this.stacked ? base[i]! : 0;
        hi[i] = lo[i]! + v[i]!;
        if (this.stacked) base[i] = hi[i]!;
      }
      rows.push({ key: s.key, label: s.label ?? s.key, color: colorOf(palette, s.key), v, lo, hi });
    }

    const w = Math.max(this.width, MARGIN.left + MARGIN.right + 10);
    const h = this.height;
    const x0 = MARGIN.left;
    const x1 = w - MARGIN.right;
    const y0 = h - MARGIN.bottom;
    const y1 = MARGIN.top;

    let [dx0, dx1] = this.xDomain ?? extent(ts);
    if (dx0 === undefined || dx1 === undefined) [dx0, dx1] = [Date.now() - HOUR, Date.now()];
    // bins start on round boundaries, so a given domain is widened to keep every point on the plot
    const [t0, t1] = extent(ts);
    if (t0 !== undefined && t1 !== undefined) [dx0, dx1] = [Math.min(dx0, t0), Math.max(dx1, t1)];
    if (dx0 === dx1) [dx0, dx1] = [dx0 - HOUR / 2, dx1 + HOUR / 2];
    const x = scaleTime().domain([dx0, dx1]).range([x0, x1]);
    const xt = (t: number): number => x(t);
    this.#x = xt;
    const yMax = max(rows, (r) => max(r.hi)) ?? 1;
    const yMin = Math.min(0, min(rows, (r) => min(r.lo)) ?? 0);
    const y = scaleLinear()
      .domain([yMin, yMax > yMin ? yMax : yMin + 1])
      .nice()
      .range([y0, y1]);

    const idx = ts.map((_, i) => i);
    const marks: SVGTemplateResult[] = rows.map((r) => {
      const top = line<number>()
        .x((i) => xt(ts[i]!))
        .y((i) => y(r.hi[i]!))
        .curve(curveMonotoneX)(idx);
      const band =
        this.stacked || rows.length === 1
          ? area<number>()
              .x((i) => xt(ts[i]!))
              .y0((i) => y(r.lo[i]!))
              .y1((i) => y(r.hi[i]!))
              .curve(curveMonotoneX)(idx)
          : null;
      return svg`
        ${band ? svg`<path class=${this.stacked ? 'band' : 'wash'} d=${band} fill=${r.color}></path>` : nothing}
        <path class="line" data-mark="line" data-series=${r.key} d=${top ?? ''} stroke=${r.color}></path>
        ${ts.length === 1 ? svg`<circle class="marker" data-mark="point" cx=${xt(ts[0]!)} cy=${y(r.hi[0]!)} r="4" fill=${r.color}></circle>` : nothing}`;
    });

    const hi = this.hover;
    const ht = hi === null ? undefined : ts[hi];
    let cross: SVGTemplateResult | typeof nothing = nothing;
    let tip: TemplateResult | typeof nothing = nothing;
    if (hi !== null && ht !== undefined) {
      const cx = xt(ht);
      cross = svg`<line class="crosshair" x1=${cx} x2=${cx} y1=${y1} y2=${y0}></line>
        ${rows.map((r) => svg`<circle class="marker" cx=${cx} cy=${y(r.hi[hi]!)} r="4" fill=${r.color}></circle>`)}`;
      const listed = this.stacked ? [...rows].reverse() : rows;
      const total = this.stacked && rows.length > 1 ? rows.reduce((a, r) => a + r.v[hi]!, 0) : null;
      tip = this.renderTip({
        x: cx,
        y: (y0 + y1) / 2,
        content: html`<div class="head">${formatDateTime(ht)}</div>
          ${listed.map((r) => html`<div class="row">${tipKey(r.color)}<strong>${this.#fmtY(r.v[hi]!)}</strong> ${r.label}</div>`)}
          ${total !== null ? html`<div class="row"><strong>${this.#fmtY(total)}</strong> total</div>` : nothing}`,
      });
    }

    const shown = legendFor(palette, new Set(rows.map((r) => r.key)));
    return html`<div data-chart="line">
      <div class="plot" data-measure>
        <svg
          width=${Math.max(this.width, 0)}
          height=${h}
          role="img"
          aria-label=${this.yLabel ? `${this.yLabel} over time` : 'Line chart'}
          @pointermove=${this.#onMove}
          @pointerleave=${this.#onLeave}
        >
          ${this.width > 0
            ? svg`${yAxis(y, x0, x1, tickCount(y0 - y1, 40), (v) => this.#fmtY(v))}
                ${xTimeAxis(x, y0, tickCount(x1 - x0, 110))}`
            : nothing}
          ${this.yLabel ? svg`<text class="axis-label" x=${x0 - 6} y=${y1 - 8} data-field="y-label">${this.yLabel}</text>` : nothing}
          ${marks} ${cross}
          <rect class="hit" x=${x0} y=${y1} width=${Math.max(0, x1 - x0)} height=${Math.max(0, y0 - y1)}></rect>
        </svg>
        ${tip}
      </div>
      ${rows.length >= 2 ? legend(shown, this.stacked ? 'rect' : 'line') : nothing}
    </div>`;
  }
}

customElements.define('mc-line-chart', McLineChart);

declare global {
  interface HTMLElementTagNameMap {
    'mc-line-chart': McLineChart;
  }
}
