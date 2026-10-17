/**
 * `/contact/:key`: what we know about one contact — type, key, path (as names when the setting
 * is on, each known hop linking to its own contact page), direct (zero-hop) signal, last seen,
 * location — with links to the chat / node pages and to the packet log filtered to this node, and
 * a chart of the packets heard from it over time (core `PacketLogModel.nodeActivity`, an indexed
 * scan of the packet log by source node). Channel senders, DM headers and path hops link here.
 * A *Stats* tab shows the packet log statistics for the contact (`<mc-contact-stats>`,
 * docs/packet-stats.md §5).
 */
import { css, html, nothing } from 'lit';
import { ACTIVITY_RANGES, hasLocation, type ActivityRange, type ContactView, type NodeActivity } from '@meshcore-web/core/app';
import { AppElement } from '../../app-context.js';
import { formatRelative, formatSnr, shortKey } from '../../format.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { avatar, listStyles, TYPE_LABEL } from './common.js';
import { pathLabelView } from '../../components/node-link.js';
import '../../components/activity-chart.js';
import './contact-stats.js';

type Tab = 'info' | 'stats';
const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'info', label: 'Info' },
  { id: 'stats', label: 'Stats' },
];

const RANGES = Object.keys(ACTIVITY_RANGES) as ActivityRange[];

export class McContactInfoPage extends AppElement {
  static override properties = { params: { attribute: false }, tab: { state: true } };
  declare params: Readonly<Record<string, string>> | undefined;
  declare tab: Tab;

  constructor() {
    super();
    this.tab = 'info';
  }

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
      .tabs {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid var(--mc-border);
      }
      .tabs button {
        border: none;
        border-bottom: 2px solid transparent;
        border-radius: 0;
        background: none;
        padding: 6px 12px;
      }
      .tabs button[aria-selected='true'] {
        border-bottom-color: var(--mc-accent);
        font-weight: 600;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      section.activity {
        margin-block: var(--mc-gap);
      }
      .activity-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-block-end: 8px;
      }
      .activity-head h3 {
        flex: 1;
        margin: 0;
        font-size: 1rem;
      }
      .seg {
        display: inline-flex;
        border: 1px solid var(--mc-border);
        border-radius: 8px;
        overflow: hidden;
      }
      .seg button {
        min-height: 0;
        padding: 2px 10px;
        border: 0;
        border-radius: 0;
        background: none;
        font-size: 0.85rem;
      }
      .seg button[aria-pressed='true'] {
        background: var(--mc-accent-soft);
        color: var(--mc-accent);
        font-weight: 600;
      }
      .activity p {
        margin: 6px 0 0;
        font-size: 0.85rem;
      }
    `,
  ];

  get key(): string {
    return (this.params?.['key'] ?? '').toLowerCase();
  }

  #range: ActivityRange = '7d';
  #activity: NodeActivity | null = null;
  /** What #activity was loaded for ("key|range|logged packets"); reloads when it changes. */
  #activityFor = '';
  #activitySeq = 0;

  #setRange(r: ActivityRange): void {
    this.#range = r;
    this.requestUpdate();
  }

  protected override updated(): void {
    const log = this.app.packetLog;
    // the packet log's total ticks as packets are logged, so the chart follows live traffic
    const want = `${this.key}|${this.#range}|${log.packets.total.peek()}`;
    if (!this.key || want === this.#activityFor) return;
    this.#activityFor = want;
    const seq = ++this.#activitySeq;
    const keyNow = this.key;
    log.nodeActivity(keyNow, this.#range).then(
      (a) => {
        if (seq !== this.#activitySeq) return;
        this.#activity = a;
        this.requestUpdate();
      },
      (err: unknown) => console.error('node activity:', err),
    );
  }

  #activitySection(key: string) {
    const a = this.#activity?.range === this.#range ? this.#activity : null;
    // read the signal so a newly logged packet re-renders (and so reloads) the chart
    void this.app.packetLog.packets.total.value;
    return html`<section class="card activity" data-field="activity">
      <div class="activity-head">
        <h3 id="activity-h">Packets heard from this node</h3>
        <span class="seg" role="group" aria-label="Time range">
          ${RANGES.map(
            (r) => html`<button data-range=${r} aria-pressed=${r === this.#range ? 'true' : 'false'} @click=${() => this.#setRange(r)}>${r}</button>`,
          )}
        </span>
      </div>
      ${!a
        ? html`<p class="muted" role="status">Loading…</p>`
        : a.total === 0
          ? html`<p class="muted" data-field="activity-empty">No packets from this node in the last ${ACTIVITY_RANGES[a.range].label}.</p>`
          : html`<mc-activity-chart aria-labelledby="activity-h" .activity=${a}></mc-activity-chart>
              <p data-field="activity-summary">
                ${a.total} packet${a.total === 1 ? '' : 's'} in the last ${ACTIVITY_RANGES[a.range].label}${a.last ? html` · last ${formatRelative(a.last, this.app.clock.now())}` : nothing}
                ${a.hashOnly
                  ? html`<br /><span class="muted" data-field="activity-hash-note"
                        >${a.hashOnly} matched only by the node's 1-byte hash <span class="mono">${key.slice(0, 2)}</span>; packets
                        from another node with the same first key byte are counted too.</span
                      >`
                  : nothing}
              </p>`}
    </section>`;
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
    return html`
      <header class="card" data-field="header">
        <a href=${hrefFor('/contacts')} aria-label="Back to contacts">←</a>
        ${avatar(v.typeName)}
        <div>
          <h2 data-field="name">${v.name}</h2>
          <span class="muted" data-field="type">${TYPE_LABEL[v.typeName]}${v.favourite ? ' · ★ favourite' : ''}${v.onDevice ? '' : ' · not on radio'}</span>
        </div>
      </header>
      <div class="tabs" role="tablist" aria-label="Contact">
        ${TABS.map(
          (t) => html`<button type="button" role="tab" data-tab=${t.id} aria-selected=${this.tab === t.id ? 'true' : 'false'} @click=${() => (this.tab = t.id)}>
            ${t.label}
          </button>`,
        )}
      </div>
      ${this.tab === 'stats' ? html`<mc-contact-stats role="tabpanel" .key=${v.key}></mc-contact-stats>` : this.#renderInfo(v)}
    `;
  }

  #renderInfo(v: ContactView) {
    const c = v.record;
    const path = this.app.contacts.outPathLabel(v, this.app.appSettings.pathNames.value);
    const located = hasLocation(c);
    return html`
      <section class="card">
        <dl class="info">
          <dt>Public key</dt>
          <dd class="mono" data-field="key">${v.key}</dd>
          <dt>Path</dt>
          <dd data-field="path" title=${path.title || nothing}>${pathLabelView(path, v.path.kind === 'hops' ? { kind: 'contact', key: v.key } : null)}</dd>
          <dt>Direct signal</dt>
          <dd data-field="direct-signal">
            ${v.directSnr !== undefined
              ? html`${formatSnr(v.directSnr)}${v.directSnrAt ? html` <span class="muted">(${formatRelative(v.directSnrAt, this.app.clock.now())})</span>` : nothing}`
              : html`<span class="muted">not heard directly</span>`}
          </dd>
          <dt>Last seen</dt>
          <dd data-field="last-seen">${v.lastSeen ? formatRelative(v.lastSeen, this.app.clock.now()) : 'never'}</dd>
          ${located ? html`<dt>Location</dt><dd data-field="location">${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</dd>` : nothing}
          ${c.notes ? html`<dt>Notes</dt><dd data-field="notes">${c.notes}</dd>` : nothing}
        </dl>
      </section>
      <div class="actions">
        ${v.typeName === 'chat' || v.typeName === 'room'
          ? html`<a data-action="message" href=${hrefFor(`/chat/${v.key}`)}>Message</a>`
          : nothing}
        ${v.typeName !== 'chat' ? html`<a data-action="node" href=${hrefFor(`/node/${v.key}`)}>Manage node</a>` : nothing}
        ${located || this.app.map.hasMarker(v.key) ? html`<a data-action="show-on-map" href=${hrefFor(`/map/node/${v.key}`)}>Show on map</a>` : nothing}
        <a data-action="node-packets" href=${hrefFor(`/packets/node/${v.key}`)}>Packets from this node</a>
      </div>
      ${this.#activitySection(v.key)}
    `;
  }
}

customElements.define('mc-contact-info-page', McContactInfoPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-contact-info-page': McContactInfoPage;
  }
}
