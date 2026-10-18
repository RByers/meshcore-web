/**
 * `<mc-box-plot>`: horizontal box-and-whisker rows sharing one value axis (docs/packet-stats.md
 * §3 item 10, §5). Per row: whiskers `whiskerLow`–`whiskerHigh` with end caps, a box q1–q3, a line
 * at the median, a mean diamond and a dot per outlier; the median is printed at the right. A row
 * with a `null` box draws no marks, only `emptyRowText`. The axis spans every row's min…max (and
 * zero when it is in range, drawn as a baseline); its tick labels sit under the rows.
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

export interface BoxRow {
  label: string;
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

/** Row pitch and box thickness (px). */
const ROW = 24;
const BOX = 12;
/** Height of the tick label strip under the rows. */
const AXIS = 18;
/** Room reserved right of the axis for the median label. */
const VALUE_ROOM = 56;

export class McBoxPlot extends ChartBase {
  static override properties = {
    rows: { attribute: false },
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
        grid-auto-rows: ${ROW}px;
        font-size: 13px;
        min-width: 0;
        align-content: start;
      }
      .label {
        align-self: center;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: end;
        line-height: ${ROW}px;
      }
      .label a {
        color: var(--mc-accent, LinkText);
      }
      .label.selected {
        font-weight: 600;
      }
      .label.selectable span {
        cursor: pointer;
      }
      .value {
        fill: var(--mc-text, CanvasText);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        pointer-events: none;
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
  declare format: ((v: number) => string) | undefined;
  /** Box colour (default palette slot 1). */
  declare color: string | undefined;
  declare emptyText: string;
  declare emptyRowText: string;
  declare hover: number | null;

  constructor() {
    super();
    this.rows = [];
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
      i * ROW + ROW / 2,
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
    if (r.key === undefined) return svg`<rect class="hit" data-i=${i} x="0" y=${i * ROW} width=${w} height=${ROW}></rect>`;
    return svg`<rect
      class="hit selectable ${r.selected ? 'selected' : ''}"
      data-i=${i}
      data-key=${r.key}
      x="0"
      y=${i * ROW}
      width=${w}
      height=${ROW}
      role="button"
      tabindex="0"
      aria-pressed=${r.selected ? 'true' : 'false'}
      aria-label=${`${r.label}: ${this.#summary(r)}`}
      @click=${() => this.#select(i)}
      @keydown=${(ev: KeyboardEvent) => this.#onKey(ev, i)}
    ></rect>`;
  }

  #marks(b: BoxSummary, i: number, x: (v: number) => number): TemplateResult {
    const cy = i * ROW + ROW / 2;
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
    const h = rows.length * ROW;
    const w = this.width;
    const boxes = rows.flatMap((r) => (r.box ? [r.box] : []));
    let lo = Math.min(...boxes.map((b) => b.min));
    let hi = Math.max(...boxes.map((b) => b.max));
    if (boxes.length === 0) [lo, hi] = [0, 1];
    else if (lo === hi) [lo, hi] = [lo - 1, hi + 1];
    const plotW = Math.max(w - VALUE_ROOM, 10);
    const x = scaleLinear().domain([lo, hi]).range([0, plotW]).nice(tickCount(plotW, 60));
    const [d0, d1] = x.domain() as [number, number];
    const zero = d0 <= 0 && d1 >= 0 ? Math.round(x(0)) + 0.5 : null;
    const ticks = x.ticks(tickCount(plotW, 60));
    const color = this.color ?? seriesColor(0);
    const selectable = rows.some((r) => r.key !== undefined);
    return html`<div class="rows" data-chart="box">
      <div class="labels">
        ${rows.map(
          (r, i) => html`<div class="label ${r.key !== undefined ? 'selectable' : ''} ${r.selected ? 'selected' : ''}" title=${r.label} data-label>
            ${r.href
              ? html`<a href=${r.href}>${r.label}</a>`
              : r.key !== undefined
                ? html`<span @click=${() => this.#select(i)}>${r.label}</span>`
                : html`<span>${r.label}</span>`}
          </div>`,
        )}
      </div>
      <div class="plot" data-measure>
        <svg
          width=${w}
          height=${h + AXIS}
          role=${selectable ? 'group' : 'img'}
          aria-label="Box plot"
          style="--c:${color}"
          @pointermove=${this.#onMove}
          @pointerleave=${this.#onLeave}
        >
          ${w > 0 ? xGrid(x, 0, h, tickCount(plotW, 60)) : nothing}
          ${zero !== null ? svg`<line class="baseline" data-field="zero" x1=${zero} x2=${zero} y1="0" y2=${h}></line>` : nothing}
          <g class="axis x" aria-hidden="true">
            ${ticks.map((t) => svg`<text class="tick" x=${x(t)} y=${h + 13} text-anchor="middle">${this.#fmt(t)}</text>`)}
          </g>
          ${rows.map((r, i) => {
            const hit = this.#hit(r, i, Math.max(w, 0));
            if (!r.box) return svg`${hit}<text class="value none" data-field="no-box" x="4" y=${i * ROW + ROW / 2} dy="0.32em">${this.emptyRowText}</text>`;
            return svg`${hit}${this.#marks(r.box, i, x)}
              <text class="value" data-field="median" x=${plotW + 8} y=${i * ROW + ROW / 2} dy="0.32em">${this.#fmt(r.box.median)}</text>`;
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
