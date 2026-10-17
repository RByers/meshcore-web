/** Device overview: identity, firmware, battery, radio parameters, link, stored data per known radio. */
import { css, html, nothing, type TemplateResult } from 'lit';
import { CONNECTION_KIND_LABEL, effect, untracked } from '@meshcore-web/core/app';
import { AppElement } from '../app-context.js';
import { PHASE_LABEL, batteryPercent, formatBytes, shortKey } from '../format.js';
import { hrefFor } from '../router.js';
import { shared } from '../styles.js';

export class McDevicePage extends AppElement {
  static override styles = [
    shared,
    css`
      :host {
        display: block;
        container-type: inline-size;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
        gap: var(--mc-gap);
      }
      header.card {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 8px 16px;
        margin-block-end: var(--mc-gap);
      }
      header > div:first-child {
        min-width: 0;
      }
      header h2 {
        margin: 0;
      }
      .pubkey {
        overflow-wrap: anywhere;
        user-select: all;
      }
      dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 6px 16px;
        margin: 0;
      }
      dt {
        color: var(--mc-text-muted);
      }
      dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      h3 {
        font-size: 1rem;
      }
      .storage {
        margin-block-start: var(--mc-gap);
      }
      .storage-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .storage-head h3 {
        margin: 0;
      }
      .storage ul {
        list-style: none;
        margin: 12px 0 0;
        padding: 0;
        display: grid;
        gap: 8px;
      }
      .storage li {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        justify-content: space-between;
        gap: 4px 16px;
        padding: 8px 10px;
        border: 1px solid var(--mc-border);
        border-radius: var(--mc-radius);
      }
      .storage li.current {
        border-color: var(--mc-accent);
        background: var(--mc-accent-soft);
      }
      .storage .who {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .storage .size {
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .storage .counts {
        flex-basis: 100%;
        font-size: 0.9em;
      }
      .storage .origin {
        margin: 12px 0 0;
        font-size: 0.9em;
      }
    `,
  ];

  #off: (() => void) | undefined;
  /** Origin-wide usage from `navigator.storage.estimate()` (all databases, caches, …), if available. */
  #origin: { usage: number; quota: number } | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // recount whenever the known radios change (a connect records / updates its device row)
    this.#off = effect(() => {
      void this.app.devices.value;
      untracked(() => void this.#refreshStorage());
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#off?.();
    this.#off = undefined;
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

  async #onRefresh(): Promise<void> {
    await this.app.refreshDevices();
    await this.#refreshStorage();
  }

  #renderStorage(): TemplateResult {
    const devices = this.app.devices.value;
    const byDevice = this.app.storage.byDevice.value;
    const loading = this.app.storage.loading.value;
    const current = this.app.connection.pubKey.value;
    return html`<section class="card storage" aria-labelledby="storage-h" data-section="storage">
      <div class="storage-head">
        <h3 id="storage-h">Stored data</h3>
        <button type="button" data-action="refresh-storage" ?disabled=${loading} @click=${() => void this.#onRefresh()}>
          ${loading ? 'Counting…' : 'Refresh'}
        </button>
      </div>
      ${devices.length === 0
        ? html`<p class="muted">No radios stored in this browser yet.</p>`
        : html`<ul>
            ${devices.map((d) => {
              const e = byDevice[d.pubKey];
              const st = e?.stats;
              const c = st?.counts;
              return html`<li class=${d.pubKey === current ? 'current' : ''} data-device=${d.pubKey}>
                <span class="who">
                  <strong>${d.name || 'Unnamed radio'}</strong>
                  <span class="muted mono">${shortKey(d.pubKey)}</span>
                  ${d.pubKey === current ? html`<span class="muted">(connected)</span>` : nothing}
                </span>
                <span class="size" data-field="db-size" title="Approximate: record data only, without index and storage overhead">
                  ${e?.status === 'error'
                    ? html`<span class="muted">unavailable</span>`
                    : st
                      ? `≈ ${formatBytes(st.approxBytes)}`
                      : html`<span class="muted">…</span>`}
                </span>
                ${c
                  ? html`<span class="counts muted">
                      <span data-field="packet-count">${c.packets.toLocaleString()}</span> packets ·
                      ${c.messages.toLocaleString()} messages · ${c.contacts.toLocaleString()} contacts ·
                      ${c.channels.toLocaleString()} channels · ${c.frames.toLocaleString()} frames
                    </span>`
                  : nothing}
              </li>`;
            })}
          </ul>`}
      ${this.#origin
        ? html`<p class="origin muted" data-field="origin-usage">
            All site data in this browser: ${formatBytes(this.#origin.usage)}${this.#origin.quota
              ? ` of ${formatBytes(this.#origin.quota)} available`
              : ''}
          </p>`
        : nothing}
    </section>`;
  }

  override render() {
    const conn = this.app.connection;
    const si = conn.selfInfo.value;
    if (!si || !conn.connected.value) {
      return html`<section class="card">
          <h2>No radio connected</h2>
          <p><a href=${hrefFor('/')}>Connect a radio</a> to see its details.</p>
        </section>
        ${this.#renderStorage()}`;
    }
    const di = conn.deviceInfo.value;
    const batt = conn.battery.value;
    const pub = conn.pubKey.value ?? '';
    const ti = conn.transportInfo.value;
    const kind = conn.kind.value;
    const radio = this.app.deviceSettings.radioParams.value;
    return html`
      <header class="card">
        <div>
          <h2 data-field="name">${si.name || 'Unnamed radio'}</h2>
          <div class="muted mono pubkey" data-field="pubkey">${pub}</div>
        </div>
        <div data-field="state">${PHASE_LABEL[conn.phase.value]}${kind ? html` · ${CONNECTION_KIND_LABEL[kind]}` : nothing}</div>
      </header>
      <div class="grid">
        <section class="card" aria-labelledby="fw-h">
          <h3 id="fw-h">Firmware</h3>
          <dl>
            <dt>Version</dt>
            <dd data-field="firmware">${di?.firmwareVersion ?? 'unknown'}</dd>
            <dt>Build date</dt>
            <dd>${di?.buildDate ?? '—'}</dd>
            <dt>Hardware</dt>
            <dd data-field="manufacturer">${di?.manufacturer ?? '—'}</dd>
            <dt>Protocol</dt>
            <dd>${di ? `v${di.firmwareVerCode}` : 'v1 (no DEVICE_QUERY)'}</dd>
            ${di?.maxContacts !== undefined
              ? html`<dt>Capacity</dt>
                  <dd>${di.maxContacts} contacts, ${di.maxChannels ?? '?'} channels</dd>`
              : nothing}
          </dl>
        </section>
        <section class="card" aria-labelledby="radio-h">
          <h3 id="radio-h">Radio</h3>
          ${radio
            ? html`<dl data-field="radio">
                <dt>Frequency</dt>
                <dd>${radio.freqMhz.toFixed(3)} MHz</dd>
                <dt>Bandwidth</dt>
                <dd>${radio.bwKhz} kHz</dd>
                <dt>Spreading factor</dt>
                <dd>SF${radio.sf}</dd>
                <dt>Coding rate</dt>
                <dd>4/${radio.cr}</dd>
                <dt>TX power</dt>
                <dd>${radio.txPowerDbm} dBm (max ${si.maxTxPowerDbm})</dd>
              </dl>`
            : nothing}
        </section>
        <section class="card" aria-labelledby="pwr-h">
          <h3 id="pwr-h">Power &amp; link</h3>
          <dl>
            <dt>Battery</dt>
            <dd data-field="battery">
              ${batt ? `${(batt.batteryMv / 1000).toFixed(2)} V (~${batteryPercent(batt.batteryMv)} %)` : '—'}
            </dd>
            ${batt?.storageTotalKb
              ? html`<dt>Storage</dt>
                  <dd>${batt.storageUsedKb ?? 0} / ${batt.storageTotalKb} KB</dd>`
              : nothing}
            <dt>Link</dt>
            <dd data-field="link">${ti ? ti.name : '—'}${ti?.detail ? html` <span class="muted">(${ti.detail})</span>` : nothing}</dd>
            <dt>Location</dt>
            <dd>${si.lat || si.lon ? `${si.lat.toFixed(5)}, ${si.lon.toFixed(5)}` : 'not set'}</dd>
          </dl>
        </section>
      </div>
      ${this.#renderStorage()}
    `;
  }
}

customElements.define('mc-device-page', McDevicePage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-device-page': McDevicePage;
  }
}
