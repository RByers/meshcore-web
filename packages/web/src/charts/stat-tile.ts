/**
 * `<mc-stat-tile>`: label, one big value, optional sub-text. Numbers are auto-compacted
 * (1,284 / 12.9K); strings are shown as given. `hint` becomes the tile's tooltip.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { formatNumber } from './chart-base.js';

export class McStatTile extends LitElement {
  static override properties = {
    label: { type: String },
    value: { attribute: false },
    sub: { type: String },
    hint: { type: String },
  };

  static override styles = css`
    :host {
      display: block;
      min-width: 0;
      font-family: var(--mc-font, system-ui, sans-serif);
    }
    .tile {
      padding: 10px 12px;
      border-radius: var(--mc-radius, 10px);
      background: var(--mc-surface, Canvas);
      border: 1px solid var(--mc-border, GrayText);
      box-sizing: border-box;
      height: 100%;
    }
    .label {
      font-size: 12px;
      color: var(--mc-text-muted, GrayText);
    }
    .value {
      font-size: 1.6rem;
      font-weight: 600;
      line-height: 1.2;
      color: var(--mc-text, CanvasText);
      overflow-wrap: anywhere;
    }
    .sub {
      font-size: 12px;
      color: var(--mc-text-muted, GrayText);
    }
  `;

  declare label: string;
  declare value: number | string | null;
  declare sub: string;
  declare hint: string;

  constructor() {
    super();
    this.label = '';
    this.value = null;
    this.sub = '';
    this.hint = '';
  }

  override render(): TemplateResult {
    const v = this.value;
    const text = v === null || (typeof v === 'number' && !Number.isFinite(v)) ? '—' : typeof v === 'number' ? formatNumber(v) : v;
    return html`<div class="tile" data-chart="stat" title=${this.hint || nothing}>
      <div class="label">${this.label}</div>
      <div class="value" data-field="value">${text}</div>
      ${this.sub ? html`<div class="sub" data-field="sub">${this.sub}</div>` : nothing}
    </div>`;
  }
}

customElements.define('mc-stat-tile', McStatTile);

declare global {
  interface HTMLElementTagNameMap {
    'mc-stat-tile': McStatTile;
  }
}
