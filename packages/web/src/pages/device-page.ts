/** Device overview: identity, firmware, battery, radio parameters, link, statistics and adverts. */
import { css, html, nothing, type TemplateResult } from 'lit';
import { CONNECTION_KIND_LABEL, effect } from '@meshcore-web/core/app';
import { AppElement } from '../app-context.js';
import { PHASE_LABEL, batteryPercent } from '../format.js';
import { hrefFor } from '../router.js';
import { shared } from '../styles.js';

function formatDuration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min ${secs % 60} s`;
}

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
      .wide {
        grid-column: 1 / -1;
      }
      .hint {
        color: var(--mc-text-muted);
        font-size: 0.85rem;
        margin: 0;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-block: 10px;
      }
      table {
        border-collapse: collapse;
        width: 100%;
        font-size: 0.9rem;
      }
      th,
      td {
        text-align: start;
        padding: 4px 6px;
        border-block-end: 1px solid var(--mc-border);
      }
      td.num {
        text-align: end;
        font-variant-numeric: tabular-nums;
      }
      .saving {
        font-size: 0.85rem;
        color: var(--mc-text-muted);
      }
    `,
  ];

  #off: (() => void) | undefined;
  #tick: ReturnType<typeof setInterval> | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    // poll statistics while a radio is connected and the page is shown
    this.#off = effect(() => {
      const client = this.app.connection.client.value;
      if (!client || !this.app.connection.connected.value) return;
      const ds = this.app.deviceSettings;
      void ds.refreshStats().catch(() => undefined);
      return ds.pollStats(5000);
    });
    // re-render once a second for the advert cooldown
    this.#tick = setInterval(() => this.requestUpdate(), 1000);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#off?.();
    this.#off = undefined;
    if (this.#tick !== undefined) clearInterval(this.#tick);
    this.#tick = undefined;
  }

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
        ${this.#advert()} ${this.#stats()}
      </div>
    `;
  }

  #advert(): TemplateResult {
    const ds = this.app.deviceSettings;
    const wait = ds.advertCooldownRemaining(this.app.clock.now());
    void ds.advertCooldownUntil.value; // re-render when the cooldown ends
    const last = ds.lastAdvert.value;
    const busy = ds.busy.value.has('advert');
    return html`<section class="card" data-section="advert" aria-labelledby="advert-h">
      <h3 id="advert-h">Advert</h3>
      <p class="hint">
        Announce this radio so others can add it. A zero-hop advert reaches direct neighbours only; a flood advert is repeated across the
        mesh (and uses airtime on every repeater).
      </p>
      <div class="actions">
        <button data-action="advert-zero-hop" ?disabled=${busy || wait > 0} @click=${() => this.#sendAdvert('zeroHop')}>Send zero-hop advert</button>
        <button data-action="advert-flood" ?disabled=${busy || wait > 0} @click=${() => this.#sendAdvert('flood')}>Send flood advert</button>
        ${wait > 0 ? html`<span class="saving" data-field="advert-cooldown">Wait ${Math.ceil(wait / 1000)} s</span>` : nothing}
      </div>
      ${last
        ? html`<p class="hint" data-field="last-advert">Last: ${last.mode === 'flood' ? 'flood' : 'zero-hop'} at ${this.app.appSettings.formatTime(last.at, { seconds: true })}</p>`
        : nothing}
      <p class="hint">Automatic advert intervals are not configurable on companion firmware (v1.18 has no command for them).</p>
    </section>`;
  }

  #sendAdvert(mode: 'flood' | 'zeroHop'): void {
    const n = this.app.notifications;
    this.app.deviceSettings.sendAdvert(mode).then(
      () => n.success(mode === 'flood' ? 'Flood advert sent' : 'Zero-hop advert sent'),
      (err: unknown) => n.error('Could not send the advert', err),
    );
  }

  #stats(): TemplateResult {
    const ds = this.app.deviceSettings;
    const stats = ds.stats.value;
    const busy = ds.busy.value.has('stats');
    return html`<section class="card wide" data-section="stats" aria-labelledby="stats-h">
      <h3 id="stats-h">Statistics</h3>
      ${stats
        ? html`<table data-field="stats">
            <tbody>
              ${stats.core
                ? html`<tr><th scope="row">Uptime</th><td class="num">${formatDuration(stats.core.uptimeSecs)}</td></tr>
                    <tr><th scope="row">Queue</th><td class="num">${stats.core.outboundQueueLen}</td></tr>
                    <tr><th scope="row">Error flags</th><td class="num">0x${stats.core.errFlags.toString(16).padStart(4, '0')}</td></tr>`
                : nothing}
              ${stats.radio
                ? html`<tr><th scope="row">Noise floor</th><td class="num">${stats.radio.noiseFloorDbm} dBm</td></tr>
                    <tr><th scope="row">Last RSSI / SNR</th><td class="num">${stats.radio.lastRssiDbm} dBm / ${stats.radio.lastSnr} dB</td></tr>
                    <tr><th scope="row">Airtime TX / RX</th><td class="num">${stats.radio.txAirSecs} s / ${stats.radio.rxAirSecs} s</td></tr>`
                : nothing}
              ${stats.packets
                ? html`<tr><th scope="row">Received</th><td class="num">${stats.packets.recv} (${stats.packets.recvFlood} flood, ${stats.packets.recvDirect} direct)</td></tr>
                    <tr><th scope="row">Sent</th><td class="num">${stats.packets.sent} (${stats.packets.sentFlood} flood, ${stats.packets.sentDirect} direct)</td></tr>
                    ${stats.packets.recvErrors !== undefined
                      ? html`<tr><th scope="row">Receive errors</th><td class="num">${stats.packets.recvErrors}</td></tr>`
                      : nothing}`
                : nothing}
              ${!stats.core && !stats.radio && !stats.packets ? html`<tr><td>Not supported by this firmware (needs v8+).</td></tr>` : nothing}
            </tbody>
          </table>
          <p class="hint">Updated ${this.app.appSettings.formatTime(stats.at, { seconds: true })}; refreshes every 5 s while this page is open.</p>`
        : html`<p class="hint">Loading…</p>`}
      <div class="actions">
        <button data-action="refresh-stats" ?disabled=${busy} aria-busy=${busy ? 'true' : 'false'} @click=${this.#refreshStats}>
          Refresh
        </button>
      </div>
    </section>`;
  }

  #refreshStats = (): void => {
    const ds = this.app.deviceSettings;
    Promise.all([ds.refreshStats(), ds.refreshBattery()]).catch((err: unknown) =>
      this.app.notifications.error('Could not refresh the statistics', err),
    );
  };
}

customElements.define('mc-device-page', McDevicePage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-device-page': McDevicePage;
  }
}
