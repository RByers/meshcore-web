/**
 * `/path/:key`: a contact's routing (issue #6, after MeshCore Open's routing sheet and path
 * editor). Shows the current path with repeater names, a hop-list editor fed from the known
 * repeaters (searchable list, or tapping repeaters on the map), "Use flood", and the previously
 * used paths with their delivery counts. State and actions live in `app.contactPaths` (core ContactPathsModel);
 * only the draft hop list is page state.
 */
import { css, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { boundsOf, type PathCandidate, type PathHistoryView, type ResolvedPath } from '@meshcore-web/core/app';
import { toHex } from '@meshcore-web/core/util/bytes';
import { AppElement } from '../../app-context.js';
import type { McTileMap } from '../../components/tile-map.js';
import '../../components/tile-map.js';
import { formatDuration, formatRelative } from '../../format.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { avatar, errorText, listStyles } from './common.js';
import { nodeLink } from '../../components/node-link.js';

interface DraftHop {
  hash: Uint8Array;
  label: string;
}

export class McPathPage extends AppElement {
  static override properties = { params: { attribute: false } };
  declare params: Readonly<Record<string, string>> | undefined;

  static override styles = [
    shared,
    listStyles,
    css`
      section {
        margin-block-end: 18px;
      }
      h3 {
        margin: 0 0 8px;
        font-size: 1rem;
      }
      .chain {
        font-family: var(--mc-mono);
        overflow-wrap: anywhere;
      }
      ol.hops {
        list-style: none;
        margin: 0 0 8px;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      ol.hops li,
      ul.list > li {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
      }
      ol.hops li {
        background: var(--mc-surface);
        border: 1px solid var(--mc-border);
        border-radius: 8px;
      }
      .grow {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .mono {
        font-family: var(--mc-mono);
        font-size: 0.85rem;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-block: 8px;
      }
      ul.list.candidates {
        max-height: 18rem;
        overflow-y: auto;
      }
      button.small {
        min-height: 0;
        padding: 2px 8px;
      }
      mc-tile-map {
        height: 320px;
      }
      .stats {
        font-size: 0.85rem;
      }
      [data-current] {
        font-weight: 600;
      }
      .error {
        color: var(--mc-danger);
      }
    `,
  ];

  #draft: DraftHop[] = [];
  #draftFor = '';
  #search = '';
  #mode: 'list' | 'map' = 'list';
  #busy = false;
  #error = '';
  #fitted = false;

  get key(): string {
    return (this.params?.['key'] ?? '').toLowerCase();
  }

  get #hashSize(): number {
    return this.#draft[0]?.hash.length ?? this.app.contactPaths.defaultHashSize.value;
  }

  protected override willUpdate(): void {
    // start the editor from the current path once per contact
    const cur = this.key ? this.app.contactPaths.current(this.key) : undefined;
    if (cur && this.#draftFor !== this.key) {
      this.#draftFor = this.key;
      this.#draft = cur.hops.map((h) => ({ hash: h.hash, label: h.label }));
    }
  }

  #add(c: PathCandidate): void {
    if (this.#draft.length >= Math.floor(64 / this.#hashSize)) return;
    this.#draft = [...this.#draft, { hash: c.pubKey.slice(0, this.#hashSize), label: c.name }];
    this.requestUpdate();
  }

  #move(i: number, by: number): void {
    const j = i + by;
    if (j < 0 || j >= this.#draft.length) return;
    const d = [...this.#draft];
    [d[i], d[j]] = [d[j]!, d[i]!];
    this.#draft = d;
    this.requestUpdate();
  }

  /** The contact a draft hop names, when its hash matches exactly one known repeater. */
  #draftKey(h: DraftHop): string | undefined {
    const hex = toHex(h.hash);
    const m = this.app.contactPaths.candidatesFor(this.key).filter((c) => c.prefix.startsWith(hex));
    return m.length === 1 ? m[0]!.key : undefined;
  }

  #remove(i: number): void {
    this.#draft = this.#draft.filter((_, k) => k !== i);
    this.requestUpdate();
  }

  async #apply(path: 'flood' | readonly Uint8Array[], msg: string): Promise<void> {
    this.#busy = true;
    this.#error = '';
    this.requestUpdate();
    try {
      await this.app.contactPaths.setPath(this.key, path);
      this.#draftFor = ''; // re-seed the editor from the new current path
      this.app.notifications.success(msg);
    } catch (err) {
      this.#error = errorText(err);
      this.app.notifications.error('Could not set path', err);
    } finally {
      this.#busy = false;
      this.requestUpdate();
    }
  }

  #useHistory(h: PathHistoryView): void {
    if (h.kind === 'flood') void this.#apply('flood', 'Path set to flood');
    else void this.#apply(h.hops.map((x) => x.hash), `Path set: ${h.label}`);
  }

  async #forget(h: PathHistoryView): Promise<void> {
    try {
      await this.app.contactPaths.forget(this.key, h.id);
    } catch (err) {
      this.app.notifications.error('Could not forget path', err);
    }
  }

  #pathText(p: ResolvedPath) {
    if (p.kind !== 'hops') return html`<span class="chain">${p.label}</span>`;
    return html`<span class="chain"
      >${p.hops.map((h, i) => html`${i ? ' → ' : ''}<span data-hop=${h.hex}>${nodeLink(h.label, h.matches.length === 1 ? h.matches[0]!.key : undefined, h.hex)}</span>`)}</span
    >`;
  }

  #candidates(cands: readonly PathCandidate[]) {
    const q = this.#search.trim().toLowerCase();
    const shown = cands.filter((c) => !q || c.name.toLowerCase().includes(q) || c.prefix.startsWith(q));
    return html`
      <input
        type="search"
        data-field="path-search"
        placeholder="Search repeaters by name or key"
        aria-label="Search repeaters"
        .value=${this.#search}
        @input=${(e: Event) => {
          this.#search = (e.target as HTMLInputElement).value;
          this.requestUpdate();
        }}
      />
      ${shown.length
        ? html`<ul class="list candidates" data-field="candidates">
            ${repeat(
              shown,
              (c) => c.key,
              (c) => html`<li data-candidate=${c.key}>
                ${avatar(c.kind)}
                <span class="grow">${c.name} <span class="muted mono">${c.prefix.slice(0, this.#hashSize * 2)}</span></span>
                <button class="small" data-action="add-hop" @click=${() => this.#add(c)}>Add</button>
              </li>`,
            )}
          </ul>`
        : html`<p class="muted" data-empty>${cands.length ? 'No repeaters match.' : 'No repeaters known yet. They appear once their adverts are heard.'}</p>`}
    `;
  }

  #map(cands: readonly PathCandidate[]) {
    const located = cands.filter((c) => c.hasLocation);
    const me = this.app.map.self.value;
    return html`
      <p class="muted">Tap repeaters in the order the message should travel.</p>
      <mc-tile-map .tileUrl=${this.app.map.tileUrl.value} label="Repeater map" data-field="path-map">
        ${me ? html`<mc-map-marker kind="self" lat=${me.lat} lon=${me.lon} label=${`${me.name} (you)`}></mc-map-marker>` : nothing}
        ${repeat(
          located,
          (c) => c.key,
          (c) => html`<mc-map-marker
            data-key=${c.key}
            kind=${c.kind}
            lat=${c.lat}
            lon=${c.lon}
            label=${c.name}
            ?selected=${this.#draft.some((h) => toHex(h.hash) === c.prefix.slice(0, h.hash.length * 2))}
            @click=${() => this.#add(c)}
          ></mc-map-marker>`,
        )}
      </mc-tile-map>
      ${located.length < cands.length ? html`<p class="muted">${cands.length - located.length} repeater(s) without a location are only in the list.</p>` : nothing}
    `;
  }

  protected override updated(): void {
    if (this.#mode !== 'map' || this.#fitted) return;
    const map = this.renderRoot.querySelector<McTileMap>('mc-tile-map');
    const me = this.app.map.self.peek();
    const pts = [...this.app.contactPaths.candidatesFor(this.key).filter((c) => c.hasLocation), ...(me ? [me] : [])];
    const b = boundsOf(pts);
    if (map && b) {
      map.fitBounds(b);
      this.#fitted = true;
    }
  }

  #history(list: readonly PathHistoryView[]) {
    if (!list.length) return html`<p class="muted" data-field="no-history">No paths used yet. Paths are remembered as you send messages.</p>`;
    return html`<ul class="list" data-field="history">
      ${list.map((h) => {
        const e = h.entry;
        const stats = [
          `${e.successes}/${e.attempts} delivered`,
          e.failures ? `${e.failures} failed` : '',
          e.roundTripMs !== undefined && e.lastResult === 'success' ? `${formatDuration(e.roundTripMs)} round trip` : '',
          e.lastUsed ? `used ${formatRelative(e.lastUsed, this.app.clock.now())}` : '',
          e.observed && e.attempts === 0 ? 'learnt from the radio' : '',
        ].filter(Boolean);
        return html`<li data-history=${h.id} ?data-current=${h.current}>
          <span class="grow">
            ${this.#pathText(h)} ${h.kind === 'hops' ? html`<span class="muted">(${h.hops.length} hop${h.hops.length === 1 ? '' : 's'})</span>` : nothing}
            <div class="muted stats" data-field="stats">${stats.join(' · ')}</div>
          </span>
          ${h.current
            ? html`<span class="muted">in use</span>`
            : html`<button class="small" data-action="use-path" ?disabled=${this.#busy} @click=${() => this.#useHistory(h)}>Use</button>`}
          <button class="small" data-action="forget-path" aria-label="Forget this path" title="Forget" @click=${() => void this.#forget(h)}>✕</button>
        </li>`;
      })}
    </ul>`;
  }

  override render() {
    const contact = this.app.contacts.view(this.key);
    if (!contact) return html`<p class="muted">Unknown contact.</p>`;
    const paths = this.app.contactPaths;
    const cur = paths.current(this.key);
    const cands = paths.candidatesFor(this.key);
    const history = paths.history(this.key);
    const draftHex = this.#draft.map((h) => toHex(h.hash)).join(',');
    const curHex = cur?.kind === 'hops' ? cur.hops.map((h) => h.hex).join(',') : cur?.kind === 'direct' ? '' : null;
    const back = contact.typeName === 'chat' ? `/chat/${contact.key}` : `/node/${contact.key}`;
    return html`
      <div class="page-head">
        <a href=${hrefFor(back)} aria-label="Back">←</a>
        ${avatar(contact.typeName)}
        <h2>Path to ${contact.name}</h2>
      </div>

      <section>
        <h3>Current path</h3>
        <div data-field="current-path">${cur ? this.#pathText(cur) : nothing}</div>
        ${cur?.kind === 'flood' ? html`<p class="muted">No known path: messages flood, and the radio learns a path from the reply.</p>` : nothing}
      </section>

      <section>
        <h3>Set path</h3>
        ${this.#draft.length
          ? html`<ol class="hops" data-field="draft">
              ${this.#draft.map(
                (h, i) => html`<li data-draft-hop=${i}>
                  <span class="muted">${i + 1}.</span>
                  <span class="grow">${nodeLink(h.label, this.#draftKey(h))} <span class="muted mono">${toHex(h.hash)}</span></span>
                  <button class="small" data-action="hop-up" aria-label="Move up" ?disabled=${i === 0} @click=${() => this.#move(i, -1)}>↑</button>
                  <button class="small" data-action="hop-down" aria-label="Move down" ?disabled=${i === this.#draft.length - 1} @click=${() => this.#move(i, 1)}>↓</button>
                  <button class="small" data-action="hop-remove" aria-label="Remove hop" @click=${() => this.#remove(i)}>✕</button>
                </li>`,
              )}
            </ol>`
          : html`<p class="muted" data-field="draft-empty">No hops: a direct (zero-hop) path. Add repeaters below.</p>`}
        <div class="row">
          <button
            class="primary"
            data-action="apply-path"
            ?disabled=${this.#busy || !contact.onDevice || draftHex === curHex}
            @click=${() => void this.#apply(this.#draft.map((h) => h.hash), this.#draft.length ? 'Path set' : 'Path set to direct')}
          >
            Set path
          </button>
          <button data-action="use-flood" ?disabled=${this.#busy || !contact.onDevice || cur?.kind === 'flood'} @click=${() => void this.#apply('flood', 'Path set to flood')}>
            Use flood
          </button>
          <button data-action="clear-draft" ?disabled=${!this.#draft.length} @click=${() => {
            this.#draft = [];
            this.requestUpdate();
          }}>Clear hops</button>
          ${this.#error ? html`<span class="error" data-field="path-error">${this.#error}</span>` : nothing}
        </div>
        <div class="row" role="tablist" aria-label="Pick repeaters from">
          <button role="tab" data-mode="list" aria-selected=${this.#mode === 'list' ? 'true' : 'false'} @click=${() => {
            this.#mode = 'list';
            this.requestUpdate();
          }}>List</button>
          <button role="tab" data-mode="map" aria-selected=${this.#mode === 'map' ? 'true' : 'false'} @click=${() => {
            this.#mode = 'map';
            this.#fitted = false;
            this.requestUpdate();
          }}>Map</button>
        </div>
        ${this.#mode === 'list' ? this.#candidates(cands) : this.#map(cands)}
      </section>

      <section>
        <h3>Previously used paths</h3>
        ${this.#history(history)}
      </section>
    `;
  }
}

customElements.define('mc-path-page', McPathPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-path-page': McPathPage;
  }
}
