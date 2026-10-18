/**
 * `<mc-dot-plot>`: a time × value scatter. x is time (epoch ms; ticks show time of day under a
 * 2-day span, else dates), y is linear with a label and an optional formatter. Dot area ∝ `size`
 * (radius 2–9 px), colour from the series key via a {@link SeriesPalette}. Points with `y: null`
 * are dropped and counted ("n packets without SNR").
 *
 * Built for ~10k points: one `<circle>` each, rendered under `guard` so hover does not re-render
 * them, and no per-dot listeners — the SVG finds the nearest dot within a ≥ 12 px hit radius.
 * Clicking a dot dispatches `dot-select` (`detail: { id }`, bubbles, composed).
 *
 * `refLines` draws horizontal dashed reference lines (e.g. the SNR decode limit) under the dots,
 * labelled at the right end and always inside the y domain.
 */
import { css, html, nothing, svg, type SVGTemplateResult, type TemplateResult } from 'lit';
import { guard } from 'lit/directives/guard.js';
import { scaleLinear, scaleSqrt, scaleTime, type ScaleLinear } from 'd3-scale';
import { extent, max } from 'd3-array';
import { ChartBase, chartStyles, formatDateTime, formatNumber, legend, type Describe, MIN_HIT, tickCount, xTimeAxis, yAxis } from './chart-base.js';
import { assignSlots, colorOf, keysByCount, legendFor, type SeriesPalette } from './palette.js';

export interface DotPoint {
  /** Epoch ms. */
  x: number;
  /** null → not plotted, counted in the "without" note. */
  y: number | null;
  /** Drives dot area (e.g. bytes). */
  size: number;
  /** Series key (looked up in `palette`). */
  color: string;
  /** Tooltip name of the series; default the key. */
  label?: string;
  id: number | string;
  /** Extra tooltip line. */
  title?: string;
}

/**
 * A horizontal reference line at a constant y. A time-varying line (e.g. noise-floor samples) would
 * be a second member of this union, `{ kind: 'series'; points: readonly { t: number; v: number }[]; … }`,
 * drawn as a step path by {@link refLineMarks} and widening the y domain by its extent.
 */
export interface RefLine {
  /** y value, in the plot's units. */
  value: number;
  /** Text at the right end of the line (e.g. "SF10 decode limit −15 dB"); also in the aria-label. */
  label: string;
  /** Stable id for `data-ref-line`; default the label. */
  key?: string;
}

export interface DotSelectDetail {
  id: number | string;
}

const MARGIN = { top: 20, right: 12, bottom: 24, left: 48 };
const R_MIN = 2;
const R_MAX = 9;
const HOUR = 3_600_000;

interface Layout {
  key: unknown[];
  /** Plotted points (non-null y) and their geometry, index-aligned. */
  pts: DotPoint[];
  cx: Float64Array;
  cy: Float64Array;
  r: Float64Array;
  dots: SVGTemplateResult;
  axes: SVGTemplateResult;
  refs: SVGTemplateResult;
  palette: SeriesPalette;
  nulls: number;
}

export class McDotPlot extends ChartBase {
  static override properties = {
    points: { attribute: false },
    xDomain: { attribute: false },
    yLabel: { type: String, attribute: 'y-label' },
    yFormat: { attribute: false },
    palette: { attribute: false },
    seriesLabel: { type: String, attribute: 'series-label' },
    describe: { attribute: false },
    noun: { type: String },
    missingLabel: { type: String, attribute: 'missing-label' },
    refLines: { attribute: false },
    height: { type: Number },
    hover: { state: true },
  };

  static override styles = [
    chartStyles,
    css`
      circle.dot {
        fill-opacity: 0.8;
      }
      svg {
        cursor: default;
      }
      svg.over {
        cursor: pointer;
      }
      .ref line {
        stroke: var(--mc-warn, GrayText);
        stroke-width: 1.5;
        stroke-dasharray: 5 4;
      }
      .ref text {
        fill: var(--chart-muted);
        paint-order: stroke;
        stroke: var(--chart-surface);
        stroke-width: 3px;
        stroke-linejoin: round;
      }
    `,
  ];

  declare points: readonly DotPoint[];
  /** [from, to] epoch ms; default: the extent of the points. */
  declare xDomain: readonly [number, number] | undefined;
  declare yLabel: string;
  declare yFormat: ((v: number) => string) | undefined;
  /** Series key → colour + legend; default: slots by point count (top 8, rest "Other"). */
  declare palette: SeriesPalette | undefined;
  /** Name of what the colour encodes, for the tooltip (e.g. "Packet type"). */
  declare seriesLabel: string;
  /** Hover text for a legend entry's series key (e.g. what a packet type means). */
  declare describe: Describe | undefined;
  /** Singular noun for the dropped-points note (plural adds "s"). */
  declare noun: string;
  /** Text after "without" in the note; default `yLabel`. */
  declare missingLabel: string | undefined;
  /** Horizontal reference lines; default none. */
  declare refLines: readonly RefLine[];
  declare height: number;
  declare hover: number | null;

  #layout: Layout | undefined;

  constructor() {
    super();
    this.points = [];
    this.xDomain = undefined;
    this.yLabel = '';
    this.yFormat = undefined;
    this.palette = undefined;
    this.seriesLabel = '';
    this.noun = 'packet';
    this.missingLabel = undefined;
    this.refLines = [];
    this.height = 280;
    this.hover = null;
  }

  #fmtY(v: number): string {
    return this.yFormat ? this.yFormat(v) : formatNumber(v);
  }

  #computeLayout(): Layout {
    const key = [this.points, this.xDomain, this.palette, this.width, this.height, this.yFormat, this.yLabel, this.refLines];
    const prev = this.#layout;
    if (prev && key.every((k, i) => k === prev.key[i])) return prev;

    const all = this.points;
    const pts = all.filter((p): p is DotPoint & { y: number } => p.y !== null && Number.isFinite(p.y));
    const palette = this.palette ?? assignSlots(keysByCount(pts.map((p) => p.color)));
    const w = Math.max(this.width, MARGIN.left + MARGIN.right + 10);
    const h = this.height;
    const x0 = MARGIN.left;
    const x1 = w - MARGIN.right;
    const y0 = h - MARGIN.bottom;
    const y1 = MARGIN.top;

    let [dx0, dx1] = this.xDomain ?? extent(pts, (p) => p.x);
    if (dx0 === undefined || dx1 === undefined) [dx0, dx1] = [Date.now() - HOUR, Date.now()];
    if (dx0 === dx1) [dx0, dx1] = [dx0 - HOUR / 2, dx1 + HOUR / 2];
    const x = scaleTime().domain([dx0, dx1]).range([x0, x1]);

    const refs = this.refLines.filter((l) => Number.isFinite(l.value));
    let [dy0, dy1] = extent([...pts.map((p) => p.y), ...refs.map((l) => l.value)]);
    if (dy0 === undefined || dy1 === undefined) [dy0, dy1] = [0, 1];
    if (dy0 === dy1) [dy0, dy1] = [dy0 - 1, dy1 + 1];
    const y = scaleLinear().domain([dy0, dy1]).nice().range([y0, y1]);

    const r = scaleSqrt()
      .domain([0, Math.max(max(pts, (p) => p.size) ?? 1, 1)])
      .range([R_MIN, R_MAX])
      .clamp(true);

    const n = pts.length;
    const cx = new Float64Array(n);
    const cy = new Float64Array(n);
    const rr = new Float64Array(n);
    const circles: SVGTemplateResult[] = new Array<SVGTemplateResult>(n);
    for (let i = 0; i < n; i++) {
      const p = pts[i]!;
      cx[i] = x(p.x);
      cy[i] = y(p.y);
      rr[i] = Math.max(R_MIN, Math.min(R_MAX, r(Math.max(0, p.size))));
      circles[i] = svg`<circle class="dot" data-mark="dot" cx=${cx[i]!.toFixed(1)} cy=${cy[i]!.toFixed(1)} r=${rr[i]!.toFixed(1)} fill=${colorOf(palette, p.color)}></circle>`;
    }
    const axes = svg`
      ${yAxis(y, x0, x1, tickCount(y0 - y1, 40), (v) => this.#fmtY(v))}
      ${xTimeAxis(x, y0, tickCount(x1 - x0, 110))}
      <text class="axis-label" x=${x0 - 6} y=${MARGIN.top - 8} text-anchor="start" data-field="y-label">${this.yLabel}</text>`;
    const refMarks = refLineMarks(refs, y, x0, x1);
    const layout: Layout = {
      key,
      pts,
      cx,
      cy,
      r: rr,
      dots: svg`${circles}`,
      axes,
      refs: refMarks,
      palette,
      nulls: all.length - n,
    };
    this.#layout = layout;
    return layout;
  }

  /** Index of the nearest plotted dot whose hit radius (≥ MIN_HIT / 2) contains (px, py). */
  #nearest(px: number, py: number): number | null {
    const l = this.#layout;
    if (!l) return null;
    let best: number | null = null;
    let bestD = Infinity;
    for (let i = 0; i < l.pts.length; i++) {
      const dx = l.cx[i]! - px;
      const dy = l.cy[i]! - py;
      const d = dx * dx + dy * dy;
      const hit = Math.max(l.r[i]! + 2, MIN_HIT / 2);
      if (d <= hit * hit && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  #onMove = (ev: PointerEvent): void => {
    const svgEl = ev.currentTarget as SVGSVGElement;
    const p = this.pointerIn(ev, svgEl);
    const i = this.#nearest(p.x, p.y);
    const l = this.#layout;
    const pt = i === null ? undefined : l?.pts[i];
    if (i === null || !pt || !l) {
      svgEl.classList.remove('over');
      this.hover = null;
      this.hideTip();
      return;
    }
    svgEl.classList.add('over');
    this.hover = i;
    const color = colorOf(l.palette, pt.color);
    this.showTip(
      l.cx[i]!,
      l.cy[i]!,
      html`<div><strong>${pt.y === null ? '—' : this.#fmtY(pt.y)}</strong> ${this.yLabel}</div>
        <div class="row"><span class="key dot" style="--c:${color}"></span>${this.seriesLabel ? `${this.seriesLabel}: ` : ''}${pt.label ?? pt.color}</div>
        <div>${formatDateTime(pt.x)}</div>
        ${pt.title ? html`<div>${pt.title}</div>` : nothing}`,
    );
  };

  #onLeave = (ev: PointerEvent): void => {
    (ev.currentTarget as Element).classList.remove('over');
    this.hover = null;
    this.hideTip();
  };

  #onClick = (ev: MouseEvent): void => {
    const p = this.pointerIn(ev, ev.currentTarget as Element);
    const i = this.#nearest(p.x, p.y);
    const pt = i === null ? undefined : this.#layout?.pts[i];
    if (!pt) return;
    this.dispatchEvent(
      new CustomEvent<DotSelectDetail>('dot-select', { detail: { id: pt.id }, bubbles: true, composed: true }),
    );
  };

  override render(): TemplateResult {
    const l = this.#computeLayout();
    const w = Math.max(this.width, 0);
    const h = this.height;
    const hi = this.hover;
    const hp = hi === null ? undefined : l.pts[hi];
    const shown = legendFor(l.palette, new Set(l.pts.map((p) => p.color)));
    const nounText = l.nulls === 1 ? this.noun : `${this.noun}s`;
    return html`<div data-chart="dot">
      <div class="plot" data-measure>
        <svg
          width=${w}
          height=${h}
          role="img"
          aria-label=${`${this.yLabel} over time, ${l.pts.length} ${this.noun}s${this.refLines.map((r) => `; ${r.label}`).join('')}`}
          @pointermove=${this.#onMove}
          @pointerleave=${this.#onLeave}
          @click=${this.#onClick}
        >
          ${w > 0 ? l.axes : nothing}
          ${w > 0 ? l.refs : nothing}
          <g class="dots">${guard([l], () => l.dots)}</g>
          ${hp && hi !== null
            ? svg`<circle class="focus" cx=${l.cx[hi]!} cy=${l.cy[hi]!} r=${l.r[hi]! + 1} fill=${colorOf(l.palette, hp.color)}></circle>`
            : nothing}
        </svg>
        ${this.renderTip()}
      </div>
      ${shown.length >= 2 ? legend(shown, 'dot', this.describe) : nothing}
      ${l.nulls > 0
        ? html`<p class="note" data-field="nulls">${formatNumber(l.nulls, 0)} ${nounText} without ${this.missingLabel ?? this.yLabel}</p>`
        : nothing}
    </div>`;
  }
}

/** Dashed horizontal lines from x0 to x1, each labelled above its right end. */
function refLineMarks(lines: readonly RefLine[], y: ScaleLinear<number, number>, x0: number, x1: number): SVGTemplateResult {
  return svg`${lines.map((l) => {
    const py = Math.round(y(l.value)) + 0.5;
    return svg`<g class="ref" data-ref-line=${l.key ?? l.label} aria-hidden="true">
      <line x1=${x0} x2=${x1} y1=${py} y2=${py}></line>
      <text x=${x1 - 2} y=${py - 4} text-anchor="end" data-field="ref-label">${l.label}</text>
    </g>`;
  })}`;
}

customElements.define('mc-dot-plot', McDotPlot);

declare global {
  interface HTMLElementTagNameMap {
    'mc-dot-plot': McDotPlot;
  }
  interface HTMLElementEventMap {
    'dot-select': CustomEvent<DotSelectDetail>;
  }
}
