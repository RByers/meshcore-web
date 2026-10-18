/**
 * `<mc-node-page>`: `/node/:key` and `/node/:key/:tab`. One page per node — a stored contact, a
 * node only heard advertising (packet log), a bare path hash or key prefix with several
 * candidates, or nothing known — resolved by core `app.node(ref)` (NodeModel), which also decides
 * the tabs: Info (always first), Messages (contacts: the DM / room chat, embedded), Path (contacts:
 * routing and path editor),
 * Overview / Telemetry / CLI / Tools (repeater, room and sensor administration) and Stats.
 *
 * Test hooks: `[data-field="header"]` with `name` / `type` / `key-short` / `session`,
 * `[data-action="show-on-map"]`, `[data-action="ping"]` / `[data-field="ping-result"]` (with
 * `data-state` ok / failed; repeaters, rooms and sensors); `nav [data-tab]` anchors; `section[data-panel]`;
 * `[data-field="subtitle"]` (contacts: path · SNR · last seen, on every tab); `[data-field="room-login-hint"]`.
 * The host carries `data-active-tab` (not `data-tab`, so `[data-tab=…]` only matches the tab links).
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import {
  canPing,
  hasLocation,
  nodeTabFor,
  type NodeIdentity,
  type NodeModel,
  type NodeTab,
  type RemoteNodeModel,
} from '@meshcore-web/core/app';
import { AppElement } from '../../app-context.js';
import { formatDuration, formatRelative, formatSnr, shortKey } from '../../format.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { avatar, listStyles, TYPE_LABEL } from '../messaging/common.js';
import { contactNote, nodeHref, pathLabelView } from '../../components/node-link.js';
import { loginLabel, type AdminTab } from './node-admin.js';
import { identityKey } from './node-info.js';
import './node-admin.js';
import './node-path.js';
import '../messaging/chat-page.js';
import '../messaging/contact-stats.js';

const TAB_LABEL: Record<NodeTab, string> = {
  info: 'Info',
  messages: 'Messages',
  path: 'Path',
  overview: 'Overview',
  telemetry: 'Telemetry',
  cli: 'CLI',
  tools: 'Tools',
  stats: 'Stats',
};

export class McNodePage extends AppElement {
  static override properties = { params: { attribute: false } };
  declare params: Readonly<Record<string, string>> | undefined;

  /** Stable params object for the embedded chat (a new object would re-render it every time). */
  #chatParams: Readonly<Record<string, string>> = {};

  static override styles = [
    shared,
    listStyles,
    css`
      :host([data-active-tab='messages']) {
        display: flex;
        flex-direction: column;
        height: calc(100dvh - 6.5rem);
      }
      :host([data-active-tab='messages']) section[role='tabpanel'] {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      header.card {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 12px;
        margin-block-end: var(--mc-gap);
      }
      header h2 {
        margin: 0;
        overflow-wrap: anywhere;
      }
      header .head-main {
        /* a 12rem basis: on a phone the map link / session wrap below instead of squeezing the name */
        flex: 1 1 12rem;
        min-width: 0;
      }
      .type-badge {
        display: inline-block;
        font-size: 0.8em;
        padding: 1px 8px;
        border-radius: 999px;
        background: var(--mc-accent-soft);
        color: var(--mc-accent);
        margin-inline-end: 6px;
      }
      .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-block-end: 12px;
        border-block-end: 1px solid var(--mc-border);
      }
      .tabs a {
        padding: 0.5em 1em;
        text-decoration: none;
        color: var(--mc-text);
        border-block-end: 3px solid transparent;
      }
      .tabs a[aria-selected='true'] {
        border-block-end-color: var(--mc-accent);
        color: var(--mc-accent);
        font-weight: 600;
      }
      .map-link {
        display: inline-flex;
        align-items: center;
        min-height: 2.5rem;
        padding: 0.5em 0.8em;
        border: 1px solid var(--mc-border);
        border-radius: 8px;
        text-decoration: none;
        white-space: nowrap;
      }
      .ok {
        color: var(--mc-ok);
      }
      .ping {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }
      .ping .error {
        color: var(--mc-danger);
        cursor: help;
      }
      .hint {
        margin: 0 0 8px;
      }
    `,
  ];

  get #ref(): string {
    return this.params?.['key'] ?? '';
  }

  /** Re-requested every render (never held): the core cache may evict and dispose a model. */
  #node(): NodeModel {
    const node = this.app.node(this.#ref);
    void node.disposed.value; // eviction re-renders, and the re-render gets a fresh model
    return node;
  }

  /** Contact note lookup for path hop tooltips. */
  #notes = (key: string): string => this.app.contacts.noteFor(key);

  override render() {
    const node = this.#node();
    const id = node.identity.value;
    if (!id) {
      this.#setActive('info');
      return html`<section class="card"><p class="muted" role="status" data-field="loading">Loading…</p></section>`;
    }
    if (id.kind === 'unknown' && !id.valid) {
      this.#setActive('info');
      return html`<section class="card" data-field="invalid">
        <h2>Unknown node</h2>
        <p class="muted">“${this.#ref}” is not a node key or hash.</p>
        <p><a href=${hrefFor('/contacts')}>Back to contacts</a></p>
      </section>`;
    }
    const tab = nodeTabFor(id, this.params?.['tab']);
    this.#setActive(tab);
    const key = identityKey(id, node.ref);
    const tabs = node.tabs.value;
    return html`
      ${this.#header(id, key)}
      <nav class="tabs" role="tablist" aria-label="Node">
        ${tabs.map(
          (t) => html`<a role="tab" data-tab=${t} aria-selected=${t === tab ? 'true' : 'false'} href=${nodeHref(key, t)}>${TAB_LABEL[t]}</a>`,
        )}
      </nav>
      <section role="tabpanel" aria-label=${TAB_LABEL[tab]} data-panel=${tab}>${this.#panel(node, id, key, tab)}</section>
    `;
  }

  #setActive(tab: NodeTab): void {
    if (this.dataset['activeTab'] !== tab) this.dataset['activeTab'] = tab;
  }

  #panel(node: NodeModel, id: NodeIdentity, key: string, tab: NodeTab): TemplateResult {
    switch (tab) {
      case 'messages': {
        if (this.#chatParams['key'] !== key) this.#chatParams = { key };
        const v = id.kind === 'contact' ? id.contact : undefined;
        const hint =
          v?.typeName === 'room' && !this.app.remoteAdmin.node(key).loggedIn.value
            ? html`<p class="muted hint" data-field="room-login-hint">
                <a href=${nodeHref(key, 'overview')}>Log in</a> so the room server sends you its posts.
              </p>`
            : nothing;
        return html`${hint}<mc-chat-page embedded mode="contact" .params=${this.#chatParams}></mc-chat-page>`;
      }
      case 'overview':
      case 'telemetry':
      case 'cli':
      case 'tools':
        return html`<mc-node-admin .key=${key} .tab=${tab satisfies AdminTab}></mc-node-admin>`;
      case 'path':
        return html`<mc-node-path .key=${key}></mc-node-path>`;
      case 'stats':
        return html`<mc-contact-stats .key=${key}></mc-contact-stats>`;
      default:
        return html`<mc-node-info .node=${node}></mc-node-info>`;
    }
  }

  #header(id: NodeIdentity, key: string): TemplateResult {
    let name: string | TemplateResult;
    let type: string;
    let icon: TemplateResult;
    let located = false;
    let session: TemplateResult | typeof nothing = nothing;
    let ping: TemplateResult | typeof nothing = nothing;
    switch (id.kind) {
      case 'contact': {
        const v = id.contact;
        name = html`<span data-field="name">${v.name}</span>${contactNote(v.note)}`;
        type = TYPE_LABEL[v.typeName];
        icon = avatar(v.typeName);
        located = hasLocation(v.record);
        if (v.typeName !== 'chat') {
          const remote = this.app.remoteAdmin.node(key);
          session = html`<span data-field="session" class=${remote.loggedIn.value ? 'ok' : 'muted'}>${loginLabel(remote.loginState.value)}</span>`;
        }
        if (canPing(v.record.type)) ping = this.#ping(this.app.remoteAdmin.node(key));
        break;
      }
      case 'heard': {
        const h = id.heard;
        name = html`<span data-field="name">${h.name || shortKey(h.key)}</span>`;
        type = `${TYPE_LABEL[h.typeName]} · not a contact`;
        icon = avatar(h.typeName);
        located = hasLocation(h.lat !== undefined && h.lon !== undefined ? { lat: h.lat, lon: h.lon } : null);
        break;
      }
      default:
        name = html`<span data-field="name">${id.ref.length === 2 ? `Hash ${id.ref}` : `Node ${shortKey(id.ref, 16)}`}</span>`;
        type = id.kind === 'ambiguous' ? 'Several nodes match' : 'Unknown node';
        icon = html`<span class="avatar" role="img" aria-label="Unknown node">?</span>`;
    }
    const full = id.kind === 'contact' || id.kind === 'heard';
    const map = full && (located || this.app.map.hasMarker(key));
    return html`<header class="card" data-field="header">
      <a href=${hrefFor('/contacts')} aria-label="Back to contacts">←</a>
      ${icon}
      <div class="head-main">
        <h2>${name}</h2>
        <div class="muted">
          <span class="type-badge" data-field="type">${type}</span>
          <span class="mono" data-field="key-short" title=${key}>${shortKey(key, 16)}</span>
        </div>
        ${id.kind === 'contact' ? html`<div class="muted" data-field="subtitle">${this.#subtitle(id, key)}</div>` : nothing}
      </div>
      ${session} ${ping}
      ${map
        ? html`<a class="map-link" data-action="show-on-map" href=${hrefFor(`/map/node/${key}`)} title="Show on map" aria-label="Show on map"
            ><span aria-hidden="true">🗺 Map</span></a
          >`
        : nothing}
    </header>`;
  }

  /**
   * One-click ping (the default trace through the node and back) and its outcome: "Reachable ·
   * 850 ms · SNR out 8 dB / back 7.5 dB" (out = what the node heard, back = what we heard), or
   * "No reply" with the reason as a tooltip.
   */
  #ping(remote: RemoteNodeModel): TemplateResult {
    const busy = remote.busy.value.has('ping');
    const connected = this.app.connection.connected.value;
    const res = remote.lastPing.value;
    const err = remote.errors.value.ping;
    let result: TemplateResult | typeof nothing = nothing;
    if (busy) {
      // the previous outcome is stale while a new ping runs
    } else if (err) {
      result = html`<span class="error" data-field="ping-result" data-state="failed" title=${err}>No reply</span>`;
    } else if (res) {
      // the path is out-hops + node + the out-hops reversed: the node is the middle entry
      const relays = (res.hops.length - 1) / 2;
      const out = res.hops[Math.floor(res.hops.length / 2)]?.snr;
      const parts = [
        'Reachable',
        formatDuration(res.roundTripMs),
        ...(relays >= 1 ? [`${relays} ${relays === 1 ? 'repeater' : 'repeaters'} each way`] : []),
        `SNR ${out !== undefined && !Number.isNaN(out) ? `out ${formatSnr(out)} / ` : ''}back ${formatSnr(res.finalSnr)}`,
      ];
      result = html`<span class="ok" data-field="ping-result" data-state="ok">${parts.join(' · ')}</span>`;
    }
    return html`<span class="ping">
      <button
        data-action="ping"
        ?disabled=${busy || !connected}
        title=${connected ? 'Trace a packet to the node and back' : 'Connect a radio to ping'}
        @click=${() => void remote.ping().catch(() => undefined)}
      >
        ${busy ? 'Pinging…' : 'Ping'}
      </button>
      ${result}
    </span>`;
  }

  /** How messages reach the contact (path · direct SNR · last seen). */
  #subtitle(id: Extract<NodeIdentity, { kind: 'contact' }>, key: string): TemplateResult {
    const v = id.contact;
    const path = this.app.contacts.outPathLabel(v, this.app.appSettings.pathNames.value);
    const parts: (string | TemplateResult)[] = [pathLabelView(path, v.path.kind === 'hops' ? { kind: 'contact', key } : null, this.#notes)];
    if (v.directSnr !== undefined) parts.push(`direct SNR ${formatSnr(v.directSnr)}`);
    if (v.lastSeen) parts.push(`seen ${formatRelative(v.lastSeen, this.app.clock.now())}`);
    return html`${parts.map((p, i) => html`${i ? ' · ' : ''}${p}`)}`;
  }
}

customElements.define('mc-node-page', McNodePage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-node-page': McNodePage;
  }
}
