/**
 * `<mc-node-list-page>`: `/nodes/:prefix` lists every known node — stored contacts and nodes only
 * heard advertising — whose public key starts with `prefix` (a 1-byte path / source / destination
 * hash, or a longer key prefix). Unlike `/node/:key` it stays a listing when only one node matches:
 * a 1-byte hash may still be some node this app never heard of. Hash links in packet paths and
 * packet endpoints open it (components/node-link.ts `hashLink`). Logic: core `app.node(prefix,
 * { list: true }).candidates` (NodeModel listing mode).
 *
 * Test hooks: `[data-field="prefix"]`, `[data-field="count"]`, `ul[data-list="nodes"]` with
 * `li[data-candidate="<key>"]` (`data-heard` for non-contacts), `[data-field="none"]`,
 * `[data-field="invalid"]`, `[data-action="node-packets"]`.
 */
import { css, html, nothing } from 'lit';
import { entryTab, normalizeNodeRef, type NodeCandidate } from '@meshcore-web/core/app';
import { AppElement } from '../../app-context.js';
import { shortKey } from '../../format.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { avatar, listStyles, TYPE_LABEL } from '../messaging/common.js';
import { contactNote, nodeHref } from '../../components/node-link.js';

export class McNodeListPage extends AppElement {
  static override properties = { params: { attribute: false } };
  declare params: Readonly<Record<string, string>> | undefined;

  static override styles = [
    shared,
    listStyles,
    css`
      .page-head a.back {
        text-decoration: none;
      }
      .foot {
        margin-block-start: 12px;
      }
    `,
  ];

  #row(c: NodeCandidate) {
    // contacts open where the contacts list opens them; heard nodes on Info
    const href = c.heard ? nodeHref(c.key) : nodeHref(c.key, entryTab(c.typeName));
    return html`<li data-candidate=${c.key} ?data-heard=${c.heard}>
      <a class="row-link" href=${href}>
        ${avatar(c.typeName)}
        <span class="row-main">
          <span class="row-title"><span class="name">${c.name || shortKey(c.key)}${contactNote(c.note)}</span></span>
          <span class="row-sub mono" title=${c.key}
            >${shortKey(c.key, 16)} · ${TYPE_LABEL[c.typeName]}${c.heard ? ' · heard, not a contact' : ''}</span
          >
        </span>
      </a>
    </li>`;
  }

  override render() {
    const raw = this.params?.['prefix'] ?? '';
    const prefix = normalizeNodeRef(raw);
    if (!prefix) {
      return html`<div class="page-head"><h2>Nodes</h2></div>
        <div class="card empty muted" data-field="invalid">“${raw}” is not a hex key prefix.</div>`;
    }
    const m = this.app.node(prefix, { list: true });
    void m.disposed.value; // eviction re-renders, and the re-render gets a fresh model
    const list = m.candidates.value;
    return html`
      <div class="page-head">
        <h2>
          <a class="back" href=${hrefFor('/contacts')} aria-label="Back to contacts">←</a>
          Nodes starting with <span class="mono" data-field="prefix">${prefix}</span>
          ${list ? html`<span class="muted" data-field="count">(${list.length})</span>` : nothing}
        </h2>
      </div>
      ${list === null
        ? html`<div class="card empty muted">Loading…</div>`
        : list.length
          ? html`<ul class="list" data-list="nodes">${list.map((c) => this.#row(c))}</ul>`
          : html`<div class="card empty muted" data-field="none">No contact or heard advert has a key starting with ${prefix}.</div>`}
      <p class="foot">
        <a data-action="node-packets" href=${hrefFor(`/packets/node/${prefix}`)}>Packets from ${prefix.length === 2 ? 'this hash' : 'these nodes'}</a>
      </p>
    `;
  }
}

customElements.define('mc-node-list-page', McNodeListPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-node-list-page': McNodeListPage;
  }
}
