/**
 * Connect page: USB Serial / Bluetooth / Emulator, plus previously connected radios with the
 * data each one has stored in this browser (packets, ≈ database size) and a two-click Remove that
 * forgets the radio and deletes its data. While a radio is connected it shows that connection
 * with a Disconnect button (disconnect first to connect to something else) and the stored radios
 * without Reconnect. The "Install app" offer lives on the Settings page.
 */
import { css, html, nothing } from 'lit';
import { CONNECTION_KIND_LABEL, effect, isConnectionKind, untracked, type ConnectionKind } from '@meshcore-web/core/app';
import type { DeviceRecord } from '@meshcore-web/core/store';
import { AppElement } from '../app-context.js';
import { PHASE_LABEL, formatBytes, formatRelative, shortKey } from '../format.js';
import { hrefFor } from '../router.js';
import { shared } from '../styles.js';
import '../components/connect-progress.js';

interface Option {
  kind: ConnectionKind;
  icon: string;
  blurb: string;
  unavailable: string;
}

const OPTIONS: readonly Option[] = [
  {
    kind: 'serial',
    icon: '🔌',
    blurb: 'A radio plugged in over USB (Web Serial).',
    unavailable: 'Web Serial is not available in this browser. Use Chrome or Edge on desktop.',
  },
  {
    kind: 'ble',
    icon: '📶',
    blurb: 'A radio nearby over Bluetooth LE (Web Bluetooth).',
    unavailable: 'Web Bluetooth is not available in this browser. Use Chrome or Edge (desktop or Android).',
  },
  {
    kind: 'emulator',
    icon: '🧪',
    blurb: 'A simulated radio running in this page, with a small virtual mesh. Nothing is transmitted.',
    unavailable: '',
  },
];

export class McConnectPage extends AppElement {
  static override styles = [
    shared,
    css`
      :host {
        display: block;
        container-type: inline-size;
      }
      .options {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
        gap: var(--mc-gap);
        margin-block: var(--mc-gap);
      }
      .option {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .option[data-last] {
        border-color: var(--mc-accent);
      }
      .option h3 {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
      }
      .option p {
        flex: 1;
      }
      .badge {
        font-size: 0.75rem;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--mc-accent-soft);
        color: var(--mc-accent);
      }
      .why {
        font-size: 0.9em;
        color: var(--mc-warn);
      }
      .status {
        min-height: 1.5em;
      }
      .progress {
        display: grid;
        gap: 6px;
        max-width: 32rem;
        margin-block: var(--mc-gap);
      }
      .progress .row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        font-size: 0.9rem;
      }
      .progress .step {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .progress .pct {
        font-variant-numeric: tabular-nums;
      }
      ul.devices {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: 8px;
      }
      .device {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 16px;
      }
      .device .who {
        flex: 1 1 12rem;
        min-width: 0;
      }
      .device .name {
        font-weight: 600;
      }
      .device .stored {
        font-variant-numeric: tabular-nums;
      }
      .device .row-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .device[data-current] {
        border-color: var(--mc-accent);
      }
      button.danger[data-armed] {
        background: var(--mc-danger);
        border-color: var(--mc-danger);
        color: var(--mc-surface);
      }
      .known-head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        justify-content: space-between;
        gap: 4px 12px;
        margin-block: 1em 0.5em;
      }
      .known-head h3 {
        margin: 0;
      }
      .known-head .total {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.9em;
        font-variant-numeric: tabular-nums;
      }
      .known-head .total button {
        min-height: 2rem;
        padding: 0.25em 0.75em;
      }
      .current {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 16px;
        margin-block: var(--mc-gap);
      }
      .current .who {
        flex: 1 1 14rem;
        min-width: 0;
      }
      .current .name {
        font-weight: 600;
        font-size: 1.1rem;
      }
      .current .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      a.button {
        display: inline-flex;
        align-items: center;
        min-height: 2.5rem;
        padding: 0.5em 1em;
        border-radius: 8px;
        border: 1px solid var(--mc-border);
        background: var(--mc-surface);
        color: var(--mc-text);
        text-decoration: none;
      }
    `,
  ];

  #off: (() => void) | undefined;
  /** Origin-wide usage from `navigator.storage.estimate()` (all databases, caches, …), if available. */
  #origin: { usage: number; quota: number } | null = null;
  /** Pubkey whose Remove button was clicked once and awaits the confirming second click. */
  #armed: string | null = null;
  /** Pubkey being removed. */
  #removing: string | null = null;

  /** Any click other than on the armed Remove button disarms it (runs after the button's own handler). */
  readonly #onClick = (e: Event): void => {
    if (this.#armed === null) return;
    const btn = e
      .composedPath()
      .find((n): n is HTMLElement => n instanceof HTMLElement && n.dataset['action'] === 'remove-device');
    if (btn?.dataset['pubkey'] !== this.#armed) this.#disarm();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('click', this.#onClick);
    // count on show, and again whenever the known radios change (connect / remove)
    this.#off = effect(() => {
      void this.app.devices.value;
      untracked(() => void this.#refreshStorage());
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('click', this.#onClick);
    this.#off?.();
    this.#off = undefined;
    this.#armed = null;
  }

  async #refreshStorage(): Promise<void> {
    await this.app.storage.refresh();
    const storage = (navigator as { storage?: StorageManager }).storage;
    if (typeof storage?.estimate !== 'function') return;
    try {
      const est = await storage.estimate();
      this.#origin = { usage: est.usage ?? 0, quota: est.quota ?? 0 };
      this.requestUpdate();
    } catch {
      // not available (e.g. opaque origin); the per-radio numbers still show
    }
  }

  #disarm(): void {
    if (this.#armed === null) return;
    this.#armed = null;
    this.requestUpdate();
  }

  /** First click arms; a second click on the same button forgets the radio and deletes its data. */
  async #remove(d: DeviceRecord): Promise<void> {
    if (this.#armed !== d.pubKey) {
      this.#armed = d.pubKey;
      this.requestUpdate();
      return;
    }
    this.#armed = null;
    this.#removing = d.pubKey;
    this.requestUpdate();
    try {
      await this.app.forgetDevice(d.pubKey, { deleteData: true });
    } catch (err) {
      this.app.notifications.error(`Could not remove ${d.name || shortKey(d.pubKey)}`, err);
    } finally {
      this.#removing = null;
      this.requestUpdate();
    }
  }

  override render() {
    const conn = this.app.connection;
    const phase = conn.phase.value;
    const busy = conn.busy.value;
    const last = conn.lastKind.value;
    const kind = conn.kind.value;
    const hs = busy ? conn.handshake.value : null;
    if (conn.connected.value) return this.#connected();
    return html`
      <h2>Connect a radio</h2>
      <p class="muted">Choose how this browser talks to your MeshCore companion radio.</p>
      <p class="status" aria-live="polite">
        ${busy && kind ? html`${PHASE_LABEL[phase]} (${CONNECTION_KIND_LABEL[kind]})` : nothing}
        ${phase === 'error' && conn.error.value ? html`<span class="why">Last attempt failed: ${conn.error.value.message}</span>` : nothing}
      </p>
      ${hs
        ? html`<div class="progress" data-section="connect-progress">
            <div class="row">
              <span class="step" data-field="connect-step" aria-live="polite">${hs.label}</span>
              <span class="pct muted" data-field="connect-percent" aria-hidden="true">${Math.round(hs.fraction * 100)}%</span>
            </div>
            <mc-progress-bar .fraction=${hs.fraction} .label=${hs.label}></mc-progress-bar>
          </div>`
        : nothing}
      <div class="options">${OPTIONS.map((o) => this.#option(o, busy, last))}</div>
      ${this.#devices(busy)}
    `;
  }

  /** The current connection: what is connected, and how to disconnect from it. */
  #connected() {
    const conn = this.app.connection;
    const si = conn.selfInfo.value;
    const kind = conn.kind.value;
    const link = conn.transportInfo.value?.name;
    const pubKey = conn.pubKey.value;
    return html`
      <h2>Connected</h2>
      <section class="card current" data-section="current" aria-label="Current connection">
        <div class="who">
          <div class="name" data-field="current-name">${si?.name || 'Unnamed radio'}</div>
          <div class="muted">
            <span data-field="current-kind">${kind ? CONNECTION_KIND_LABEL[kind] : ''}</span>${link ? html` · <span data-field="current-link">${link}</span>` : nothing}
            ${pubKey ? html` · <span class="mono" title=${pubKey}>${shortKey(pubKey)}</span>` : nothing}
          </div>
        </div>
        <div class="actions">
          <a class="button" href=${hrefFor('/device')}>Device info</a>
          <button class="danger" data-action="disconnect-current" ?disabled=${conn.phase.value === 'disconnecting'}
            @click=${() => void conn.disconnect()}>Disconnect</button>
        </div>
      </section>
      <p class="muted" data-field="connected-note">Disconnect this radio to connect to a different one.</p>
      ${this.#devices(false, true)}
    `;
  }

  #option(o: Option, busy: boolean, last: ConnectionKind | null) {
    const available = this.app.connection.isAvailable(o.kind);
    const whyId = `why-${o.kind}`;
    return html`<section class="card option" data-kind=${o.kind} ?data-last=${last === o.kind}>
      <h3><span aria-hidden="true">${o.icon}</span>${CONNECTION_KIND_LABEL[o.kind]}
        ${last === o.kind ? html`<span class="badge">Last used</span>` : nothing}</h3>
      <p class="muted">${o.blurb}</p>
      ${available ? nothing : html`<p class="why" id=${whyId}>${o.unavailable}</p>`}
      <button
        class=${last === o.kind || (!last && o.kind === 'emulator') ? 'primary' : ''}
        data-connect=${o.kind}
        ?disabled=${!available || busy}
        aria-describedby=${available ? nothing : whyId}
        @click=${() => void this.app.connection.connect(o.kind)}
      >
        ${o.kind === 'emulator' ? 'Start emulator' : `Connect via ${CONNECTION_KIND_LABEL[o.kind]}`}
      </button>
    </section>`;
  }

  /** Known radios with their stored data; `connected`: the list shown under the current connection. */
  #devices(busy: boolean, connected = false) {
    const devices = this.app.devices.value;
    if (devices.length === 0) return nothing;
    const storage = this.app.storage;
    const loading = storage.loading.value;
    const origin = this.#origin;
    return html`<section aria-labelledby="known-h" data-section="known">
      <div class="known-head">
        <h3 id="known-h">${connected ? 'Radios in this browser' : 'Previously connected'}</h3>
        <span class="total muted">
          <span data-field="storage-total" title="Approximate: record data only, without index and storage overhead"
            >≈ ${formatBytes(storage.totalBytes.value)} stored</span
          >${origin
            ? html`<span
                data-field="origin-usage"
                title=${`All site data in this browser${origin.quota ? `, of ${formatBytes(origin.quota)} available` : ''}`}
                >· ${formatBytes(origin.usage)} site total</span
              >`
            : nothing}
          <button type="button" data-action="refresh-storage" ?disabled=${loading} aria-label="Recount stored data"
            @click=${() => void this.#refreshStorage()}>
            ${loading ? 'Counting…' : 'Recount'}
          </button>
        </span>
      </div>
      <ul class="devices">
        ${devices.map((d) => this.#device(d, busy, connected))}
      </ul>
    </section>`;
  }

  /** "1,234 packets · ≈ 1.2 MB", other record counts in the tooltip. */
  #stored(d: DeviceRecord) {
    const e = this.app.storage.byDevice.value[d.pubKey];
    if (e?.status === 'error') return html`<div class="stored muted" data-field="stored">Stored data unavailable</div>`;
    const st = e?.stats;
    if (!st) return html`<div class="stored muted" data-field="stored">Counting stored data…</div>`;
    const c = st.counts;
    const detail =
      `${c.messages.toLocaleString()} messages · ${c.contacts.toLocaleString()} contacts · ` +
      `${c.channels.toLocaleString()} channels · ${c.frames.toLocaleString()} frames ` +
      '(size is approximate: record data only)';
    return html`<div class="stored muted" data-field="stored" title=${detail}>
      <span data-field="packet-count">${c.packets.toLocaleString()}</span> packets ·
      <span data-field="db-size">≈ ${formatBytes(st.approxBytes)}</span>
    </div>`;
  }

  #device(d: DeviceRecord, busy: boolean, connected: boolean) {
    const conn = this.app.connection;
    const kind = isConnectionKind(d.transport) ? d.transport : null;
    const available = kind !== null && conn.isAvailable(kind);
    const direct = kind !== null && conn.canReconnect(kind);
    const label = d.name || shortKey(d.pubKey);
    const current = connected && conn.pubKey.value === d.pubKey;
    const armed = this.#armed === d.pubKey;
    const removing = this.#removing === d.pubKey;
    const disabled = busy || this.#removing !== null;
    return html`<li class="card device" data-pubkey=${d.pubKey} ?data-current=${current}>
      <div class="who">
        <div class="name">${d.name || 'Unnamed radio'}${current ? html` <span class="muted">(connected)</span>` : nothing}</div>
        <div class="muted">
          <span class="mono" title=${d.pubKey}>${shortKey(d.pubKey)}</span>
          · ${kind ? CONNECTION_KIND_LABEL[kind] : d.transport} · ${formatRelative(d.lastConnected, this.app.clock.now())}
        </div>
        ${this.#stored(d)}
      </div>
      <div class="row-actions">
        ${connected
          ? nothing
          : html`<button
              data-reconnect=${d.pubKey}
              ?disabled=${!available || disabled}
              aria-label=${`Reconnect to ${label}`}
              title=${direct ? 'Reconnect' : 'Opens the browser device chooser'}
              @click=${() => void conn.reconnect(d)}
            >
              Reconnect
            </button>`}
        <button
          class="danger"
          data-action="remove-device"
          data-pubkey=${d.pubKey}
          ?data-armed=${armed}
          ?disabled=${disabled}
          aria-label=${armed ? `Confirm: remove ${label} and delete its stored data` : `Remove ${label} and its stored data`}
          title=${current ? 'Disconnects, then deletes everything stored for this radio' : 'Deletes everything stored for this radio'}
          @click=${() => void this.#remove(d)}
          @blur=${() => {
            if (armed) this.#disarm();
          }}
        >
          ${removing ? 'Removing…' : armed ? 'Confirm remove' : 'Remove'}
        </button>
      </div>
    </li>`;
  }
}

customElements.define('mc-connect-page', McConnectPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-connect-page': McConnectPage;
  }
}
