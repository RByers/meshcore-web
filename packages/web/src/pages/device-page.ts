/** Device overview: identity, firmware, battery, radio parameters, link. */
import { css, html, nothing } from 'lit';
import { CONNECTION_KIND_LABEL } from '@meshcore-web/core/app';
import { AppElement } from '../app-context.js';
import { PHASE_LABEL, batteryPercent } from '../format.js';
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
    `,
  ];

  override render() {
    const conn = this.app.connection;
    const si = conn.selfInfo.value;
    if (!si || !conn.connected.value) {
      return html`<section class="card">
        <h2>No radio connected</h2>
        <p><a href=${hrefFor('/')}>Connect a radio</a> to see its details.</p>
      </section>`;
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
    `;
  }
}

customElements.define('mc-device-page', McDevicePage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-device-page': McDevicePage;
  }
}
