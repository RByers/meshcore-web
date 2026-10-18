/**
 * `<mc-packet-filters>`: the filter area at the top of `/packets`, shared by the Packets and Stats
 * tabs (docs/packet-stats.md §3, §6). Renders the packet log's filter (`app.packetLog.packets.filter`):
 * the date range (`<mc-stats-range parts="range">`: presets and one From / To pair), direction,
 * types, route, node and text, removable chips for criteria with no control of their own (the
 * `/packets/node/:key` source and Stats drill-downs), and Reset, which clears everything.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { packetFilterChips, type PacketFilter } from '@meshcore-web/core/app';
import { PayloadType, RouteType, payloadTypeName } from '@meshcore-web/core/packet';
import { AppElement } from '../../app-context.js';
import { hrefFor } from '../../router.js';
import { shared } from '../../styles.js';
import { contactNote } from '../../components/node-link.js';
import { chipHook } from './packet-stats.js';
import '../../components/stats-range.js';

const PAYLOAD_TYPES = Object.values(PayloadType);
const ROUTE_TYPES = Object.entries(RouteType) as [string, number][];

export class McPacketFilters extends AppElement {
  static override properties = {
    nodeRoute: { type: Boolean, attribute: 'node-route' },
  };
  /** The page is on `/packets/node/:key`: clearing the source filter also leaves that route. */
  declare nodeRoute: boolean;
  #textTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.nodeRoute = false;
  }

  static override styles = [
    shared,
    css`
      :host {
        display: block;
      }
      :host([hidden]) {
        display: none;
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: end;
      }
      mc-stats-range {
        flex-basis: 100%;
      }
      label {
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
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        align-self: end;
        padding: 4px 4px 4px 10px;
        border: 1px solid var(--mc-accent);
        border-radius: 999px;
        background: var(--mc-accent-soft);
        font-size: 0.85rem;
      }
      .mono {
        font-family: var(--mc-mono);
      }
      .chip button {
        min-height: 0;
        padding: 0 6px;
        border: 0;
        background: none;
      }
    `,
  ];

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.#textTimer);
  }

  get #log() {
    return this.app.packetLog;
  }

  #set(patch: Partial<PacketFilter>): void {
    void this.#log.packets.setFilter(patch);
  }

  #debounced(apply: () => void): void {
    clearTimeout(this.#textTimer);
    this.#textTimer = setTimeout(apply, 250);
  }

  #toggleType(t: number, on: boolean): void {
    const cur = new Set(this.#log.packets.filter.peek().payloadTypes ?? []);
    if (on) cur.add(t);
    else cur.delete(t);
    this.#set({ payloadTypes: [...cur].sort((a, b) => a - b) });
  }

  #leaveNodeRoute(): void {
    if (this.nodeRoute) location.hash = hrefFor('/packets');
  }

  #chips(f: PacketFilter): TemplateResult {
    return html`${f.src
      ? html`<span class="chip" data-filter="src" data-chip="src" title=${`Packets originated by ${f.src}`}
          >From ${this.app.contacts.view(f.src)?.name ?? `${f.src.slice(0, 8)}…`}${contactNote(this.app.contacts.noteFor(f.src))}
          <button
            data-action="clear-src"
            aria-label="Show packets from every node"
            @click=${() => {
              void this.#log.packets.setFilter({ src: undefined });
              this.#leaveNodeRoute();
            }}
          >✕</button></span
        >`
      : nothing}
    ${packetFilterChips(f)
      .filter((c) => c.key.startsWith('drill-'))
      .map(
        // Stats drill-downs with no control of their own (§6)
        (c) => html`<span class="chip" data-filter=${c.key} data-chip=${chipHook(c.key)} title="Filter set from a Stats chart"
          >${c.label}
          <button data-action="remove-chip" data-remove-filter=${chipHook(c.key)} aria-label=${`Remove ${c.name} filter`} @click=${() => void this.#log.removeFilterChip(c.key)}>✕</button></span
        >`,
      )}`;
  }

  override render(): TemplateResult {
    const f = this.#log.packets.filter.value;
    const types = new Set(f.payloadTypes ?? []);
    return html`<div class="filters" role="search" aria-label="Packet filters" data-packet-filters>
      <mc-stats-range parts="range"></mc-stats-range>
      ${this.#chips(f)}
      <label
        >Direction
        <select data-filter="direction" @change=${(e: Event) => this.#set({ direction: ((e.target as HTMLSelectElement).value || undefined) as PacketFilter['direction'] })}>
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
          this.#set({ routeTypes: v === '' ? undefined : [Number(v)] });
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
            this.#debounced(() => this.#set({ node: v || undefined }));
          }} />
      </label>
      <label
        >Search
        <input type="search" data-filter="text" placeholder="text or hex" .value=${f.text ?? ''}
          @input=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            this.#debounced(() => this.#set({ text: v.trim() || undefined }));
          }} />
      </label>
      ${Object.keys(f).length
        ? html`<button
            data-action="clear-filters"
            @click=${() => {
              clearTimeout(this.#textTimer);
              void this.#log.packets.clearFilter();
              this.#leaveNodeRoute();
            }}
          >Reset</button>`
        : nothing}
    </div>`;
  }
}

customElements.define('mc-packet-filters', McPacketFilters);

declare global {
  interface HTMLElementTagNameMap {
    'mc-packet-filters': McPacketFilters;
  }
}
