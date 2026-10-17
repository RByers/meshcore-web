/** Contacts: search / filter / sort, per-contact actions, add by shared contact. */
import { css, html, nothing } from 'lit';
import { CONTACT_FILTERS, messagePreview, type ContactFilter, type ContactSort, type ContactView } from '@meshcore-web/core/app';
import { AppElement } from '../../app-context.js';
import { formatRelative, formatSnr } from '../../format.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { avatar, copyText, errorText, listStyles, unreadBadge } from './common.js';

const FILTER_LABEL: Record<ContactFilter, string> = {
  all: 'All',
  chat: 'Users',
  repeater: 'Repeaters',
  room: 'Rooms',
  sensor: 'Sensors',
  favourites: 'Favourites',
  unread: 'Unread',
};

/** Where a contact opens: chat for users, the node page for repeaters / rooms / sensors. */
export function contactHref(v: Pick<ContactView, 'key' | 'typeName'>): string {
  return hrefFor(v.typeName === 'chat' ? `/chat/${v.key}` : `/node/${v.key}`);
}

export class McContactsPage extends AppElement {
  static override styles = [
    shared,
    listStyles,
    css`
      .flags {
        font-size: 0.8rem;
      }
      .share-url {
        width: 100%;
        font-family: var(--mc-mono);
        font-size: 0.8rem;
        min-height: 6rem;
        overflow-wrap: anywhere;
      }
    `,
  ];

  #addError = '';
  #busy = false;
  #exportUrl = '';
  #exportName = '';
  #removeKey = '';

  #dialog(id: string): HTMLDialogElement | null {
    return this.renderRoot.querySelector<HTMLDialogElement>(`#${id}`);
  }

  #openAdd(): void {
    this.#addError = '';
    this.requestUpdate();
    this.#dialog('add-dialog')?.showModal();
  }

  async #submitAdd(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const share = String(data.get('share') ?? '');
    const name = String(data.get('name') ?? '');
    this.#busy = true;
    this.#addError = '';
    this.requestUpdate();
    try {
      const rec = await this.app.contacts.add(share, name ? { name } : {});
      form.reset();
      this.#dialog('add-dialog')?.close();
      this.app.notifications.success(`Added ${rec.name || 'contact'}`);
    } catch (err) {
      this.#addError = errorText(err);
    } finally {
      this.#busy = false;
      this.requestUpdate();
    }
  }

  async #act(v: ContactView, action: 'reset' | 'share' | 'export' | 'remove' | 'favourite'): Promise<void> {
    this.renderRoot.querySelector<HTMLElement>(`#menu-${v.key}`)?.hidePopover();
    const m = this.app.contacts;
    try {
      switch (action) {
        case 'reset':
          await m.resetPath(v.key);
          this.app.notifications.info(`Path to ${v.name} reset; the next message floods`);
          break;
        case 'share':
          await m.share(v.key);
          this.app.notifications.success(`Shared ${v.name} (zero hop)`);
          break;
        case 'export': {
          const exp = await m.export(v.key);
          this.#exportUrl = exp.url;
          this.#exportName = v.name;
          this.requestUpdate();
          await this.updateComplete;
          this.#dialog('export-dialog')?.showModal();
          break;
        }
        case 'favourite':
          await m.setFavourite(v.key, !v.favourite);
          break;
        case 'remove':
          this.#removeKey = v.key;
          this.requestUpdate();
          await this.updateComplete;
          this.#dialog('remove-dialog')?.showModal();
          break;
      }
    } catch (err) {
      this.app.notifications.error(`Could not ${action === 'reset' ? 'reset path' : action} ${v.name}`, err);
    }
  }

  async #confirmRemove(): Promise<void> {
    const key = this.#removeKey;
    const v = this.app.contacts.view(key);
    this.#dialog('remove-dialog')?.close();
    try {
      await this.app.contacts.remove(key);
      this.app.notifications.info(`Removed ${v?.name ?? 'contact'}`);
    } catch (err) {
      this.app.notifications.error('Could not remove contact', err);
    }
  }

  async #refresh(): Promise<void> {
    this.#busy = true;
    this.requestUpdate();
    try {
      await this.app.contacts.refresh();
    } catch (err) {
      this.app.notifications.error('Could not refresh contacts', err);
    } finally {
      this.#busy = false;
      this.requestUpdate();
    }
  }

  async #copyExport(): Promise<void> {
    if (await copyText(this.#exportUrl)) this.app.notifications.success('Copied');
    else this.renderRoot.querySelector<HTMLTextAreaElement>('.share-url')?.select();
  }

  #row(v: ContactView) {
    const now = Date.now();
    const meta = [
      v.path.label,
      v.directSnr !== undefined ? `direct SNR ${formatSnr(v.directSnr)}` : '',
      v.lastSeen ? `seen ${formatRelative(v.lastSeen, now)}` : 'never seen',
    ].filter(Boolean);
    const menuId = `menu-${v.key}`;
    return html`<li data-contact=${v.key} data-type=${v.typeName}>
      <a class="row-link" href=${contactHref(v)}>
        ${avatar(v.typeName)}
        <span class="row-main">
          <span class="row-title">
            <span class="name">${v.name}</span>
            ${v.favourite ? html`<span class="flags" title="Favourite" aria-label="Favourite">★</span>` : nothing}
            ${!v.onDevice ? html`<span class="flags muted" title="Not on the radio">(not on radio)</span>` : nothing}
            <span class="when">${v.lastActivity ? formatRelative(v.lastActivity, now) : ''}</span>
          </span>
          <span class="row-sub" data-field="meta">${meta.join(' · ')}</span>
          ${v.lastMessage ? html`<span class="preview">${messagePreview(v.lastMessage)}</span>` : nothing}
        </span>
        ${unreadBadge(v.unread)}
      </a>
      <button class="menu-btn" popovertarget=${menuId} aria-label=${`Actions for ${v.name}`} data-menu=${v.key}>⋮</button>
      <div class="menu" id=${menuId} popover>
        <button data-action="favourite" @click=${() => void this.#act(v, 'favourite')}>
          ${v.favourite ? 'Remove favourite' : 'Add favourite'}
        </button>
        <button data-action="set-path" @click=${() => (location.hash = hrefFor(`/path/${v.key}`))}>Set path…</button>
        <button data-action="reset-path" ?disabled=${!v.onDevice} @click=${() => void this.#act(v, 'reset')}>Reset path</button>
        <button data-action="share" ?disabled=${!v.onDevice} @click=${() => void this.#act(v, 'share')}>Share (zero hop)</button>
        <button data-action="export" ?disabled=${!v.onDevice} @click=${() => void this.#act(v, 'export')}>Export link…</button>
        <button data-action="remove" class="danger" @click=${() => void this.#act(v, 'remove')}>Remove…</button>
      </div>
    </li>`;
  }

  override render() {
    const m = this.app.contacts;
    const visible = m.visible.value;
    const total = m.views.value.length;
    const removing = this.#removeKey ? m.view(this.#removeKey) : undefined;
    return html`
      <div class="page-head">
        <h2>Contacts <span class="muted" data-field="count">(${total})</span></h2>
        <button data-action="refresh" ?disabled=${this.#busy} @click=${() => void this.#refresh()}>Refresh</button>
        <button class="primary" data-action="add-contact" @click=${() => this.#openAdd()}>Add contact</button>
      </div>
      <div class="toolbar" role="search">
        <input
          type="search"
          data-field="search"
          placeholder="Search name or key"
          aria-label="Search contacts"
          .value=${m.search.value}
          @input=${(e: Event) => m.setSearch((e.target as HTMLInputElement).value)}
        />
        <select data-field="filter" aria-label="Filter" @change=${(e: Event) => m.setFilter((e.target as HTMLSelectElement).value as ContactFilter)}>
          ${CONTACT_FILTERS.map((f) => html`<option value=${f} ?selected=${m.filter.value === f}>${FILTER_LABEL[f]}</option>`)}
        </select>
        <select data-field="sort" aria-label="Sort" @change=${(e: Event) => m.setSort((e.target as HTMLSelectElement).value as ContactSort)}>
          <option value="recent" ?selected=${m.sort.value === 'recent'}>Recent</option>
          <option value="name" ?selected=${m.sort.value === 'name'}>A–Z</option>
        </select>
      </div>
      ${visible.length
        ? html`<ul class="list" data-list="contacts">${visible.map((v) => this.#row(v))}</ul>`
        : html`<div class="card empty muted">${m.loading.value ? 'Loading…' : total ? 'No contacts match.' : 'No contacts yet.'}</div>`}

      <dialog id="add-dialog" aria-labelledby="add-h">
        <form @submit=${(e: SubmitEvent) => void this.#submitAdd(e)}>
          <h3 id="add-h">Add contact</h3>
          <label>
            Shared contact
            <span class="hint">A <code>meshcore://…</code> link, an advert in hex, or a 64-digit public key.</span>
            <textarea name="share" rows="4" required data-field="share"></textarea>
          </label>
          <label>
            Name <span class="hint">Only used for a bare public key.</span>
            <input name="name" data-field="add-name" autocomplete="off" />
          </label>
          ${this.#addError ? html`<p class="form-error" role="alert">${this.#addError}</p>` : nothing}
          <div class="actions">
            <button type="button" @click=${() => this.#dialog('add-dialog')?.close()}>Cancel</button>
            <button type="submit" class="primary" data-action="add-submit" ?disabled=${this.#busy}>Add</button>
          </div>
        </form>
      </dialog>

      <dialog id="export-dialog" aria-labelledby="export-h">
        <form method="dialog">
          <h3 id="export-h">Share ${this.#exportName}</h3>
          <textarea class="share-url" readonly data-field="export-url" .value=${this.#exportUrl}></textarea>
          <div class="actions">
            <button type="button" @click=${() => void this.#copyExport()}>Copy</button>
            <button class="primary">Done</button>
          </div>
        </form>
      </dialog>

      <dialog id="remove-dialog" aria-labelledby="remove-h">
        <form method="dialog">
          <h3 id="remove-h">Remove ${removing?.name ?? 'contact'}?</h3>
          <p>The contact is removed from the radio and its messages are deleted from this browser.</p>
          <div class="actions">
            <button>Cancel</button>
            <button type="button" class="danger" data-action="remove-confirm" @click=${() => void this.#confirmRemove()}>Remove</button>
          </div>
        </form>
      </dialog>
    `;
  }
}

customElements.define('mc-contacts-page', McContactsPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-contacts-page': McContactsPage;
  }
}
