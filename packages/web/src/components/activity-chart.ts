/**
 * `<mc-activity-chart>`: a bar chart of packets per time slot (a core `NodeActivity`). One series,
 * so no legend (the surrounding heading names it). Bars are HTML so they stay crisp at any width;
 * each bar has a hover / focus tooltip, and a table view lists the non-empty slots.
 *
 * Test hooks: `[data-bar]` (slot index, `data-count`), `[data-field="tooltip"]`,
 * `[data-field="activity-table"]`.
 */
import { LitElement, css, html, nothing } from 'lit';
import type { NodeActivity } from '@meshcore-web/core/app';

const HOUR = 3_600_000;

function slotLabel(start: number, end: number, bucketMs: number): string {
  const s = new Date(start);
  const day = s.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (bucketMs >= 24 * HOUR) return day;
  const t = (d: Date): string => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day} ${t(s)}–${t(new Date(end))}`;
}

function axisLabel(ts: number, bucketMs: number): string {
  const d = new Date(ts);
  return bucketMs >= 6 * HOUR ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const plural = (n: number): string => `${n} packet${n === 1 ? '' : 's'}`;

export class McActivityChart extends LitElement {
  static override properties = { activity: { attribute: false }, hover: { state: true } };

  static override styles = css`
    :host {
      display: block;
    }
    .plot {
      position: relative;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0 6px;
    }
    .y {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--mc-text-muted);
      text-align: end;
      height: 120px;
    }
    .bars {
      position: relative;
      display: flex;
      align-items: flex-end;
      gap: 2px;
      height: 120px;
      border-block-end: 1px solid var(--mc-border);
      background: linear-gradient(var(--mc-border), var(--mc-border)) top / 100% 1px no-repeat;
    }
    .slot {
      flex: 1;
      height: 100%;
      display: flex;
      align-items: flex-end;
      outline: none;
      cursor: default;
    }
    .bar {
      width: 100%;
      background: var(--mc-accent);
      border-radius: 4px 4px 0 0;
      min-height: 0;
    }
    .slot[data-count='0'] .bar {
      display: none;
    }
    .slot:hover .bar,
    .slot:focus-visible .bar {
      filter: brightness(1.15);
    }
    .slot:focus-visible {
      box-shadow: inset 0 0 0 2px var(--mc-focus);
      border-radius: 3px;
    }
    .x {
      grid-column: 2;
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--mc-text-muted);
      margin-block-start: 2px;
    }
    .tip {
      position: absolute;
      top: 4px;
      left: 0;
      max-width: 100%;
      box-sizing: border-box;
      background: var(--mc-surface);
      color: var(--mc-text);
      border: 1px solid var(--mc-border);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 0.8rem;
      pointer-events: none;
      box-shadow: 0 2px 8px rgb(0 0 0 / 0.15);
      z-index: 1;
    }
    .tip strong {
      font-variant-numeric: tabular-nums;
    }
    details {
      margin-block-start: 6px;
      font-size: 0.85rem;
    }
    table {
      border-collapse: collapse;
      margin-block-start: 4px;
    }
    td,
    th {
      padding: 2px 10px 2px 0;
      text-align: start;
    }
    td.n {
      text-align: end;
      font-variant-numeric: tabular-nums;
    }
  `;

  declare activity: NodeActivity | undefined;
  declare hover: number | null;

  constructor() {
    super();
    this.activity = undefined;
    this.hover = null;
  }

  /** Centres the tooltip over the hovered bar, clamped inside the plot. */
  protected override updated(): void {
    const tip = this.renderRoot.querySelector<HTMLElement>('.tip');
    const bars = this.renderRoot.querySelector<HTMLElement>('.bars');
    const n = this.activity?.buckets.length ?? 0;
    if (!tip || !bars || this.hover === null || !n) return;
    const w = bars.clientWidth;
    const centre = ((this.hover + 0.5) / n) * w;
    tip.style.left = `${Math.max(0, Math.min(w - tip.offsetWidth, centre - tip.offsetWidth / 2))}px`;
  }

  override render() {
    const a = this.activity;
    if (!a) return nothing;
    const max = Math.max(1, a.max);
    const hovered = this.hover !== null ? a.buckets[this.hover] : undefined;
    const used = a.buckets.filter((b) => b.count > 0);
    return html`
      <div class="plot">
        <div class="y" aria-hidden="true"><span>${a.max}</span><span>0</span></div>
        <div class="bars" role="list" aria-label=${`${plural(a.total)} per slot`} @pointerleave=${() => (this.hover = null)}>
          ${a.buckets.map(
            (b, i) => html`<div
              class="slot"
              role="listitem"
              tabindex=${b.count ? '0' : '-1'}
              data-bar=${i}
              data-count=${b.count}
              aria-label=${`${slotLabel(b.start, b.end, a.bucketMs)}: ${plural(b.count)}`}
              @pointerenter=${() => (this.hover = i)}
              @focus=${() => (this.hover = i)}
              @blur=${() => (this.hover = null)}
            >
              <div class="bar" style=${`height:${(b.count / max) * 100}%`}></div>
            </div>`,
          )}
          ${hovered
            ? html`<div class="tip" data-field="tooltip" role="status">
                ${slotLabel(hovered.start, hovered.end, a.bucketMs)} · <strong>${plural(hovered.count)}</strong>
              </div>`
            : nothing}
        </div>
        <div class="x" aria-hidden="true"><span>${axisLabel(a.from, a.bucketMs)}</span><span>now</span></div>
      </div>
      ${used.length
        ? html`<details>
            <summary>Table</summary>
            <table data-field="activity-table">
              <thead><tr><th scope="col">Time</th><th scope="col">Packets</th></tr></thead>
              <tbody>
                ${used.map((b) => html`<tr><td>${slotLabel(b.start, b.end, a.bucketMs)}</td><td class="n">${b.count}</td></tr>`)}
              </tbody>
            </table>
          </details>`
        : nothing}
    `;
  }
}

customElements.define('mc-activity-chart', McActivityChart);

declare global {
  interface HTMLElementTagNameMap {
    'mc-activity-chart': McActivityChart;
  }
}
