/**
 * `<mc-node-info>`: the node page's Info tab. What we know about the node — key (or the bare
 * hash / prefix), path and direct signal (contacts), last seen / heard, location — and a link to
 * the packet log filtered to it. Packets heard over time are on the *Stats* tab.
 *
 * A contact gets a *Contact* section: local note, SMAZ (chat & room), a favourite toggle, the
 * on-radio flag and a two-click *Remove contact*. A node only heard advertising gets
 * *Add contact* (from its advert). Several candidates for a hash / prefix are listed as links.
 *
 * Test hooks: `dl.info` `[data-field="key|path|direct-signal|last-seen|heard|location"]`,
 * `[data-candidate="<key>"]`, `[data-section="contact|note|smaz"]`, `[data-field="contact-flags"]`,
 * `[data-action="favourite|remove-contact|add-contact|node-packets"]` (`aria-pressed` on the
 * favourite toggle; `data-armed` while the
 * remove button awaits its confirming click).
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import {
  hasLocation,
  nodeCandidates,
  type ContactView,
  type HeardNode,
  type NodeIdentity,
  type NodeModel,
} from '@meshcore-web/core/app';
import { AppElement } from '../../app-context.js';
import { formatRelative, formatSnr, shortKey } from '../../format.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { listStyles, TYPE_LABEL } from '../messaging/common.js';
import { contactNote, nodeHref, pathLabelView } from '../../components/node-link.js';

/** The key links and panels use: the resolved full key, else the reference as given. */
export function identityKey(id: NodeIdentity | null, ref: string): string {
  return id && (id.kind === 'contact' || id.kind === 'heard') ? id.key : ref;
}

function heardLocation(h: HeardNode): { lat: number; lon: number } | null {
  return h.lat !== undefined && h.lon !== undefined && hasLocation({ lat: h.lat, lon: h.lon }) ? { lat: h.lat, lon: h.lon } : null;
}

export class McNodeInfo extends AppElement {
  static override properties = { node: { attribute: false } };
  declare node: NodeModel | undefined;

  static override styles = [
    shared,
    listStyles,
    css`
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
      ul.candidates {
        margin: 8px 0 0;
        padding-inline-start: 1.2em;
      }
      section.contact {
        margin-block: var(--mc-gap);
      }
      section.contact > h3 {
        margin: 0 0 8px;
        font-size: 1rem;
      }
      section.contact > .card {
        margin-block-end: var(--mc-gap);
      }
      label.check {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .note-form {
        display: flex;
        gap: 8px;
        align-items: end;
      }
      .note-label {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .hint {
        color: var(--mc-text-muted);
        font-size: 0.85rem;
        margin: 4px 0 0;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
    `,
  ];

  /** The Remove button was clicked once and awaits the confirming second click. */
  #armed = false;
  #removing = false;
  #adding = false;
  #starring = false;

  /** Any click other than on the armed Remove button disarms it (runs after the button's own handler). */
  readonly #onClick = (e: Event): void => {
    if (!this.#armed) return;
    const onRemove = e.composedPath().some((n) => n instanceof HTMLElement && n.dataset['action'] === 'remove-contact');
    if (!onRemove) this.#disarm();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('click', this.#onClick);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('click', this.#onClick);
    this.#armed = false;
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    // another node in the same element (navigating between node pages): never carry the arming over
    if (changed.has('node')) this.#armed = false;
  }

  override render() {
    const node = this.node;
    const id = node?.identity.value;
    if (!node || !id) return nothing;
    const key = identityKey(id, node.ref);
    return html`
      <section class="card">${this.#facts(id)}</section>
      ${id.kind === 'contact' ? this.#contactSection(id.contact) : nothing}
      <div class="actions">
        ${node.canAddContact.value
          ? html`<button class="primary" data-action="add-contact" ?disabled=${this.#adding} @click=${() => void this.#add()}>
              ${this.#adding ? 'Adding…' : 'Add contact'}
            </button>`
          : nothing}
        <a data-action="node-packets" href=${hrefFor(`/packets/node/${key}`)}>Packets from this node</a>
      </div>
    `;
  }

  #facts(id: NodeIdentity): TemplateResult {
    const now = this.app.clock.now();
    switch (id.kind) {
      case 'contact': {
        const v = id.contact;
        const c = v.record;
        const path = this.app.contacts.outPathLabel(v, this.app.appSettings.pathNames.value);
        return html`<dl class="info">
          <dt>Public key</dt>
          <dd class="mono" data-field="key">${v.key}</dd>
          <dt>Path</dt>
          <dd data-field="path" title=${path.title || nothing}>${pathLabelView(path, v.path.kind === 'hops' ? { kind: 'contact', key: v.key } : null, (k) => this.app.contacts.noteFor(k))}</dd>
          <dt>Direct signal</dt>
          <dd data-field="direct-signal">
            ${v.directSnr !== undefined
              ? html`${formatSnr(v.directSnr)}${v.directSnrAt ? html` <span class="muted">(${formatRelative(v.directSnrAt, now)})</span>` : nothing}`
              : html`<span class="muted">not heard directly</span>`}
          </dd>
          <dt>Last seen</dt>
          <dd data-field="last-seen">${v.lastSeen ? formatRelative(v.lastSeen, now) : 'never'}</dd>
          ${hasLocation(c) ? html`<dt>Location</dt><dd data-field="location">${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</dd>` : nothing}
        </dl>`;
      }
      case 'heard': {
        const h = id.heard;
        const loc = heardLocation(h);
        const how = [h.hops === null ? 'advert' : h.hops === 0 ? 'advert, direct' : `advert, ${h.hops} hop${h.hops === 1 ? '' : 's'}`];
        if (h.snr !== undefined) how.push(`SNR ${formatSnr(h.snr)}`);
        return html`<dl class="info">
          <dt>Public key</dt>
          <dd class="mono" data-field="key">${h.key}</dd>
          <dt>Last heard</dt>
          <dd data-field="last-seen">${formatRelative(h.heardAt, now)}</dd>
          <dt>Heard</dt>
          <dd data-field="heard">${how.join(' · ')}</dd>
          ${loc ? html`<dt>Location</dt><dd data-field="location">${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}</dd>` : nothing}
        </dl>
        <p class="hint">Heard advertising; not in your contacts.</p>`;
      }
      case 'ambiguous': {
        const items = nodeCandidates(id.contacts, id.heard);
        return html`${this.#refFact(id.ref)}
          <p class="hint">${items.length} nodes match:</p>
          <ul class="candidates" data-field="candidates">
            ${items.map(
              (c) =>
                html`<li>
                  <a data-candidate=${c.key} href=${nodeHref(c.key)}>${c.name || shortKey(c.key)}</a>${contactNote(c.note)}
                  <span class="muted">(${TYPE_LABEL[c.typeName]}${c.heard ? ', heard' : ''}, ${shortKey(c.key)})</span>
                </li>`,
            )}
          </ul>`;
      }
      case 'unknown':
        return html`${this.#refFact(id.ref)}
          <p class="hint" data-field="unknown">No contact or heard advert matches.</p>`;
    }
  }

  #refFact(ref: string): TemplateResult {
    const label = ref.length === 2 ? 'Hash' : ref.length === 64 ? 'Public key' : 'Key prefix';
    return html`<dl class="info">
      <dt>${label}</dt>
      <dd class="mono" data-field="key">${ref}</dd>
    </dl>`;
  }

  // ---- contact section ----

  #contactSection(v: ContactView): TemplateResult {
    return html`<section class="contact" data-section="contact">
      <h3>Contact</h3>
      ${this.#noteSetting(v)}
      ${v.typeName === 'chat' || v.typeName === 'room' ? this.#smazSetting(v) : nothing}
      <div class="card actions">
        ${this.#favouriteButton(v)}
        <span class="muted" data-field="contact-flags">${v.onDevice ? 'on radio' : 'not on radio'}</span>
        ${this.#removeButton(v)}
      </div>
    </section>`;
  }

  /** Local note shown after the contact's name everywhere (app-only, never sent to the radio). */
  #noteSetting(v: ContactView): TemplateResult {
    return html`<section class="card" data-section="note">
      <form class="note-form" @submit=${(e: SubmitEvent) => void this.#saveNote(e, v.key)} novalidate>
        <label class="note-label"
          >Note
          <input name="note" data-field="note-input" maxlength="100" autocomplete="off" placeholder="Add a note…" .value=${v.note} />
        </label>
        <button type="submit" data-action="save-note">Save</button>
      </form>
      <p class="hint">Shown after the name wherever this contact appears. Stored in this app only.</p>
    </section>`;
  }

  async #saveNote(e: SubmitEvent, key: string): Promise<void> {
    e.preventDefault();
    const input = (e.currentTarget as HTMLFormElement).elements.namedItem('note') as HTMLInputElement;
    try {
      await this.app.contacts.setNote(key, input.value);
      input.value = input.value.trim();
      this.app.notifications.success(input.value ? 'Note saved' : 'Note cleared');
    } catch (err) {
      this.app.notifications.error('Could not save note', err);
    }
  }

  /** Per-contact SMAZ setting for outgoing DMs (feature-inventory.md §2.4a); explicit off blocks auto-enable. */
  #smazSetting(v: ContactView): TemplateResult {
    return html`<section class="card" data-section="smaz">
      <label class="check"
        ><input
          type="checkbox"
          data-action="smaz"
          .checked=${v.record.smaz === true}
          @change=${(e: Event) => void this.#setSmaz(v.key, (e.target as HTMLInputElement).checked)}
        />
        Compress outgoing messages (SMAZ)</label
      >
      <p class="hint">Only MeshCore Open and compatible clients decode compressed messages; other clients show them as “s:…” text.</p>
    </section>`;
  }

  async #setSmaz(key: string, on: boolean): Promise<void> {
    try {
      await this.app.contacts.setSmaz(key, on);
    } catch (err) {
      this.app.notifications.error('Could not change compression', err);
    }
  }

  /** Stars / unstars the contact (locally and, when on the radio, its FAVOURITE flag). */
  #favouriteButton(v: ContactView): TemplateResult {
    return html`<button
      data-action="favourite"
      aria-pressed=${v.favourite ? 'true' : 'false'}
      ?disabled=${this.#starring}
      title=${v.favourite ? 'Remove from favourites' : 'Add to favourites'}
      @click=${() => void this.#toggleFavourite(v)}
    >
      ${v.favourite ? '★ Favourite' : '☆ Add to favourites'}
    </button>`;
  }

  async #toggleFavourite(v: ContactView): Promise<void> {
    this.#starring = true;
    this.requestUpdate();
    try {
      await this.app.contacts.setFavourite(v.key, !v.favourite);
    } catch (err) {
      this.app.notifications.error(`Could not ${v.favourite ? 'unstar' : 'star'} ${v.name}`, err);
    } finally {
      this.#starring = false;
      this.requestUpdate();
    }
  }

  #removeButton(v: ContactView): TemplateResult {
    const armed = this.#armed;
    return html`<button
      class="danger"
      data-action="remove-contact"
      ?data-armed=${armed}
      ?disabled=${this.#removing}
      aria-label=${armed ? `Confirm: remove ${v.name} from contacts` : `Remove ${v.name} from contacts`}
      @click=${() => void this.#remove(v)}
      @blur=${() => {
        if (this.#armed) this.#disarm();
      }}
    >
      ${this.#removing ? 'Removing…' : armed ? 'Confirm remove' : 'Remove contact'}
    </button>`;
  }

  #disarm(): void {
    if (!this.#armed) return;
    this.#armed = false;
    this.requestUpdate();
  }

  /** First click arms; a second click removes the contact (the page then shows it as heard / unknown). */
  async #remove(v: ContactView): Promise<void> {
    const node = this.node;
    if (!node) return;
    if (!this.#armed) {
      this.#armed = true;
      this.requestUpdate();
      return;
    }
    this.#armed = false;
    this.#removing = true;
    this.requestUpdate();
    try {
      await node.removeContact();
      this.app.notifications.success(`Removed ${v.name}`);
    } catch (err) {
      this.app.notifications.error(`Could not remove ${v.name}`, err);
    } finally {
      this.#removing = false;
      this.requestUpdate();
    }
  }

  async #add(): Promise<void> {
    const node = this.node;
    if (!node) return;
    this.#adding = true;
    this.requestUpdate();
    try {
      const rec = await node.addContact();
      this.app.notifications.success(`Added ${rec.name || shortKey(node.ref)}`);
    } catch (err) {
      this.app.notifications.error('Could not add the contact', err);
    } finally {
      this.#adding = false;
      this.requestUpdate();
    }
  }
}

customElements.define('mc-node-info', McNodeInfo);

declare global {
  interface HTMLElementTagNameMap {
    'mc-node-info': McNodeInfo;
  }
}
