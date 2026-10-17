/**
 * `/packets`: the packet log (over-the-air packets the radio reported) and the frame log (every
 * host ↔ device frame), with filters, live tail, paging, export / import / clear, and the
 * inspector in a side panel (wide) or on its own page `/packets/:id` (narrow).
 * State and logic live in the core PacketLogModel; this component renders and forwards intents.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import type { FrameRow, LogView, PacketFilter, PacketRow } from '@meshcore-web/core/app';
import { PayloadType, RouteType, payloadTypeName } from '@meshcore-web/core/packet';
import { CMD, PUSH, RESP } from '@meshcore-web/core/protocol';
import { AppElement } from '../../app-context.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { formatLogTime, frameInspectorProps, fromDatetimeLocal, packetInspectorProps, toDatetimeLocal, type InspectorProps } from './inspection.js';
import { jsonReplacer } from './packet-inspector.js';
import { hopsLink } from '../../components/path-dialog.js';
import './packet-inspector.js';

export type LogTab = 'packets' | 'frames';

/** Below this host width the inspector opens as its own page. */
export const WIDE_MIN_PX = 900;

const PAYLOAD_TYPES = Object.values(PayloadType);
const ROUTE_TYPES = Object.entries(RouteType) as [string, number][];

/** Fired before a download starts (tests and integrations can observe exports). */
export interface ExportEventDetail {
  filename: string;
  text: string;
}

export class McPacketsPage extends AppElement {
  static override properties = {
    params: { attribute: false },
    tab: { state: true },
    wide: { state: true },
    selected: { state: true },
    inspector: { state: true },
    confirm: { state: true },
    busy: { state: true },
  };
  declare params: Readonly<Record<string, string>>;
  declare tab: LogTab;
  declare wide: boolean;
  declare selected: { tab: LogTab; id: number } | null;
  declare inspector: InspectorProps | null;
  declare confirm: '' | 'clear' | 'key';
  declare busy: boolean;
  #ro: ResizeObserver | undefined;
  #textTimer: ReturnType<typeof setTimeout> | undefined;
  #loadSeq = 0;

  constructor() {
    super();
    this.params = {};
    this.tab = 'packets';
    this.wide = true;
    this.selected = null;
    this.inspector = null;
    this.confirm = '';
    this.busy = false;
  }

  static override styles = [
    shared,
    css`
      :host {
        display: block;
        min-width: 0;
      }
      .tabs {
        display: flex;
        gap: 4px;
        margin-block-end: 12px;
        border-block-end: 1px solid var(--mc-border);
      }
      .tabs button {
        border: 0;
        border-radius: 8px 8px 0 0;
        background: transparent;
        border-block-end: 3px solid transparent;
      }
      .tabs button[aria-selected='true'] {
        border-block-end-color: var(--mc-accent);
        color: var(--mc-accent);
        font-weight: 600;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: var(--mc-gap);
      }
      .layout.split {
        grid-template-columns: minmax(0, 3fr) minmax(20rem, 2fr);
      }
      aside.card {
        position: sticky;
        top: 72px;
        align-self: start;
        max-height: calc(100dvh - 96px);
        overflow: auto;
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: end;
        margin-block-end: 8px;
      }
      .filters label {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 0.8rem;
        color: var(--mc-text-muted);
      }
      input:not([type='checkbox'], [type='radio'], [type='range']),
      select {
        font: inherit;
        color: var(--mc-text);
        background: var(--mc-surface);
        border: 1px solid var(--mc-border);
        border-radius: 8px;
        padding: 0.35em 0.5em;
        min-height: 2.25rem;
      }
      input[type='search'] {
        min-width: 12rem;
      }
      details.types {
        position: relative;
      }
      details.types summary {
        list-style: none;
        cursor: pointer;
        border: 1px solid var(--mc-border);
        border-radius: 8px;
        padding: 0.35em 0.75em;
        min-height: 2.25rem;
        display: flex;
        align-items: center;
        color: var(--mc-text);
      }
      details.types .menu {
        position: absolute;
        z-index: 2;
        inset-block-start: calc(100% + 4px);
        background: var(--mc-surface);
        border: 1px solid var(--mc-border);
        border-radius: 8px;
        padding: 8px;
        display: grid;
        grid-template-columns: repeat(2, max-content);
        gap: 4px 16px;
        box-shadow: 0 6px 20px rgb(0 0 0 / 0.15);
      }
      details.types .menu label {
        flex-direction: row;
        align-items: center;
        gap: 6px;
        color: var(--mc-text);
        font-size: 0.875rem;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-block-end: 8px;
        font-size: 0.875rem;
      }
      .toolbar .spacer {
        flex: 1;
      }
      .toolbar button {
        min-height: 2.25rem;
        padding: 0.3em 0.8em;
      }
      .live {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .tablewrap {
        overflow-x: auto;
        border: 1px solid var(--mc-border);
        border-radius: var(--mc-radius);
        background: var(--mc-surface);
      }
      table {
        border-collapse: collapse;
        width: 100%;
        font-size: 0.8125rem;
      }
      th,
      td {
        text-align: start;
        padding: 4px 8px;
        white-space: nowrap;
        border-block-end: 1px solid var(--mc-border);
      }
      th {
        position: sticky;
        top: 0;
        background: var(--mc-surface-2);
        font-weight: 600;
      }
      td.summary {
        white-space: normal;
        min-width: 14rem;
        overflow-wrap: anywhere;
      }
      td.num {
        text-align: end;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: var(--mc-mono);
      }
      tbody tr {
        cursor: pointer;
      }
      tbody tr:hover {
        background: var(--mc-surface-2);
      }
      tbody tr[aria-selected='true'] {
        background: var(--mc-accent-soft);
      }
      .dir-rx,
      .dir-in {
        color: var(--mc-ok);
      }
      .dir-tx,
      .dir-out {
        color: var(--mc-accent);
      }
      .empty {
        padding: 24px;
        text-align: center;
      }
      .confirm {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        flex-wrap: wrap;
      }
      .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    this.#ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? this.clientWidth;
      const wide = w >= WIDE_MIN_PX;
      if (wide !== this.wide) this.wide = wide;
    });
    this.#ro.observe(this);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#ro?.disconnect();
    clearTimeout(this.#textTimer);
  }

  get #log() {
    return this.app.packetLog;
  }

  // ---- intents ----

  #setTab(tab: LogTab): void {
    this.tab = tab;
  }

  async #open(tab: LogTab, id: number): Promise<void> {
    const wide = this.clientWidth >= WIDE_MIN_PX;
    if (!wide) {
      location.hash = hrefFor(tab === 'packets' ? `/packets/${id}` : `/packets/frame/${id}`);
      return;
    }
    this.wide = true;
    this.selected = { tab, id };
    const seq = ++this.#loadSeq;
    try {
      const props =
        tab === 'packets'
          ? await this.#log.inspect(id).then((i) => (i ? packetInspectorProps(i) : null))
          : await this.#log.inspectFrame(id).then((i) => (i ? frameInspectorProps(i) : null));
      if (seq === this.#loadSeq) this.inspector = props;
    } catch (err) {
      this.app.notifications.error('Could not inspect', err);
    }
  }

  #close(): void {
    this.selected = null;
    this.inspector = null;
  }

  #view(): LogView<{ id: number }, object, { id: number }> {
    return (this.tab === 'packets' ? this.#log.packets : this.#log.frames) as unknown as LogView<{ id: number }, object, { id: number }>;
  }

  #setPacketFilter(patch: Partial<PacketFilter>): void {
    void this.#log.packets.setFilter(patch);
  }

  #debouncedText(apply: () => void): void {
    clearTimeout(this.#textTimer);
    this.#textTimer = setTimeout(apply, 250);
  }

  #toggleType(t: number, on: boolean): void {
    const cur = new Set(this.#log.packets.filter.peek().payloadTypes ?? []);
    if (on) cur.add(t);
    else cur.delete(t);
    this.#setPacketFilter({ payloadTypes: [...cur].sort((a, b) => a - b) });
  }

  async #export(): Promise<void> {
    try {
      const filtered = this.tab === 'packets' ? Object.keys(this.#log.packets.filter.peek()).length > 0 : Object.keys(this.#log.frames.filter.peek()).length > 0;
      const data = this.tab === 'packets' ? await this.#log.exportPackets({ filtered }) : await this.#log.exportFrames({ filtered });
      const text = JSON.stringify(data, jsonReplacer, 1);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `meshcore-${this.tab}-${stamp}.json`;
      this.dispatchEvent(new CustomEvent<ExportEventDetail>('mc-export', { detail: { filename, text }, bubbles: true, composed: true }));
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.app.notifications.success(`Exported ${data.count} ${this.tab}`);
    } catch (err) {
      this.app.notifications.error('Export failed', err);
    }
  }

  async #import(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const r = await this.#log.importJson(await file.text());
      this.app.notifications.success(`Imported ${r.packets} packets, ${r.frames} frames`);
    } catch (err) {
      this.app.notifications.error('Import failed', err);
    }
  }

  async #clear(): Promise<void> {
    this.confirm = '';
    try {
      const n = this.tab === 'packets' ? await this.#log.clearPackets() : await this.#log.clearFrames();
      this.#close();
      this.app.notifications.info(`Cleared ${n} ${this.tab}`);
    } catch (err) {
      this.app.notifications.error('Clear failed', err);
    }
  }

  async #storeKey(): Promise<void> {
    this.confirm = '';
    this.busy = true;
    try {
      await this.#log.storeSelfKeyFromDevice();
      this.app.notifications.success('Radio key stored: direct messages will be decrypted in the inspector');
      if (this.selected) void this.#open(this.selected.tab, this.selected.id);
    } catch (err) {
      this.app.notifications.error('Could not export the radio key', err);
    } finally {
      this.busy = false;
    }
  }

  async #forgetKey(): Promise<void> {
    try {
      await this.#log.setSelfPrivateKey(null);
      this.app.notifications.info('Radio key forgotten');
    } catch (err) {
      this.app.notifications.error('Could not forget the key', err);
    }
  }

  // ---- rendering ----

  #packetFilters(): TemplateResult {
    const f = this.#log.packets.filter.value;
    const types = new Set(f.payloadTypes ?? []);
    return html`<div class="filters" role="search" aria-label="Packet filters">
      <label
        >Direction
        <select data-filter="direction" @change=${(e: Event) => this.#setPacketFilter({ direction: ((e.target as HTMLSelectElement).value || undefined) as PacketFilter['direction'] })}>
          <option value="" ?selected=${!f.direction}>All</option>
          <option value="rx" ?selected=${f.direction === 'rx'}>↓ rx (received)</option>
          <option value="tx" ?selected=${f.direction === 'tx'}>↑ tx (sent)</option>
        </select>
      </label>
      <details class="types">
        <summary data-filter="types">Types${types.size ? ` (${types.size})` : ': all'}</summary>
        <div class="menu">
          ${PAYLOAD_TYPES.map(
            (t) => html`<label
              ><input type="checkbox" data-type=${payloadTypeName(t)} .checked=${types.has(t)}
                @change=${(e: Event) => this.#toggleType(t, (e.target as HTMLInputElement).checked)} />${payloadTypeName(t)}</label
            >`,
          )}
        </div>
      </details>
      <label
        >Route
        <select data-filter="route" @change=${(e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          this.#setPacketFilter({ routeTypes: v === '' ? undefined : [Number(v)] });
        }}>
          <option value="" ?selected=${!f.routeTypes?.length}>Any</option>
          ${ROUTE_TYPES.map(([n, v]) => html`<option value=${v} ?selected=${f.routeTypes?.length === 1 && f.routeTypes[0] === v}>${n}</option>`)}
        </select>
      </label>
      <label
        >Node
        <input data-filter="node" class="mono" size="10" placeholder="hash / key" .value=${f.node ?? ''}
          @input=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value.trim();
            this.#debouncedText(() => this.#setPacketFilter({ node: v || undefined }));
          }} />
      </label>
      <label
        >From
        <input type="datetime-local" data-filter="from" .value=${toDatetimeLocal(f.from)}
          @change=${(e: Event) => this.#setPacketFilter({ from: fromDatetimeLocal((e.target as HTMLInputElement).value) })} />
      </label>
      <label
        >To
        <input type="datetime-local" data-filter="to" .value=${toDatetimeLocal(f.to)}
          @change=${(e: Event) => this.#setPacketFilter({ to: fromDatetimeLocal((e.target as HTMLInputElement).value) })} />
      </label>
      <label
        >Search
        <input type="search" data-filter="text" placeholder="text or hex" .value=${f.text ?? ''}
          @input=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            this.#debouncedText(() => this.#setPacketFilter({ text: v.trim() || undefined }));
          }} />
      </label>
      ${Object.keys(f).length ? html`<button data-action="clear-filters" @click=${() => void this.#log.packets.clearFilter()}>Reset</button>` : nothing}
    </div>`;
  }

  #frameFilters(): TemplateResult {
    const f = this.#log.frames.filter.value;
    const code = f.codes?.length === 1 ? f.codes[0] : undefined;
    const opt = (n: string, v: number, dir: string) =>
      html`<option value=${v} ?selected=${code === v}>${n} (0x${v.toString(16).padStart(2, '0')}${dir})</option>`;
    return html`<div class="filters" role="search" aria-label="Frame filters">
      <label
        >Direction
        <select data-filter="frame-direction" @change=${(e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          void this.#log.frames.setFilter({ direction: v === 'in' || v === 'out' ? v : undefined });
        }}>
          <option value="" ?selected=${!f.direction}>Both</option>
          <option value="out" ?selected=${f.direction === 'out'}>host → device</option>
          <option value="in" ?selected=${f.direction === 'in'}>device → host</option>
        </select>
      </label>
      <label
        >Code
        <select data-filter="code" @change=${(e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          void this.#log.frames.setFilter({ codes: v === '' ? undefined : [Number(v)] });
        }}>
          <option value="" ?selected=${code === undefined}>Any</option>
          <optgroup label="Commands">${Object.entries(CMD).map(([n, v]) => opt(n, v, ''))}</optgroup>
          <optgroup label="Responses">${Object.entries(RESP).map(([n, v]) => opt(n, v, ''))}</optgroup>
          <optgroup label="Pushes">${Object.entries(PUSH).map(([n, v]) => opt(n, v, ''))}</optgroup>
        </select>
      </label>
      <label
        >Search
        <input type="search" data-filter="frame-text" placeholder="name, text or hex" .value=${f.text ?? ''}
          @input=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            this.#debouncedText(() => void this.#log.frames.setFilter({ text: v.trim() || undefined }));
          }} />
      </label>
      ${Object.keys(f).length ? html`<button data-action="clear-filters" @click=${() => void this.#log.frames.clearFilter()}>Reset</button>` : nothing}
    </div>`;
  }

  #toolbar(): TemplateResult {
    const v = this.#view();
    const noun = this.tab;
    const page = v.page.value;
    const pages = v.pageCount.value;
    const missed = v.missed.value;
    const log = this.#log;
    return html`<div class="toolbar">
      <span data-field="counts" role="status">${v.matching.value === v.total.value ? `${v.total.value} ${noun}` : `${v.matching.value} of ${v.total.value} ${noun}`}</span>
      <label class="live"
        ><input type="checkbox" data-action="live" .checked=${v.live.value}
          @change=${(e: Event) => void v.setLive((e.target as HTMLInputElement).checked)} />Live tail</label
      >
      ${missed > 0 ? html`<button data-action="show-new" @click=${() => void v.setLive(true)}>${missed} new</button>` : nothing}
      <span class="spacer"></span>
      <button data-action="prev" ?disabled=${page === 0} @click=${() => void v.prev()} aria-label="Newer page">‹ Newer</button>
      <span data-field="page">${page + 1} / ${pages}</span>
      <button data-action="next" ?disabled=${!v.hasMore.value} @click=${() => void v.next()} aria-label="Older page">Older ›</button>
      <button data-action="export" @click=${() => void this.#export()}>Export</button>
      <input type="file" accept="application/json,.json" data-action="import" aria-label="Import JSON" hidden @change=${(e: Event) => void this.#import(e)} />
      <button data-action="import-button" @click=${() => this.renderRoot.querySelector<HTMLInputElement>('input[data-action="import"]')?.click()}>Import…</button>
      ${this.confirm === 'clear'
        ? html`<span class="confirm"
            >Delete all logged ${noun}?
            <button class="danger" data-action="confirm-clear" @click=${() => void this.#clear()}>Delete</button>
            <button @click=${() => (this.confirm = '')}>Cancel</button></span
          >`
        : html`<button class="danger" data-action="clear" @click=${() => (this.confirm = 'clear')}>Clear…</button>`}
      ${this.tab === 'packets'
        ? log.selfKeyStored.value
          ? html`<button data-action="forget-key" @click=${() => void this.#forgetKey()} title="Stop decrypting direct messages">Forget radio key</button>`
          : this.confirm === 'key'
            ? html`<span class="confirm"
                >Export the radio's private key and keep it in this browser to decrypt direct messages?
                <button class="primary" data-action="confirm-key" ?disabled=${this.busy} @click=${() => void this.#storeKey()}>Store key</button>
                <button @click=${() => (this.confirm = '')}>Cancel</button></span
              >`
            : html`<button data-action="store-key" @click=${() => (this.confirm = 'key')} title="Decrypt direct messages (stores the radio key in this browser)">Decrypt DMs…</button>`
        : nothing}
    </div>`;
  }

  #packetTable(rows: readonly PacketRow[]): TemplateResult {
    const sel = this.selected?.tab === 'packets' ? this.selected.id : null;
    return html`<div class="tablewrap">
      <table data-table="packets">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Dir</th>
            <th scope="col">Type</th>
            <th scope="col">Route</th>
            <th scope="col">Path / hops</th>
            <th scope="col">SNR / RSSI</th>
            <th scope="col">Size</th>
            <th scope="col">Summary</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const rec = r.record;
            return html`<tr
              data-packet-id=${r.id}
              data-type=${r.typeName}
              tabindex="0"
              aria-selected=${sel === r.id ? 'true' : 'false'}
              @click=${() => void this.#open('packets', r.id)}
              @keydown=${(e: KeyboardEvent) => this.#rowKey(e, 'packets', r.id)}
            >
              <td class="mono">${formatLogTime(rec.ts)}</td>
              <td class="dir-${rec.direction}" data-dir=${rec.direction} title=${rec.direction === 'rx' ? 'received: heard by the radio' : 'sent: transmitted at this app\'s request'}>
                ${rec.direction === 'rx' ? '↓ rx' : '↑ tx'}
              </td>
              <td>${r.typeName}</td>
              <td>${r.routeName || '—'}</td>
              <td class="mono" title=${r.path.join(' → ')} data-field="path">
                ${r.hops === null ? '—' : r.path.length ? hopsLink(`${r.path.join('→')} (${r.hops})`, { kind: 'packet', id: r.id }) : String(r.hops)}
              </td>
              <td class="num">${rec.snr !== undefined ? `${rec.snr} dB` : '—'}${rec.rssi !== undefined ? ` / ${rec.rssi}` : ''}</td>
              ${rec.format === 'none'
                ? html`<td class="num muted" title="On-air bytes unknown: logged from the command sent to the radio">—</td>`
                : html`<td class="num">${rec.bytes.length}</td>`}
              <td class="summary">${r.summary}</td>
            </tr>`;
          })}
        </tbody>
      </table>
      ${rows.length === 0 ? html`<p class="empty muted">${this.#log.packets.total.value ? 'No packets match the filters.' : 'No packets logged yet. Packets the radio hears, and those this app asks it to send, appear here live.'}</p>` : nothing}
    </div>`;
  }

  #frameTable(rows: readonly FrameRow[]): TemplateResult {
    const sel = this.selected?.tab === 'frames' ? this.selected.id : null;
    return html`<div class="tablewrap">
      <table data-table="frames">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Dir</th>
            <th scope="col">Code</th>
            <th scope="col">Size</th>
            <th scope="col">Summary</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const rec = r.record;
            return html`<tr
              data-frame-id=${r.id}
              data-name=${r.name}
              tabindex="0"
              aria-selected=${sel === r.id ? 'true' : 'false'}
              @click=${() => void this.#open('frames', r.id)}
              @keydown=${(e: KeyboardEvent) => this.#rowKey(e, 'frames', r.id)}
            >
              <td class="mono">${formatLogTime(rec.ts)}</td>
              <td class="dir-${rec.direction}" title=${rec.direction === 'out' ? 'host → device' : 'device → host'}>${rec.direction === 'out' ? '→ dev' : '← dev'}</td>
              <td><span class="mono">${rec.code >= 0 ? rec.code.toString(16).padStart(2, '0') : '--'}</span> ${r.name}</td>
              <td class="num">${rec.size}</td>
              <td class="summary">${r.summary}</td>
            </tr>`;
          })}
        </tbody>
      </table>
      ${rows.length === 0 ? html`<p class="empty muted">No frames match.</p>` : nothing}
    </div>`;
  }

  #rowKey(e: KeyboardEvent, tab: LogTab, id: number): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void this.#open(tab, id);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const tr = e.currentTarget as HTMLElement;
      const next = (e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling) as HTMLElement | null;
      next?.focus();
    }
  }

  override render() {
    const conn = this.app.connection;
    if (!conn.connected.value) {
      return html`<section class="card">
        <h2>Packets</h2>
        <p><a href=${hrefFor('/')}>Connect a radio</a> to see its packet and frame logs.</p>
      </section>`;
    }
    const log = this.#log;
    // The inspector belongs to the tab its row came from: switching tabs hides it (and back shows it).
    const split = this.wide && this.selected !== null && this.selected.tab === this.tab;
    return html`
      <div class="tabs" role="tablist" aria-label="Log">
        <button role="tab" data-tab="packets" aria-selected=${this.tab === 'packets' ? 'true' : 'false'} @click=${() => this.#setTab('packets')}>
          Packets <span class="muted">(${log.packets.total.value})</span>
        </button>
        <button role="tab" data-tab="frames" aria-selected=${this.tab === 'frames' ? 'true' : 'false'} @click=${() => this.#setTab('frames')}>
          Frames <span class="muted">(${log.frames.total.value})</span>
        </button>
      </div>
      <div class="layout ${split ? 'split' : ''}">
        <section role="tabpanel" aria-label=${this.tab === 'packets' ? 'Over-the-air packets' : 'Host ↔ device frames'}>
          ${this.tab === 'packets' ? this.#packetFilters() : this.#frameFilters()} ${this.#toolbar()}
          ${this.tab === 'packets' ? this.#packetTable(log.packets.rows.value) : this.#frameTable(log.frames.rows.value)}
        </section>
        ${split
          ? html`<aside class="card" aria-label="Inspector">
              <div class="toolbar">
                <span class="spacer"></span>
                <a href=${hrefFor(this.selected!.tab === 'packets' ? `/packets/${this.selected!.id}` : `/packets/frame/${this.selected!.id}`)}>Open full page</a>
                <button data-action="close-inspector" @click=${() => this.#close()} aria-label="Close inspector">✕</button>
              </div>
              ${this.inspector
                ? html`<mc-packet-inspector
                    .heading=${this.inspector.heading}
                    .meta=${this.inspector.meta}
                    .bytes=${this.inspector.bytes}
                    .annotation=${this.inspector.annotation}
                    .json=${this.inspector.json}
                  ></mc-packet-inspector>`
                : html`<p class="muted">Loading…</p>`}
            </aside>`
          : nothing}
      </div>
    `;
  }
}

customElements.define('mc-packets-page', McPacketsPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-packets-page': McPacketsPage;
  }
}
