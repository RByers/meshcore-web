/** Conversations overview: recent DMs and channels, newest first, with unread badges. */
import { html, nothing } from 'lit';
import { messagePreview, type ConversationView } from '@meshcore-web/core/app';
import { AppElement } from '../../app-context.js';
import { formatRelative } from '../../format.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { avatar, listStyles, unreadBadge } from './common.js';

export function conversationHref(c: Pick<ConversationView, 'convType' | 'key' | 'icon'>): string {
  if (c.convType === 'channel') return hrefFor(`/channel/${c.key}`);
  return hrefFor(c.icon === 'chat' ? `/chat/${c.key}` : `/node/${c.key}`);
}

export class McMessagesPage extends AppElement {
  static override styles = [shared, listStyles];

  override render() {
    const m = this.app.conversations;
    const items = m.items.value;
    return html`
      <div class="page-head">
        <h2>Messages</h2>
        <a href=${hrefFor('/contacts')}>Contacts</a>
        <a href=${hrefFor('/channels')}>Channels</a>
      </div>
      ${items.length
        ? html`<ul class="list" data-list="conversations">
            ${items.map(
              (c) => html`<li data-conv=${`${c.convType}:${c.key}`}>
                <a class="row-link" href=${conversationHref(c)}>
                  ${avatar(c.icon)}
                  <span class="row-main">
                    <span class="row-title">
                      <span class="name">${c.name}</span>
                      ${c.muted ? html`<span title="Muted" aria-label="Muted">🔕</span>` : nothing}
                      <span class="when">${c.lastActivity ? formatRelative(c.lastActivity) : ''}</span>
                    </span>
                    <span class="preview">${c.lastMessage ? messagePreview(c.lastMessage) : 'No messages yet'}</span>
                  </span>
                  ${unreadBadge(c.unread, c.muted)}
                </a>
              </li>`,
            )}
          </ul>`
        : html`<div class="card empty muted">
            ${m.loading.value
              ? 'Loading…'
              : html`No conversations yet. Pick someone in <a href=${hrefFor('/contacts')}>Contacts</a> or open a
                  <a href=${hrefFor('/channels')}>channel</a>.`}
          </div>`}
    `;
  }
}

customElements.define('mc-messages-page', McMessagesPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-messages-page': McMessagesPage;
  }
}
