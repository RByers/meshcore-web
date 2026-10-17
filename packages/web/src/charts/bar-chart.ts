/**
 * `<mc-bar-chart>`: horizontal bars, one row per item in the order given. The label column is a
 * link when the item has an `href`; the value is printed at the bar end; height follows the item
 * count. Hover (rows are the hit targets) shows label, value and the optional `title`.
 */
import { css, html, nothing, svg, type TemplateResult } from 'lit';
import { scaleLinear } from 'd3-scale';
import { max } from 'd3-array';
import { ChartBase, chartStyles, formatNumber, hBarPath, tickCount, xGrid } from './chart-base.js';
import { seriesColor } from './palette.js';

export interface BarItem {
  label: string;
  value: number;
  /** Makes the label a link. */
  href?: string;
  /** Extra tooltip line. */
  title?: string;
}

/** Row pitch and bar thickness (px). */
const ROW = 24;
const BAR = 14;
/** Room reserved past the longest bar for its value label. */
const VALUE_ROOM = 56;

export class McBarChart extends ChartBase {
  static override properties = {
    items: { attribute: false },
    format: { attribute: false },
    color: { type: String },
    emptyText: { type: String, attribute: 'empty-text' },
    hover: { state: true },
  };

  static override styles = [
    chartStyles,
    css`
      .bars {
        display: grid;
        grid-template-columns: minmax(4em, var(--mc-bar-label-width, 34%)) minmax(0, 1fr);
        column-gap: 8px;
      }
      .labels {
        display: grid;
        grid-auto-rows: ${ROW}px;
        font-size: 13px;
        min-width: 0;
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
      .value {
        fill: var(--mc-text, CanvasText);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
      .bar.dim {
        opacity: 0.55;
      }
    `,
  ];

  declare items: readonly BarItem[];
  declare format: ((v: number) => string) | undefined;
  /** Bar colour (default palette slot 1). */
  declare color: string | undefined;
  declare emptyText: string;
  declare hover: number | null;

  constructor() {
    super();
    this.items = [];
    this.format = undefined;
    this.color = undefined;
    this.emptyText = 'No data';
    this.hover = null;
  }

  #fmt(v: number): string {
    return this.format ? this.format(v) : formatNumber(v);
  }

  #onMove = (ev: PointerEvent): void => {
    const target = (ev.target as Element | null)?.closest('[data-i]');
    const i = target ? Number(target.getAttribute('data-i')) : NaN;
    const item = this.items[i];
    const svgEl = ev.currentTarget as Element;
    if (!item) {
      this.#onLeave();
      return;
    }
    this.hover = i;
    const p = this.pointerIn(ev, svgEl);
    this.showTip(
      p.x,
      i * ROW + ROW / 2,
      html`<div class="head">${item.label}</div>
        <div><strong>${this.#fmt(item.value)}</strong></div>
        ${item.title ? html`<div>${item.title}</div>` : nothing}`,
    );
  };

  #onLeave = (): void => {
    this.hover = null;
    this.hideTip();
  };

  override render(): TemplateResult {
    const items = this.items;
    if (items.length === 0) return html`<p class="empty" data-chart="bar" data-empty>${this.emptyText}</p>`;
    const h = items.length * ROW;
    const w = this.width;
    const x = scaleLinear()
      .domain([0, Math.max(max(items, (d) => d.value) ?? 0, 1)])
      .range([0, Math.max(w - VALUE_ROOM, 10)]);
    const color = this.color ?? seriesColor(0);
    const pad = (ROW - BAR) / 2;
    return html`<div class="bars" data-chart="bar">
      <div class="labels">
        ${items.map(
          (d) => html`<div class="label" title=${d.label} data-label>
            ${d.href ? html`<a href=${d.href}>${d.label}</a>` : html`<span>${d.label}</span>`}
          </div>`,
        )}
      </div>
      <div class="plot" data-measure>
        <svg
          width=${w}
          height=${h}
          role="img"
          aria-label="Bar chart"
          @pointermove=${this.#onMove}
          @pointerleave=${this.#onLeave}
        >
          ${w > 0 ? xGrid(x, 0, h, tickCount(w, 80)) : nothing}
          <line class="baseline" x1="0.5" x2="0.5" y1="0" y2=${h}></line>
          ${items.map((d, i) => {
            const x1 = x(Math.max(0, d.value));
            const dim = this.hover !== null && this.hover !== i;
            return svg`<path class="bar ${dim ? 'dim' : ''}" data-mark="bar" d=${hBarPath(0, x1, i * ROW + pad, BAR)} fill=${color}></path>
              <text class="value" x=${x1 + 6} y=${i * ROW + ROW / 2} dy="0.32em">${this.#fmt(d.value)}</text>
              <rect class="hit" data-i=${i} x="0" y=${i * ROW} width=${Math.max(w, 0)} height=${ROW}></rect>`;
          })}
        </svg>
        ${this.renderTip()}
      </div>
    </div>`;
  }
}

customElements.define('mc-bar-chart', McBarChart);

declare global {
  interface HTMLElementTagNameMap {
    'mc-bar-chart': McBarChart;
  }
}
