/**
 * `<mc-node-admin>` (Phase 10): the repeater / room server / sensor administration tabs of the
 * node page (`/node/:key/overview|telemetry|cli|tools`, node-page.ts). A thin view over
 * `app.remoteAdmin.node(key)` (RemoteNodeModel): Overview (login + status), Telemetry, CLI and
 * Tools (trace, path discovery, reset path, neighbours, regions, ACL). `key` must be a stored contact's
 * full public key.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import {
  QUICK_CLI_COMMANDS,
  cliKindOf,
  completeCliCommand,
  formatSeconds,
  parseHopList,
  type HopRef,
  type LoginState,
  type RemoteAction,
  type RemoteNodeModel,
  type StatusField,
  type TelemetryHistory,
} from '@meshcore-web/core/app';
import { toHex } from '@meshcore-web/core/util/bytes';
import { AppElement } from '../../app-context.js';
import { formatSnr, formatTime } from '../../format.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { listStyles } from '../messaging/common.js';
import { contactNote, hashLink, nodeLink, pathLabelView, type NoteLookup } from '../../components/node-link.js';
import { assignSlots, type TimeSeries } from '../../charts/index.js';

/** The node page tabs this element renders. */
export type AdminTab = 'overview' | 'telemetry' | 'cli' | 'tools';

const GROUP_LABEL: Record<StatusField['group'], string> = { system: 'System', radio: 'Radio', packets: 'Packets', room: 'Room' };

export function loginLabel(s: LoginState): string {
  switch (s.state) {
    case 'loggedOut':
      return 'Not logged in';
    case 'loggingIn':
      return 'Logging in…';
    case 'admin':
      return 'Logged in as admin';
    case 'guest':
      return `Logged in as ${s.role && s.role !== 'guest' ? s.role.replace('read', 'read-').toLowerCase() : 'guest'}`;
    case 'failed':
      return 'Login failed';
  }
}

/** A hop hash plus its name: the contact's node page, or (unresolved / ambiguous) the listing of the nodes with the hash. */
function hopLabel(h: HopRef, notes: NoteLookup): TemplateResult {
  if (h.key) return html`<span class="mono">${h.hash}</span> ${nodeLink(h.name ?? h.hash, h.key)}${contactNote(notes(h.key))}`;
  // this radio has a name but no key: plain text
  if (h.name && !h.ambiguous) return html`<span class="mono">${h.hash}</span> ${h.name}`;
  return html`${hashLink(html`<span class="mono">${h.hash}</span>`, h.hash)}${h.name ? html` ${h.name}?` : nothing}`;
}

const fmtVolts = (v: number): string => v.toFixed(2);
const fmtCelsius = (v: number): string => v.toFixed(1);
/** Battery points from TELEMETRY_RESPONSE are filled, from STATUS_RESPONSE hollow. */
const BATTERY_MARKERS = { filled: 'telemetry', hollow: 'status report' } as const;

/** Swallows a model action's rejection (the model records it in `errors`). */
function quiet(p: Promise<unknown>): void {
  p.catch(() => undefined);
}

/** A repeater's regions request: running, its answer or error. */
interface RegionFetch {
  busy: boolean;
  ac: AbortController;
  names?: string[];
  error?: string;
}

export class McNodeAdmin extends AppElement {
  static override properties = {
    key: { type: String },
    tab: { type: String },
    password: { state: true },
    remember: { state: true },
    cliInput: { state: true },
    tracePath: { state: true },
    traceError: { state: true },
  };
  /** The contact's full public key (lowercase hex). */
  declare key: string;
  declare tab: AdminTab;
  declare password: string | null;
  declare remember: boolean | null;
  declare cliInput: string;
  declare tracePath: string | null;
  declare traceError: string;

  #history: string[] = [];
  #historyPos = -1;
  #lastKey = '';
  /** The repeater's regions request (`app.regions.fetchFromRepeater`). */
  #regionFetch: RegionFetch | null = null;

  constructor() {
    super();
    this.key = '';
    this.tab = 'overview';
    this.password = null;
    this.remember = null;
    this.cliInput = '';
    this.tracePath = null;
    this.traceError = '';
  }

  static override styles = [
    shared,
    listStyles,
    css`
      .stack {
        display: grid;
        gap: var(--mc-gap);
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .row input[type='password'],
      .row input[type='text'] {
        flex: 1 1 12rem;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
        gap: 8px;
      }
      .stat {
        background: var(--mc-surface-2);
        border-radius: 8px;
        padding: 8px 10px;
      }
      .stat .label {
        font-size: 0.85em;
        color: var(--mc-text-muted);
      }
      .stat .value {
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      h3 {
        font-size: 1rem;
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        border-collapse: collapse;
        width: 100%;
      }
      th,
      td {
        text-align: start;
        padding: 6px 8px;
        border-block-end: 1px solid var(--mc-border);
      }
      th {
        color: var(--mc-text-muted);
        font-weight: 500;
      }
      .error {
        color: var(--mc-danger);
      }
      .ok {
        color: var(--mc-ok);
      }
      .terminal {
        font-family: var(--mc-mono);
        font-size: 0.9em;
        background: light-dark(#14181d, #0b0e11);
        color: #d7dde4;
        border-radius: 8px;
        padding: 10px;
        min-height: 12rem;
        max-height: 50vh;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .terminal .out {
        color: #8cc4ff;
      }
      .terminal .out::before {
        content: '> ';
      }
      .terminal .err {
        color: #ff8a80;
      }
      .terminal .ts {
        color: #6b7580;
        margin-inline-end: 8px;
      }
      .suggestions {
        list-style: none;
        margin: 4px 0 0;
        padding: 0;
        border: 1px solid var(--mc-border);
        border-radius: 8px;
        max-height: 14rem;
        overflow: auto;
      }
      .suggestions button {
        display: block;
        width: 100%;
        text-align: start;
        border: 0;
        border-radius: 0;
        min-height: 2rem;
      }
      .suggestions .desc {
        color: var(--mc-text-muted);
        margin-inline-start: 8px;
        font-size: 0.85em;
      }
      ul.region-list {
        list-style: none;
        margin: 0 0 8px;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 6px 16px;
      }
      ul.region-list li {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      ul.region-list button {
        min-height: 0;
        padding: 2px 10px;
      }
      ol.hops {
        margin: 0;
        padding-inline-start: 1.5em;
      }
    `,
  ];

  /** Contact note lookup for hop labels and path tooltips. */
  #notes = (key: string): string => this.app.contacts.noteFor(key);

  get #key(): string {
    return this.key.toLowerCase();
  }

  override willUpdate(): void {
    if (this.#key !== this.#lastKey) {
      this.#lastKey = this.#key;
      this.password = null;
      this.remember = null;
      this.tracePath = null;
      this.cliInput = '';
      this.#history = [];
      this.#historyPos = -1;
      this.#regionFetch?.ac.abort();
      this.#regionFetch = null;
    }
    // idempotent: starts tracking the archived battery / temperature history once
    if (this.#key && this.tab === 'telemetry') quiet(this.#node().loadTelemetryHistory());
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#regionFetch?.ac.abort();
  }

  #node(): RemoteNodeModel {
    return this.app.remoteAdmin.node(this.#key);
  }

  override render() {
    if (!this.#key) return nothing;
    const node = this.#node();
    if (!node.contact.value) return nothing;
    switch (this.tab) {
      case 'telemetry':
        return this.#telemetry(node);
      case 'cli':
        return this.#cli(node);
      case 'tools':
        return this.#tools(node);
      default:
        return this.#overview(node);
    }
  }

  #err(node: RemoteNodeModel, action: RemoteAction): TemplateResult | typeof nothing {
    const e = node.errors.value[action];
    return e ? html`<p class="error" role="alert" data-error=${action}>${e}</p>` : nothing;
  }

  #busy(node: RemoteNodeModel, action: RemoteAction): boolean {
    return node.busy.value.has(action);
  }

  // ---- overview ----

  async #login(e: Event): Promise<void> {
    e.preventDefault();
    const node = this.#node();
    const pw = this.password ?? node.savedPassword.peek() ?? '';
    const remember = this.remember ?? node.savedPassword.peek() !== null;
    const s = await node.login(pw, { remember });
    if (s.state === 'admin' || s.state === 'guest') {
      if (node.kind.peek() === 'sensor') quiet(node.refreshTelemetry());
      else quiet(node.refreshStatus());
    }
  }

  #overview(node: RemoteNodeModel): TemplateResult {
    const kind = node.kind.value;
    const ls = node.loginState.value;
    const saved = node.savedPassword.value;
    const pw = this.password ?? saved ?? '';
    const remember = this.remember ?? saved !== null;
    const status = node.lastStatus.value;
    const owner = node.ownerInfo.value;
    return html`<div class="stack">
      <section class="card" data-card="login">
        <h3>Login</h3>
        <form class="row" @submit=${(e: Event) => void this.#login(e)}>
          <label class="visually-hidden" for="pw">Password</label>
          <input
            id="pw"
            type="password"
            data-field="password"
            autocomplete="current-password"
            maxlength="15"
            placeholder=${kind === 'room' ? 'Password (blank for guest)' : 'Admin or guest password'}
            .value=${pw}
            @input=${(e: Event) => (this.password = (e.target as HTMLInputElement).value)}
          />
          <label><input type="checkbox" data-field="remember" .checked=${remember} @change=${(e: Event) => (this.remember = (e.target as HTMLInputElement).checked)} /> Remember</label>
          <button class="primary" type="submit" data-action="login" ?disabled=${ls.state === 'loggingIn'}>
            ${ls.state === 'loggingIn' ? 'Logging in…' : 'Log in'}
          </button>
          ${node.loggedIn.value ? html`<button type="button" data-action="logout" @click=${() => quiet(node.logout())}>Log out</button>` : nothing}
        </form>
        <p data-field="login-state" class=${ls.state === 'failed' ? 'error' : node.loggedIn.value ? 'ok' : 'muted'} role=${ls.state === 'failed' ? 'alert' : nothing}>
          ${ls.state === 'failed' ? ls.reason : loginLabel(ls)}
          ${ls.state === 'admin' || ls.state === 'guest' ? html` <span class="muted">since ${formatTime(ls.since, this.app.clock.now())}</span>` : nothing}
        </p>
        <p class="muted">The password is up to 15 characters. Wrong passwords get no reply, so a failed login takes a few seconds.</p>
      </section>
      ${kind === 'sensor'
        ? html`<section class="card"><p class="muted">Sensors have no status report; see <a href=${hrefFor(`/node/${this.#key}/telemetry`)}>Telemetry</a>.</p></section>`
        : html`<section class="card" data-card="status">
            <div class="row">
              <h3 style="flex: 1; margin: 0">Status</h3>
              ${status ? html`<span class="muted">updated ${formatTime(status.at, this.app.clock.now())}</span>` : nothing}
              <button data-action="refresh-status" ?disabled=${this.#busy(node, 'status')} @click=${() => quiet(node.refreshStatus())}>
                ${this.#busy(node, 'status') ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            ${this.#err(node, 'status')}
            ${status
              ? (['system', 'radio', 'packets', 'room'] as const).map((g) => {
                  const fields = status.fields.filter((f) => f.group === g);
                  return fields.length
                    ? html`<h3 style="margin-block-start: 12px">${GROUP_LABEL[g]}</h3>
                        <div class="stats">
                          ${fields.map((f) => html`<div class="stat" data-stat=${f.id}><div class="label">${f.label}</div><div class="value">${f.display}</div></div>`)}
                        </div>`
                    : nothing;
                })
              : html`<p class="muted">${node.loggedIn.value ? 'No status yet.' : 'Log in, then refresh to read the node status.'}</p>`}
          </section>`}
      ${kind === 'repeater'
        ? html`<section class="card" data-card="owner">
            <div class="row">
              <h3 style="flex: 1; margin: 0">Owner info</h3>
              <button data-action="owner" ?disabled=${this.#busy(node, 'owner')} @click=${() => quiet(node.fetchOwnerInfo())}>Fetch</button>
            </div>
            ${this.#err(node, 'owner')}
            ${owner
              ? html`<dl class="stats">
                  <div class="stat"><div class="label">Firmware</div><div class="value" data-field="firmware">${owner.firmwareVersion}</div></div>
                  <div class="stat"><div class="label">Name</div><div class="value">${owner.nodeName}</div></div>
                  <div class="stat"><div class="label">Owner</div><div class="value">${owner.ownerInfo || '—'}</div></div>
                </dl>`
              : nothing}
          </section>`
        : nothing}
    </div>`;
  }

  // ---- telemetry ----

  #telemetry(node: RemoteNodeModel): TemplateResult {
    const t = node.telemetry.value;
    const mm = node.avgMinMax.value;
    return html`<div class="stack">
      <section class="card" data-card="telemetry">
        <div class="row">
          <h3 style="flex: 1; margin: 0">Telemetry</h3>
          ${t ? html`<span class="muted">updated ${formatTime(t.at, this.app.clock.now())}</span>` : nothing}
          <button data-action="refresh-telemetry" ?disabled=${this.#busy(node, 'telemetry')} @click=${() => quiet(node.refreshTelemetry())}>
            ${this.#busy(node, 'telemetry') ? 'Requesting…' : t ? 'Refresh' : 'Request'}
          </button>
        </div>
        ${this.#err(node, 'telemetry')}
        ${t
          ? t.items.length
            ? html`<div class="table-wrap"><table>
                <thead><tr><th>Reading</th><th>Value</th><th>Channel</th></tr></thead>
                <tbody>
                  ${t.items.map((i) => html`<tr data-reading=${i.name.toLowerCase()} data-channel=${i.channel}><td>${i.label}</td><td data-field="value">${i.display}</td><td>${i.channel}</td></tr>`)}
                </tbody>
              </table></div>`
            : html`<p class="muted">The node returned no readings.</p>`
          : html`<p class="muted">Not requested yet. Nodes may only share telemetry with logged-in clients.</p>`}
        ${t?.error ? html`<p class="muted">Decoding stopped: ${t.error}</p>` : nothing}
      </section>
      ${node.kind.value === 'sensor'
        ? html`<section class="card" data-card="minmax">
            <div class="row">
              <h3 style="flex: 1; margin: 0">Last hour: min / max / average</h3>
              <button data-action="fetch-minmax" ?disabled=${this.#busy(node, 'avgMinMax')} @click=${() => quiet(node.fetchAvgMinMax(3600, 0))}>Request</button>
            </div>
            ${this.#err(node, 'avgMinMax')}
            ${mm
              ? html`<div class="table-wrap"><table>
                  <thead><tr><th>Reading</th><th>Min</th><th>Max</th><th>Avg</th></tr></thead>
                  <tbody>
                    ${mm.entries.map((e) => html`<tr data-minmax><td>${e.label}</td><td>${e.min} ${e.unit}</td><td>${e.max} ${e.unit}</td><td>${e.avg} ${e.unit}</td></tr>`)}
                  </tbody>
                </table></div>`
              : nothing}
          </section>`
        : nothing}
      ${this.#telemetryHistory(node.telemetryHistory.value)}
    </div>`;
  }

  #telemetryHistory(h: TelemetryHistory | null): TemplateResult {
    let body: TemplateResult;
    if (!h) {
      body = this.app.connection.store.value
        ? html`<p class="muted" data-field="history-loading">Loading…</p>`
        : html`<p class="muted" data-field="history-offline">Connect to the radio to see saved telemetry.</p>`;
    } else if (!h.battery.length && !h.temperature.length) {
      body = html`<p class="muted" data-field="history-empty">No saved telemetry for this node yet.</p>`;
    } else {
      const channels = [...new Set(h.temperature.map((p) => p.channel))].sort((a, b) => a - b);
      const tempKey = (c: number): string => `temp-${c}`;
      const tempLabel = (c: number): string => (c === 1 ? 'MCU' : `Sensor (ch ${c})`);
      // one palette over both charts, so a colour means one series throughout the card
      const palette = assignSlots(
        ['battery', ...channels.map(tempKey)],
        new Map([['battery', 'Battery'], ...channels.map((c): [string, string] => [tempKey(c), tempLabel(c)])]),
      );
      const ts = [...h.battery, ...h.temperature].map((p) => p.ts);
      const xDomain: [number, number] = [Math.min(...ts), Math.max(...ts)];
      const battery: TimeSeries[] = [
        { key: 'battery', label: 'Battery', points: h.battery.map((p) => ({ t: p.ts, v: p.volts, hollow: p.source === 'status' })) },
      ];
      const temperature: TimeSeries[] = channels.map((c) => ({
        key: tempKey(c),
        label: tempLabel(c),
        points: h.temperature.filter((p) => p.channel === c).map((p) => ({ t: p.ts, v: p.celsius })),
      }));
      body = html`<div class="stack">${h.battery.length
        ? html`<mc-time-series-chart
            data-history="battery"
            y-label="Battery (V)"
            .series=${battery}
            .palette=${palette}
            .xDomain=${xDomain}
            .yFormat=${fmtVolts}
            .markerLegend=${BATTERY_MARKERS}
          ></mc-time-series-chart>`
        : nothing}
      ${h.temperature.length
        ? html`<mc-time-series-chart
            data-history="temperature"
            y-label="Temperature (°C)"
            .series=${temperature}
            .palette=${palette}
            .xDomain=${xDomain}
            .yFormat=${fmtCelsius}
          ></mc-time-series-chart>`
        : nothing}</div>`;
    }
    return html`<section class="card" data-card="telemetry-history">
      <h3 style="margin: 0 0 8px">History</h3>
      ${body}
    </section>`;
  }

  // ---- CLI ----

  #suggestions(): ReturnType<typeof completeCliCommand> {
    const q = this.cliInput;
    if (!q.trim()) return [];
    const s = completeCliCommand(q, cliKindOf(this.#node().kind.peek()));
    return s.length === 1 && s[0]!.usage === q.trim() ? [] : s;
  }

  async #sendCli(command: string): Promise<void> {
    const cmd = command.trim();
    if (!cmd) return;
    if (this.#history.at(-1) !== cmd) this.#history.push(cmd);
    this.#historyPos = -1;
    this.cliInput = '';
    await this.#node().runCli(cmd);
    await this.updateComplete;
    const term = this.renderRoot.querySelector('.terminal');
    if (term) term.scrollTop = term.scrollHeight;
  }

  #onCliKey(e: KeyboardEvent): void {
    const input = e.target as HTMLInputElement;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!this.#history.length) return;
      e.preventDefault();
      if (e.key === 'ArrowUp') this.#historyPos = this.#historyPos < 0 ? this.#history.length - 1 : Math.max(0, this.#historyPos - 1);
      else this.#historyPos = this.#historyPos < 0 ? -1 : this.#historyPos + 1;
      if (this.#historyPos >= this.#history.length) this.#historyPos = -1;
      this.cliInput = this.#historyPos < 0 ? '' : (this.#history[this.#historyPos] ?? '');
      input.value = this.cliInput;
    } else if (e.key === 'Tab') {
      const first = this.#suggestions()[0];
      if (first) {
        e.preventDefault();
        this.cliInput = first.completion;
        input.value = this.cliInput;
      }
    } else if (e.key === 'Escape') {
      this.cliInput = '';
      input.value = '';
    }
  }

  #cli(node: RemoteNodeModel): TemplateResult {
    const entries = node.transcript.value;
    const sugg = this.#suggestions();
    return html`<section class="card stack" data-card="cli">
      ${node.isAdmin.value
        ? nothing
        : html`<p class="muted" data-field="cli-hint">Remote CLI commands are only answered for admin logins. <a href=${hrefFor(`/node/${this.#key}/overview`)}>Log in</a> first.</p>`}
      <div class="terminal" data-field="transcript" role="log" aria-live="polite" aria-label="CLI transcript">
        ${entries.length
          ? entries.map(
              (e) =>
                html`<div data-dir=${e.direction} class=${e.direction === 'out' ? 'out' : e.direction === 'error' ? 'err' : 'in'}><span class="ts">${new Date(e.ts).toLocaleTimeString()}</span>${e.text}</div>`,
            )
          : html`<div class="ts">No commands yet. Try "ver" or type "get " for preferences.</div>`}
      </div>
      <form
        @submit=${(e: Event) => {
          e.preventDefault();
          void this.#sendCli(this.cliInput);
        }}
      >
        <div class="row">
          <label class="visually-hidden" for="cli">Command</label>
          <input
            id="cli"
            type="text"
            class="mono"
            data-field="cli-input"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="Command (Tab completes, ↑/↓ history)"
            .value=${this.cliInput}
            @input=${(e: Event) => (this.cliInput = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => this.#onCliKey(e)}
          />
          <button class="primary" type="submit" data-action="send-cli" ?disabled=${!this.cliInput.trim()}>
            ${this.#busy(node, 'cli') ? 'Waiting…' : 'Send'}
          </button>
          <button type="button" data-action="clear-cli" @click=${() => node.clearTranscript()} ?disabled=${!entries.length}>Clear</button>
        </div>
        ${sugg.length
          ? html`<ul class="suggestions" data-field="suggestions" aria-label="Suggestions">
              ${sugg.map(
                (s) =>
                  html`<li>
                    <button
                      type="button"
                      class="mono"
                      data-suggestion=${s.usage}
                      @click=${() => {
                        this.cliInput = s.completion;
                        (this.renderRoot.querySelector('[data-field="cli-input"]') as HTMLInputElement | null)?.focus();
                      }}
                    >
                      ${s.usage}<span class="desc">${s.description}</span>
                    </button>
                  </li>`,
              )}
            </ul>`
          : nothing}
      </form>
      <div class="row" aria-label="Quick commands">
        ${QUICK_CLI_COMMANDS.map((c) => html`<button type="button" class="mono" data-quick=${c} @click=${() => void this.#sendCli(c)}>${c}</button>`)}
      </div>
    </section>`;
  }

  // ---- tools ----

  #defaultTrace(node: RemoteNodeModel): string {
    const d = node.defaultTracePath();
    const hex = toHex(d.path);
    const step = d.hashSize * 2;
    const parts: string[] = [];
    for (let i = 0; i < hex.length; i += step) parts.push(hex.slice(i, i + step));
    return parts.join(',');
  }

  #trace(node: RemoteNodeModel): void {
    this.traceError = '';
    const text = this.tracePath ?? this.#defaultTrace(node);
    let path: Uint8Array;
    try {
      path = parseHopList(text);
    } catch (err) {
      this.traceError = err instanceof Error ? err.message : String(err);
      return;
    }
    const first = text.split(/[\s,>-]+/).filter(Boolean)[0] ?? '';
    quiet(node.tracePath(path, Math.max(1, first.length / 2)));
  }

  async #fetchRegions(): Promise<void> {
    if (this.#regionFetch?.busy) return;
    const ac = new AbortController();
    const state: RegionFetch = { busy: true, ac };
    this.#regionFetch = state;
    this.requestUpdate();
    try {
      state.names = await this.app.regions.fetchFromRepeater(this.#key, { signal: ac.signal });
    } catch (err) {
      state.error = ac.signal.aborted ? 'Cancelled' : `No answer: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      state.busy = false;
      this.requestUpdate();
    }
  }

  #addRegions(names: readonly string[]): void {
    const added = this.app.regions.addAll(names);
    this.app.notifications.success(added ? `${added} region${added === 1 ? '' : 's'} added` : 'Already saved');
  }

  #regionsCard(): TemplateResult {
    const f = this.#regionFetch;
    const saved = this.app.regions.names.value;
    const fresh = f?.names?.filter((n) => !saved.includes(n)) ?? [];
    return html`<section class="card" data-card="regions">
      <div class="row">
        <h3 style="flex: 1; margin: 0">Regions</h3>
        ${f?.busy
          ? html`<button data-action="cancel-fetch-regions" @click=${() => f.ac.abort()}>Cancel</button>`
          : nothing}
        <button data-action="fetch-regions" ?disabled=${f?.busy === true} @click=${() => void this.#fetchRegions()}>
          ${f?.busy ? 'Fetching…' : 'Fetch regions'}
        </button>
      </div>
      <p class="muted">The regions (flood scopes) this repeater serves. It answers only when reachable direct or along a known path.</p>
      ${f?.error ? html`<p class="error" role="alert" data-error="regions">${f.error}</p>` : nothing}
      ${f?.names
        ? f.names.length
          ? html`<ul class="region-list" data-field="regions-result">
                ${f.names.map(
                  (n) => html`<li data-region=${n}>
                    <span class="mono">#${n}</span>
                    ${saved.includes(n)
                      ? html`<span class="muted" data-field="saved">saved</span>`
                      : html`<button data-action="add-region" @click=${() => this.#addRegions([n])}>Add</button>`}
                  </li>`,
                )}
              </ul>
              <div class="row">
                <button class="primary" data-action="add-all-regions" ?disabled=${!fresh.length} @click=${() => this.#addRegions(fresh)}>Add all</button>
                <a href=${hrefFor('/settings')}>Manage regions</a>
              </div>`
          : html`<p class="muted" data-field="regions-result">This repeater serves no regions.</p>`
        : nothing}
    </section>`;
  }

  #tools(node: RemoteNodeModel): TemplateResult {
    const kind = node.kind.value;
    const trace = node.lastTrace.value;
    const pd = node.pathDiscovery.value;
    const nb = node.neighbours.value;
    const acl = node.acl.value;
    return html`<div class="stack">
      <section class="card" data-card="trace">
        <h3>Trace path</h3>
        <p class="muted">Hop hashes to visit (comma separated hex). Only repeaters forward a trace; each hop reports the SNR it heard.</p>
        <form
          class="row"
          @submit=${(e: Event) => {
            e.preventDefault();
            this.#trace(node);
          }}
        >
          <label class="visually-hidden" for="trace">Hops</label>
          <input
            id="trace"
            type="text"
            class="mono"
            data-field="trace-path"
            placeholder="e.g. a1,b2,a1"
            .value=${this.tracePath ?? this.#defaultTrace(node)}
            @input=${(e: Event) => (this.tracePath = (e.target as HTMLInputElement).value)}
          />
          <button class="primary" type="submit" data-action="trace" ?disabled=${this.#busy(node, 'trace')}>${this.#busy(node, 'trace') ? 'Tracing…' : 'Trace'}</button>
        </form>
        ${this.traceError ? html`<p class="error" role="alert">${this.traceError}</p>` : nothing} ${this.#err(node, 'trace')}
        ${trace
          ? html`<ol class="hops" data-field="trace-result">
                ${trace.hops.map((h) => html`<li data-trace-hop=${h.hash}>${hopLabel(h, this.#notes)} — <span data-field="snr">${formatSnr(h.snr)}</span></li>`)}
                <li data-trace-hop="self">You — ${formatSnr(trace.finalSnr)}</li>
              </ol>
              <p class="muted">Round trip ${trace.roundTripMs} ms</p>`
          : nothing}
      </section>
      <section class="card" data-card="path">
        <h3>Path</h3>
        <p>Current path: <strong data-field="current-path"
            >${node.contact.value
              ? pathLabelView(
                  this.app.contacts.outPathLabel(node.contact.value, this.app.appSettings.pathNames.value),
                  node.contact.value.path.kind === 'hops' ? { kind: 'contact', key: this.#key } : null,
                  this.#notes,
                )
              : '—'}</strong
          ></p>
        <div class="row">
          <button data-action="discover" ?disabled=${this.#busy(node, 'discovery')} @click=${() => quiet(node.discoverPath())}>
            ${this.#busy(node, 'discovery') ? 'Discovering…' : 'Discover path'}
          </button>
          <button data-action="reset-path" ?disabled=${this.#busy(node, 'resetPath')} @click=${() => quiet(node.resetPath())}>Reset path</button>
          ${kind !== 'sensor'
            ? html`<button data-action="advert" @click=${() => quiet(node.requestAdvert(false))} title="CLI 'advert' (admin)">Ask to advertise</button>`
            : nothing}
        </div>
        ${this.#err(node, 'discovery')} ${this.#err(node, 'resetPath')}
        ${pd
          ? html`<dl class="stats" data-field="discovery-result">
              <div class="stat"><div class="label">Out (to node)</div><div class="value">${pd.outPath.length ? pd.outPath.map((h, i) => html`${i ? ' → ' : ''}${hopLabel(h, this.#notes)}`) : 'direct'}</div></div>
              <div class="stat"><div class="label">In (from node)</div><div class="value">${pd.inPath.length ? pd.inPath.map((h, i) => html`${i ? ' → ' : ''}${hopLabel(h, this.#notes)}`) : 'direct'}</div></div>
              <div class="stat"><div class="label">Round trip</div><div class="value">${pd.roundTripMs} ms</div></div>
            </dl>`
          : nothing}
      </section>
      ${kind === 'repeater'
        ? html`<section class="card" data-card="neighbours">
            <div class="row">
              <h3 style="flex: 1; margin: 0">Neighbours</h3>
              <button data-action="neighbours" ?disabled=${this.#busy(node, 'neighbours')} @click=${() => quiet(node.fetchNeighbours())}>Fetch</button>
            </div>
            ${this.#err(node, 'neighbours')}
            ${nb
              ? nb.items.length
                ? html`<div class="table-wrap"><table>
                    <thead><tr><th>Node</th><th>Heard</th><th>SNR</th></tr></thead>
                    <tbody>
                      ${nb.items.map((n) => html`<tr data-neighbour=${n.hash}><td>${hopLabel(n, this.#notes)}</td><td>${formatSeconds(n.heardSecsAgo)} ago</td><td>${formatSnr(n.snr)}</td></tr>`)}
                    </tbody>
                  </table></div>
                  ${nb.total > nb.items.length ? html`<p class="muted">${nb.items.length} of ${nb.total}</p>` : nothing}`
                : html`<p class="muted">No neighbours heard.</p>`
              : nothing}
          </section>
          ${this.#regionsCard()}`
        : nothing}
      <section class="card" data-card="acl">
        <div class="row">
          <h3 style="flex: 1; margin: 0">Access list</h3>
          <button data-action="acl" ?disabled=${this.#busy(node, 'acl')} @click=${() => quiet(node.fetchAcl())}>Fetch</button>
        </div>
        <p class="muted">Admin only.</p>
        ${this.#err(node, 'acl')}
        ${acl
          ? acl.items.length
            ? html`<div class="table-wrap"><table>
                <thead><tr><th>Client</th><th>Role</th></tr></thead>
                <tbody>
                  ${acl.items.map((a) => html`<tr data-acl=${a.hash}><td>${hopLabel(a, this.#notes)}</td><td>${a.role}</td></tr>`)}
                </tbody>
              </table></div>`
            : html`<p class="muted">The access list is empty.</p>`
          : nothing}
      </section>
    </div>`;
  }
}

customElements.define('mc-node-admin', McNodeAdmin);

declare global {
  interface HTMLElementTagNameMap {
    'mc-node-admin': McNodeAdmin;
  }
}
