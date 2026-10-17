/**
 * Connection progress bars.
 *
 * - `<mc-progress-bar .fraction .label>`: a determinate bar (role="progressbar", 0..100) with a
 *   moving sheen so it visibly shows work while the fraction holds still. `thin` styles it as a
 *   3px edge bar.
 * - `<mc-connect-progress>`: the Chrome-style loading bar along the top of the app, bound to
 *   `ConnectionModel.handshake`. On a successful connect it fills to 100% and fades out; on
 *   failure or cancel it goes away at once.
 */
import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import type { HandshakeProgress } from '@meshcore-web/core/app';
import { AppElement } from '../app-context.js';

/** How long the finished bar lingers (fill + fade) before it is removed. */
const FINISH_MS = 450;

export class McProgressBar extends LitElement {
  static override properties = {
    fraction: { type: Number },
    label: { type: String },
    thin: { type: Boolean, reflect: true },
    done: { type: Boolean, reflect: true },
  };

  static override styles = css`
    :host {
      display: block;
      --bar-height: 0.5rem;
      --bar-radius: 999px;
    }
    :host([thin]) {
      --bar-height: 3px;
      --bar-radius: 0;
    }
    .track {
      position: relative;
      height: var(--bar-height);
      border-radius: var(--bar-radius);
      background: var(--mc-accent-soft);
      overflow: hidden;
    }
    :host([thin]) .track {
      background: transparent;
    }
    .fill {
      position: absolute;
      inset: 0;
      background: var(--mc-accent);
      border-radius: inherit;
      transform-origin: left center;
      transition: transform 0.3s ease-out;
      overflow: hidden;
    }
    :host(:dir(rtl)) .fill {
      transform-origin: right center;
    }
    /* sheen sweeping across the filled part: "still working" even when the fraction holds */
    .fill::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, transparent, color-mix(in oklab, var(--mc-accent-text) 55%, transparent), transparent);
      transform: translateX(-100%);
      animation: sheen 1.2s ease-in-out infinite;
    }
    :host([done]) .fill::after {
      display: none;
    }
    @keyframes sheen {
      to {
        transform: translateX(100%);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .fill {
        transition: none;
      }
      .fill::after {
        display: none;
      }
    }
  `;

  /** 0..1 */
  declare fraction: number;
  declare label: string;
  declare thin: boolean;
  declare done: boolean;

  constructor() {
    super();
    this.fraction = 0;
    this.label = '';
    this.thin = false;
    this.done = false;
  }

  override render() {
    const f = Math.max(0, Math.min(1, Number.isFinite(this.fraction) ? this.fraction : 0));
    const pct = Math.round(f * 100);
    return html`<div
      class="track"
      role="progressbar"
      aria-label="Connection progress"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${pct}
      aria-valuetext=${this.label ? `${this.label}, ${pct}%` : `${pct}%`}
    >
      <div class="fill" style=${`transform: scaleX(${f})`}></div>
    </div>`;
  }
}

export class McConnectProgress extends AppElement {
  static override styles = css`
    :host {
      display: block;
      pointer-events: none;
    }
    mc-progress-bar {
      transition: opacity 0.3s ease-in 0.15s;
    }
    mc-progress-bar[done] {
      opacity: 0;
    }
    @media (prefers-reduced-motion: reduce) {
      mc-progress-bar {
        transition: none;
      }
    }
  `;

  /** The last progress of a connect that just succeeded, shown full while it fades out. */
  #finishing: HandshakeProgress | null = null;
  #finishTimer: ReturnType<typeof setTimeout> | undefined;
  #last: HandshakeProgress | null = null;

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const conn = this.app.connection;
    const hs = conn.handshake.peek();
    if (hs) {
      this.#stopFinish();
    } else if (this.#last && conn.phase.peek() === 'connected') {
      this.#finishing = this.#last;
      clearTimeout(this.#finishTimer);
      this.#finishTimer = setTimeout(() => {
        this.#finishing = null;
        this.requestUpdate();
      }, FINISH_MS);
    } else if (conn.phase.peek() !== 'connected') {
      this.#stopFinish();
    }
    this.#last = hs;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#stopFinish();
  }

  #stopFinish(): void {
    clearTimeout(this.#finishTimer);
    this.#finishTimer = undefined;
    this.#finishing = null;
  }

  override render() {
    const conn = this.app.connection;
    const hs = conn.handshake.value;
    void conn.phase.value; // re-render on phase changes (finish vs. failure)
    const shown = hs ?? this.#finishing;
    if (!shown) return nothing;
    // one template for both states so the same bar animates to full, then fades
    const done = !hs;
    return html`<mc-progress-bar
      thin
      data-field="connect-progress"
      ?done=${done}
      .fraction=${done ? 1 : shown.fraction}
      .label=${done ? 'Connected' : shown.label}
    ></mc-progress-bar>`;
  }
}

customElements.define('mc-progress-bar', McProgressBar);
customElements.define('mc-connect-progress', McConnectProgress);

declare global {
  interface HTMLElementTagNameMap {
    'mc-progress-bar': McProgressBar;
    'mc-connect-progress': McConnectProgress;
  }
}
