/**
 * One conversation: `/channel/:key` (mode="channel"), or a DM (mode="contact") embedded in the
 * node page's Messages tab (`/node/:key/messages`, `embedded`: no header — the node page shows it).
 * Bubbles with status for outgoing messages, auto-scroll with a "new messages" affordance,
 * composer with byte counter (Enter sends, Shift+Enter newline) and replies. A "New messages"
 * divider marks where the unread messages began when the conversation was opened
 * (`ChatModel.firstUnreadId`); on open the log scrolls to it instead of the bottom.
 */
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { parseReply, receivedSignal, type ChatModel } from '@meshcore-web/core/app';
import type { ConversationType, MessageRecord } from '@meshcore-web/core/store';
import { smazSizes } from '@meshcore-web/core/util/smaz';
import { AppElement } from '../../app-context.js';
import { formatDuration, formatSnr, formatTime } from '../../format.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { avatar, listStyles } from './common.js';
import { contactNote, nodeHref, pathLabelView } from '../../components/node-link.js';
import { LongPress, reactionChipsTemplate, reactionStyles, type McReactionPicker } from './reactions.js';

/** Distance from the bottom (px) still counted as "at the bottom". */
const STICKY_PX = 48;

export class McChatPage extends AppElement {
  static override properties = { params: { attribute: false }, mode: { type: String }, embedded: { type: Boolean, reflect: true } };
  declare params: Readonly<Record<string, string>> | undefined;
  declare mode: string | null;
  /** Inside another page (the node page's Messages tab): no header, fills the parent's flex box. */
  declare embedded: boolean;

  constructor() {
    super();
    this.embedded = false;
  }

  static override styles = [
    shared,
    listStyles,
    reactionStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: calc(100dvh - 6.5rem);
        min-height: 20rem;
      }
      :host([embedded]) {
        height: auto;
        flex: 1;
        min-height: 0;
      }
      /* On narrow screens the actions wrap onto their own row instead of squeezing the name/subtitle. */
      header.chat-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 10px;
        padding-block-end: 10px;
        border-block-end: 1px solid var(--mc-border);
      }
      header .back {
        text-decoration: none;
        font-size: 1.2rem;
        padding: 4px 8px;
      }
      header .who {
        flex: 1 1 12rem;
        min-width: 0;
      }
      header .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-inline-start: auto;
      }
      @media (max-width: 30rem) {
        header .actions {
          flex: 1 1 100%;
        }
        header .actions > * {
          flex: 1 1 0;
          justify-content: center;
          white-space: nowrap;
        }
      }
      header h2 {
        margin: 0;
        font-size: 1.15rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .log-wrap {
        position: relative;
        flex: 1;
        min-height: 0;
      }
      .log {
        height: 100%;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 12px 4px;
      }
      ol.messages {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .msg {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        max-width: min(36rem, 80%);
      }
      .msg[data-dir='out'] {
        align-self: flex-end;
        align-items: flex-end;
      }
      .sender {
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--mc-accent);
        margin-inline: 10px;
      }
      a.sender {
        text-decoration: none;
      }
      a.sender:hover,
      button.sender:hover {
        text-decoration: underline;
      }
      button.sender {
        min-height: 0;
        padding: 0;
        border: 0;
        background: transparent;
        font: inherit;
        font-size: 0.8rem;
        cursor: pointer;
      }
      .bubble {
        padding: 6px 10px;
        border-radius: 14px;
        background: var(--mc-surface);
        border: 1px solid var(--mc-border);
        overflow-wrap: anywhere;
      }
      /* pre-wrap only on the message text: on .bubble it would render the template's indentation. */
      .bubble [data-field='text'] {
        white-space: pre-wrap;
      }
      .msg[data-dir='out'] .bubble {
        background: var(--mc-accent-soft);
        border-color: transparent;
      }
      .msg[data-status='failed'] .bubble {
        border-color: var(--mc-danger);
      }
      .msg[data-status='pending'] .bubble {
        opacity: 0.7;
      }
      .quote {
        display: block;
        border-inline-start: 3px solid var(--mc-accent);
        padding-inline-start: 6px;
        margin-block-end: 4px;
        font-size: 0.85rem;
        color: var(--mc-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
      }
      .meta {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.75rem;
        color: var(--mc-text-muted);
        margin-inline: 8px;
      }
      .meta .smaz {
        display: inline-flex;
        cursor: help;
      }
      .meta button {
        min-height: 0;
        padding: 0 6px;
        font-size: 0.75rem;
        border: 0;
        background: transparent;
        color: var(--mc-text-muted);
      }
      .meta button.retry {
        color: var(--mc-danger);
        font-weight: 600;
      }
      .status[data-status='delivered'] {
        color: var(--mc-ok);
      }
      .status[data-status='failed'] {
        color: var(--mc-danger);
      }
      .spinner {
        display: inline-block;
        width: 0.8em;
        height: 0.8em;
        border: 2px solid currentColor;
        border-inline-end-color: transparent;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(1turn);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .spinner {
          animation: none;
        }
      }
      .unread-divider {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-block: 4px;
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--mc-accent);
      }
      .unread-divider::before,
      .unread-divider::after {
        content: '';
        flex: 1;
        border-block-start: 1px solid var(--mc-accent);
        opacity: 0.6;
      }
      .more {
        display: flex;
        justify-content: center;
        margin-block-end: 8px;
      }
      .new-messages {
        position: absolute;
        inset-block-end: 10px;
        inset-inline-start: 50%;
        translate: -50% 0;
        border-radius: 999px;
        box-shadow: 0 4px 12px rgb(0 0 0 / 0.2);
      }
      form.composer {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding-block-start: 8px;
        border-block-start: 1px solid var(--mc-border);
      }
      .compose-row {
        display: flex;
        gap: 8px;
        align-items: flex-end;
      }
      .compose-row textarea {
        flex: 1;
        resize: none;
        min-height: 2.5rem;
        max-height: 8rem;
        field-sizing: content;
      }
      .reply-banner {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.85rem;
        color: var(--mc-text-muted);
      }
      .reply-banner span {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .reply-banner button {
        min-height: 0;
        padding: 0 8px;
      }
      .compose-foot {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 4px 12px;
      }
      .bytes {
        font-size: 0.75rem;
        color: var(--mc-text-muted);
        text-align: end;
        margin-inline-start: auto;
      }
      .bytes[data-over] {
        color: var(--mc-danger);
        font-weight: 600;
      }
    `,
  ];

  #chat: ChatModel | undefined;
  #draft = '';
  #atBottom = true;
  #newBelow = false;
  #lastCount = 0;
  #lastId: number | undefined;
  /** The message the reaction picker is open for. */
  #reactTo: number | undefined;
  #longPress = new LongPress();

  get convType(): ConversationType {
    return this.mode === 'channel' ? 'channel' : 'contact';
  }

  get key(): string {
    return (this.params?.['key'] ?? '').toLowerCase();
  }

  /** The conversation model (created on first render). */
  get chat(): ChatModel | undefined {
    return this.#chat;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#chat?.setActive(true);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#chat?.setActive(false);
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (!this.key) return;
    if (!this.#chat || this.#chat.convKey !== this.key || this.#chat.convType !== this.convType) {
      this.#chat?.setActive(false);
      this.#chat = this.app.chat(this.convType, this.key);
      this.#chat.setActive(this.isConnected);
      this.#lastCount = 0;
      this.#atBottom = true;
    }
  }

  #log(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('.log');
  }

  #onScroll(): void {
    const log = this.#log();
    if (!log) return;
    this.#atBottom = log.scrollHeight - log.scrollTop - log.clientHeight <= STICKY_PX;
    if (this.#atBottom && this.#newBelow) {
      this.#newBelow = false;
      this.requestUpdate();
    }
  }

  #scrollToBottom(): void {
    const log = this.#log();
    if (log) log.scrollTop = log.scrollHeight;
    this.#atBottom = true;
    if (this.#newBelow) {
      this.#newBelow = false;
      this.requestUpdate();
    }
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    const ms = this.#chat?.messages.peek() ?? [];
    const last = ms.at(-1);
    const grew = ms.length !== this.#lastCount && last?.id !== this.#lastId;
    const first = this.#lastCount === 0 && ms.length > 0;
    this.#lastCount = ms.length;
    this.#lastId = last?.id;
    if (!grew) return;
    if (first && this.#scrollToDivider()) return;
    if (first || this.#atBottom || last?.direction === 'out') this.#scrollToBottom();
    else if (!this.#newBelow) {
      this.#newBelow = true;
      this.requestUpdate();
    }
  }

  /** Scrolls the "New messages" divider to the top of the log (if there is one). */
  #scrollToDivider(): boolean {
    const log = this.#log();
    const divider = this.renderRoot.querySelector<HTMLElement>('[data-field="unread-divider"]');
    if (!log || !divider) return false;
    log.scrollTop += divider.getBoundingClientRect().top - log.getBoundingClientRect().top - 8;
    this.#onScroll();
    return true;
  }

  async #send(): Promise<void> {
    const chat = this.#chat;
    if (!chat) return;
    const text = this.#draft;
    if (!text.trim() || chat.budget(text.trim()).over) return;
    try {
      this.#draft = '';
      this.requestUpdate();
      await chat.send(text);
      this.#scrollToBottom();
    } catch (err) {
      this.#draft = text;
      this.requestUpdate();
      this.app.notifications.error('Could not send', err);
    }
  }

  #onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.#send();
    }
  }

  async #retry(m: MessageRecord): Promise<void> {
    try {
      await this.#chat?.retry(m.id);
    } catch (err) {
      this.app.notifications.error('Could not retry', err);
    }
  }

  // ---- reactions (see reactions.ts) ----

  #openReactions(m: MessageRecord): void {
    if (!this.#chat?.canReact(m) || !this.app.connection.connected.peek()) return;
    this.#reactTo = m.id;
    void this.renderRoot.querySelector<McReactionPicker>('mc-reaction-picker')?.open();
  }

  async #react(emoji: string): Promise<void> {
    const id = this.#reactTo;
    this.#reactTo = undefined;
    if (id === undefined) return;
    try {
      await this.#chat?.react(id, emoji);
    } catch (err) {
      this.app.notifications.error('Could not react', err);
    }
  }

  async #retryReaction(m: MessageRecord, emoji: string): Promise<void> {
    try {
      await this.#chat?.retryReaction(m.id, emoji);
    } catch (err) {
      this.app.notifications.error('Could not retry the reaction', err);
    }
  }

  #reply(m: MessageRecord): void {
    this.#chat?.setReplyTo(m);
    this.renderRoot.querySelector<HTMLTextAreaElement>('[data-field="composer"]')?.focus();
  }

  async #toggleMute(): Promise<void> {
    try {
      const ch = this.#chat?.channel.peek();
      if (ch) await this.app.channels.setMuted(ch.key, !ch.muted);
    } catch (err) {
      this.app.notifications.error('Action failed', err);
    }
  }

  #status(m: MessageRecord) {
    if (m.direction !== 'out') return nothing;
    const attempts = (m.attempt ?? 0) + 1;
    const tries = this.convType === 'contact' && attempts > 1 ? html`<span data-field="attempt">attempt ${attempts}</span>` : nothing;
    switch (m.status) {
      case 'pending':
        return html`${tries}<span class="status" data-status="pending" role="img" aria-label="Sending" title="Sending"><span class="spinner"></span></span>`;
      case 'sent':
        return html`${tries}<span class="status" data-status="sent" title="Sent by the radio" role="img" aria-label="Sent">✓</span>`;
      case 'delivered':
        return html`${tries}<span
            class="status"
            data-status="delivered"
            role="img"
            title="Delivered"
            aria-label=${m.roundTripMs !== undefined ? `Delivered in ${formatDuration(m.roundTripMs)}` : 'Delivered'}
            >✓✓${m.roundTripMs !== undefined ? html` <span data-field="rtt">${formatDuration(m.roundTripMs)}</span>` : nothing}</span
          >`;
      case 'failed':
        return html`${tries}<span class="status" data-status="failed" aria-label="Failed">✕ failed</span>
          <button class="retry" data-action="retry" @click=${() => void this.#retry(m)}>Retry</button>`;
    }
  }

  #message(chat: ChatModel, m: MessageRecord) {
    const reply = parseReply(m.text);
    const quoted = reply ? chat.quotedMessage(m) : undefined;
    const showSender = this.convType === 'channel' && m.direction === 'in';
    return html`<li class="msg" data-id=${m.id} data-dir=${m.direction} data-status=${m.status}>
      ${showSender ? this.#sender(m) : nothing}
      <div
        class="bubble"
        @contextmenu=${(e: Event) => {
          if (!chat.canReact(m)) return;
          e.preventDefault();
          this.#openReactions(m);
        }}
        @pointerdown=${(e: PointerEvent) => this.#longPress.start(e, () => this.#openReactions(m))}
        @pointermove=${(e: PointerEvent) => this.#longPress.move(e)}
        @pointerup=${() => this.#longPress.cancel()}
        @pointercancel=${() => this.#longPress.cancel()}
        @pointerleave=${() => this.#longPress.cancel()}
      >
        ${reply
          ? html`<span class="quote" data-field="quote">↪ ${reply.name}${quoted ? html`: ${parseReply(quoted.text)?.text ?? quoted.text}` : nothing}</span
              ><span data-field="text">${reply.text}</span>`
          : html`<span data-field="text">${m.text}</span>`}
      </div>
      <div class="meta">
        <time datetime=${new Date(m.receivedAt).toISOString()}>${formatTime(m.receivedAt, this.app.clock.now())}</time>
        ${m.direction === 'in' ? this.#signal(m) : nothing}
        ${m.compressed ? smazIcon(m) : nothing} ${this.#status(m)}
        ${chat.canReact(m)
          ? html`<button data-action="react" aria-label="React" title="React (or right-click / long-press the message)" @click=${() => this.#openReactions(m)}>☺+</button>`
          : nothing}
        <button data-action="reply" aria-label="Reply" title="Reply" @click=${() => this.#reply(m)}>↩</button>
      </div>
      ${reactionChipsTemplate(chat.reactions(m), (emoji) => void this.#retryReaction(m, emoji))}
    </li>`;
  }

  /**
   * How an incoming message arrived (issue #11): hop count or the node-name chain (issue #3),
   * a link to the path view (issue #2),
   * and, only when it was heard zero hop, its SNR. The last-hop SNR stays in the tooltip.
   */
  #signal(m: MessageRecord) {
    const sig = receivedSignal(m);
    const path = this.app.contacts.pathLabel({ pathLen: m.pathLen, path: m.path, countLabel: sig.pathLabel }, this.app.appSettings.pathNames.value);
    const title = [path.title, sig.lastHopSnr !== undefined ? `SNR ${formatSnr(sig.lastHopSnr)}${sig.zeroHop ? '' : ' (last hop)'}` : '']
      .filter(Boolean)
      .join('\n');
    const link = pathLabelView(path, (sig.hops ?? 0) > 0 ? { kind: 'message', message: m } : null, this.#notes);
    return html`<span data-field="route"
      ><span data-field="signal" title=${title || nothing}
        ><span data-field="path">${link}</span>${sig.snr !== undefined ? html` · <span data-field="snr">SNR ${formatSnr(sig.snr)}</span>` : nothing}</span
      ></span
    >`;
  }

  /** Contact note lookup for path hop tooltips. */
  #notes = (key: string): string => this.app.contacts.noteFor(key);

  /** A channel sender: links to the contact, or to the contacts searched by a shared name (issue #12). */
  #sender(m: MessageRecord) {
    const name = m.senderName ?? 'unknown';
    const target = this.app.contacts.senderTarget(m.senderName);
    if (target.kind === 'contact') {
      return html`<a class="sender" data-field="sender" data-sender="contact" href=${nodeHref(target.key)} title="Node details">${name}${contactNote(this.app.contacts.noteFor(target.key))}</a>`;
    }
    if (target.kind === 'search') {
      return html`<button
        type="button"
        class="sender"
        data-field="sender"
        data-sender="search"
        title=${`${target.count} contacts are named ${target.name}`}
        @click=${() => {
          this.app.contacts.showByName(target.name);
          location.hash = hrefFor('/contacts');
        }}
      >${name}</button>`;
    }
    return html`<span class="sender" data-field="sender" data-sender="unknown">${name}</span>`;
  }

  /** Channel subtitle (DMs are embedded in the node page, which shows the contact's own). */
  #subtitle(chat: ChatModel): string {
    if (this.convType !== 'channel') return '';
    const ch = chat.channel.value;
    if (!ch) return 'Channel';
    return `${ch.deviceIndex !== null ? `slot ${ch.deviceIndex}` : 'not on radio'}${ch.muted ? ' · muted' : ''}`;
  }

  #header(chat: ChatModel, kind: Parameters<typeof avatar>[0]): TemplateResult | typeof nothing {
    if (this.embedded) return nothing;
    const channel = this.convType === 'channel';
    const ch = channel ? chat.channel.value : null;
    return html`<header class="chat-head">
      <a class="back" href=${hrefFor(channel ? '/channels' : '/contacts')} aria-label="Back">←</a>
      ${avatar(kind)}
      <div class="who">
        <h2 data-field="title">${chat.title.value}</h2>
        <div class="muted" data-field="subtitle">${this.#subtitle(chat)}</div>
      </div>
      ${channel
        ? html`<div class="actions" data-field="header-actions">
            <button data-action="mute" aria-pressed=${ch?.muted ? 'true' : 'false'} @click=${() => void this.#toggleMute()}>
              ${ch?.muted ? '🔕 Muted' : '🔔 Mute'}
            </button>
          </div>`
        : nothing}
    </header>`;
  }

  override render() {
    const chat = this.#chat;
    if (!chat) return html`<p class="muted">No conversation selected.</p>`;
    // Until the model's first load has published the contact / channel record, the title would be
    // the key placeholder and the composer would send with the wrong compression / byte limit.
    if (chat.loading.value) return html`<p class="muted" data-field="loading">Loading…</p>`;
    const messages = chat.messages.value;
    const unreadFrom = chat.firstUnreadId.value;
    const channel = this.convType === 'channel';
    const ch = channel ? chat.channel.value : null;
    const kind = channel ? (this.app.channels.views.value.find((c) => c.key === this.key)?.kind ?? 'private') : (this.app.contacts.view(this.key)?.typeName ?? 'chat');
    const replyTo = chat.replyTo.value;
    const limit = chat.byteLimit.value;
    const budget = chat.budget(this.#draft.trim());
    const canSend = this.app.connection.connected.value && (!channel || ch?.deviceIndex !== null);
    return html`
      ${this.#header(chat, kind)}
      <div class="log-wrap">
        <div class="log" @scroll=${() => this.#onScroll()}>
          ${chat.hasMore.value
            ? html`<div class="more"><button data-action="load-more" @click=${() => void chat.loadMore()}>Load older messages</button></div>`
            : nothing}
          ${messages.length
            ? html`<ol class="messages" aria-label="Messages" aria-live="polite">
                ${messages.map((m) => html`${m.id === unreadFrom ? unreadDivider : nothing}${this.#message(chat, m)}`)}
              </ol>`
            : html`<p class="empty muted">No messages yet. Say hello!</p>`}
        </div>
        ${this.#newBelow
          ? html`<button class="new-messages primary" data-action="new-messages" @click=${() => this.#scrollToBottom()}>New messages ↓</button>`
          : nothing}
      </div>
      <form
        class="composer"
        @submit=${(e: Event) => {
          e.preventDefault();
          void this.#send();
        }}
      >
        ${replyTo
          ? html`<div class="reply-banner" data-field="reply-banner">
              <span>Replying to <strong>${chat.replyName(replyTo)}</strong>: ${replyTo.text}</span>
              <button type="button" data-action="cancel-reply" aria-label="Cancel reply" @click=${() => chat.setReplyTo(null)}>✕</button>
            </div>`
          : nothing}
        <div class="compose-row">
          <textarea
            data-field="composer"
            rows="1"
            aria-label="Message"
            placeholder=${canSend ? 'Message' : channel ? 'This channel is not on the radio' : 'Not connected'}
            ?disabled=${!canSend}
            .value=${this.#draft}
            @input=${(e: Event) => {
              this.#draft = (e.target as HTMLTextAreaElement).value;
              this.requestUpdate();
            }}
            @keydown=${(e: KeyboardEvent) => this.#onKeydown(e)}
          ></textarea>
          <button class="primary" type="submit" data-action="send" ?disabled=${!canSend || !this.#draft.trim() || budget.over}>Send</button>
        </div>
        <div class="compose-foot">
          <div class="bytes" data-field="bytes" ?data-over=${budget.over} ?data-compressed=${budget.compressed} aria-live="polite">
            ${budget.remaining} / ${limit} bytes left${budget.compressed ? ' (compressed)' : ''}
          </div>
        </div>
      </form>
      <mc-reaction-picker @reaction-pick=${(e: CustomEvent<{ emoji: string }>) => void this.#react(e.detail.emoji)}></mc-reaction-picker>
    `;
  }
}

const unreadDivider = html`<li class="unread-divider" data-field="unread-divider" role="separator" aria-label="New messages">New messages</li>`;

/** Marks a message that went over the air as an "s:" SMAZ envelope, with the size saving as its tooltip. */
function smazIcon(m: MessageRecord) {
  const { plain, compressed } = smazSizes(m.text);
  const label = `${m.direction === 'out' ? 'Sent' : 'Received'} SMAZ-compressed: ${plain} → ${compressed} bytes`;
  return html`<span class="smaz" data-field="smaz" role="img" title=${label} aria-label=${label}
    ><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 1.5v4.5M5.5 3.5 8 6l2.5-2.5M8 14.5V10M5.5 12.5 8 10l2.5 2.5M2.5 8h11" /></svg
  ></span>`;
}

customElements.define('mc-chat-page', McChatPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-chat-page': McChatPage;
  }
}
