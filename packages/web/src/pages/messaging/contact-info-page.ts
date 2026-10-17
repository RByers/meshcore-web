/**
 * `/contact/:key`: what we know about one contact — type, key, path, direct (zero-hop) signal,
 * last seen, location — with links to the chat / node pages. Channel senders and DM headers
 * link here (issue #12).
 */
import { css, html, nothing } from 'lit';
import { hasLocation } from '@meshcore-web/core/app';
import { AppElement } from '../../app-context.js';
import { formatRelative, formatSnr, shortKey } from '../../format.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { avatar, listStyles, TYPE_LABEL } from './common.js';
import { hopsLink } from '../../components/path-dialog.js';

export class McContactInfoPage extends AppElement {
  static override properties = { params: { attribute: false } };
  declare params: Readonly<Record<string, string>> | undefined;

  static override styles = [
    shared,
    listStyles,
    css`
      header.card {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      header h2 {
        margin: 0;
        overflow-wrap: anywhere;
      }
      dl.info {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 6px 16px;
        margin: 0;
      }
      dl.info dt {
        color: var(--mc-text-muted);
      }
      dl.info dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
    `,
  ];

  get key(): string {
    return (this.params?.['key'] ?? '').toLowerCase();
  }

  override render() {
    const contacts = this.app.contacts;
    const v = contacts.view(this.key);
    if (!v) {
      return html`<section class="card">
        <h2>Unknown contact</h2>
        <p class="muted">${contacts.loading.value ? 'Loading…' : html`No contact with key ${shortKey(this.key)}.`}</p>
        <p><a href=${hrefFor('/contacts')}>Back to contacts</a></p>
      </section>`;
    }
    const c = v.record;
    const located = hasLocation(c);
    return html`
      <header class="card" data-field="header">
        <a href=${hrefFor('/contacts')} aria-label="Back to contacts">←</a>
        ${avatar(v.typeName)}
        <div>
          <h2 data-field="name">${v.name}</h2>
          <span class="muted" data-field="type">${TYPE_LABEL[v.typeName]}${v.favourite ? ' · ★ favourite' : ''}${v.onDevice ? '' : ' · not on radio'}</span>
        </div>
      </header>
      <section class="card">
        <dl class="info">
          <dt>Public key</dt>
          <dd class="mono" data-field="key">${v.key}</dd>
          <dt>Path</dt>
          <dd data-field="path">${hopsLink(v.path.label, v.path.kind === 'hops' ? { kind: 'contact', key: v.key } : null)}</dd>
          <dt>Direct signal</dt>
          <dd data-field="direct-signal">
            ${v.directSnr !== undefined
              ? html`${formatSnr(v.directSnr)}${v.directSnrAt ? html` <span class="muted">(${formatRelative(v.directSnrAt)})</span>` : nothing}`
              : html`<span class="muted">not heard directly</span>`}
          </dd>
          <dt>Last seen</dt>
          <dd data-field="last-seen">${v.lastSeen ? formatRelative(v.lastSeen) : 'never'}</dd>
          ${located ? html`<dt>Location</dt><dd data-field="location">${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</dd>` : nothing}
          ${c.notes ? html`<dt>Notes</dt><dd data-field="notes">${c.notes}</dd>` : nothing}
        </dl>
      </section>
      <div class="actions">
        ${v.typeName === 'chat' || v.typeName === 'room'
          ? html`<a data-action="message" href=${hrefFor(`/chat/${v.key}`)}>Message</a>`
          : nothing}
        ${v.typeName !== 'chat' ? html`<a data-action="node" href=${hrefFor(`/node/${v.key}`)}>Manage node</a>` : nothing}
        ${located ? html`<a data-action="show-on-map" href=${hrefFor(`/map/node/${v.key}`)}>Show on map</a>` : nothing}
      </div>
    `;
  }
}

customElements.define('mc-contact-info-page', McContactInfoPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-contact-info-page': McContactInfoPage;
  }
}
