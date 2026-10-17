/** Toast stack bound to NotificationsModel. Errors are announced assertively. */
import { css, html, nothing } from 'lit';
import type { Toast } from '@meshcore-web/core/app';
import { AppElement } from '../app-context.js';
import { shared } from '../styles.js';

const ICON: Record<Toast['kind'], string> = { info: 'ℹ', success: '✓', warning: '!', error: '✕' };

export class McToasts extends AppElement {
  static override styles = [
    shared,
    css`
      :host {
        display: contents;
      }
      .stack {
        /* the popover (top layer) keeps toasts above dialogs; reset UA popover styles */
        position: fixed;
        inset: auto calc(16px + env(safe-area-inset-right, 0px)) calc(16px + env(safe-area-inset-bottom, 0px)) auto;
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        overflow: visible;
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: min(380px, calc(100vw - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
        pointer-events: none;
      }
      .toast {
        pointer-events: auto;
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 10px;
        align-items: start;
        padding: 10px 12px;
        border-radius: var(--mc-radius);
        background: var(--mc-surface);
        border: 1px solid var(--mc-border);
        border-inline-start: 4px solid var(--kind);
        box-shadow: 0 6px 24px rgb(0 0 0 / 0.18);
        --kind: var(--mc-accent);
      }
      .toast[data-kind='success'] {
        --kind: var(--mc-ok);
      }
      .toast[data-kind='warning'] {
        --kind: var(--mc-warn);
      }
      .toast[data-kind='error'] {
        --kind: var(--mc-danger);
      }
      .icon {
        color: var(--kind);
        font-weight: 700;
      }
      .msg {
        font-weight: 600;
      }
      .detail {
        font-size: 0.9em;
        color: var(--mc-text-muted);
        overflow-wrap: anywhere;
      }
      button {
        min-height: 0;
        padding: 2px 8px;
        border: 0;
        background: transparent;
      }
      @media (max-width: 640px) {
        .stack {
          inset: calc(8px + env(safe-area-inset-top, 0px)) calc(8px + env(safe-area-inset-right, 0px)) auto
            calc(8px + env(safe-area-inset-left, 0px));
          width: auto;
        }
      }
    `,
  ];

  override firstUpdated(): void {
    const stack = this.renderRoot.querySelector<HTMLElement>('.stack');
    if (stack && 'showPopover' in stack) {
      try {
        stack.showPopover();
      } catch {
        /* already open */
      }
    }
  }

  override render() {
    const toasts = this.app.notifications.toasts.value;
    return html`<div class="stack" popover="manual">
      <div role="status" aria-live="polite" aria-atomic="false">
        ${toasts.filter((t) => t.kind !== 'error').map((t) => this.#toast(t))}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="false">
        ${toasts.filter((t) => t.kind === 'error').map((t) => this.#toast(t))}
      </div>
    </div>`;
  }

  #toast(t: Toast) {
    return html`<div class="toast" data-kind=${t.kind} data-id=${t.id} style="margin-block-end:8px">
      <span class="icon" aria-hidden="true">${ICON[t.kind]}</span>
      <div>
        <div class="msg">${t.message}</div>
        ${t.detail ? html`<div class="detail">${t.detail}</div>` : nothing}
      </div>
      <button aria-label="Dismiss notification" @click=${() => this.app.notifications.dismiss(t.id)}>✕</button>
    </div>`;
  }
}

customElements.define('mc-toasts', McToasts);

declare global {
  interface HTMLElementTagNameMap {
    'mc-toasts': McToasts;
  }
}
