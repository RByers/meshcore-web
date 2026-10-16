/** Channels on the radio: add (name + key, #hashtag, Public), edit, delete, mute. */
import { css, html, nothing } from 'lit';
import { base64Encode, messagePreview, type ChannelView } from '@meshcore-web/core/app';
import { AppElement } from '../../app-context.js';
import { formatRelative } from '../../format.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { avatar, copyText, errorText, listStyles, unreadBadge, TYPE_LABEL } from './common.js';

export class McChannelsPage extends AppElement {
  static override styles = [
    shared,
    listStyles,
    css`
      .key {
        font-family: var(--mc-mono);
        font-size: 0.8rem;
        overflow-wrap: anywhere;
      }
    `,
  ];

  /** Key of the channel being edited; '' while adding. */
  #editKey = '';
  #error = '';
  #busy = false;
  #deleteKey = '';

  #dialog(id: string): HTMLDialogElement | null {
    return this.renderRoot.querySelector<HTMLDialogElement>(`#${id}`);
  }

  async #openEditor(key: string): Promise<void> {
    this.#editKey = key;
    this.#error = '';
    this.requestUpdate();
    await this.updateComplete;
    const form = this.#dialog('channel-dialog')?.querySelector('form');
    form?.reset();
    const ch = key ? this.app.channels.find(key) : undefined;
    if (form && ch) {
      (form.elements.namedItem('name') as HTMLInputElement).value = ch.name;
    }
    this.#dialog('channel-dialog')?.showModal();
  }

  async #submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const name = String(data.get('name') ?? '');
    const psk = String(data.get('psk') ?? '');
    this.#busy = true;
    this.#error = '';
    this.requestUpdate();
    try {
      const m = this.app.channels;
      const rec = this.#editKey ? await m.edit(this.#editKey, { name, psk }) : await m.add({ name, psk });
      this.#dialog('channel-dialog')?.close();
      this.app.notifications.success(`${this.#editKey ? 'Saved' : 'Added'} ${rec.name}${rec.deviceIndex !== null ? ` (slot ${rec.deviceIndex})` : ''}`);
    } catch (err) {
      this.#error = errorText(err);
    } finally {
      this.#busy = false;
      this.requestUpdate();
    }
  }

  async #act(c: ChannelView, action: 'edit' | 'mute' | 'delete' | 'copy-key'): Promise<void> {
    this.renderRoot.querySelector<HTMLElement>(`#menu-${c.key}`)?.hidePopover();
    try {
      if (action === 'edit') await this.#openEditor(c.key);
      else if (action === 'mute') await this.app.channels.setMuted(c.key, !c.muted);
      else if (action === 'copy-key') {
        const ok = await copyText(base64Encode(c.record.psk));
        this.app.notifications.info(ok ? 'Key copied (base64)' : `Key: ${base64Encode(c.record.psk)}`);
      } else {
        this.#deleteKey = c.key;
        this.requestUpdate();
        await this.updateComplete;
        this.#dialog('delete-dialog')?.showModal();
      }
    } catch (err) {
      this.app.notifications.error(`Could not ${action} ${c.name}`, err);
    }
  }

  async #confirmDelete(): Promise<void> {
    const key = this.#deleteKey;
    const name = this.app.channels.find(key)?.name ?? 'channel';
    const form = this.#dialog('delete-dialog')?.querySelector('form');
    const deleteMessages = (form?.elements.namedItem('delete-messages') as HTMLInputElement | null)?.checked ?? false;
    this.#dialog('delete-dialog')?.close();
    try {
      await this.app.channels.remove(key, { deleteMessages });
      this.app.notifications.info(`Deleted ${name}`);
    } catch (err) {
      this.app.notifications.error('Could not delete channel', err);
    }
  }

  async #refresh(): Promise<void> {
    try {
      await this.app.channels.refresh();
    } catch (err) {
      this.app.notifications.error('Could not refresh channels', err);
    }
  }

  #row(c: ChannelView) {
    const menuId = `menu-${c.key}`;
    const lm = c.lastMessage;
    return html`<li data-channel=${c.key} data-kind=${c.kind} ?data-muted=${c.muted}>
      <a class="row-link" href=${hrefFor(`/channel/${c.key}`)}>
        ${avatar(c.kind)}
        <span class="row-main">
          <span class="row-title">
            <span class="name">${c.name}</span>
            ${c.muted ? html`<span title="Muted" aria-label="Muted">🔕</span>` : nothing}
            <span class="when">${lm ? formatRelative(lm.receivedAt) : ''}</span>
          </span>
          <span class="row-sub">${TYPE_LABEL[c.kind]} · ${c.slot !== null ? `slot ${c.slot}` : 'not on radio'}</span>
          ${lm ? html`<span class="preview">${messagePreview(lm)}</span>` : nothing}
        </span>
        ${unreadBadge(c.unread, c.muted)}
      </a>
      <button class="menu-btn" popovertarget=${menuId} aria-label=${`Actions for ${c.name}`} data-menu=${c.key}>⋮</button>
      <div class="menu" id=${menuId} popover>
        <button data-action="edit" ?disabled=${c.slot === null} @click=${() => void this.#act(c, 'edit')}>Edit…</button>
        <button data-action="mute" @click=${() => void this.#act(c, 'mute')}>${c.muted ? 'Unmute' : 'Mute'}</button>
        <button data-action="copy-key" @click=${() => void this.#act(c, 'copy-key')}>Copy key</button>
        <button data-action="delete" class="danger" @click=${() => void this.#act(c, 'delete')}>Delete…</button>
      </div>
    </li>`;
  }

  override render() {
    const m = this.app.channels;
    const views = m.views.value;
    const free = m.freeSlot.value;
    const editing = this.#editKey ? m.find(this.#editKey) : undefined;
    const deleting = this.#deleteKey ? m.find(this.#deleteKey) : undefined;
    return html`
      <div class="page-head">
        <h2>Channels <span class="muted">(${m.onDevice.value.length}/${m.slotCount.value} slots)</span></h2>
        <button data-action="refresh" @click=${() => void this.#refresh()}>Refresh</button>
        <button class="primary" data-action="add-channel" ?disabled=${free === null} @click=${() => void this.#openEditor('')}>Add channel</button>
      </div>
      ${views.length
        ? html`<ul class="list" data-list="channels">${views.map((c) => this.#row(c))}</ul>`
        : html`<div class="card empty muted">${m.loading.value ? 'Loading…' : 'No channels on this radio.'}</div>`}

      <dialog id="channel-dialog" aria-labelledby="channel-h">
        <form @submit=${(e: SubmitEvent) => void this.#submit(e)}>
          <h3 id="channel-h">${editing ? `Edit ${editing.name}` : 'Add channel'}</h3>
          <label>
            Name
            <span class="hint">Start with <code>#</code> to join a hashtag channel (key derived from the name). "Public" uses the well-known key.</span>
            <input name="name" required maxlength="31" autocomplete="off" data-field="channel-name" />
          </label>
          <label>
            Key ${editing ? html`<span class="hint">Leave empty to keep the current key.</span>` : html`<span class="hint">16 bytes as 32 hex digits or base64. Leave empty for a hashtag / Public channel or a new random key.</span>`}
            <input name="psk" autocomplete="off" spellcheck="false" class="key" data-field="channel-psk" />
          </label>
          ${editing ? html`<p class="hint muted">Current key: <span class="key">${base64Encode(editing.psk)}</span></p>` : nothing}
          ${!editing && free !== null ? html`<p class="muted">Will use slot ${free}.</p>` : nothing}
          ${this.#error ? html`<p class="form-error" role="alert">${this.#error}</p>` : nothing}
          <div class="actions">
            <button type="button" @click=${() => this.#dialog('channel-dialog')?.close()}>Cancel</button>
            <button type="submit" class="primary" data-action="channel-submit" ?disabled=${this.#busy}>${editing ? 'Save' : 'Add'}</button>
          </div>
        </form>
      </dialog>

      <dialog id="delete-dialog" aria-labelledby="delete-h">
        <form method="dialog">
          <h3 id="delete-h">Delete ${deleting?.name ?? 'channel'}?</h3>
          <p>The radio's slot is cleared. Re-adding the same key restores the history unless you delete it too.</p>
          <label style="flex-direction: row; font-weight: 400"><input type="checkbox" name="delete-messages" /> Also delete its messages</label>
          <div class="actions">
            <button>Cancel</button>
            <button type="button" class="danger" data-action="delete-confirm" @click=${() => void this.#confirmDelete()}>Delete</button>
          </div>
        </form>
      </dialog>
    `;
  }
}

customElements.define('mc-channels-page', McChannelsPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-channels-page': McChannelsPage;
  }
}
