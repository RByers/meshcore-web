/**
 * `<mc-stats-range>`: the date-range / bin-size filter row shared by the packet log Stats tab and
 * the contact Stats tab (docs/packet-stats.md §3, §5). Bound to `app.packetStats`: presets
 * (*All* = the whole log, the default), a custom `from` / `to` pair, and the timeline bin size.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { signal } from '@meshcore-web/core/app';
import { AppElement } from '../app-context.js';
import { shared } from '../styles.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Preset {
  id: string;
  label: string;
  /** Length of the window ending now; null = whole log. */
  ms: number | null;
}

export const RANGE_PRESETS: readonly Preset[] = [
  { id: 'all', label: 'All', ms: null },
  { id: '1h', label: 'Last hour', ms: HOUR },
  { id: '24h', label: '24 h', ms: DAY },
  { id: '7d', label: '7 d', ms: 7 * DAY },
];

export const BIN_OPTIONS: readonly { label: string; value: number | 'auto' }[] = [
  { label: 'auto', value: 'auto' },
  { label: '1 min', value: 60_000 },
  { label: '5 min', value: 5 * 60_000 },
  { label: '1 h', value: HOUR },
  { label: '1 d', value: DAY },
];

/** `datetime-local` value (local time, minute precision) for an epoch ms, '' for null. */
export function toLocalInput(ts: number | null): string {
  if (ts === null) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Epoch ms for a `datetime-local` value, null when empty / invalid. */
export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * The preset that produced the current model range ('custom' after a manual edit). Module-level so
 * every instance (packets tab, contact tab) highlights the same button for the shared range.
 */
const activePreset = signal<string>('all');

export class McStatsRange extends AppElement {

  static override styles = [
    shared,
    css`
      :host {
        display: block;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 12px;
      }
      .presets {
        display: inline-flex;
        gap: 4px;
      }
      .presets button[aria-pressed='true'] {
        background: var(--mc-accent);
        color: var(--mc-accent-text);
        border-color: var(--mc-accent);
      }
      label {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--mc-text-muted);
        font-size: 13px;
      }
      input,
      select {
        font: inherit;
        color: var(--mc-text);
        background: var(--mc-surface);
        border: 1px solid var(--mc-border);
        border-radius: 6px;
        padding: 3px 6px;
      }
    `,
  ];

  async #applyPreset(p: Preset): Promise<void> {
    activePreset.value = p.id;
    const now = this.app.clock.now();
    await this.app.packetStats.setRange(p.ms === null ? { from: null, to: null } : { from: now - p.ms, to: null });
  }

  async #applyCustom(which: 'from' | 'to', value: string): Promise<void> {
    activePreset.value = 'custom';
    const cur = this.app.packetStats.range.peek();
    const ts = fromLocalInput(value);
    await this.app.packetStats.setRange({ ...cur, [which]: ts });
  }

  override render(): TemplateResult {
    const stats = this.app.packetStats;
    const range = stats.range.value;
    const bin = stats.bin.value;
    const bounds = stats.bounds.value;
    const preset = range.from === null && range.to === null ? 'all' : activePreset.value;
    return html`<div class="row" data-stats-range>
      <span class="presets" role="group" aria-label="Date range">
        ${RANGE_PRESETS.map(
          (p) => html`<button
            type="button"
            data-preset=${p.id}
            aria-pressed=${preset === p.id ? 'true' : 'false'}
            @click=${() => void this.#applyPreset(p)}
          >
            ${p.label}
          </button>`,
        )}
      </span>
      <label
        >From
        <input
          type="datetime-local"
          data-range="from"
          .value=${toLocalInput(range.from)}
          min=${bounds ? toLocalInput(bounds.first) : nothing}
          @change=${(e: Event) => void this.#applyCustom('from', (e.target as HTMLInputElement).value)}
        />
      </label>
      <label
        >To
        <input
          type="datetime-local"
          data-range="to"
          .value=${toLocalInput(range.to)}
          max=${bounds ? toLocalInput(bounds.last) : nothing}
          @change=${(e: Event) => void this.#applyCustom('to', (e.target as HTMLInputElement).value)}
        />
      </label>
      <label
        >Bin
        <select data-bin @change=${(e: Event) => stats.setBin(parseBin((e.target as HTMLSelectElement).value))}>
          ${BIN_OPTIONS.map((o) => html`<option value=${String(o.value)} ?selected=${bin === o.value}>${o.label}</option>`)}
        </select>
      </label>
      ${stats.loading.value ? html`<span class="muted" data-loading>Loading…</span>` : nothing}
    </div>`;
  }
}

function parseBin(v: string): number | 'auto' {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 'auto';
}

customElements.define('mc-stats-range', McStatsRange);

declare global {
  interface HTMLElementTagNameMap {
    'mc-stats-range': McStatsRange;
  }
}
