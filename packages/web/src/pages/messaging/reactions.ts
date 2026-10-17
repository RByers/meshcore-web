/**
 * Emoji reactions UI (MeshCore Open compatible, feature-inventory.md §2.4b): the chips under a
 * bubble, the react button, long-press / right-click to open the picker, and the picker dialog
 * (quick set plus the full table by category). Logic lives in the core ChatModel / reactions.ts.
 */
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { REACTION_EMOJI_CATEGORIES, REACTION_QUICK_EMOJIS, type ReactionChip, type ReactionEmojiCategory } from '@meshcore-web/core/app';
import { shared } from '../../styles.js';
import { listStyles } from './common.js';

/** Styles for the chips and react button; add to the chat page's styles. */
export const reactionStyles = css`
  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 2px 8px 0;
  }
  .reaction {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 0;
    padding: 1px 8px;
    border-radius: 999px;
    border: 1px solid var(--mc-border);
    background: var(--mc-surface-2);
    color: var(--mc-text);
    font-size: 0.9rem;
    line-height: 1.4;
  }
  .reaction[data-own] {
    border-color: var(--mc-accent);
  }
  .reaction[data-state='pending'] {
    opacity: 0.5;
  }
  .reaction[data-state='failed'] {
    border-color: var(--mc-danger);
    color: var(--mc-danger);
  }
  .reaction .count {
    font-size: 0.75rem;
    font-weight: 700;
  }
`;

/** "Bob, Carol and you" style tooltip. */
function sendersLabel(chip: ReactionChip): string {
  return `${chip.emoji} ${chip.senders.join(', ')}`;
}

/**
 * The chips under a bubble: one per emoji with its count; the tooltip lists who reacted. Our own
 * pending reaction is dimmed; a failed one is a retry button.
 */
export function reactionChipsTemplate(chips: readonly ReactionChip[], onRetry: (emoji: string) => void): TemplateResult | typeof nothing {
  if (!chips.length) return nothing;
  return html`<div class="reactions" data-field="reactions">
    ${chips.map((c) => {
      const failed = c.state === 'failed';
      const content = html`<span>${c.emoji}</span>${c.count > 1 ? html`<span class="count">${c.count}</span>` : nothing}${c.state === 'pending'
          ? html`<span class="spinner" aria-hidden="true"></span>`
          : nothing}`;
      if (failed) {
        const label = `${sendersLabel(c)}: failed, retry`;
        return html`<button
          type="button"
          class="reaction"
          data-field="reaction"
          data-action="retry-reaction"
          data-emoji=${c.emoji}
          data-state="failed"
          data-own
          title=${label}
          aria-label=${label}
          @click=${() => onRetry(c.emoji)}
        >
          ${content}<span aria-hidden="true">↻</span>
        </button>`;
      }
      const label = c.state === 'pending' ? `${sendersLabel(c)} (sending)` : sendersLabel(c);
      return html`<span class="reaction" role="img" data-field="reaction" data-emoji=${c.emoji} data-state=${c.state ?? 'done'} ?data-own=${c.own} title=${label} aria-label=${label}
        >${content}</span
      >`;
    })}
  </div>`;
}

/** Long-press detection for touch: `start` on pointerdown, `cancel` on up / move / leave. */
export class LongPress {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #x = 0;
  #y = 0;
  /** Set when the last press fired, so the click that follows can be ignored. */
  fired = false;

  constructor(private readonly ms = 500) {}

  start(e: PointerEvent, cb: () => void): void {
    this.cancel();
    this.fired = false;
    if (e.pointerType === 'mouse') return; // desktop: right-click / the react button
    this.#x = e.clientX;
    this.#y = e.clientY;
    this.#timer = setTimeout(() => {
      this.fired = true;
      cb();
    }, this.ms);
  }

  move(e: PointerEvent): void {
    if (Math.hypot(e.clientX - this.#x, e.clientY - this.#y) > 10) this.cancel();
  }

  cancel(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

export interface ReactionPickEventDetail {
  emoji: string;
}

/**
 * The emoji picker dialog (MeshCore Open `EmojiPicker`): the quick row, then tabs Smileys /
 * Gestures / Hearts / Objects. `open()` shows it modally; picking fires `reaction-pick`.
 */
export class McReactionPicker extends LitElement {
  static override styles = [
    shared,
    listStyles,
    css`
      dialog {
        width: min(26rem, calc(100vw - 32px));
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      h3 {
        margin: 0;
      }
      .quick,
      .grid {
        display: grid;
        gap: 4px;
      }
      .quick {
        grid-template-columns: repeat(6, 1fr);
        padding-block: 10px;
        border-block-end: 1px solid var(--mc-border);
      }
      .grid {
        grid-template-columns: repeat(auto-fill, minmax(2.5rem, 1fr));
        max-height: 40dvh;
        overflow-y: auto;
        padding-block-start: 8px;
      }
      .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding-block-start: 8px;
      }
      .tabs button {
        min-height: 0;
        padding: 2px 10px;
        border-radius: 999px;
      }
      .tabs button[aria-selected='true'] {
        background: var(--mc-accent-soft);
        border-color: var(--mc-accent);
      }
      .emoji {
        font-size: 1.4rem;
        min-height: 2.5rem;
        padding: 0;
        border: 0;
        background: transparent;
        border-radius: 8px;
      }
      .quick .emoji {
        background: var(--mc-surface-2);
      }
      .emoji:hover {
        background: var(--mc-accent-soft);
      }
    `,
  ];

  #tab: ReactionEmojiCategory['id'] = 'smileys';

  #dialog(): HTMLDialogElement | null {
    return this.renderRoot.querySelector('dialog');
  }

  get isOpen(): boolean {
    return this.#dialog()?.open ?? false;
  }

  async open(): Promise<void> {
    await this.updateComplete;
    const d = this.#dialog();
    if (d && !d.open) d.showModal();
  }

  close(): void {
    this.#dialog()?.close();
  }

  #pick(emoji: string): void {
    this.close();
    this.dispatchEvent(new CustomEvent<ReactionPickEventDetail>('reaction-pick', { detail: { emoji } }));
  }

  #button(emoji: string) {
    return html`<button type="button" class="emoji" data-emoji=${emoji} aria-label=${`React ${emoji}`} @click=${() => this.#pick(emoji)}>${emoji}</button>`;
  }

  override render() {
    const cat = REACTION_EMOJI_CATEGORIES.find((c) => c.id === this.#tab) ?? REACTION_EMOJI_CATEGORIES[0]!;
    return html`<dialog id="reaction-picker" closedby="any" aria-labelledby="reaction-h" data-field="reaction-picker">
      <header>
        <h3 id="reaction-h">Add reaction</h3>
        <button type="button" data-action="close-picker" aria-label="Close" @click=${() => this.close()}>✕</button>
      </header>
      <div class="quick" data-field="quick-emojis">${REACTION_QUICK_EMOJIS.map((e) => this.#button(e))}</div>
      <div class="tabs" role="tablist">
        ${REACTION_EMOJI_CATEGORIES.map(
          (c) =>
            html`<button
              type="button"
              role="tab"
              data-tab=${c.id}
              aria-selected=${c.id === cat.id ? 'true' : 'false'}
              @click=${() => {
                this.#tab = c.id;
                this.requestUpdate();
              }}
            >
              ${c.label}
            </button>`,
        )}
      </div>
      <div class="grid" role="tabpanel" data-field="emoji-grid" aria-label=${cat.label}>${cat.emojis.map((e) => this.#button(e))}</div>
    </dialog>`;
  }
}

customElements.define('mc-reaction-picker', McReactionPicker);

declare global {
  interface HTMLElementTagNameMap {
    'mc-reaction-picker': McReactionPicker;
  }
  interface HTMLElementEventMap {
    'reaction-pick': CustomEvent<ReactionPickEventDetail>;
  }
}
