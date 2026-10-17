/**
 * `<mc-bar-chart>`: horizontal bars, one row per item in the order given. The label column is a
 * link when the item has an `href`; the value is printed at the bar end; height follows the item
 * count. Hover (rows are the hit targets) shows label, value and the optional `title`.
 *
 * Items with a `key` are selectable: clicking the row (bar, or a label that isn't a link) or
 * pressing Enter / Space on the focused bar dispatches a bubbling, composed `bar-select` event
 * ({@link BarSelectDetail}). A linked label stays a plain link, so one row can both select (bar)
 * and navigate (label). Items without a key are plain marks.
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
  /** Makes the row selectable; `bar-select` carries it. */
  key?: string;
  /** Highlights the row as the active selection. */
  selected?: boolean;
}

export interface BarSelectDetail {
  key: string;
  index: number;
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
      .bar {
        pointer-events: none;
      }
      .bar.dim {
        opacity: 0.55;
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
        ${item.title ? html`<div>${item.title}</div>` : nothing}
        ${item.key !== undefined ? html`<div>${item.selected ? 'Click to clear filter' : 'Click to filter'}</div>` : nothing}`,
    );
  };

  #onLeave = (): void => {
    this.hover = null;
    this.hideTip();
  };

  #select(i: number): void {
    const key = this.items[i]?.key;
    if (key === undefined) return;
    this.dispatchEvent(new CustomEvent<BarSelectDetail>('bar-select', { detail: { key, index: i }, bubbles: true, composed: true }));
  }

  #onKey(ev: KeyboardEvent, i: number): void {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    this.#select(i);
  }

  #hit(d: BarItem, i: number, w: number): TemplateResult {
    if (d.key === undefined) return svg`<rect class="hit" data-i=${i} x="0" y=${i * ROW} width=${w} height=${ROW}></rect>`;
    return svg`<rect
      class="hit selectable ${d.selected ? 'selected' : ''}"
      data-i=${i}
      data-key=${d.key}
      x="0"
      y=${i * ROW}
      width=${w}
      height=${ROW}
      role="button"
      tabindex="0"
      aria-pressed=${d.selected ? 'true' : 'false'}
      aria-label=${`${d.label}: ${this.#fmt(d.value)}`}
      @click=${() => this.#select(i)}
      @keydown=${(ev: KeyboardEvent) => this.#onKey(ev, i)}
    ></rect>`;
  }

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
    const selectable = items.some((d) => d.key !== undefined);
    return html`<div class="bars" data-chart="bar">
      <div class="labels">
        ${items.map(
          (d, i) => html`<div
            class="label ${d.key !== undefined ? 'selectable' : ''} ${d.selected ? 'selected' : ''}"
            title=${d.label}
            data-label
          >
            ${d.href
              ? html`<a href=${d.href}>${d.label}</a>`
              : d.key !== undefined
                ? html`<span @click=${() => this.#select(i)}>${d.label}</span>`
                : html`<span>${d.label}</span>`}
          </div>`,
        )}
      </div>
      <div class="plot" data-measure>
        <svg
          width=${w}
          height=${h}
          role=${selectable ? 'group' : 'img'}
          aria-label="Bar chart"
          @pointermove=${this.#onMove}
          @pointerleave=${this.#onLeave}
        >
          ${w > 0 ? xGrid(x, 0, h, tickCount(w, 80)) : nothing}
          <line class="baseline" x1="0.5" x2="0.5" y1="0" y2=${h}></line>
          ${items.map((d, i) => {
            const x1 = x(Math.max(0, d.value));
            const dim = this.hover !== null && this.hover !== i;
            return svg`${this.#hit(d, i, Math.max(w, 0))}
              <path class="bar ${dim ? 'dim' : ''}" data-mark="bar" d=${hBarPath(0, x1, i * ROW + pad, BAR)} fill=${color}></path>
              <text class="value" x=${x1 + 6} y=${i * ROW + ROW / 2} dy="0.32em">${this.#fmt(d.value)}</text>`;
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
