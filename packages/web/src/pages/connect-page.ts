/**
 * Connect page: USB Serial / Bluetooth / Emulator, plus previously connected radios. While a
 * radio is connected it shows only that connection with a Disconnect button: disconnect first
 * to connect to something else. The "Install app" offer lives on the Settings page.
 */
import { css, html, nothing } from 'lit';
import { CONNECTION_KIND_LABEL, isConnectionKind, type ConnectionKind } from '@meshcore-web/core/app';
import type { DeviceRecord } from '@meshcore-web/core/store';
import { AppElement } from '../app-context.js';
import { PHASE_LABEL, formatRelative, shortKey } from '../format.js';
import { hrefFor } from '../router.js';
import { shared } from '../styles.js';

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

  override render() {
    const conn = this.app.connection;
    const phase = conn.phase.value;
    const busy = conn.busy.value;
    const last = conn.lastKind.value;
    const kind = conn.kind.value;
    if (conn.connected.value) return this.#connected();
    return html`
      <h2>Connect a radio</h2>
      <p class="muted">Choose how this browser talks to your MeshCore companion radio.</p>
      <p class="status" aria-live="polite">
        ${busy && kind ? html`${PHASE_LABEL[phase]} (${CONNECTION_KIND_LABEL[kind]})` : nothing}
        ${phase === 'error' && conn.error.value ? html`<span class="why">Last attempt failed: ${conn.error.value.message}</span>` : nothing}
      </p>
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

  #devices(busy: boolean) {
    const devices = this.app.devices.value;
    if (devices.length === 0) return nothing;
    return html`<section aria-labelledby="known-h">
      <h3 id="known-h">Previously connected</h3>
      <ul class="devices">
        ${devices.map((d) => this.#device(d, busy))}
      </ul>
    </section>`;
  }

  #device(d: DeviceRecord, busy: boolean) {
    const conn = this.app.connection;
    const kind = isConnectionKind(d.transport) ? d.transport : null;
    const available = kind !== null && conn.isAvailable(kind);
    const direct = kind !== null && conn.canReconnect(kind);
    return html`<li class="card device" data-pubkey=${d.pubKey}>
      <div class="who">
        <div class="name">${d.name || 'Unnamed radio'}</div>
        <div class="muted">
          <span class="mono" title=${d.pubKey}>${shortKey(d.pubKey)}</span>
          · ${kind ? CONNECTION_KIND_LABEL[kind] : d.transport} · ${formatRelative(d.lastConnected, this.app.clock.now())}
        </div>
      </div>
      <button
        data-reconnect=${d.pubKey}
        ?disabled=${!available || busy}
        aria-label=${`Reconnect to ${d.name || shortKey(d.pubKey)}`}
        title=${direct ? 'Reconnect' : 'Opens the browser device chooser'}
        @click=${() => void conn.reconnect(d)}
      >
        Reconnect
      </button>
    </li>`;
  }
}

customElements.define('mc-connect-page', McConnectPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-connect-page': McConnectPage;
  }
}
