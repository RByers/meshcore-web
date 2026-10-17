/**
 * Shared chart plumbing (docs/packet-stats.md §2): width measurement with a ResizeObserver
 * (height is fixed per chart, width fluid), axis / grid templates rendered with Lit `svg` from d3
 * scales, a hover tooltip (HTML positioned over the SVG), a legend, and `Intl` tick formatting.
 *
 * Colours: `--mc-*` tokens (inherited from `<mc-app>`, with fallbacks so a chart also renders
 * standalone) and the `--viz-*` palette (palette.ts). Text never wears a series colour.
 */
import { css, html, LitElement, nothing, svg, type PropertyDeclarations, type PropertyValues, type SVGTemplateResult, type TemplateResult } from 'lit';
import type { ScaleLinear, ScaleTime } from 'd3-scale';
import { vizTokens, type LegendEntry } from './palette.js';

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Minimum hit-target size (px) for any mark, whatever its painted size. */
export const MIN_HIT = 12;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------- formatting

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(compact: boolean, digits: number): Intl.NumberFormat {
  const k = `${compact}:${digits}`;
  let f = numberFormats.get(k);
  if (!f) {
    f = new Intl.NumberFormat(undefined, { notation: compact ? 'compact' : 'standard', maximumFractionDigits: digits });
    numberFormats.set(k, f);
  }
  return f;
}

/** Locale number, compact from 1,000 up (1.2K, 3.4M); at most `digits` fraction digits. */
export function formatNumber(v: number, digits = 1): string {
  return numberFormat(Math.abs(v) >= 1000, digits).format(v);
}

/** `fraction` (0…1) as a percentage, e.g. 0.0123 → "1.2 %" style per locale. */
export function formatPercent(fraction: number, digits = 1): string {
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: digits }).format(fraction);
}

const TIME_OF_DAY = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const DATE_ONLY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Time-axis tick formatter for a domain `spanMs` wide: time of day under 2 days, else dates. */
export function timeTickFormat(spanMs: number): (t: number | Date) => string {
  const f = spanMs < 2 * DAY_MS ? TIME_OF_DAY : DATE_ONLY;
  return (t) => f.format(t);
}

/** Full timestamp for tooltips. */
export function formatDateTime(t: number | Date): string {
  return DATE_TIME.format(t);
}

/** About one tick per `spacing` px, at least 2. */
export function tickCount(px: number, spacing: number): number {
  return Math.max(2, Math.floor(px / spacing));
}

// ---------------------------------------------------------------------------------- templates

/** Horizontal gridlines + left tick labels for a linear y scale, spanning x0…x1. */
export function yAxis(
  y: ScaleLinear<number, number>,
  x0: number,
  x1: number,
  count: number,
  format: (v: number) => string = (v) => formatNumber(v),
): SVGTemplateResult {
  return svg`<g class="axis y" aria-hidden="true">
    ${y.ticks(count).map(
      (t) => svg`<line class="grid" x1=${x0} x2=${x1} y1=${Math.round(y(t)) + 0.5} y2=${Math.round(y(t)) + 0.5}></line>
        <text class="tick" x=${x0 - 6} y=${y(t)} dy="0.32em" text-anchor="end">${format(t)}</text>`,
    )}
  </g>`;
}

/** Baseline at `yPos` plus bottom time tick labels. */
export function xTimeAxis(
  x: ScaleTime<number, number>,
  yPos: number,
  count: number,
  format?: (t: Date) => string,
): SVGTemplateResult {
  const [d0, d1] = x.domain();
  const fmt = format ?? timeTickFormat((d1?.getTime() ?? 0) - (d0?.getTime() ?? 0));
  const [r0, r1] = x.range();
  return svg`<g class="axis x" aria-hidden="true">
    <line class="baseline" x1=${r0 ?? 0} x2=${r1 ?? 0} y1=${Math.round(yPos) + 0.5} y2=${Math.round(yPos) + 0.5}></line>
    ${x.ticks(count).map(
      (t) => svg`<text class="tick" x=${x(t)} y=${yPos + 15} text-anchor="middle">${fmt(t)}</text>`,
    )}
  </g>`;
}

/** Vertical gridlines (no labels) for a linear x scale, from y0 to y1. */
export function xGrid(x: ScaleLinear<number, number>, y0: number, y1: number, count: number): SVGTemplateResult {
  return svg`<g class="axis" aria-hidden="true">
    ${x.ticks(count).map((t) => svg`<line class="grid" x1=${Math.round(x(t)) + 0.5} x2=${Math.round(x(t)) + 0.5} y1=${y0} y2=${y1}></line>`)}
  </g>`;
}

/**
 * Path for a horizontal bar from x0 to x1 (x1 ≥ x0), `h` tall at top `y`: square at the
 * baseline, `r`-rounded at the data end.
 */
export function hBarPath(x0: number, x1: number, y: number, h: number, r = 4): string {
  const w = Math.max(0, x1 - x0);
  const rr = Math.min(r, w, h / 2);
  return `M${x0},${y}H${x1 - rr}A${rr},${rr} 0 0 1 ${x1},${y + rr}V${y + h - rr}A${rr},${rr} 0 0 1 ${x1 - rr},${y + h}H${x0}Z`;
}

/** Legend list; `kind` mirrors the mark (rect for bars/areas, line for lines, dot for dots). */
export function legend(entries: readonly LegendEntry[], kind: 'rect' | 'line' | 'dot' = 'rect'): TemplateResult {
  return html`<ul class="legend" data-legend>
    ${entries.map(
      (e) => html`<li data-legend-key=${e.key}>
        <span class="key ${kind}" style="--c:${e.color}"></span><span>${e.label}</span>
      </li>`,
    )}
  </ul>`;
}

/** Short line key for a tooltip row. */
export function tipKey(color: string): TemplateResult {
  return html`<span class="key line" style="--c:${color}"></span>`;
}

// ---------------------------------------------------------------------------------- styles

export const chartStyles = [
  vizTokens,
  css`
    :host {
      display: block;
      position: relative;
      font-family: var(--mc-font, system-ui, sans-serif);
      color: var(--mc-text, CanvasText);
      --chart-surface: var(--mc-surface, Canvas);
      --chart-grid: color-mix(in oklab, var(--mc-border, GrayText), transparent 35%);
      --chart-muted: var(--mc-text-muted, GrayText);
    }
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }
    .plot {
      position: relative;
      min-width: 0;
    }
    svg {
      display: block;
      overflow: visible;
      font-size: 11px;
    }
    .tick {
      fill: var(--chart-muted);
      font-variant-numeric: tabular-nums;
    }
    .axis-label {
      fill: var(--chart-muted);
      font-size: 11px;
    }
    .grid {
      stroke: var(--chart-grid);
      stroke-width: 1;
    }
    .baseline {
      stroke: var(--mc-border, GrayText);
      stroke-width: 1;
    }
    .hit {
      fill: transparent;
    }
    .legend {
      list-style: none;
      display: flex;
      flex-wrap: wrap;
      gap: 4px 14px;
      margin: 6px 0 0;
      padding: 0;
      font-size: 12px;
      color: var(--chart-muted);
    }
    .legend li {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .key {
      flex: none;
      display: inline-block;
      background: var(--c);
    }
    .key.rect {
      width: 10px;
      height: 10px;
      border-radius: 2px;
    }
    .key.dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .key.line {
      width: 12px;
      height: 2px;
      border-radius: 1px;
    }
    .tip {
      position: absolute;
      z-index: 2;
      pointer-events: none;
      max-width: min(280px, 90vw);
      padding: 6px 8px;
      border-radius: 6px;
      background: var(--chart-surface);
      border: 1px solid var(--mc-border, GrayText);
      box-shadow: 0 4px 16px rgb(0 0 0 / 0.16);
      font-size: 12px;
      line-height: 1.35;
      color: var(--chart-muted);
      white-space: nowrap;
    }
    .tip strong {
      color: var(--mc-text, CanvasText);
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .tip .row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tip .head {
      color: var(--mc-text, CanvasText);
    }
    .note {
      margin: 4px 0 0;
      font-size: 12px;
      color: var(--chart-muted);
    }
    .empty {
      margin: 0;
      padding: 12px 0;
      color: var(--chart-muted);
      font-size: 13px;
    }
  `,
];

// ---------------------------------------------------------------------------------- base element

export interface Tip {
  /** Anchor position in px relative to the `[data-measure]` element. */
  x: number;
  y: number;
  content: TemplateResult;
}

/**
 * Base for the charts: `width` tracks the `[data-measure]` element in the shadow root (else the
 * host) with a ResizeObserver; `tip` is a tooltip rendered by {@link renderTip} inside that
 * element (which is `position: relative`).
 */
export abstract class ChartBase extends LitElement {
  static override properties: PropertyDeclarations = {
    width: { state: true },
    tip: { state: true },
  };

  /** Measured width (px) of the plot area container. */
  declare width: number;
  declare tip: Tip | null;

  #ro: ResizeObserver | undefined;
  #observed: Element | undefined;

  constructor() {
    super();
    this.width = 0;
    this.tip = null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      if (!e) return;
      const w = Math.floor(e.contentRect.width);
      if (w !== this.width) this.width = w;
    });
    this.#observed = undefined;
    if (this.hasUpdated) this.#observe();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#ro?.disconnect();
    this.#ro = undefined;
    this.#observed = undefined;
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    this.#observe();
  }

  #observe(): void {
    const target = this.renderRoot.querySelector('[data-measure]') ?? this;
    if (target === this.#observed || !this.#ro) return;
    if (this.#observed) this.#ro.unobserve(this.#observed);
    this.#observed = target;
    // the observer reports the initial size too (no synchronous re-render from `updated`)
    this.#ro.observe(target);
  }

  /** Pointer position relative to `el`. */
  protected pointerIn(ev: MouseEvent, el: Element): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  protected showTip(x: number, y: number, content: TemplateResult): void {
    this.tip = { x, y, content };
  }

  protected hideTip(): void {
    if (this.tip) this.tip = null;
  }

  /** The tooltip, placed beside the anchor on the side with more room. */
  protected renderTip(t: Tip | null = this.tip): TemplateResult | typeof nothing {
    if (!t) return nothing;
    const right = t.x > this.width / 2;
    const tx = right ? 'calc(-100% - 12px)' : '12px';
    return html`<div class="tip" role="tooltip" data-tip style="left:${t.x}px;top:${t.y}px;transform:translate(${tx}, -50%)">
      ${t.content}
    </div>`;
  }
}
