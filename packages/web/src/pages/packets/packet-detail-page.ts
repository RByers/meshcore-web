/**
 * `/packets/:id` and `/packets/frame/:id`: one packet or frame in `<mc-packet-inspector>` on its
 * own page (used on narrow screens, and as a permalink from the side panel).
 */
import { css, html, nothing, type PropertyValues } from 'lit';
import { AppElement } from '../../app-context.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { frameInspectorProps, packetInspectorProps, type InspectorProps } from './inspection.js';
import './packet-inspector.js';

export class McPacketDetailPage extends AppElement {
  static override properties = {
    params: { attribute: false },
    kind: { type: String },
    props: { state: true },
    missing: { state: true },
  };
  declare params: Readonly<Record<string, string>>;
  /** 'packet' or 'frame' (set by the page registration). */
  declare kind: string;
  declare props: InspectorProps | null;
  declare missing: boolean;
  #loaded = '';

  constructor() {
    super();
    this.params = {};
    this.kind = 'packet';
    this.props = null;
    this.missing = false;
  }

  static override styles = [
    shared,
    css`
      :host {
        display: block;
        min-width: 0;
      }
      nav.crumbs {
        margin-block-end: 12px;
      }
    `,
  ];

  protected override willUpdate(_changed: PropertyValues<this>): void {
    const store = this.app.connection.store.value;
    const key = `${this.kind}:${this.params['id'] ?? ''}:${store?.pubKey ?? ''}`;
    if (key !== this.#loaded && store) {
      this.#loaded = key;
      void this.#load();
    }
  }

  async #load(): Promise<void> {
    const id = Number(this.params['id']);
    this.props = null;
    this.missing = false;
    if (!Number.isInteger(id)) {
      this.missing = true;
      return;
    }
    const log = this.app.packetLog;
    await log.settled();
    const p =
      this.kind === 'frame'
        ? await log.inspectFrame(id).then((i) => (i ? frameInspectorProps(i) : null))
        : await log.inspect(id).then((i) => (i ? packetInspectorProps(i) : null));
    this.props = p;
    this.missing = p === null;
  }

  override render() {
    const back = html`<nav class="crumbs"><a href=${hrefFor('/packets')} data-action="back">‹ Packet log</a></nav>`;
    if (!this.app.connection.connected.value) {
      return html`${back}<section class="card"><p><a href=${hrefFor('/')}>Connect a radio</a> to inspect its logs.</p></section>`;
    }
    return html`${back}
      <section class="card">
        ${this.props
          ? html`<mc-packet-inspector
              .heading=${this.props.heading}
              .meta=${this.props.meta}
              .bytes=${this.props.bytes}
              .annotation=${this.props.annotation}
              .json=${this.props.json}
            ></mc-packet-inspector>`
          : this.missing
            ? html`<p>This ${this.kind} is not in the log (it may have been cleared or pruned).</p>`
            : html`<p class="muted">Loading…</p>`}
        ${nothing}
      </section>`;
  }
}

customElements.define('mc-packet-detail-page', McPacketDetailPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-packet-detail-page': McPacketDetailPage;
  }
}
