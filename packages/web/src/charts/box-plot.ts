/**
 * `<mc-box-plot>`: horizontal box-and-whisker rows sharing one value axis (docs/packet-stats.md
 * §3 item 10, §5). Per row: whiskers `whiskerLow`–`whiskerHigh` with end caps, a box q1–q3, a line
 * at the median, a mean diamond and a dot per outlier; the median is printed at the right. A row
 * with a `null` box draws no marks, only `emptyRowText`. The axis spans every row's min…max (and
 * zero when it is in range, drawn as a baseline); its tick labels sit under the rows.
 *
 * Optional extras (the Stats tab's signal-by-last-hop card): a `refLine` — a vertical dashed
 * `--mc-danger` line across every row, labelled above them and always inside the axis — and per
 * row a `tone` (box colour `--mc-ok` / `--mc-warn` / `--mc-danger`, `data-tone` on the row), a muted
 * `detail` line under the label, and `valueText` / `valueSub` replacing the printed median (the sub
 * line in the tone colour). Rows grow to two lines when any row has a `detail` or `valueSub`.
 *
 * Rows follow `<mc-bar-chart>`: a label column (a link when the row has an `href`), a hover
 * tooltip (label, median, the caller's `title` lines), and rows with a `key` are selectable —
 * clicking the row (or a label that isn't a link) or Enter / Space on the focused row dispatches the
 * same bubbling, composed `bar-select` event ({@link BarSelectDetail}), so drill-down handlers work
 * for both charts; `selected` marks the pressed row.
 */
import { css, html, nothing, svg, type TemplateResult } from 'lit';
import { scaleLinear } from 'd3-scale';
import { ChartBase, chartStyles, formatNumber, tickCount, xGrid } from './chart-base.js';
import type { BarSelectDetail } from './bar-chart.js';
import { seriesColor } from './palette.js';

/** Box-and-whisker numbers of one row (structurally the core `BoxStats`). */
export interface BoxSummary {
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  mean: number;
  whiskerLow: number;
  whiskerHigh: number;
  outliers: readonly number[];
}

/** Row colour: good `--mc-ok`, ok `--mc-warn`, bad `--mc-danger`; none = the chart colour. */
export type BoxTone = 'good' | 'ok' | 'bad';

/** A vertical reference line across all rows. */
export interface BoxRefLine {
  value: number;
  label: string;
}

export interface BoxRow {
  label: string;
  /** Muted second label line. */
  detail?: string;
  tone?: BoxTone;
  /** Right-hand text instead of the median (`data-field="value"`). */
  valueText?: string;
  /** Right-hand second line, in the tone colour (`data-field="value-sub"`). */
  valueSub?: string;
  /** `null` = no values: no marks, `emptyRowText` instead. */
  box: BoxSummary | null;
  /** Makes the label a link. */
  href?: string;
  /** Tooltip lines under the label and median. */
  title?: string | readonly string[];
  /** Makes the row selectable; `bar-select` carries it. */
  key?: string;
  /** Highlights the row as the active selection. */
  selected?: boolean;
}

/** Row pitch (one / two text lines) and box thickness (px). */
const ROW = 24;
const ROW2 = 36;
const BOX = 12;
/** Height of the tick label strip under the rows; room above them for the reference label. */
const AXIS = 18;
const TOP = 16;
/** Room reserved right of the axis for the median label (wider for `valueSub`). */
const VALUE_ROOM = 56;
const VALUE_ROOM2 = 76;

const TONE_COLOR: Record<BoxTone, string> = {
  good: 'var(--mc-ok, CanvasText)',
  ok: 'var(--mc-warn, CanvasText)',
  bad: 'var(--mc-danger, CanvasText)',
};

export class McBoxPlot extends ChartBase {
  static override properties = {
    rows: { attribute: false },
    refLine: { attribute: false },
    label: { type: String },
    format: { attribute: false },
    color: { type: String },
    emptyText: { type: String, attribute: 'empty-text' },
    emptyRowText: { type: String, attribute: 'empty-row-text' },
    hover: { state: true },
  };

  static override styles = [
    chartStyles,
    css`
      .rows {
        display: grid;
        grid-template-columns: minmax(4em, var(--mc-bar-label-width, 34%)) minmax(0, 1fr);
        column-gap: 8px;
      }
      .labels {
        display: grid;
        grid-auto-rows: var(--row, ${ROW}px);
        padding-top: var(--top, 0px);
        font-size: 13px;
        min-width: 0;
        align-content: start;
      }
      .label {
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-width: 0;
        text-align: end;
        line-height: 1.2;
      }
      .label > * {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .detail {
        font-size: 11px;
        color: var(--chart-muted);
      }
      .label a {
        color: var(--mc-accent, LinkText);
      }
      .label.selected {
        font-weight: 600;
      }
      .label.selectable span.name {
        cursor: pointer;
      }
      .value {
        fill: var(--mc-text, CanvasText);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        pointer-events: none;
      }
      .value.sub {
        font-size: 11px;
        fill: var(--c);
      }
      .ref line {
        stroke: var(--mc-danger, GrayText);
        stroke-width: 1.5;
        stroke-dasharray: 5 4;
      }
      .ref text {
        fill: var(--chart-muted);
        font-size: 11px;
      }
      .value.none {
        fill: var(--chart-muted);
        font-style: italic;
      }
      .marks {
        pointer-events: none;
      }
      .marks.dim {
        opacity: 0.55;
      }
      .whisker {
        stroke: var(--mc-text, CanvasText);
        stroke-width: 1;
        opacity: 0.7;
      }
      .box {
        fill: color-mix(in oklab, var(--c), transparent 55%);
        stroke: var(--c);
        stroke-width: 1;
      }
      .median {
        stroke: var(--mc-text, CanvasText);
        stroke-width: 2;
      }
      .mean {
        fill: var(--chart-surface);
        stroke: var(--mc-text, CanvasText);
        stroke-width: 1;
      }
      .outlier {
        fill: none;
        stroke: var(--c);
        stroke-width: 1.25;
      }
      .hit.selectable {
        cursor: pointer;
      }
      .hit.selectable:hover {
        fill: color-mix(in oklab, var(--mc-accent, Highlight), transparent 90%);
      }
      .hit.selected {
        fill: color-mix(in oklab, var(--mc-accent, Highlight), transparent 84%);
      }
      .hit.selectable:focus {
        outline: none;
      }
      .hit.selectable:focus-visible {
        outline: 2px solid var(--mc-accent, Highlight);
        outline-offset: -2px;
      }
    `,
  ];

  declare rows: readonly BoxRow[];
  declare refLine: BoxRefLine | null;
  /** The SVG's accessible name (the reference label is appended). */
  declare label: string;
  declare format: ((v: number) => string) | undefined;
  /** Box colour (default palette slot 1). */
  declare color: string | undefined;
  declare emptyText: string;
  declare emptyRowText: string;
  declare hover: number | null;
  /** Row pitch and top offset of the last render (tooltip / hit layout). */
  #row = ROW;
  #top = 0;

  constructor() {
    super();
    this.rows = [];
    this.refLine = null;
    this.label = 'Box plot';
    this.format = undefined;
    this.color = undefined;
    this.emptyText = 'No data';
    this.emptyRowText = 'no data';
    this.hover = null;
  }

  #fmt(v: number): string {
    return this.format ? this.format(v) : formatNumber(v);
  }

  #summary(r: BoxRow): string {
    return r.box ? `median ${this.#fmt(r.box.median)}` : this.emptyRowText;
  }

  #onMove = (ev: PointerEvent): void => {
    const target = (ev.target as Element | null)?.closest('[data-i]');
    const i = target ? Number(target.getAttribute('data-i')) : NaN;
    const r = this.rows[i];
    if (!r) {
      this.#onLeave();
      return;
    }
    this.hover = i;
    const p = this.pointerIn(ev, ev.currentTarget as Element);
    const lines = r.title === undefined ? [] : typeof r.title === 'string' ? [r.title] : r.title;
    this.showTip(
      p.x,
      this.#top + i * this.#row + this.#row / 2,
      html`<div class="head">${r.label}</div>
        <div><strong>${this.#summary(r)}</strong></div>
        ${lines.map((l) => html`<div>${l}</div>`)}
        ${r.key !== undefined ? html`<div>${r.selected ? 'Click to clear filter' : 'Click to filter'}</div>` : nothing}`,
    );
  };

  #onLeave = (): void => {
    this.hover = null;
    this.hideTip();
  };

  #select(i: number): void {
    const key = this.rows[i]?.key;
    if (key === undefined) return;
    this.dispatchEvent(new CustomEvent<BarSelectDetail>('bar-select', { detail: { key, index: i }, bubbles: true, composed: true }));
  }

  #onKey(ev: KeyboardEvent, i: number): void {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    this.#select(i);
  }

  #hit(r: BoxRow, i: number, w: number): TemplateResult {
    const y = this.#top + i * this.#row;
    if (r.key === undefined) return svg`<rect class="hit" data-i=${i} x="0" y=${y} width=${w} height=${this.#row}></rect>`;
    return svg`<rect
      class="hit selectable ${r.selected ? 'selected' : ''}"
      data-i=${i}
      data-key=${r.key}
      x="0"
      y=${y}
      width=${w}
      height=${this.#row}
      role="button"
      tabindex="0"
      aria-pressed=${r.selected ? 'true' : 'false'}
      aria-label=${`${r.label}: ${this.#summary(r)}`}
      @click=${() => this.#select(i)}
      @keydown=${(ev: KeyboardEvent) => this.#onKey(ev, i)}
    ></rect>`;
  }

  #cy(i: number): number {
    return this.#top + i * this.#row + this.#row / 2;
  }

  #value(r: BoxRow, b: BoxSummary, i: number, x: number): TemplateResult {
    const cy = this.#cy(i);
    if (r.valueText === undefined && r.valueSub === undefined) {
      return svg`<text class="value" data-field="median" x=${x} y=${cy} dy="0.32em">${this.#fmt(b.median)}</text>`;
    }
    return svg`<text class="value" data-field="value" x=${x} y=${r.valueSub ? cy - 6 : cy} dy="0.32em">${r.valueText ?? this.#fmt(b.median)}</text>
      ${r.valueSub ? svg`<text class="value sub" data-field="value-sub" x=${x} y=${cy + 8} dy="0.32em">${r.valueSub}</text>` : nothing}`;
  }

  #marks(b: BoxSummary, i: number, x: (v: number) => number): TemplateResult {
    const cy = this.#cy(i);
    const top = cy - BOX / 2;
    const cap = BOX / 4;
    const [wl, wh, q1, q3, med, mean] = [x(b.whiskerLow), x(b.whiskerHigh), x(b.q1), x(b.q3), x(b.median), x(b.mean)];
    const d = 4;
    return svg`<g class="marks ${this.hover !== null && this.hover !== i ? 'dim' : ''}" data-row=${i}>
      <line class="whisker" data-mark="whisker" x1=${wl} x2=${wh} y1=${cy} y2=${cy}></line>
      <line class="whisker" data-mark="cap" x1=${wl} x2=${wl} y1=${cy - cap} y2=${cy + cap}></line>
      <line class="whisker" data-mark="cap" x1=${wh} x2=${wh} y1=${cy - cap} y2=${cy + cap}></line>
      <rect class="box" data-mark="box" x=${q1} y=${top} width=${Math.max(q3 - q1, 1)} height=${BOX} rx="2"></rect>
      <line class="median" data-mark="median" x1=${med} x2=${med} y1=${top} y2=${top + BOX}></line>
      <path class="mean" data-mark="mean" d=${`M${mean},${cy - d}L${mean + d},${cy}L${mean},${cy + d}L${mean - d},${cy}Z`}></path>
      ${b.outliers.map((o) => svg`<circle class="outlier" data-mark="outlier" cx=${x(o)} cy=${cy} r="2.5"></circle>`)}
    </g>`;
  }

  override render(): TemplateResult {
    const rows = this.rows;
    if (rows.length === 0) return html`<p class="empty" data-chart="box" data-empty>${this.emptyText}</p>`;
    const ref = this.refLine;
    const twoLine = rows.some((r) => r.detail !== undefined || r.valueSub !== undefined);
    const rowH = (this.#row = twoLine ? ROW2 : ROW);
    const top = (this.#top = ref ? TOP : 0);
    const h = rows.length * rowH;
    const bottom = top + h;
    const w = this.width;
    const boxes = rows.flatMap((r) => (r.box ? [r.box] : []));
    const values = boxes.flatMap((b) => [b.min, b.max]);
    if (ref) values.push(ref.value);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (values.length === 0) [lo, hi] = [0, 1];
    else if (lo === hi) [lo, hi] = [lo - 1, hi + 1];
    const plotW = Math.max(w - (rows.some((r) => r.valueSub !== undefined) ? VALUE_ROOM2 : VALUE_ROOM), 10);
    const x = scaleLinear().domain([lo, hi]).range([0, plotW]).nice(tickCount(plotW, 60));
    const [d0, d1] = x.domain() as [number, number];
    const zero = d0 <= 0 && d1 >= 0 ? Math.round(x(0)) + 0.5 : null;
    const ticks = x.ticks(tickCount(plotW, 60));
    const color = this.color ?? seriesColor(0);
    const selectable = rows.some((r) => r.key !== undefined);
    const refX = ref ? Math.round(x(ref.value)) + 0.5 : 0;
    const refLeft = refX < plotW / 2;
    return html`<div class="rows" data-chart="box">
      <div class="labels" style="--row:${rowH}px;--top:${top}px">
        ${rows.map(
          (r, i) => html`<div class="label ${r.key !== undefined ? 'selectable' : ''} ${r.selected ? 'selected' : ''}" title=${r.label} data-label>
            ${r.href
              ? html`<a class="name" href=${r.href}>${r.label}</a>`
              : r.key !== undefined
                ? html`<span class="name" @click=${() => this.#select(i)}>${r.label}</span>`
                : html`<span class="name">${r.label}</span>`}
            ${r.detail ? html`<span class="detail" data-detail>${r.detail}</span>` : nothing}
          </div>`,
        )}
      </div>
      <div class="plot" data-measure>
        <svg
          width=${w}
          height=${bottom + AXIS}
          role=${selectable ? 'group' : 'img'}
          aria-label=${`${this.label}${ref ? `; ${ref.label}` : ''}`}
          style="--c:${color}"
          @pointermove=${this.#onMove}
          @pointerleave=${this.#onLeave}
        >
          ${w > 0 ? xGrid(x, top, bottom, tickCount(plotW, 60)) : nothing}
          ${zero !== null ? svg`<line class="baseline" data-field="zero" x1=${zero} x2=${zero} y1=${top} y2=${bottom}></line>` : nothing}
          <g class="axis x" aria-hidden="true">
            ${ticks.map((t) => svg`<text class="tick" x=${x(t)} y=${bottom + 13} text-anchor="middle">${this.#fmt(t)}</text>`)}
          </g>
          ${ref
            ? svg`<g class="ref" data-ref-line aria-hidden="true">
                <line x1=${refX} x2=${refX} y1=${top - 2} y2=${bottom}></line>
                <text x=${refLeft ? refX + 4 : refX - 4} y=${top - 5} text-anchor=${refLeft ? 'start' : 'end'} data-field="ref-label">${ref.label}</text>
              </g>`
            : nothing}
          ${rows.map((r, i) => {
            const hit = this.#hit(r, i, Math.max(w, 0));
            if (!r.box) return svg`${hit}<text class="value none" data-field="no-box" x="4" y=${this.#cy(i)} dy="0.32em">${this.emptyRowText}</text>`;
            return svg`${hit}<g style=${r.tone ? `--c:${TONE_COLOR[r.tone]}` : nothing} data-tone=${r.tone ?? nothing}>${this.#marks(r.box, i, x)}${this.#value(r, r.box, i, plotW + 8)}</g>`;
          })}
        </svg>
        ${this.renderTip()}
      </div>
    </div>`;
  }
}

customElements.define('mc-box-plot', McBoxPlot);

declare global {
  interface HTMLElementTagNameMap {
    'mc-box-plot': McBoxPlot;
  }
}
