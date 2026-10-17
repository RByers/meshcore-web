/**
 * `<mc-breakdown>`: one horizontal 100 % stacked bar for a single dimension, 2 px surface gaps
 * between segments, with a legend that carries each segment's label and share. Segments keep the
 * given order; zero values are dropped; beyond 8 the remainder folds into "Other". Hovering a
 * segment shows its value, share and optional `title`.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { ChartBase, chartStyles, formatNumber, formatPercent, type Describe } from './chart-base.js';
import { assignSlots, colorOf, MAX_SERIES, OTHER_KEY, type SeriesPalette } from './palette.js';

export interface BreakdownSegment {
  label: string;
  value: number;
  /** Extra tooltip line (e.g. packet count). */
  title?: string;
}

const TRACK = 16;

export class McBreakdown extends ChartBase {
  static override properties = {
    segments: { attribute: false },
    format: { attribute: false },
    palette: { attribute: false },
    label: { type: String },
    describe: { attribute: false },
    hover: { state: true },
  };

  static override styles = [
    chartStyles,
    css`
      .caption {
        font-size: 13px;
        margin: 0 0 4px;
      }
      .track {
        display: flex;
        gap: 2px;
        height: ${TRACK}px;
        border-radius: 4px;
        overflow: hidden;
      }
      .seg {
        flex: var(--v) 1 0;
        min-width: 2px;
        background: var(--c);
      }
      .seg.dim {
        opacity: 0.55;
      }
      .legend .share {
        color: var(--mc-text, CanvasText);
        font-variant-numeric: tabular-nums;
      }
    `,
  ];

  declare segments: readonly BreakdownSegment[];
  declare format: ((v: number) => string) | undefined;
  /** Label → colour; default: slots in segment order. */
  declare palette: SeriesPalette | undefined;
  /** Optional caption above the bar (the dimension name). */
  declare label: string;
  /** Hover text for a legend label (e.g. what a packet type means). */
  declare describe: Describe | undefined;
  declare hover: number | null;

  constructor() {
    super();
    this.segments = [];
    this.format = undefined;
    this.palette = undefined;
    this.label = '';
    this.hover = null;
  }

  #fmt(v: number): string {
    return this.format ? this.format(v) : formatNumber(v);
  }

  /** Non-zero segments, folded to ≤ 8 + "Other" unless a palette decides the colours. */
  #folded(): BreakdownSegment[] {
    const segs = this.segments.filter((s) => s.value > 0);
    if (this.palette || segs.length <= MAX_SERIES) return segs;
    const head = segs.slice(0, MAX_SERIES);
    const rest = segs.slice(MAX_SERIES);
    const other = rest.reduce((a, s) => a + s.value, 0);
    const existing = head.findIndex((s) => s.label === OTHER_KEY);
    if (existing >= 0) {
      const o = head[existing]!;
      head[existing] = { label: OTHER_KEY, value: o.value + other };
      return head;
    }
    return [...head, { label: OTHER_KEY, value: other, title: `${rest.length} more` }];
  }

  #onMove = (ev: PointerEvent, segs: readonly BreakdownSegment[], total: number): void => {
    const el = (ev.target as Element | null)?.closest('[data-i]');
    const i = el ? Number(el.getAttribute('data-i')) : NaN;
    const s = segs[i];
    if (!s) return;
    this.hover = i;
    const track = ev.currentTarget as Element;
    const p = this.pointerIn(ev, track);
    this.showTip(
      p.x,
      TRACK / 2,
      html`<div class="head">${s.label}</div>
        <div><strong>${formatPercent(s.value / total)}</strong> · ${this.#fmt(s.value)}</div>
        ${s.title ? html`<div>${s.title}</div>` : nothing}`,
    );
  };

  #onLeave = (): void => {
    this.hover = null;
    this.hideTip();
  };

  override render(): TemplateResult {
    const segs = this.#folded();
    const total = segs.reduce((a, s) => a + s.value, 0);
    if (segs.length === 0 || total <= 0) {
      return html`<div data-chart="breakdown">
        ${this.label ? html`<p class="caption">${this.label}</p>` : nothing}
        <p class="empty" data-empty>No data</p>
      </div>`;
    }
    const palette = this.palette ?? assignSlots(segs.map((s) => s.label));
    return html`<div data-chart="breakdown">
      ${this.label ? html`<p class="caption">${this.label}</p>` : nothing}
      <div class="plot" data-measure>
        <div
          class="track"
          role="img"
          aria-label=${`${this.label ? `${this.label}: ` : ''}${segs.map((s) => `${s.label} ${formatPercent(s.value / total)}`).join(', ')}`}
          @pointermove=${(ev: PointerEvent) => this.#onMove(ev, segs, total)}
          @pointerleave=${this.#onLeave}
        >
          ${segs.map(
            (s, i) => html`<div
              class="seg ${this.hover !== null && this.hover !== i ? 'dim' : ''}"
              data-mark="segment"
              data-i=${i}
              style="--v:${s.value};--c:${colorOf(palette, s.label)}"
            ></div>`,
          )}
        </div>
        ${this.renderTip()}
      </div>
      <ul class="legend" data-legend>
        ${segs.map(
          (s) => html`<li data-legend-key=${s.label} title=${this.describe?.(s.label) || nothing}>
            <span class="key rect" style="--c:${colorOf(palette, s.label)}"></span><span>${s.label}</span
            ><span class="share">${formatPercent(s.value / total)}</span>
          </li>`,
        )}
      </ul>
    </div>`;
  }
}

customElements.define('mc-breakdown', McBreakdown);

declare global {
  interface HTMLElementTagNameMap {
    'mc-breakdown': McBreakdown;
  }
}
