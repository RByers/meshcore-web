/**
 * Settings page (Phase 11): device settings of the connected radio (identity, radio, adverts,
 * device status, contacts policy, advanced) and local app settings. Thin view over
 * `app.deviceSettings` (DeviceSettingsModel) and `app.appSettings` (AppSettingsModel).
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import {
  LORA_BANDWIDTHS_KHZ,
  LORA_CODING_RATES,
  LORA_SPREADING_FACTORS,
  MAX_PACKET_RETENTION_DAYS,
  RADIO_PRESETS,
  SettingsValidationError,
  THEME_OPTIONS,
  TIME_FORMAT_OPTIONS,
  effect,
  findRadioPreset,
  type DeviceSettingsModel,
  type SettingsAction,
  type ThemePreference,
  type TimeFormatPreference,
} from '@meshcore-web/core/app';
import { AppElement } from '../../app-context.js';
import { APP_VERSION, BUILD_DATE, MESHCORE_FIRMWARE_URL, MESHCORE_URL, REPO_URL } from '../../build-info.js';
import { batteryPercent } from '../../format.js';
import { getInstallPrompt } from '../../pwa.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';

interface RadioDraft {
  freqMhz: number;
  bwKhz: number;
  sf: number;
  cr: number;
  clientRepeat: boolean;
}

interface DialogRequest {
  title: string;
  body: TemplateResult | string;
  confirmLabel: string;
  danger?: boolean;
  /** The confirm button stays disabled until this text is typed. */
  requireText?: string;
  resolve: (ok: boolean) => void;
}

const THEME_LABEL: Record<ThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const TIME_FORMAT_LABEL: Record<TimeFormatPreference, string> = { system: 'System default', '12h': '12-hour', '24h': '24-hour' };
const TELEMETRY_LABEL = ['Deny', 'Per-contact', 'Allow all'];

function num(form: HTMLFormElement, name: string): number {
  const v = new FormData(form).get(name);
  return typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
}

function str(form: HTMLFormElement, name: string): string {
  const v = new FormData(form).get(name);
  return typeof v === 'string' ? v : '';
}

function checked(form: HTMLFormElement, name: string): boolean {
  return new FormData(form).get(name) !== null;
}

function formatDuration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min ${secs % 60} s`;
}

function formatDrift(drift: number): string {
  const a = Math.abs(drift);
  const amount = a < 120 ? `${a} s` : a < 7200 ? `${Math.round(a / 60)} min` : `${(a / 3600).toFixed(1)} h`;
  return drift === 0 ? 'in sync' : `${amount} ${drift > 0 ? 'ahead' : 'behind'}`;
}

export class McSettingsPage extends AppElement {
  static override styles = [
    shared,
    css`
      :host {
        display: block;
        container-type: inline-size;
      }
      .sections {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
        gap: var(--mc-gap);
        align-items: start;
      }
      section.card h2 {
        font-size: 1.1rem;
      }
      h3 {
        font-size: 0.95rem;
        margin-block: 1em 0.5em;
      }
      form {
        display: grid;
        gap: 10px;
      }
      form + form {
        margin-block-start: 14px;
        padding-block-start: 14px;
        border-block-start: 1px solid var(--mc-border);
      }
      label.field {
        display: grid;
        gap: 4px;
        font-size: 0.9rem;
      }
      label.check {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
        gap: 10px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      input:not([type='checkbox'], [type='radio'], [type='range']),
      select,
      textarea {
        font: inherit;
        color: var(--mc-text);
        background: var(--mc-surface);
        border: 1px solid var(--mc-border);
        border-radius: 8px;
        padding: 0.45em 0.6em;
        min-height: 2.5rem;
        width: 100%;
      }
      textarea {
        font-family: var(--mc-mono);
        font-size: 0.85rem;
        min-height: 5rem;
      }
      input[aria-invalid='true'],
      select[aria-invalid='true'],
      textarea[aria-invalid='true'] {
        border-color: var(--mc-danger);
      }
      input[type='range'] {
        width: 100%;
      }
      .error {
        color: var(--mc-danger);
        font-size: 0.85rem;
        margin: 0;
      }
      .hint {
        color: var(--mc-text-muted);
        font-size: 0.85rem;
        margin: 0;
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
      details {
        border-block-start: 1px solid var(--mc-border);
        padding-block: 10px 0;
        margin-block-start: 10px;
      }
      summary {
        cursor: pointer;
        font-weight: 600;
      }
      details > :not(summary) {
        margin-block-start: 10px;
      }
      .key {
        font-family: var(--mc-mono);
        font-size: 0.8rem;
        overflow-wrap: anywhere;
        background: var(--mc-surface-2);
        padding: 8px;
        border-radius: 8px;
        user-select: all;
      }
      section.about {
        margin-block-start: var(--mc-gap);
      }
      section.about dl {
        margin-block-end: 0.75em;
      }
      .warn {
        color: var(--mc-warn);
      }
      .danger-zone {
        border-color: color-mix(in oklab, var(--mc-danger), transparent 50%);
      }
      dialog {
        border: 1px solid var(--mc-border);
        border-radius: var(--mc-radius);
        background: var(--mc-surface);
        color: var(--mc-text);
        padding: var(--mc-gap);
        width: min(28rem, calc(100vw - 32px));
      }
      dialog::backdrop {
        background: rgb(0 0 0 / 0.45);
      }
      dialog form {
        gap: 14px;
      }
      dialog .actions {
        justify-content: flex-end;
      }
      .saving {
        font-size: 0.85rem;
        color: var(--mc-text-muted);
      }
    `,
  ];

  #errors: Record<string, string> = {};
  #radioDraft: RadioDraft | null = null;
  #txDraft: number | null = null;
  #exportedKey: string | null = null;
  #dialog: DialogRequest | null = null;
  #dialogText = '';
  #off: (() => void) | undefined;
  #tick: ReturnType<typeof setInterval> | undefined;

  get #ds(): DeviceSettingsModel {
    return this.app.deviceSettings;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // load extra settings and poll stats while a radio is connected and the page is shown
    this.#off = effect(() => {
      const client = this.app.connection.client.value;
      if (!client || !this.app.connection.connected.value) return;
      const ds = this.#ds;
      void ds.loadAll().catch((err: unknown) => this.app.notifications.error('Could not load device settings', err));
      const stop = ds.pollStats(5000);
      return () => {
        stop();
        this.#radioDraft = null;
        this.#txDraft = null;
        this.#exportedKey = null;
        this.#errors = {};
      };
    });
    // re-render once a second for the advert cooldown and clock display
    this.#tick = setInterval(() => this.requestUpdate(), 1000);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#off?.();
    this.#off = undefined;
    if (this.#tick !== undefined) clearInterval(this.#tick);
    this.#tick = undefined;
    this.#dialog?.resolve(false);
    this.#dialog = null;
  }

  // ---- helpers ----

  #confirm(req: Omit<DialogRequest, 'resolve'>): Promise<boolean> {
    this.#dialog?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.#dialog = { ...req, resolve };
      this.#dialogText = '';
      this.requestUpdate();
    });
  }

  #onDialogClose = (e: Event): void => {
    const d = e.currentTarget as HTMLDialogElement;
    const req = this.#dialog;
    this.#dialog = null;
    req?.resolve(d.returnValue === 'confirm');
    this.requestUpdate();
  };

  /** Runs an action: clears errors, maps validation errors to fields, toasts the result. */
  async #do(what: string, fn: () => Promise<unknown>, success?: string): Promise<boolean> {
    this.#errors = {};
    this.requestUpdate();
    try {
      await fn();
      if (success) this.app.notifications.success(success);
      return true;
    } catch (err) {
      if (err instanceof SettingsValidationError) {
        this.#errors = { ...this.#errors, [err.field]: err.message };
      } else {
        this.app.notifications.error(`Could not ${what}`, err);
      }
      return false;
    } finally {
      this.requestUpdate();
    }
  }

  #err(field: string): TemplateResult | typeof nothing {
    const m = this.#errors[field];
    return m ? html`<p class="error" id=${`err-${field}`} role="alert" data-error=${field}>${m}</p>` : nothing;
  }

  #invalid(field: string): 'true' | typeof nothing {
    return this.#errors[field] ? 'true' : nothing;
  }

  #described(field: string): string | typeof nothing {
    return this.#errors[field] ? `err-${field}` : nothing;
  }

  #busy(action: SettingsAction): boolean {
    return this.#ds.busy.value.has(action);
  }

  #btn(action: SettingsAction, label: string, dataAction: string, opts: { primary?: boolean; danger?: boolean; type?: 'submit' | 'button'; onClick?: () => void; disabled?: boolean } = {}): TemplateResult {
    const busy = this.#busy(action);
    return html`<button
      type=${opts.type ?? 'submit'}
      class=${opts.primary ? 'primary' : opts.danger ? 'danger' : ''}
      data-action=${dataAction}
      ?disabled=${busy || opts.disabled === true}
      aria-busy=${busy ? 'true' : 'false'}
      @click=${opts.onClick ?? nothing}
    >
      ${busy ? 'Saving…' : label}
    </button>`;
  }

  // ---- render ----

  override render() {
    const conn = this.app.connection;
    const connected = conn.connected.value && conn.selfInfo.value !== null;
    return html`
      <h2 class="visually-hidden">Settings</h2>
      <div class="sections">
        ${connected
          ? html`${this.#identity()} ${this.#radio()} ${this.#advert()} ${this.#device()} ${this.#contactsPolicy()} ${this.#advanced()}`
          : html`<section class="card" data-section="no-radio">
              <h2>Radio settings</h2>
              <p><a href=${hrefFor('/')}>Connect a radio</a> to change its settings.</p>
            </section>`}
        ${this.#appSection()} ${this.#install()}
      </div>
      ${this.#about()}
      ${this.#renderDialog()}
    `;
  }

  override updated(): void {
    const d = this.renderRoot.querySelector<HTMLDialogElement>('dialog[data-dialog-root]');
    if (d && this.#dialog && !d.open) d.showModal();
  }

  #renderDialog(): TemplateResult {
    const req = this.#dialog;
    const blocked = req?.requireText !== undefined && this.#dialogText !== req.requireText;
    return html`<dialog data-dialog-root aria-labelledby="dlg-title" @close=${this.#onDialogClose}>
      ${req
        ? html`<form method="dialog">
            <h2 id="dlg-title">${req.title}</h2>
            <div>${req.body}</div>
            ${req.requireText !== undefined
              ? html`<label class="field"
                  >Type <strong>${req.requireText}</strong> to confirm
                  <input
                    data-dialog="confirm-text"
                    autocomplete="off"
                    .value=${this.#dialogText}
                    @input=${(e: Event) => {
                      this.#dialogText = (e.target as HTMLInputElement).value;
                      this.requestUpdate();
                    }}
                /></label>`
              : nothing}
            <div class="actions">
              <button value="cancel" data-dialog="cancel" autofocus>Cancel</button>
              <button value="confirm" data-dialog="confirm" class=${req.danger ? 'danger' : 'primary'} ?disabled=${blocked}>${req.confirmLabel}</button>
            </div>
          </form>`
        : nothing}
    </dialog>`;
  }

  #identity(): TemplateResult {
    const ds = this.#ds;
    const name = ds.name.value ?? '';
    const loc = ds.location.value;
    return html`<section class="card" data-section="identity" aria-labelledby="s-identity">
      <h2 id="s-identity">Identity</h2>
      <form data-form="name" @submit=${this.#saveName} novalidate>
        <label class="field"
          >Node name
          <input name="name" required maxlength="31" autocomplete="off" .value=${name} aria-invalid=${this.#invalid('name')}
            aria-describedby=${this.#described('name')} />
        </label>
        ${this.#err('name')}
        <div class="actions">${this.#btn('name', 'Save name', 'save-name', { primary: true })}</div>
      </form>
      <form data-form="location" @submit=${this.#saveLocation} novalidate>
        <div class="row">
          <label class="field"
            >Latitude
            <input name="lat" type="number" step="any" min="-90" max="90" inputmode="decimal" .value=${loc ? String(loc.lat) : ''}
              aria-invalid=${this.#invalid('lat')} aria-describedby=${this.#described('lat')} />
          </label>
          <label class="field"
            >Longitude
            <input name="lon" type="number" step="any" min="-180" max="180" inputmode="decimal" .value=${loc ? String(loc.lon) : ''}
              aria-invalid=${this.#invalid('lon')} aria-describedby=${this.#described('lon')} />
          </label>
        </div>
        ${this.#err('lat')} ${this.#err('lon')}
        <p class="hint">Degrees. 0, 0 means "not set". Shared in adverts only if the advert location policy allows it.</p>
        <div class="actions">
          ${this.#btn('location', 'Save location', 'save-location', { primary: true })}
          ${ds.canGeolocate
            ? html`<button type="button" data-action="use-location" ?disabled=${this.#busy('location')} @click=${this.#useLocation}>Use my location</button>`
            : nothing}
        </div>
      </form>
    </section>`;
  }

  #saveName = (e: SubmitEvent): void => {
    e.preventDefault();
    const name = str(e.currentTarget as HTMLFormElement, 'name');
    void this.#do('save the name', () => this.#ds.setName(name), 'Name saved');
  };

  #saveLocation = (e: SubmitEvent): void => {
    e.preventDefault();
    const f = e.currentTarget as HTMLFormElement;
    const lat = num(f, 'lat');
    const lon = num(f, 'lon');
    void this.#do('save the location', () => this.#ds.setLocation(lat, lon), 'Location saved');
  };

  #useLocation = (): void => {
    void this.#do('use your location', async () => {
      const pos = await this.#ds.useCurrentLocation();
      this.app.notifications.success('Location saved', `${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`);
    });
  };

  #radio(): TemplateResult {
    const ds = this.#ds;
    const cur = ds.radioParams.value!;
    const repeatKnown = ds.clientRepeat.value !== undefined;
    const draft: RadioDraft = this.#radioDraft ?? { freqMhz: cur.freqMhz, bwKhz: cur.bwKhz, sf: cur.sf, cr: cur.cr, clientRepeat: ds.clientRepeat.value ?? false };
    const preset = findRadioPreset(draft);
    const tx = ds.txPower.value!;
    const txValue = this.#txDraft ?? tx.dbm;
    const bws = LORA_BANDWIDTHS_KHZ.includes(draft.bwKhz) ? LORA_BANDWIDTHS_KHZ : [...LORA_BANDWIDTHS_KHZ, draft.bwKhz].sort((a, b) => a - b);
    const set = (patch: Partial<RadioDraft>): void => {
      this.#radioDraft = { ...draft, ...patch };
      this.requestUpdate();
    };
    const changed = this.#radioDraft !== null;
    return html`<section class="card" data-section="radio" aria-labelledby="s-radio">
      <h2 id="s-radio">Radio</h2>
      <form data-form="radio" @submit=${this.#applyRadio} novalidate>
        <label class="field"
          >Preset
          <select name="preset" @change=${(e: Event) => {
            const p = RADIO_PRESETS.find((x) => x.id === (e.target as HTMLSelectElement).value);
            if (p) set({ freqMhz: p.freqMhz, bwKhz: p.bwKhz, sf: p.sf, cr: p.cr, clientRepeat: p.clientRepeat === true });
          }}>
            <option value="" ?selected=${!preset}>Custom</option>
            ${RADIO_PRESETS.map((p) => html`<option value=${p.id} ?selected=${preset?.id === p.id}>${p.name} (${p.freqMhz} MHz, ${p.bwKhz} kHz, SF${p.sf}, CR4/${p.cr})</option>`)}
          </select>
        </label>
        <div class="row">
          <label class="field"
            >Frequency (MHz)
            <input name="freq" type="number" step="0.001" min="150" max="2500" inputmode="decimal" .value=${draft.freqMhz.toFixed(3)}
              aria-invalid=${this.#invalid('freq')} aria-describedby=${this.#described('freq')}
              @change=${(e: Event) => set({ freqMhz: Number((e.target as HTMLInputElement).value) })} />
          </label>
          <label class="field"
            >Bandwidth (kHz)
            <select name="bw" aria-invalid=${this.#invalid('bw')} @change=${(e: Event) => set({ bwKhz: Number((e.target as HTMLSelectElement).value) })}>
              ${bws.map((b) => html`<option value=${b} ?selected=${b === draft.bwKhz}>${b}</option>`)}
            </select>
          </label>
          <label class="field"
            >Spreading factor
            <select name="sf" aria-invalid=${this.#invalid('sf')} @change=${(e: Event) => set({ sf: Number((e.target as HTMLSelectElement).value) })}>
              ${LORA_SPREADING_FACTORS.map((s) => html`<option value=${s} ?selected=${s === draft.sf}>SF${s}</option>`)}
            </select>
          </label>
          <label class="field"
            >Coding rate
            <select name="cr" aria-invalid=${this.#invalid('cr')} @change=${(e: Event) => set({ cr: Number((e.target as HTMLSelectElement).value) })}>
              ${LORA_CODING_RATES.map((c) => html`<option value=${c} ?selected=${c === draft.cr}>4/${c}</option>`)}
            </select>
          </label>
        </div>
        ${repeatKnown
          ? html`<label class="check"
                ><input type="checkbox" name="clientRepeat" .checked=${draft.clientRepeat}
                  @change=${(e: Event) => set({ clientRepeat: (e.target as HTMLInputElement).checked })} />
                Client repeat (off-grid frequencies only)</label
              >`
          : nothing}
        ${this.#err('freq')} ${this.#err('bw')} ${this.#err('sf')} ${this.#err('cr')}
        <p class="hint">
          Current: ${cur.freqMhz.toFixed(3)} MHz, ${cur.bwKhz} kHz, SF${cur.sf}, CR4/${cur.cr}. Applied immediately; nodes on other settings
          can no longer be heard.
        </p>
        <div class="actions">
          ${this.#btn('radio', 'Apply radio settings', 'apply-radio', { primary: true })}
          ${changed
            ? html`<button type="button" data-action="reset-radio" @click=${() => {
                this.#radioDraft = null;
                this.requestUpdate();
              }}>Reset</button>`
            : nothing}
        </div>
      </form>
      <form data-form="txpower" @submit=${this.#saveTxPower} novalidate>
        <label class="field"
          >TX power: <output data-field="txpower-value">${txValue} dBm</output>
          <input name="txPower" type="range" min=${tx.minDbm} max=${tx.maxDbm} step="1" .value=${String(txValue)}
            aria-valuetext=${`${txValue} dBm`} aria-invalid=${this.#invalid('txPower')}
            @input=${(e: Event) => {
              this.#txDraft = Number((e.target as HTMLInputElement).value);
              this.requestUpdate();
            }} />
        </label>
        <p class="hint">${tx.minDbm} to ${tx.maxDbm} dBm (device maximum). Respect your region's legal limit.</p>
        ${this.#err('txPower')}
        <div class="actions">${this.#btn('txPower', 'Save TX power', 'save-txpower', { primary: true, disabled: txValue === tx.dbm })}</div>
      </form>
    </section>`;
  }

  #applyRadio = async (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    const cur = this.#ds.radioParams.value!;
    const d = this.#radioDraft ?? { freqMhz: cur.freqMhz, bwKhz: cur.bwKhz, sf: cur.sf, cr: cur.cr, clientRepeat: this.#ds.clientRepeat.value ?? false };
    const ok = await this.#confirm({
      title: 'Change radio settings?',
      body: html`<p>
          The radio switches to ${d.freqMhz.toFixed(3)} MHz, ${d.bwKhz} kHz, SF${d.sf}, CR4/${d.cr} immediately. It can only talk to nodes
          using the same settings.
        </p>
        <p class="hint">The connection to this app is not affected.</p>`,
      confirmLabel: 'Apply',
    });
    if (!ok) return;
    const repeatKnown = this.#ds.clientRepeat.value !== undefined;
    const done = await this.#do(
      'apply the radio settings',
      () => this.#ds.setRadioParams({ freqMhz: d.freqMhz, bwKhz: d.bwKhz, sf: d.sf, cr: d.cr, ...(repeatKnown ? { clientRepeat: d.clientRepeat } : {}) }),
      'Radio settings applied',
    );
    if (done) this.#radioDraft = null;
  };

  #saveTxPower = async (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    const dbm = num(e.currentTarget as HTMLFormElement, 'txPower');
    if (await this.#do('save the TX power', () => this.#ds.setTxPower(dbm), `TX power set to ${dbm} dBm`)) this.#txDraft = null;
  };

  #advert(): TemplateResult {
    const ds = this.#ds;
    const wait = ds.advertCooldownRemaining(this.app.clock.now());
    void ds.advertCooldownUntil.value; // re-render when the cooldown ends
    const last = ds.lastAdvert.value;
    const busy = this.#busy('advert');
    return html`<section class="card" data-section="advert" aria-labelledby="s-advert">
      <h2 id="s-advert">Advert</h2>
      <p class="hint">
        Announce this radio so others can add it. A zero-hop advert reaches direct neighbours only; a flood advert is repeated across the
        mesh (and uses airtime on every repeater).
      </p>
      <div class="actions">
        <button data-action="advert-zero-hop" ?disabled=${busy || wait > 0} @click=${() => this.#sendAdvert('zeroHop')}>Send zero-hop advert</button>
        <button data-action="advert-flood" ?disabled=${busy || wait > 0} @click=${() => this.#sendAdvert('flood')}>Send flood advert</button>
        ${wait > 0 ? html`<span class="saving" data-field="advert-cooldown">Wait ${Math.ceil(wait / 1000)} s</span>` : nothing}
      </div>
      ${this.#err('advert')}
      ${last
        ? html`<p class="hint" data-field="last-advert">Last: ${last.mode === 'flood' ? 'flood' : 'zero-hop'} at ${this.app.appSettings.formatTime(last.at, { seconds: true })}</p>`
        : nothing}
      <p class="hint">Automatic advert intervals are not configurable on companion firmware (v1.18 has no command for them).</p>
    </section>`;
  }

  #sendAdvert(mode: 'flood' | 'zeroHop'): void {
    void this.#do('send the advert', () => this.#ds.sendAdvert(mode), mode === 'flood' ? 'Flood advert sent' : 'Zero-hop advert sent');
  }

  #device(): TemplateResult {
    const ds = this.#ds;
    const di = ds.deviceInfo.value;
    const batt = ds.battery.value;
    const t = ds.deviceTime.value;
    const stats = ds.stats.value;
    const fmt = this.app.appSettings;
    const nowDevice = t ? t.deviceSecs * 1000 + (this.app.clock.now() - t.at) : null;
    const pin = ds.pin.value;
    return html`<section class="card" data-section="device" aria-labelledby="s-device">
      <h2 id="s-device">Device</h2>
      <h3>Clock</h3>
      <dl>
        <dt>Device time</dt>
        <dd data-field="device-time">${nowDevice !== null ? fmt.formatTime(nowDevice, { seconds: true, date: true }) : '—'}</dd>
        <dt>Drift</dt>
        <dd data-field="time-drift" class=${t && Math.abs(t.driftSecs) > 30 ? 'warn' : ''}>${t ? formatDrift(t.driftSecs) : '—'}</dd>
      </dl>
      <div class="actions" style="margin-block-start: 8px">
        ${this.#btn('time', 'Sync time', 'sync-time', { type: 'button', onClick: this.#syncTime })}
      </div>

      <h3>Power &amp; storage</h3>
      <dl>
        <dt>Battery</dt>
        <dd data-field="battery">${batt ? `${(batt.batteryMv / 1000).toFixed(2)} V (~${batteryPercent(batt.batteryMv)} %)` : '—'}</dd>
        <dt>Storage</dt>
        <dd data-field="storage">${batt?.storageTotalKb ? `${batt.storageUsedKb ?? 0} / ${batt.storageTotalKb} KB` : '—'}</dd>
      </dl>

      <h3>Statistics</h3>
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
          <p class="hint">Updated ${fmt.formatTime(stats.at, { seconds: true })}; refreshes every 5 s while this page is open.</p>`
        : html`<p class="hint">Loading…</p>`}
      <div class="actions">
        ${this.#btn('stats', 'Refresh', 'refresh-stats', {
          type: 'button',
          onClick: () => void this.#do('refresh the statistics', () => Promise.all([ds.refreshStats(), ds.refreshBattery()])),
        })}
      </div>

      <h3>Firmware</h3>
      <dl data-field="firmware-info">
        <dt>Version</dt>
        <dd>${di?.firmwareVersion ?? 'unknown'}${di ? html` <span class="muted">(protocol v${di.firmwareVerCode})</span>` : nothing}</dd>
        <dt>Build date</dt>
        <dd>${di?.buildDate ?? '—'}</dd>
        <dt>Hardware</dt>
        <dd>${di?.manufacturer ?? '—'}</dd>
      </dl>

      <form data-form="pin" @submit=${this.#savePin} novalidate>
        <label class="field"
          >Bluetooth PIN
          <input name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" placeholder="0 = default"
            .value=${pin !== null ? String(pin) : ''} aria-invalid=${this.#invalid('pin')} aria-describedby=${this.#described('pin')} />
        </label>
        ${this.#err('pin')}
        <p class="hint">6 digits, or 0 for the firmware default. Takes effect after a reboot.</p>
        <div class="actions">${this.#btn('pin', 'Save PIN', 'save-pin')}</div>
      </form>
    </section>`;
  }

  #syncTime = (): void => {
    void this.#do('sync the time', async () => {
      const r = await this.#ds.syncTime();
      const n = this.app.notifications;
      if (r.status === 'set') n.success('Device clock set', `It was ${formatDrift(r.driftSecs)}`);
      else if (r.status === 'inSync') n.info('Device clock is already in sync');
      else n.warning('Device clock is ahead', 'The firmware cannot set its clock backwards. Reboot the radio to reset it.');
    });
  };

  #savePin = (e: SubmitEvent): void => {
    e.preventDefault();
    const pin = num(e.currentTarget as HTMLFormElement, 'pin');
    void this.#do('save the PIN', () => this.#ds.setPin(pin), 'PIN saved (takes effect after reboot)');
  };

  #contactsPolicy(): TemplateResult {
    const ds = this.#ds;
    const other = ds.otherParams.value!;
    const aa = ds.autoAdd.value;
    return html`<section class="card" data-section="contacts" aria-labelledby="s-contacts">
      <h2 id="s-contacts">Contacts &amp; privacy</h2>
      <form data-form="contacts" @submit=${this.#saveContacts} novalidate>
        <label class="check"><input type="checkbox" name="manualAdd" .checked=${other.manualAdd} /> Add contacts manually only</label>
        <p class="hint">When on, adverts from unknown nodes are not added automatically; they appear as discovered nodes instead.</p>
        ${aa
          ? html`<fieldset>
              <legend>Auto-add from adverts</legend>
              <label class="check"><input type="checkbox" name="aaChat" .checked=${aa.chat} /> Companions (chat)</label>
              <label class="check"><input type="checkbox" name="aaRepeater" .checked=${aa.repeater} /> Repeaters</label>
              <label class="check"><input type="checkbox" name="aaRoom" .checked=${aa.room} /> Room servers</label>
              <label class="check"><input type="checkbox" name="aaSensor" .checked=${aa.sensor} /> Sensors</label>
              <label class="check"><input type="checkbox" name="aaOverwrite" .checked=${aa.overwriteOldest} /> Overwrite oldest when full</label>
              <label class="field"
                >Max hops (0 = any)
                <input name="maxHops" type="number" min="0" max="64" step="1" .value=${String(aa.maxHops)} aria-invalid=${this.#invalid('maxHops')} />
              </label>
              ${this.#err('maxHops')}
            </fieldset>`
          : nothing}
        <h3>Privacy</h3>
        <label class="check"><input type="checkbox" name="shareLocation" .checked=${other.advertLocPolicy === 1} /> Include location in adverts</label>
        <label class="check"><input type="checkbox" name="multiAcks" .checked=${other.multiAcks > 0} /> Send extra ACKs</label>
        <div class="row">
          ${(['base', 'location', 'environment'] as const).map(
            (k) => html`<label class="field"
              >Telemetry: ${k}
              <select name=${`tm-${k}`}>
                ${TELEMETRY_LABEL.map((l, i) => html`<option value=${i} ?selected=${other.telemetryModes[k] === i}>${l}</option>`)}
              </select>
            </label>`,
          )}
        </div>
        <div class="actions">${this.#btn(this.#busy('autoAdd') ? 'autoAdd' : 'otherParams', 'Save', 'save-contacts', { primary: true })}</div>
      </form>
    </section>`;
  }

  #saveContacts = (e: SubmitEvent): void => {
    e.preventDefault();
    const f = e.currentTarget as HTMLFormElement;
    const ds = this.#ds;
    const other = ds.otherParams.peek()!;
    const multi = checked(f, 'multiAcks') ? Math.max(1, other.multiAcks) : 0;
    void this.#do(
      'save the contact settings',
      async () => {
        await ds.setOtherParams({
          manualAdd: checked(f, 'manualAdd'),
          advertLocPolicy: checked(f, 'shareLocation') ? 1 : 0,
          multiAcks: multi,
          telemetryModes: { base: num(f, 'tm-base'), location: num(f, 'tm-location'), environment: num(f, 'tm-environment') },
        });
        if (ds.autoAdd.peek()) {
          await ds.setAutoAdd({
            chat: checked(f, 'aaChat'),
            repeater: checked(f, 'aaRepeater'),
            room: checked(f, 'aaRoom'),
            sensor: checked(f, 'aaSensor'),
            overwriteOldest: checked(f, 'aaOverwrite'),
            maxHops: num(f, 'maxHops'),
          });
        }
      },
      'Contact settings saved',
    );
  };

  #advanced(): TemplateResult {
    const ds = this.#ds;
    const tuning = ds.tuning.value;
    const vars = ds.customVars.value;
    const scope = ds.defaultFloodScope.value;
    return html`<section class="card danger-zone" data-section="advanced" aria-labelledby="s-advanced">
      <h2 id="s-advanced">Advanced</h2>
      <details data-details="tuning">
        <summary>Tuning</summary>
        ${tuning
          ? html`<form data-form="tuning" @submit=${this.#saveTuning} novalidate>
              <div class="row">
                <label class="field"
                  >RX delay base
                  <input name="rxDelayBase" type="number" min="0" max="20" step="0.001" .value=${String(tuning.rxDelayBase)}
                    aria-invalid=${this.#invalid('rxDelayBase')} />
                </label>
                <label class="field"
                  >Airtime factor
                  <input name="airtimeFactor" type="number" min="0" max="9" step="0.001" .value=${String(tuning.airtimeFactor)}
                    aria-invalid=${this.#invalid('airtimeFactor')} />
                </label>
              </div>
              ${this.#err('rxDelayBase')} ${this.#err('airtimeFactor')}
              <div class="actions">${this.#btn('tuning', 'Save tuning', 'save-tuning')}</div>
            </form>`
          : html`<p class="hint">Not available.</p>`}
      </details>

      <details data-details="custom-vars">
        <summary>Custom variables</summary>
        ${vars && vars.length
          ? html`<form data-form="custom-var" @submit=${this.#saveVar} novalidate>
              <div class="row">
                <label class="field"
                  >Variable
                  <select name="varName">
                    ${vars.map((v) => html`<option value=${v.name}>${v.name} = ${v.value}</option>`)}
                  </select>
                </label>
                <label class="field"
                  >New value
                  <input name="varValue" autocomplete="off" aria-invalid=${this.#invalid('varValue')} />
                </label>
              </div>
              ${this.#err('varName')} ${this.#err('varValue')}
              <div class="actions">${this.#btn('customVar', 'Set', 'save-custom-var')}</div>
            </form>`
          : html`<p class="hint">This firmware reports no custom variables.</p>`}
      </details>

      <details data-details="flood-scope">
        <summary>Default flood scope</summary>
        ${scope === undefined
          ? html`<p class="hint">Not supported by this firmware.</p>`
          : html`<form data-form="flood-scope" @submit=${this.#saveScope} novalidate>
              <label class="field"
                >Region name (empty = unscoped)
                <input name="scope" autocomplete="off" .value=${scope?.name ?? ''} aria-invalid=${this.#invalid('floodScope')} />
              </label>
              ${this.#err('floodScope')}
              <p class="hint">Flood messages and flood adverts are limited to repeaters that serve this region.</p>
              <div class="actions">${this.#btn('floodScope', 'Save scope', 'save-scope')}</div>
            </form>`}
      </details>

      <details data-details="private-key">
        <summary>Private key</summary>
        <p class="warn">Anyone with the private key can impersonate this radio and read its direct messages.</p>
        <div class="actions">
          ${this.#btn('privateKey', 'Export private key…', 'export-key', { type: 'button', onClick: this.#exportKey })}
        </div>
        ${this.#exportedKey ? html`<p class="key" data-field="private-key">${this.#exportedKey}</p>` : nothing}
        <form data-form="import-key" @submit=${this.#importKey} novalidate>
          <label class="field"
            >Import a private key (128 hex characters)
            <textarea name="privateKey" autocomplete="off" spellcheck="false" aria-invalid=${this.#invalid('privateKey')}></textarea>
          </label>
          ${this.#err('privateKey')}
          <div class="actions">${this.#btn('privateKey', 'Import…', 'import-key', { danger: true })}</div>
        </form>
      </details>

      <h3>Danger zone</h3>
      <div class="actions">
        ${this.#btn('reboot', 'Reboot radio…', 'reboot', { type: 'button', danger: true, onClick: this.#reboot })}
        ${this.#btn('factoryReset', 'Factory reset…', 'factory-reset', { type: 'button', danger: true, onClick: this.#factoryReset })}
      </div>
    </section>`;
  }

  #saveTuning = (e: SubmitEvent): void => {
    e.preventDefault();
    const f = e.currentTarget as HTMLFormElement;
    const t = { rxDelayBase: num(f, 'rxDelayBase'), airtimeFactor: num(f, 'airtimeFactor') };
    void this.#do('save the tuning', () => this.#ds.setTuning(t), 'Tuning saved');
  };

  #saveVar = (e: SubmitEvent): void => {
    e.preventDefault();
    const f = e.currentTarget as HTMLFormElement;
    const name = str(f, 'varName');
    const value = str(f, 'varValue');
    void this.#do('set the variable', () => this.#ds.setCustomVar(name, value), `${name} set`);
  };

  #saveScope = (e: SubmitEvent): void => {
    e.preventDefault();
    const name = str(e.currentTarget as HTMLFormElement, 'scope');
    void this.#do('save the flood scope', () => this.#ds.setDefaultFloodScope(name || null), name ? 'Flood scope saved' : 'Flood scope cleared');
  };

  #exportKey = async (): Promise<void> => {
    const stored = this.app.appSettings.storePrivateKey.peek();
    const ok = await this.#confirm({
      title: 'Show the private key?',
      body: html`<p>The key will be shown on screen. Anyone who sees or copies it can impersonate this radio.</p>
        ${stored ? html`<p class="hint">It will also be saved in this browser (App settings → store private key).</p>` : nothing}`,
      confirmLabel: 'Show key',
      danger: true,
    });
    if (!ok) return;
    await this.#do('export the private key', async () => {
      this.#exportedKey = await this.#ds.exportPrivateKey();
    });
  };

  #importKey = async (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    const hex = str(e.currentTarget as HTMLFormElement, 'privateKey');
    const ok = await this.#confirm({
      title: 'Replace the radio identity?',
      body: html`<p>The radio takes the identity of the imported key. Its current key is lost unless you exported it. The app disconnects afterwards.</p>`,
      confirmLabel: 'Import key',
      danger: true,
    });
    if (!ok) return;
    await this.#do('import the private key', () => this.#ds.importPrivateKey(hex), 'Private key imported. Reconnect to continue.');
  };

  #reboot = async (): Promise<void> => {
    const ok = await this.#confirm({
      title: 'Reboot the radio?',
      body: 'The connection drops while the radio restarts. Reconnect when it is back.',
      confirmLabel: 'Reboot',
      danger: true,
    });
    if (ok) await this.#do('reboot the radio', () => this.#ds.reboot());
  };

  #factoryReset = async (): Promise<void> => {
    const first = await this.#confirm({
      title: 'Factory reset?',
      body: html`<p>This erases the radio's identity, contacts, channels and settings. It cannot be undone.</p>`,
      confirmLabel: 'Continue',
      danger: true,
    });
    if (!first) return;
    const second = await this.#confirm({
      title: 'Really erase everything?',
      body: html`<p>The radio gets a new identity; other nodes will see it as a new node.</p>`,
      confirmLabel: 'Erase radio',
      danger: true,
      requireText: 'reset',
    });
    if (second) await this.#do('reset the radio', () => this.#ds.factoryReset('reset'));
  };

  #appSection(): TemplateResult {
    const s = this.app.appSettings;
    return html`<section class="card" data-section="app" aria-labelledby="s-app">
      <h2 id="s-app">App</h2>
      <form data-form="app" @submit=${(e: Event) => e.preventDefault()}>
        <fieldset>
          <legend>Theme</legend>
          <div class="actions">
            ${THEME_OPTIONS.map(
              (t) => html`<label class="check"
                ><input type="radio" name="theme" value=${t} .checked=${s.theme.value === t} @change=${() => s.setTheme(t)} /> ${THEME_LABEL[t]}</label
              >`,
            )}
          </div>
        </fieldset>
        <label class="field"
          >Time format
          <select name="timeFormat" @change=${(e: Event) => s.setTimeFormat((e.target as HTMLSelectElement).value as TimeFormatPreference)}>
            ${TIME_FORMAT_OPTIONS.map((t) => html`<option value=${t} ?selected=${s.timeFormat.value === t}>${TIME_FORMAT_LABEL[t]}</option>`)}
          </select>
        </label>
        <label class="field"
          >Keep packet log for (days, blank = forever)
          <input name="retention" type="number" min="1" max=${MAX_PACKET_RETENTION_DAYS} step="1" placeholder="Forever"
            .value=${s.packetRetentionDays.value === null ? '' : String(s.packetRetentionDays.value)}
            aria-invalid=${this.#invalid('retention')} @change=${this.#saveRetention} />
        </label>
        ${this.#err('retention')}
        <label class="check"
          ><input type="checkbox" name="pathNames" .checked=${s.pathNames.value}
            @change=${(e: Event) => s.setPathNames((e.target as HTMLInputElement).checked)} />
          Show path as node names</label
        >
        <p class="hint">Shows paths as “Alice &gt; Bob &gt; a3” instead of “3 hops”. Unknown repeaters show their hash; “a3?” means several contacts share it.</p>
        <label class="check"
          ><input type="checkbox" name="approximatePositions" .checked=${s.approximatePositions.value}
            @change=${(e: Event) => s.setApproximatePositions((e.target as HTMLInputElement).checked)} />
          Approximate positions of nodes without a location (from the repeaters they were last heard through)</label
        >
        <p class="hint">Shown on the map with a dashed outline and “?”, a few hundred metres from the most recent repeater that relayed their packets.</p>
        <label class="check"
          ><input type="checkbox" name="storePrivateKey" .checked=${s.storePrivateKey.value}
            @change=${(e: Event) => void s.setStorePrivateKey((e.target as HTMLInputElement).checked)} />
          Store an exported private key in this browser to decrypt direct messages in the packet inspector</label
        >
        <p class="hint">Off by default. Turning it off deletes a stored key of the connected radio.</p>
        <label class="check"
          ><input type="checkbox" name="smazAutoEnable" .checked=${s.smazAutoEnable.value}
            @change=${(e: Event) => s.setSmazAutoEnable((e.target as HTMLInputElement).checked)} />
          Turn on compression for a contact when they send a compressed message</label
        >
        <p class="hint">
          Off by default. A contact who sends SMAZ-compressed (“s:…”) messages uses MeshCore Open or a compatible client, so it can decode them too.
          Contacts where you turned compression off on their contact page are left alone.
        </p>
      </form>
    </section>`;
  }

  /** Shown only while the browser offers installation (`beforeinstallprompt`). */
  #install() {
    const install = getInstallPrompt();
    if (!install.available.value) return nothing;
    return html`<section class="card install" data-section="install" aria-labelledby="s-install">
      <h2 id="s-install">Install app</h2>
      <p class="hint">Install MeshCore Web to open it from your dock or home screen, in its own window; the app shell works offline.</p>
      <div class="actions">
        <button class="primary" data-action="install" @click=${() => void install.prompt()}>Install app</button>
      </div>
    </section>`;
  }

  #about(): TemplateResult {
    const built = new Date(BUILD_DATE);
    const builtText = Number.isNaN(built.getTime()) ? BUILD_DATE : built.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    return html`<section class="card about" data-section="about" aria-labelledby="s-about">
      <h2 id="s-about">About</h2>
      <dl>
        <dt>Version</dt>
        <dd data-field="version">${APP_VERSION}</dd>
        <dt>Built</dt>
        <dd data-field="build-date"><time datetime=${BUILD_DATE}>${builtText}</time></dd>
        <dt>Source</dt>
        <dd><a data-field="repo" href=${REPO_URL} target="_blank" rel="noopener">${REPO_URL.replace(/^https:\/\//, '')}</a></dd>
        <dt>Licence</dt>
        <dd data-field="licence">MIT</dd>
      </dl>
      <p class="hint">
        MeshCore Web is an independent web client for
        <a href=${MESHCORE_URL} target="_blank" rel="noopener">MeshCore</a>. Thanks to the MeshCore project and
        contributors for the <a href=${MESHCORE_FIRMWARE_URL} target="_blank" rel="noopener">firmware</a> and companion
        protocol this app is built on. Runs entirely in your browser; nothing is sent to a server.
      </p>
    </section>`;
  }

  #saveRetention = (e: Event): void => {
    const raw = (e.target as HTMLInputElement).value.trim();
    const days = raw === '' ? null : Number(raw);
    this.#errors = {};
    this.app.appSettings.setPacketRetentionDays(days).then(
      (removed) =>
        this.app.notifications.success(
          days === null ? 'Packet log keeps packets forever' : `Packet log keeps ${days} days`,
          removed ? `${removed} older packets removed` : undefined,
        ),
      (err: unknown) => {
        this.#errors = { retention: err instanceof Error ? err.message : String(err) };
        this.requestUpdate();
      },
    );
  };
}

customElements.define('mc-settings-page', McSettingsPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-settings-page': McSettingsPage;
  }
}
