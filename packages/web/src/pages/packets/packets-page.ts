/**
 * `/packets`: the packet log (over-the-air packets the radio reported) with live tail, infinite
 * scroll, export / import / clear, and the inspector in a side panel (wide) or on its own page
 * `/packets/:id` (narrow); a "Map" of the listed packets' paths (`<mc-packets-map>`); its Stats; and, with the "Show the Frames tab" setting
 * (`appSettings.showFrames`, off by default), the frame log (every host ↔ device frame).
 * `/packets/node/:key` opens the packet log filtered to the packets that node originated (linked
 * from the contact page; the filter uses the packet log's source index).
 * The Packets and Stats tabs share one filter (the packet log's), rendered once above the tab row
 * by `<mc-packet-filters>`; the Frames tab has its own. State and logic live in the core
 * PacketLogModel; this component renders and forwards intents.
 */
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { resolvedPathTitle, sendOutcomeLabel, type FrameRow, type LogView, type PacketRow } from '@meshcore-web/core/app';
import { CMD, PUSH, RESP } from '@meshcore-web/core/protocol';
import { AppElement } from '../../app-context.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { formatLogTime, frameInspectorProps, packetInspectorProps, type InspectorProps } from './inspection.js';
import { jsonReplacer } from './packet-inspector.js';
import { hopsLink } from '../../components/path-dialog.js';
import { pathHops } from '../../components/node-link.js';
import './packet-inspector.js';
import './packet-stats.js';
import './packet-filters.js';
import './packets-map.js';

/** The list tabs plus the Stats tab (docs/packet-stats.md §3); Frames only with `showFrames`. */
export type LogTab = 'packets' | 'frames' | 'stats';

/** Below this host width the inspector opens as its own page. */
export const WIDE_MIN_PX = 900;

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
    showMap: { state: true },
  };
  declare params: Readonly<Record<string, string>>;
  declare tab: LogTab;
  declare wide: boolean;
  declare selected: { tab: LogTab; id: number } | null;
  declare inspector: InspectorProps | null;
  declare confirm: '' | 'clear' | 'key';
  declare busy: boolean;
  /** The Packets tab's "Map" panel is open (`<mc-packets-map>`, per page instance). */
  declare showMap: boolean;
  #ro: ResizeObserver | undefined;
  /** Watches the end-of-list sentinel: older rows load as it nears the viewport (infinite scroll). */
  #io: IntersectionObserver | undefined;
  #sentinel: Element | null = null;
  #sentinelRows: unknown = null;
  /** Height of the sticky filter area, so the sticky inspector sits below it. */
  #filtersRo: ResizeObserver | undefined;
  #textTimer: ReturnType<typeof setTimeout> | undefined;
  #observedFilters: Element | null = null;
  #loadSeq = 0;
  /** `send` of the packet the inspector shows (JSON), to refresh it when the outcome changes. */
  #inspectedSend = '';
  #inspectedId = -1;
  /** First visible row before an update, so rows added above it don't move it (see #keepAnchor). */
  #anchor: { attr: string; id: string; top: number } | null = null;
  /** Contact note lookup for path hop tooltips. */
  #notes = (key: string): string => this.app.contacts.noteFor(key);

  constructor() {
    super();
    this.params = {};
    this.tab = 'packets';
    this.wide = true;
    this.selected = null;
    this.inspector = null;
    this.confirm = '';
    this.busy = false;
    this.showMap = false;
  }

  static override styles = [
    shared,
    css`
      :host {
        display: block;
        min-width: 0;
        /* rows added above the viewport are compensated for by hand (#keepAnchor); keep the
           browser's own scroll anchoring out of it so it can't adjust a second time */
        overflow-anchor: none;
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
        top: calc(72px + var(--mc-filters-h, 0px));
        align-self: start;
        max-height: calc(100dvh - 96px - var(--mc-filters-h, 0px));
        overflow: auto;
      }
      mc-packet-filters {
        padding-block: 8px;
        margin-block-end: 4px;
        background: var(--mc-bg);
      }
      /* wide: the shared filters stay in view under the app header (narrow: they would eat the screen) */
      @media (min-width: 900px) {
        mc-packet-filters {
          position: sticky;
          top: 60px; /* under the app header (61px) */
          z-index: 2;
        }
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
      .more {
        margin: 0;
        padding: 8px;
        text-align: center;
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
      /* One line per row: a long summary is cut off with an ellipsis (full text in its title)
         instead of wrapping and making its row taller than the rest. width: 100% gives the
         summary the leftover space; max-width: 0 lets it shrink below its text width. */
      td.summary {
        width: 100%;
        max-width: 0;
        min-width: 14rem;
        overflow: hidden;
        text-overflow: ellipsis;
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
      .send {
        font-size: 0.75rem;
        font-variant-numeric: tabular-nums;
        color: var(--mc-text-muted);
      }
      .send-sent,
      .send-confirmed {
        color: var(--mc-ok);
      }
      .send-no-ack {
        color: var(--mc-warn);
      }
      .send-failed {
        color: var(--mc-danger);
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

  /** /packets/node/:key: show what that node sent. */
  #applyRouteFilter(changed: PropertyValues<this>): void {
    const key = this.params['key']?.toLowerCase();
    if (changed.has('params') && key && this.#log.packets.filter.peek().src !== key) {
      this.tab = 'packets';
      void this.#log.packets.setFilter({ src: key }, { replace: true });
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? this.clientWidth;
      const wide = w >= WIDE_MIN_PX;
      if (wide !== this.wide) this.wide = wide;
    });
    this.#ro.observe(this);
    this.#io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) this.#loadMore();
      },
      { rootMargin: '0px 0px 600px 0px' },
    );
    this.#filtersRo = new ResizeObserver((entries) => {
      const h = entries[0]?.borderBoxSize[0]?.blockSize ?? 0;
      this.style.setProperty('--mc-filters-h', `${Math.ceil(h)}px`);
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#ro?.disconnect();
    this.#io?.disconnect();
    this.#sentinel = null;
    this.#filtersRo?.disconnect();
    clearTimeout(this.#textTimer);
  }

  // ---- scroll anchoring ----
  // Live tail inserts rows at the top. When the reader has scrolled down into the table, keep the
  // first visible row where it is: record its position before Lit renders (willUpdate) and scroll by
  // however far it moved right after (updated). Both run synchronously in the same update microtask
  // as the DOM change, so no frame is painted in between and nothing visibly jumps. Done by hand
  // rather than relying on CSS scroll anchoring, which isn't in every browser (Safari < 27) and
  // whose timing differs between engines.

  override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    this.#applyRouteFilter(changed);
    // the Frames tab was turned off in Settings while it was showing
    if (this.tab === 'frames' && !this.app.appSettings.showFrames.peek()) this.tab = 'packets';
    this.#anchor = this.#findAnchor();
  }

  override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    const filters = this.renderRoot.querySelector('mc-packet-filters');
    if (filters !== this.#observedFilters) {
      if (this.#observedFilters) this.#filtersRo?.unobserve(this.#observedFilters);
      if (filters) this.#filtersRo?.observe(filters);
      this.#observedFilters = filters;
    }
    this.#keepAnchor();
    this.#refreshInspector();
    this.#watchSentinel();
  }

  /**
   * (Re)observes the sentinel whenever it or the rows change, so the observer reports it again
   * when a load didn't push it out of range (short list, tall screen) and the next page follows.
   */
  #watchSentinel(): void {
    const el = this.renderRoot.querySelector('[data-load-more]');
    const rows = this.tab === 'stats' ? null : this.#view().rows.peek();
    if (el === this.#sentinel && rows === this.#sentinelRows) return;
    if (this.#sentinel) this.#io?.unobserve(this.#sentinel);
    this.#sentinel = el;
    this.#sentinelRows = rows;
    if (el) this.#io?.observe(el);
  }

  #loadMore(): void {
    if (this.tab === 'stats') return;
    this.#view()
      .loadMore()
      .catch((err: unknown) => this.app.notifications.error('Could not load more', err));
  }

  /** The inspected tx row's send outcome changed (e.g. its ACK arrived): inspect it again. */
  #refreshInspector(): void {
    const s = this.selected;
    if (s?.tab !== 'packets' || !this.inspector || s.id !== this.#inspectedId) return;
    const row = this.#log.packets.rows.peek().find((r) => r.id === s.id);
    if (!row) return;
    const key = JSON.stringify(row.record.send ?? null);
    if (key === this.#inspectedSend) return;
    this.#inspectedSend = key;
    void this.#open('packets', s.id);
  }

  #findAnchor(): { attr: string; id: string; top: number } | null {
    if (this.tab === 'stats') return null; // no live-tail table
    const attr = this.tab === 'packets' ? 'data-packet-id' : 'data-frame-id';
    const rows = this.renderRoot.querySelectorAll<HTMLElement>(`tbody tr[${attr}]`);
    const first = rows[0];
    // only once the reader has scrolled past the top of the list: at the top new rows should show
    if (!first || first.getBoundingClientRect().top >= 0) return null;
    for (const tr of rows) {
      const r = tr.getBoundingClientRect();
      if (r.bottom > 0) return { attr, id: tr.getAttribute(attr)!, top: r.top };
    }
    return null;
  }

  #keepAnchor(): void {
    const a = this.#anchor;
    this.#anchor = null;
    if (!a) return;
    const tr = this.renderRoot.querySelector<HTMLElement>(`tbody tr[${a.attr}="${a.id}"]`);
    if (!tr) return; // different page / filter / tab: nothing to keep in place
    const delta = tr.getBoundingClientRect().top - a.top;
    if (delta !== 0) window.scrollBy({ top: delta, behavior: 'instant' });
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
          ? await this.#log.inspect(id).then((i) => {
              if (!i) return null;
              if (seq === this.#loadSeq) {
                this.#inspectedId = id;
                this.#inspectedSend = JSON.stringify(i.record.send ?? null);
              }
              return packetInspectorProps(i, (p) => this.app.contacts.resolvePath(p), this.app.clock.now());
            })
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

  #debouncedText(apply: () => void): void {
    clearTimeout(this.#textTimer);
    this.#textTimer = setTimeout(apply, 250);
  }

  async #export(): Promise<void> {
    try {
      const filtered = this.tab === 'packets' ? Object.keys(this.#log.packets.filter.peek()).length > 0 : Object.keys(this.#log.frames.filter.peek()).length > 0;
      const data = this.tab === 'packets' ? await this.#log.exportPackets({ filtered }) : await this.#log.exportFrames({ filtered });
      const text = JSON.stringify(data, jsonReplacer, 1);
      const stamp = new Date(this.app.clock.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
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
      ${this.tab === 'packets'
        ? html`<button
            data-action="map"
            aria-pressed=${this.showMap ? 'true' : 'false'}
            title="Map the paths of the newest packets listed"
            @click=${() => (this.showMap = !this.showMap)}
          >
            ${this.showMap ? 'Hide map' : 'Map'}
          </button>`
        : nothing}
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

  /** Path / hops: hex hashes, or node names with the "Show path as node names" setting (issue #3). */
  #pathCell(r: PacketRow): TemplateResult {
    if (r.hops === null) return html`<td class="mono" data-field="path">—</td>`;
    if (!r.path.length) return html`<td class="mono" data-field="path">${r.hops}</td>`;
    const hops = this.app.contacts.resolvePath(r.path);
    const names = this.app.appSettings.pathNames.value;
    return html`<td class="mono" data-field="path" title=${resolvedPathTitle(hops)}
      >${pathHops(hops, names ? { names, notes: this.#notes } : { names, sep: '→', notes: this.#notes })} ${hopsLink(`(${r.hops})`, { kind: 'packet', id: r.id })}</td
    >`;
  }

  /** Send outcome of a tx row (pending / sent / confirmed / failed / no ACK). */
  #sendMarker(r: PacketRow, now: number): TemplateResult | typeof nothing {
    const s = sendOutcomeLabel(r.record, now);
    if (!s) return nothing;
    return html` <span class="send send-${s.status}" data-send-status=${s.status} title=${s.title}>${s.text}</span>`;
  }

  #packetTable(rows: readonly PacketRow[]): TemplateResult {
    const sel = this.selected?.tab === 'packets' ? this.selected.id : null;
    // app clock: a DM still unconfirmed past the radio's estimated timeout shows "no ACK"
    const now = this.app.clock.now();
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
          ${repeat(rows, (r) => r.id, (r) => {
            const rec = r.record;
            return html`<tr
              data-packet-id=${r.id}
              data-type=${r.typeName}
              tabindex="0"
              aria-selected=${sel === r.id ? 'true' : 'false'}
              @click=${() => void this.#open('packets', r.id)}
              @keydown=${(e: KeyboardEvent) => this.#rowKey(e, 'packets', r.id)}
            >
              <td class="mono">${formatLogTime(rec.ts, this.app.clock.now())}</td>
              <td class="dir-${rec.direction}" data-dir=${rec.direction} title=${rec.direction === 'rx' ? 'received: heard by the radio' : 'sent: transmitted at this app\'s request'}>
                ${rec.direction === 'rx' ? '↓ rx' : '↑ tx'}${this.#sendMarker(r, now)}
              </td>
              <td>${r.typeName}</td>
              <td>${r.routeName || '—'}</td>
              ${this.#pathCell(r)}
              <td class="num">${rec.snr !== undefined ? `${rec.snr} dB` : '—'}${rec.rssi !== undefined ? ` / ${rec.rssi}` : ''}</td>
              ${rec.format === 'none'
                ? html`<td class="num muted" title="On-air bytes unknown: logged from the command sent to the radio">—</td>`
                : html`<td class="num">${rec.bytes.length}</td>`}
              <td class="summary" title=${r.summary}>${r.summary}</td>
            </tr>`;
          })}
        </tbody>
      </table>
      ${this.#moreSentinel(this.#log.packets.hasMore.value)}
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
          ${repeat(rows, (r) => r.id, (r) => {
            const rec = r.record;
            return html`<tr
              data-frame-id=${r.id}
              data-name=${r.name}
              tabindex="0"
              aria-selected=${sel === r.id ? 'true' : 'false'}
              @click=${() => void this.#open('frames', r.id)}
              @keydown=${(e: KeyboardEvent) => this.#rowKey(e, 'frames', r.id)}
            >
              <td class="mono">${formatLogTime(rec.ts, this.app.clock.now())}</td>
              <td class="dir-${rec.direction}" title=${rec.direction === 'out' ? 'host → device' : 'device → host'}>${rec.direction === 'out' ? '→ dev' : '← dev'}</td>
              <td><span class="mono">${rec.code >= 0 ? rec.code.toString(16).padStart(2, '0') : '--'}</span> ${r.name}</td>
              <td class="num">${rec.size}</td>
              <td class="summary" title=${r.summary}>${r.summary}</td>
            </tr>`;
          })}
        </tbody>
      </table>
      ${this.#moreSentinel(this.#log.frames.hasMore.value)}
      ${rows.length === 0 ? html`<p class="empty muted">No frames match.</p>` : nothing}
    </div>`;
  }

  /** End of the list: older rows load as it scrolls into view (see #watchSentinel). */
  #moreSentinel(hasMore: boolean): TemplateResult | typeof nothing {
    return hasMore ? html`<p class="more muted" data-load-more>Loading older…</p>` : nothing;
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
        <p><a href=${hrefFor('/')}>Connect a radio</a> to see its packet log and statistics.</p>
      </section>`;
    }
    const log = this.#log;
    const showFrames = this.app.appSettings.showFrames.value;
    // The inspector belongs to the tab its row came from: switching tabs hides it (and back shows it).
    const split = this.tab !== 'stats' && this.wide && this.selected !== null && this.selected.tab === this.tab;
    return html`
      <mc-packet-filters ?node-route=${!!this.params['key']} ?hidden=${this.tab === 'frames'}></mc-packet-filters>
      <div class="tabs" role="tablist" aria-label="Log">
        <button role="tab" data-tab="packets" aria-selected=${this.tab === 'packets' ? 'true' : 'false'} @click=${() => this.#setTab('packets')}>
          Packets <span class="muted">(${log.packets.total.value})</span>
        </button>
        <button role="tab" data-tab="stats" aria-selected=${this.tab === 'stats' ? 'true' : 'false'} @click=${() => this.#setTab('stats')}>Stats</button>
        ${showFrames
          ? html`<button role="tab" data-tab="frames" aria-selected=${this.tab === 'frames' ? 'true' : 'false'} @click=${() => this.#setTab('frames')}>
              Frames <span class="muted">(${log.frames.total.value})</span>
            </button>`
          : nothing}
      </div>
      ${this.tab === 'stats'
        ? html`<section role="tabpanel" aria-label="Packet statistics"><mc-packet-stats></mc-packet-stats></section>`
        : this.#listTab(split)}
    `;
  }

  #listTab(split: boolean): TemplateResult {
    const log = this.#log;
    return html`
      <div class="layout ${split ? 'split' : ''}">
        <section role="tabpanel" aria-label=${this.tab === 'packets' ? 'Over-the-air packets' : 'Host ↔ device frames'}>
          ${this.tab === 'frames' ? this.#frameFilters() : nothing} ${this.#toolbar()}
          ${this.tab === 'packets' && this.showMap ? html`<mc-packets-map></mc-packets-map>` : nothing}
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
      </div>`;
  }
}

customElements.define('mc-packets-page', McPacketsPage);

declare global {
  interface HTMLElementTagNameMap {
    'mc-packets-page': McPacketsPage;
  }
}
