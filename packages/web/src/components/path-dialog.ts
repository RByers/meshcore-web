/**
 * Path view (issue #2): `<mc-hops-link>` makes an "N hops" label clickable; it fires
 * `mc-show-path` with a core `PathRequest`, which `<mc-app>` answers by opening its single
 * `<mc-path-dialog>`. The dialog lists the stops (origin, each hop, destination) with resolved
 * names / candidates / hex hashes, and draws the route on a `<mc-tile-map>`; estimated positions
 * (hops without a location, ambiguous hashes) are dashed markers with a "?" and dashed legs, shown
 * only while the "approximate positions" setting is on (the dialog has a checkbox for it).
 * Resolution and layout live in core (`app.paths`, path-geometry.ts).
 *
 * Each stop that resolves to one known node links to its node page; an unknown / ambiguous hash
 * links to the node page of the bare hash.
 *
 * Test hooks: `mc-hops-link`, `[data-path-dialog]`, `[data-path-list] li[data-stop]` with
 * `data-role` / `data-position`, `a[data-node-link]`, `a[data-hash-link]`, `mc-map-marker[data-stop]`, `[data-action="close-path"]`,
 * `[data-approximate]` (the estimate checkbox), `[data-field="unplaced"]`.
 */
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import {
  formatDistance,
  isApproximate,
  type PathGeometry,
  type PathRequest,
  type PathSpec,
  type PathStop,
} from '@meshcore-web/core/app';
import { AppElement } from '../app-context.js';
import { hrefFor } from '../router.js';
import { shared } from '../styles.js';
import { contactNote, nodeHref, nodesHref } from './node-link.js';
import './tile-map.js';
import type { MapLine, McTileMap } from './tile-map.js';

export const SHOW_PATH_EVENT = 'mc-show-path';

/** Asks the app shell to open the path view for `req`. */
export function showPath(from: Element, req: PathRequest): void {
  from.dispatchEvent(new CustomEvent<PathRequest>(SHOW_PATH_EVENT, { detail: req, bubbles: true, composed: true }));
}

/** An inline "N hops" button that opens the path view (clicks don't reach the parent). */
export class McHopsLink extends LitElement {
  static override properties = { request: { attribute: false }, icon: { type: Boolean, reflect: true } };

  static override styles = css`
    :host {
      display: inline;
    }
    :host([icon]) {
      margin-inline-start: 0.35em;
    }
    :host([icon]) button {
      text-decoration: none;
    }
    button {
      font: inherit;
      color: var(--mc-accent);
      background: none;
      border: 0;
      padding: 0;
      min-height: 0;
      cursor: pointer;
      text-decoration: underline dotted;
      text-underline-offset: 2px;
    }
    button:hover {
      text-decoration-style: solid;
    }
    button:focus-visible {
      outline: 2px solid var(--mc-focus);
      outline-offset: 2px;
      border-radius: 3px;
    }
  `;

  declare request: PathRequest | undefined;
  /** Icon-only button (next to a path whose node names are links themselves). */
  declare icon: boolean;

  constructor() {
    super();
    this.request = undefined;
    this.icon = false;
    this.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.request) showPath(this, this.request);
    });
    // Enter / Space on the inner button click it (and so the host); keep row key handlers out
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
    });
  }

  override render() {
    // the icon lives in shadow DOM so the host's light-DOM text stays the path itself
    return this.icon
      ? html`<button type="button" title="Show the path on a map" aria-label="Show the path on a map">🧭</button>`
      : html`<button type="button" title="Show the path"><slot></slot></button>`;
  }
}

/** `<mc-hops-link>` around `label` (plain text when there is nothing to show). */
export function hopsLink(label: string, req: PathRequest | null): TemplateResult {
  return req ? html`<mc-hops-link .request=${req}>${label}</mc-hops-link>` : html`${label}`;
}

/** An icon-only `<mc-hops-link>` (for paths whose hops are node links). */
export function pathViewButton(req: PathRequest): TemplateResult {
  return html`<mc-hops-link icon .request=${req}></mc-hops-link>`;
}

const ROLE_LABEL: Record<PathStop['role'], string> = { from: 'From', hop: 'Hop', to: 'To' };
const POSITION_NOTE: Partial<Record<PathStop['position'], string>> = {
  ambiguous: 'location of the nearest match',
  interpolated: 'approximate location (between neighbours)',
  extrapolated: 'approximate location (extended from neighbours)',
};

export class McPathDialog extends AppElement {
  static override styles = [
    shared,
    css`
      dialog {
        border: 1px solid var(--mc-border);
        border-radius: var(--mc-radius);
        background: var(--mc-surface);
        color: var(--mc-text);
        padding: var(--mc-gap);
        width: min(44rem, calc(100vw - 32px));
        max-height: calc(100dvh - 32px);
      }
      dialog::backdrop {
        background: rgb(0 0 0 / 0.4);
      }
      header {
        display: flex;
        align-items: start;
        gap: 8px;
      }
      header h2 {
        flex: 1;
        font-size: 1.15rem;
      }
      .close {
        min-height: 2rem;
        padding: 0 0.6em;
      }
      ol {
        list-style: none;
        margin: 0 0 12px;
        padding: 0;
      }
      li {
        display: grid;
        grid-template-columns: 4.5rem 1fr;
        gap: 2px 10px;
        padding: 6px 0;
        border-block-end: 1px solid var(--mc-border);
      }
      li:last-child {
        border-block-end: 0;
      }
      .role {
        color: var(--mc-text-muted);
        font-size: 0.85rem;
      }
      .who {
        overflow-wrap: anywhere;
      }
      .hash {
        font-family: var(--mc-mono);
        font-size: 0.85rem;
        color: var(--mc-text-muted);
      }
      .detail {
        grid-column: 2;
        font-size: 0.85rem;
        color: var(--mc-text-muted);
      }
      .detail a {
        margin-inline-start: 6px;
      }
      li[data-position='interpolated'] .who::after,
      li[data-position='extrapolated'] .who::after,
      li[data-position='ambiguous'] .who::after {
        content: ' ?';
        color: var(--mc-warn);
        font-weight: 700;
      }
      mc-tile-map {
        height: clamp(240px, 50dvh, 420px);
      }
      .foot {
        margin-block-start: 8px;
        font-size: 0.85rem;
      }
      .estimate {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-block-start: 6px;
        font-size: 0.85rem;
      }
    `,
  ];

  #spec: PathSpec | null = null;
  #loading = false;
  #open = false;
  #fitPending = false;
  #seq = 0;

  get #dialog(): HTMLDialogElement | null {
    return this.renderRoot.querySelector('dialog');
  }

  /** The spec on show (for tests / callers). */
  get spec(): PathSpec | null {
    return this.#spec;
  }

  /** Opens the dialog and resolves `req` (async for messages / packets). */
  async show(req: PathRequest): Promise<void> {
    const seq = ++this.#seq;
    this.#spec = null;
    this.#loading = true;
    this.#open = true;
    this.requestUpdate();
    await this.updateComplete;
    const d = this.#dialog;
    if (d && !d.open) d.showModal();
    let spec: PathSpec | null = null;
    try {
      spec = await this.app.paths.resolve(req);
    } catch {
      spec = null;
    }
    if (seq !== this.#seq) return;
    this.#spec = spec;
    this.#loading = false;
    this.#fitPending = true;
    this.requestUpdate();
  }

  close(): void {
    this.#dialog?.close();
  }

  #onClose = (): void => {
    // the close event is async: a show() right after close() has already reopened the dialog
    if (this.#dialog?.open) return;
    this.#open = false;
    this.#spec = null;
    this.requestUpdate();
  };

  protected override updated(): void {
    const map = this.renderRoot.querySelector<McTileMap>('mc-tile-map');
    if (this.#fitPending && map && this.#spec) {
      const b = this.app.paths.geometry(this.#spec).bounds;
      if (b) map.fitBounds(b, { maxZoom: 15, padding: 40 });
      this.#fitPending = false;
    }
  }

  override render() {
    const spec = this.#spec;
    return html`<dialog data-path-dialog aria-labelledby="path-h" @close=${this.#onClose}>
      ${this.#open
        ? html`<header>
              <h2 id="path-h">${spec?.title ?? 'Path'}</h2>
              <button class="close" data-action="close-path" aria-label="Close" @click=${() => this.close()}>✕</button>
            </header>
            ${this.#loading
              ? html`<p class="muted" role="status">Looking up the path…</p>`
              : spec
                ? this.#body(spec, this.app.paths.geometry(spec))
                : html`<p class="muted" data-field="path-missing">This path is no longer available.</p>`}`
        : nothing}
    </dialog>`;
  }

  #setEstimate(on: boolean): void {
    this.app.appSettings.setApproximatePositions(on);
    this.#fitPending = true;
  }

  #body(spec: PathSpec, g: PathGeometry) {
    const hopsKnown = spec.hashes.length;
    const count = hopsKnown || spec.hopCount || 0;
    const estimate = this.app.appSettings.approximatePositions.value;
    // whether estimating would place stops that have no (single) location
    const estimable = this.app.paths.geometry(spec, { estimate: true }).placed > g.known;
    const unplaced = g.stops.filter((s) => s.position === 'none').length;
    return html`
      ${spec.note ? html`<p class="muted" data-field="path-note">${spec.note}</p>` : nothing}
      <ol data-path-list aria-label="Stops">
        ${g.stops.map((s, i) =>
          s.role === 'to' && !hopsKnown && spec.hopCount
            ? html`<li data-unknown-hops><span class="role">Hops</span><span class="who">${spec.hopCount === 1 ? '1 repeater' : `${spec.hopCount} repeaters`}, not recorded</span></li>${this.#stop(s, i)}`
            : this.#stop(s, i),
        )}
      </ol>
      ${g.placed > 0
        ? html`<mc-tile-map .tileUrl=${this.app.map.tileUrl.value} label="Path map" .lines=${this.#lines(g)} label-zoom="0">
            ${g.stops.map((s, i) => this.#marker(s, i))}
          </mc-tile-map>`
        : html`<p class="muted" data-field="no-map">None of these nodes has a known location, so the path can't be drawn on the map.</p>`}
      <p class="foot muted">
        ${count === 0 ? 'Direct (no hops).' : count === 1 ? '1 hop.' : `${count} hops.`}
        ${g.placed > 1 ? html` Drawn length ${formatDistance(g.distanceM)}.` : nothing}
        ${g.placed > g.known ? html` Dashed markers with “?” are estimated positions.` : nothing}
        ${g.placed > 0 && unplaced > 0
          ? html`<span data-field="unplaced">${unplaced === 1 ? '1 stop has' : `${unplaced} stops have`} no known location and ${unplaced === 1 ? 'is' : 'are'} not on the map.</span>`
          : nothing}
      </p>
      ${estimable
        ? html`<label class="estimate"
            ><input type="checkbox" data-approximate .checked=${estimate} @change=${(e: Event) => this.#setEstimate((e.target as HTMLInputElement).checked)} />
            Approximate positions of nodes without a location</label
          >`
        : nothing}
    `;
  }

  #stop(s: PathStop, i: number) {
    const hopNo = s.role === 'hop' ? i : 0;
    const note = POSITION_NOTE[s.position];
    const showOnMap = s.node && s.node.kind !== 'self' && s.node.key && s.position !== 'none' && !isApproximate(s.position);
    return html`<li data-stop=${i} data-role=${s.role} data-position=${s.position} data-hash=${s.hash ?? nothing}>
      <span class="role">${s.role === 'hop' ? `Hop ${hopNo}` : ROLE_LABEL[s.role]}</span>
      <span class="who">
        ${s.node && s.node.kind !== 'self'
          ? html`<a data-field="label" data-node-link=${s.node.key} href=${nodeHref(s.node.key)} title="Node details" @click=${() => this.close()}>${s.label}</a>${contactNote(this.app.contacts.noteFor(s.node.key))}`
          : !s.node && s.hash
            ? html`<a data-field="label" data-hash-link=${s.hash} href=${nodesHref(s.hash)} title="Nodes with this hash" @click=${() => this.close()}>${s.label}</a>`
            : html`<span data-field="label">${s.label}</span>`}
        ${s.hash && s.label !== s.hash ? html` <span class="hash">${s.hash}</span>` : nothing}
      </span>
      ${s.candidates.length > 1 && !s.node
        ? html`<span class="detail" data-field="candidates">${s.candidates.length} known nodes share this hash</span>`
        : nothing}
      ${s.role === 'hop' && s.candidates.length === 0 ? html`<span class="detail">Unknown repeater</span>` : nothing}
      ${note || showOnMap
        ? html`<span class="detail">
            ${note ?? nothing}
            ${showOnMap
              ? html`<a href=${hrefFor(`/map/node/${s.node!.key}`)} data-action="stop-on-map" @click=${() => this.close()}>Show on map</a>`
              : nothing}
          </span>`
        : nothing}
    </li>`;
  }

  #marker(s: PathStop, i: number) {
    if (s.lat === undefined || s.lon === undefined) return nothing;
    const approx = isApproximate(s.position);
    const kind = s.node?.kind ?? '';
    const desc = [s.role === 'hop' ? `hop ${i}` : ROLE_LABEL[s.role].toLowerCase(), approx ? 'approximate location' : ''].filter(Boolean).join(', ');
    return html`<mc-map-marker
      data-stop=${i}
      kind=${kind}
      lat=${s.lat}
      lon=${s.lon}
      label=${s.label}
      description=${desc}
      glyph=${s.role === 'hop' ? String(i) : ''}
      ?approximate=${approx}
    ></mc-map-marker>`;
  }

  #lines(g: PathGeometry): MapLine[] {
    const placed = g.stops.filter((s) => s.lat !== undefined && s.lon !== undefined);
    const out: MapLine[] = [];
    for (let i = 1; i < placed.length; i++) {
      const a = placed[i - 1]!;
      const b = placed[i]!;
      out.push({ points: [{ lat: a.lat!, lon: a.lon! }, { lat: b.lat!, lon: b.lon! }], dashed: isApproximate(a.position) || isApproximate(b.position), id: String(i), arrow: true });
    }
    return out;
  }
}

customElements.define('mc-hops-link', McHopsLink);
customElements.define('mc-path-dialog', McPathDialog);

declare global {
  interface HTMLElementTagNameMap {
    'mc-hops-link': McHopsLink;
    'mc-path-dialog': McPathDialog;
  }
  interface HTMLElementEventMap {
    'mc-show-path': CustomEvent<PathRequest>;
  }
}
