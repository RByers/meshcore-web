/**
 * `<mc-range-plot>`: horizontal min–max range bars with a median marker, one row per item on a
 * shared value axis (docs/packet-stats.md §2, §3 "Link quality by neighbour"). Each row has a
 * two-line label (name, plus a muted `detail` line), a bar coloured by its `tone`, and two lines of
 * text at the right (`valueText`, `valueSub`). An optional `refLine` is a vertical dashed line
 * across every row (`--mc-danger`), labelled above the rows. The axis spans every row's min…max and
 * the reference line; tick labels sit under the rows.
 *
 * Rows follow `<mc-bar-chart>` / `<mc-box-plot>`: the label is a link when the row has an `href`, a
 * hover tooltip shows the caller's `title` lines, and rows with a `key` are selectable — clicking
 * the row (or a label that isn't a link) or Enter / Space dispatches the same bubbling, composed
 * `bar-select` event ({@link BarSelectDetail}); `selected` marks the pressed row.
 */
import { css, html, nothing, svg, type TemplateResult } from 'lit';
import { scaleLinear } from 'd3-scale';
import { ChartBase, chartStyles, formatNumber, tickCount, xGrid } from './chart-base.js';
import type { BarSelectDetail } from './bar-chart.js';

/** Row colour: good `--mc-ok`, ok `--mc-warn`, bad `--mc-danger`; none = the accent colour. */
export type RangeTone = 'good' | 'ok' | 'bad';

export interface RangeRow {
  label: string;
  /** Muted second label line. */
  detail?: string;
  min: number;
  max: number;
  median: number;
  tone?: RangeTone;
  /** Right-hand text, first line (default: the formatted median). */
  valueText?: string;
  /** Right-hand text, second (muted) line. */
  valueSub?: string;
  /** Makes the label a link. */
  href?: string;
  /** Tooltip lines under the label. */
  title?: string | readonly string[];
  /** Makes the row selectable; `bar-select` carries it. */
  key?: string;
  selected?: boolean;
}

/** A vertical reference line across all rows. */
export interface RangeRefLine {
  value: number;
  label: string;
}

/** Row pitch, bar thickness, room above the rows for the reference label, axis strip (px). */
const ROW = 36;
const BAR = 10;
const TOP = 16;
const AXIS = 18;
/** Room right of the axis for the value text. */
const VALUE_ROOM = 84;

export class McRangePlot extends ChartBase {
  static override properties = {
    rows: { attribute: false },
    refLine: { attribute: false },
    format: { attribute: false },
    emptyText: { type: String, attribute: 'empty-text' },
    label: { type: String },
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
        padding-top: ${TOP}px;
        min-width: 0;
        align-content: start;
      }
      .label {
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-width: 0;
        text-align: end;
        font-size: 13px;
        line-height: 1.2;
      }
      .label > * {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .label a {
        color: var(--mc-accent, LinkText);
      }
      .label.selected .name {
        font-weight: 600;
      }
      .label.selectable span.name {
        cursor: pointer;
      }
      .detail {
        font-size: 11px;
        color: var(--chart-muted);
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
      .marks {
        pointer-events: none;
      }
      .marks.dim {
        opacity: 0.55;
      }
      .range {
        fill: color-mix(in oklab, var(--c), transparent 55%);
        stroke: var(--c);
        stroke-width: 1;
      }
      .median {
        stroke: var(--mc-text, CanvasText);
        stroke-width: 2.5;
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

  declare rows: readonly RangeRow[];
  declare refLine: RangeRefLine | null;
  declare format: ((v: number) => string) | undefined;
  declare emptyText: string;
  /** The SVG's accessible name. */
  declare label: string;
  declare hover: number | null;

  constructor() {
    super();
    this.rows = [];
    this.refLine = null;
    this.format = undefined;
    this.emptyText = 'No data';
    this.label = 'Range plot';
    this.hover = null;
  }

  #fmt(v: number): string {
    return this.format ? this.format(v) : formatNumber(v);
  }

  #summary(r: RangeRow): string {
    const parts = [`median ${this.#fmt(r.median)}`, `range ${this.#fmt(r.min)} to ${this.#fmt(r.max)}`];
    if (r.valueSub) parts.push(r.valueSub);
    return parts.join(', ');
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
      TOP + i * ROW + ROW / 2,
      html`<div class="head">${r.label}</div>
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

  #hit(r: RangeRow, i: number, w: number): TemplateResult {
    const y = TOP + i * ROW;
    if (r.key === undefined) return svg`<rect class="hit" data-i=${i} x="0" y=${y} width=${w} height=${ROW}></rect>`;
    return svg`<rect
      class="hit selectable ${r.selected ? 'selected' : ''}"
      data-i=${i}
      data-key=${r.key}
      x="0"
      y=${y}
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

  #row(r: RangeRow, i: number, x: (v: number) => number, plotW: number): TemplateResult {
    const cy = TOP + i * ROW + ROW / 2;
    const x0 = x(r.min);
    const x1 = x(r.max);
    const med = x(r.median);
    const color = r.tone ? TONE_COLOR[r.tone] : 'var(--mc-accent, Highlight)';
    return svg`<g style="--c:${color}" data-row=${i} data-tone=${r.tone ?? nothing}>
      <g class="marks ${this.hover !== null && this.hover !== i ? 'dim' : ''}">
        <rect class="range" data-mark="range" x=${x0} y=${cy - BAR / 2} width=${Math.max(x1 - x0, 2)} height=${BAR} rx="3"></rect>
        <line class="median" data-mark="median" x1=${med} x2=${med} y1=${cy - BAR / 2 - 3} y2=${cy + BAR / 2 + 3}></line>
      </g>
      <text class="value" data-field="value" x=${plotW + 8} y=${r.valueSub ? cy - 6 : cy} dy="0.32em">${r.valueText ?? this.#fmt(r.median)}</text>
      ${r.valueSub ? svg`<text class="value sub" data-field="value-sub" x=${plotW + 8} y=${cy + 8} dy="0.32em">${r.valueSub}</text>` : nothing}
    </g>`;
  }

  override render(): TemplateResult {
    const rows = this.rows;
    if (rows.length === 0) return html`<p class="empty" data-chart="range" data-empty>${this.emptyText}</p>`;
    const h = rows.length * ROW;
    const w = this.width;
    const ref = this.refLine;
    const values = rows.flatMap((r) => [r.min, r.max]);
    if (ref) values.push(ref.value);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (lo === hi) [lo, hi] = [lo - 1, hi + 1];
    const plotW = Math.max(w - VALUE_ROOM, 10);
    const x = scaleLinear().domain([lo, hi]).range([0, plotW]).nice(tickCount(plotW, 60));
    const ticks = x.ticks(tickCount(plotW, 60));
    const selectable = rows.some((r) => r.key !== undefined);
    const refX = ref ? Math.round(x(ref.value)) + 0.5 : 0;
    const refLeft = refX < plotW / 2;
    return html`<div class="rows" data-chart="range">
      <div class="labels">
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
          height=${TOP + h + AXIS}
          role=${selectable ? 'group' : 'img'}
          aria-label=${`${this.label}${ref ? `; ${ref.label}` : ''}`}
          @pointermove=${this.#onMove}
          @pointerleave=${this.#onLeave}
        >
          ${w > 0 ? xGrid(x, TOP, TOP + h, tickCount(plotW, 60)) : nothing}
          <g class="axis x" aria-hidden="true">
            ${ticks.map((t) => svg`<text class="tick" x=${x(t)} y=${TOP + h + 13} text-anchor="middle">${this.#fmt(t)}</text>`)}
          </g>
          ${ref
            ? svg`<g class="ref" data-ref-line aria-hidden="true">
                <line x1=${refX} x2=${refX} y1=${TOP - 2} y2=${TOP + h}></line>
                <text x=${refLeft ? refX + 4 : refX - 4} y=${TOP - 5} text-anchor=${refLeft ? 'start' : 'end'} data-field="ref-label">${ref.label}</text>
              </g>`
            : nothing}
          ${rows.map((r, i) => svg`${this.#hit(r, i, Math.max(w, 0))}${this.#row(r, i, x, plotW)}`)}
        </svg>
        ${this.renderTip()}
      </div>
    </div>`;
  }
}

const TONE_COLOR: Record<RangeTone, string> = {
  good: 'var(--mc-ok, CanvasText)',
  ok: 'var(--mc-warn, CanvasText)',
  bad: 'var(--mc-danger, CanvasText)',
};

customElements.define('mc-range-plot', McRangePlot);

declare global {
  interface HTMLElementTagNameMap {
    'mc-range-plot': McRangePlot;
  }
}
