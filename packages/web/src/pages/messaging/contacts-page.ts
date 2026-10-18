/**
 * Contacts: search / filter / sort, per-contact actions, add by shared contact, and a selection
 * mode for bulk delete (select all visible, or the visible ones not heard from for a period —
 * core `contactsNotHeardSince`, favourites skipped — then `ContactsModel.removeMany`).
 */
import { css, html, nothing } from 'lit';
import {
  CONTACT_FILTERS,
  contactLastHeard,
  contactsNotHeardSince,
  entryTab,
  messagePreview,
  STALE_PERIODS,
  type ContactFilter,
  type ContactSort,
  type ContactView,
} from '@meshcore-web/core/app';
import { AppElement } from '../../app-context.js';
import { formatRelative, formatSnr } from '../../format.js';
import { shared } from '../../styles.js';
import { avatar, copyText, errorText, listStyles, unreadBadge } from './common.js';
import { contactNote, nodeHref } from '../../components/node-link.js';

const FILTER_LABEL: Record<ContactFilter, string> = {
  all: 'All',
  chat: 'Users',
  repeater: 'Repeaters',
  room: 'Rooms',
  sensor: 'Sensors',
  favourites: 'Favourites',
  unread: 'Unread',
};

/** Where a contact opens: its node page, on Messages for users and rooms, else on Info. */
export function contactHref(v: Pick<ContactView, 'key' | 'typeName'>): string {
  return nodeHref(v.key, entryTab(v.typeName));
}

export class McContactsPage extends AppElement {
  static override styles = [
    shared,
    listStyles,
    css`
      .flags {
        font-size: 0.8rem;
      }
      .star-btn {
        flex: none;
        border: 0;
        background: transparent;
        min-width: 2.5rem;
        padding: 0;
        font-size: 1.3rem;
        line-height: 1;
        color: var(--mc-text-muted);
      }
      .star-btn[aria-pressed='true'] {
        color: #f5b400;
      }
      .star-btn:hover {
        color: #f5b400;
      }
      .select-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-block-end: 12px;
        padding: 8px 12px;
        border: 1px solid var(--mc-border);
        border-radius: var(--mc-radius);
        background: var(--mc-accent-soft);
      }
      .select-bar .count {
        font-weight: 600;
        margin-inline-end: auto;
      }
      .select-bar .hint {
        flex-basis: 100%;
        font-size: 0.85rem;
        color: var(--mc-text-muted);
      }
      label.row-link {
        cursor: pointer;
      }
      label.row-link input {
        flex: none;
        width: 1.2rem;
        height: 1.2rem;
        margin: 0;
      }
      li[data-selected] {
        background: var(--mc-accent-soft);
      }
      .bulk-names {
        margin: 0;
        padding-inline-start: 1.2em;
        max-height: 10rem;
        overflow: auto;
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
  /** Selection mode for bulk delete; keys in #selected may include contacts hidden by the filter. */
  #selecting = false;
  #selected = new Set<string>();
  #selectNote = '';
  /** Bulk delete progress while removeMany runs. */
  #deleting: { done: number; total: number } | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.#onKey);
  }

  override disconnectedCallback(): void {
    window.removeEventListener('keydown', this.#onKey);
    super.disconnectedCallback();
  }

  #onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !this.#selecting || this.#deleting) return;
    if (this.renderRoot.querySelector('dialog[open]')) return; // Esc closes the dialog first
    this.#setSelecting(false);
  };

  #setSelecting(on: boolean): void {
    this.#selecting = on;
    this.#selected = new Set();
    this.#selectNote = '';
    this.requestUpdate();
  }

  #select(keys: Iterable<string>, note = ''): void {
    this.#selected = new Set(keys);
    this.#selectNote = note;
    this.requestUpdate();
  }

  #toggle(key: string, on: boolean): void {
    if (on) this.#selected.add(key);
    else this.#selected.delete(key);
    this.#selectNote = '';
    this.requestUpdate();
  }

  #selectStale(e: Event): void {
    const sel = e.target as HTMLSelectElement;
    const period = STALE_PERIODS[Number(sel.value)];
    sel.value = '';
    if (!period) return;
    const visible = this.app.contacts.visible.peek();
    const stale = contactsNotHeardSince(visible, this.app.clock.now() - period.ms);
    const favs = visible.filter((v) => v.favourite).length;
    this.#select(
      stale.map((v) => v.key),
      `${stale.length} not heard in ${period.label}${favs ? ` · ${favs} favourite${favs === 1 ? '' : 's'} skipped` : ''}`,
    );
  }

  /** Selected keys that still exist, in list order. */
  #selectedViews(): ContactView[] {
    return this.app.contacts.views.value.filter((v) => this.#selected.has(v.key));
  }

  async #confirmBulk(): Promise<void> {
    const views = this.#selectedViews();
    this.#dialog('bulk-dialog')?.close();
    if (!views.length) return;
    this.#deleting = { done: 0, total: views.length };
    this.requestUpdate();
    try {
      const r = await this.app.contacts.removeMany(
        views.map((v) => v.key),
        {
          onProgress: (done, total) => {
            this.#deleting = { done, total };
            this.requestUpdate();
          },
        },
      );
      if (r.removed.length) this.app.notifications.info(`Deleted ${r.removed.length} contact${r.removed.length === 1 ? '' : 's'}`);
      if (r.failed.length) {
        const names = r.failed.map((f) => views.find((v) => v.key === f.key)?.name ?? f.key.slice(0, 12)).join(', ');
        this.app.notifications.error(`Could not delete ${r.failed.length}: ${names}`, r.failed[0]?.error);
      }
    } catch (err) {
      this.app.notifications.error('Could not delete contacts', err);
    } finally {
      this.#deleting = null;
      this.#setSelecting(false);
    }
  }

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

  async #act(v: ContactView, action: 'reset' | 'share' | 'export' | 'remove'): Promise<void> {
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

  async #toggleFavourite(v: ContactView): Promise<void> {
    try {
      await this.app.contacts.setFavourite(v.key, !v.favourite);
    } catch (err) {
      this.app.notifications.error(`Could not ${v.favourite ? 'unstar' : 'star'} ${v.name}`, err);
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
    const now = this.app.clock.now();
    const path = this.app.contacts.outPathLabel(v, this.app.appSettings.pathNames.value);
    const heard = contactLastHeard(v);
    const meta = [
      path.label,
      v.directSnr !== undefined ? `direct SNR ${formatSnr(v.directSnr)}` : '',
      heard ? `heard ${formatRelative(heard, now)}` : 'never heard',
    ].filter(Boolean);
    const main = html`${avatar(v.typeName)}
      <span class="row-main">
        <span class="row-title">
          <span class="name">${v.name}${contactNote(v.note)}</span>
          ${v.favourite && this.#selecting ? html`<span class="flags" title="Favourite">★</span>` : nothing}
          ${!v.onDevice ? html`<span class="flags muted" title="Not on the radio">(not on radio)</span>` : nothing}
          <span class="when">${v.lastActivity ? formatRelative(v.lastActivity, now) : ''}</span>
        </span>
        <span class="row-sub" data-field="meta" title=${path.title || nothing}>${meta.join(' · ')}</span>
        ${v.lastMessage ? html`<span class="preview">${messagePreview(v.lastMessage)}</span>` : nothing}
      </span>`;
    if (this.#selecting) {
      const on = this.#selected.has(v.key);
      return html`<li data-contact=${v.key} data-type=${v.typeName} ?data-selected=${on}>
        <label class="row-link">
          <input
            type="checkbox"
            data-select=${v.key}
            aria-label=${`Select ${v.name}`}
            .checked=${on}
            ?disabled=${!!this.#deleting}
            @change=${(e: Event) => this.#toggle(v.key, (e.target as HTMLInputElement).checked)}
          />
          ${main}
        </label>
      </li>`;
    }
    const menuId = `menu-${v.key}`;
    return html`<li data-contact=${v.key} data-type=${v.typeName}>
      <a class="row-link" href=${contactHref(v)}>
        ${main}
        ${unreadBadge(v.unread)}
      </a>
      <button
        class="star-btn"
        data-action="favourite"
        aria-pressed=${v.favourite ? 'true' : 'false'}
        aria-label=${`Favourite ${v.name}`}
        title=${v.favourite ? 'Remove from favourites' : 'Add to favourites'}
        @click=${() => void this.#toggleFavourite(v)}
      >
        ${v.favourite ? '★' : '☆'}
      </button>
      <button class="menu-btn" popovertarget=${menuId} aria-label=${`Actions for ${v.name}`} data-menu=${v.key}>⋮</button>
      <div class="menu" id=${menuId} popover>
        <a data-action="info" href=${nodeHref(v.key)}>Info</a>
        <button data-action="set-path" @click=${() => (location.hash = nodeHref(v.key, 'path'))}>Set path…</button>
        <button data-action="reset-path" ?disabled=${!v.onDevice} @click=${() => void this.#act(v, 'reset')}>Reset path</button>
        <button data-action="share" ?disabled=${!v.onDevice} @click=${() => void this.#act(v, 'share')}>Share (zero hop)</button>
        <button data-action="export" ?disabled=${!v.onDevice} @click=${() => void this.#act(v, 'export')}>Export link…</button>
        <button data-action="remove" class="danger" @click=${() => void this.#act(v, 'remove')}>Remove…</button>
      </div>
    </li>`;
  }

  #selectBar(visible: readonly ContactView[], selected: readonly ContactView[]) {
    const busy = this.#deleting;
    const shown = new Set(visible.map((v) => v.key));
    const hidden = selected.filter((v) => !shown.has(v.key)).length;
    return html`<div class="select-bar" data-field="select-bar">
      <span class="count" data-field="selected-count" role="status">
        ${busy
          ? `Deleting ${busy.done} / ${busy.total}…`
          : html`${selected.length} selected${hidden ? html` <span class="muted">(${hidden} hidden by filter)</span>` : nothing}`}
      </span>
      <button data-action="select-all" ?disabled=${!!busy || !visible.length} @click=${() => this.#select(visible.map((v) => v.key))}>Select all</button>
      <button data-action="select-none" ?disabled=${!!busy || !selected.length} @click=${() => this.#select([])}>Clear</button>
      <select
        data-field="stale"
        aria-label="Select contacts not heard in a period"
        title="Selects the listed contacts not heard from in the period (favourites are skipped)"
        ?disabled=${!!busy || !visible.length}
        @change=${(e: Event) => this.#selectStale(e)}
      >
        <option value="" selected>Not heard in…</option>
        ${STALE_PERIODS.map((p, i) => html`<option value=${i}>${p.label}</option>`)}
      </select>
      <button
        class="danger"
        data-action="bulk-delete"
        ?disabled=${!!busy || !selected.length}
        @click=${() => this.#dialog('bulk-dialog')?.showModal()}
      >
        Delete ${selected.length || ''}
      </button>
      <button data-action="select-cancel" ?disabled=${!!busy} @click=${() => this.#setSelecting(false)}>Cancel</button>
      <span class="hint" data-field="select-note">${this.#selectNote || 'Tap contacts to select them. “Not heard in…” skips favourites.'}</span>
    </div>`;
  }

  override render() {
    const m = this.app.contacts;
    const visible = m.visible.value;
    const total = m.views.value.length;
    const removing = this.#removeKey ? m.view(this.#removeKey) : undefined;
    const selected = this.#selecting ? this.#selectedViews() : [];
    return html`
      <div class="page-head">
        <h2>Contacts <span class="muted" data-field="count">(${total})</span></h2>
        ${this.#selecting
          ? nothing
          : html`<button data-action="select-mode" ?disabled=${!total} @click=${() => this.#setSelecting(true)}>Select</button>
              <button data-action="refresh" ?disabled=${this.#busy} @click=${() => void this.#refresh()}>Refresh</button>
              <button class="primary" data-action="add-contact" @click=${() => this.#openAdd()}>Add contact</button>`}
      </div>
      ${this.#selecting ? this.#selectBar(visible, selected) : nothing}
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

      <dialog id="bulk-dialog" aria-labelledby="bulk-h">
        <form method="dialog">
          <h3 id="bulk-h">Delete ${selected.length} contact${selected.length === 1 ? '' : 's'}?</h3>
          <ul class="bulk-names" data-field="bulk-names">
            ${selected.slice(0, 5).map((v) => html`<li>${v.name}${contactNote(v.note)}</li>`)}
            ${selected.length > 5 ? html`<li class="muted">and ${selected.length - 5} more</li>` : nothing}
          </ul>
          <p>They are removed from the radio and their messages are deleted from this browser.</p>
          <div class="actions">
            <button>Cancel</button>
            <button type="button" class="danger" data-action="bulk-confirm" @click=${() => void this.#confirmBulk()}>Delete</button>
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
