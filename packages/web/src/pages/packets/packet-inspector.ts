/**
 * `<mc-packet-inspector>`: byte-level view of one packet or frame.
 *
 * - metadata header (`meta` label/value pairs) and "Copy hex" / "Copy JSON" buttons;
 * - hex dump, 16 bytes per row with offsets and an ASCII column;
 * - the annotation tree (name, value, meaning; bit fields as bit diagrams; decrypted sections
 *   marked), and the annotator's errors.
 *
 * Hovering / focusing a tree node highlights its bytes (`.hl` on the cells); clicking selects it
 * (`.sel`). Hovering or clicking a byte targets the deepest annotation node covering it.
 * Data hooks: `[data-byte="<offset>"]` (hex cells), `[data-ascii="<offset>"]`,
 * `[data-node="<path>"]` / `[data-name]` (tree rows), `[data-action="copy-hex|copy-json"]`.
 */
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import type { Annotation, AnnotationNode } from '@meshcore-web/core/packet';
import { toHex } from '@meshcore-web/core/util/bytes';
import { shared } from '../../styles.js';

export interface InspectorMeta {
  label: string;
  value: string | TemplateResult;
}

interface Indexed {
  id: string;
  node: AnnotationNode;
  depth: number;
}

/** Flattens the tree into path ids ("0", "0.1", …) for lookups. */
function index(root: AnnotationNode): Map<string, Indexed> {
  const m = new Map<string, Indexed>();
  const walk = (n: AnnotationNode, id: string, depth: number): void => {
    m.set(id, { id, node: n, depth });
    (n.children ?? []).forEach((c, i) => walk(c, `${id}.${i}`, depth + 1));
  };
  walk(root, '0', 0);
  return m;
}

/** Deepest non-bit node covering byte `offset` (decrypted overlays count as deeper). */
export function deepestNodeAt(root: AnnotationNode, offset: number): string | null {
  let best: string | null = null;
  const walk = (n: AnnotationNode, id: string): void => {
    if (offset < n.offset || offset >= n.offset + n.length) return;
    best = id;
    // prefer decrypted children (they describe the plaintext of this range)
    const kids = (n.children ?? []).map((c, i) => [c, i] as const).filter(([c]) => !c.bits);
    const dec = kids.find(([c]) => c.decrypted && offset >= c.offset && offset < c.offset + c.length);
    const plain = kids.find(([c]) => !c.decrypted && offset >= c.offset && offset < c.offset + c.length);
    const next = dec ?? plain;
    if (next) walk(next[0], `${id}.${next[1]}`);
  };
  walk(root, '0');
  return best;
}

function printable(b: number): string {
  return b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·';
}

export class McPacketInspector extends LitElement {
  static override properties = {
    annotation: { attribute: false },
    bytes: { attribute: false },
    meta: { attribute: false },
    json: { attribute: false },
    heading: { type: String },
    hovered: { state: true },
    selected: { state: true },
    copied: { state: true },
  };
  declare annotation: Annotation | null;
  declare bytes: Uint8Array;
  declare meta: readonly InspectorMeta[];
  /** Object serialised by "Copy JSON". */
  declare json: unknown;
  declare heading: string;
  declare hovered: string | null;
  declare selected: string | null;
  declare copied: string;
  #index = new Map<string, Indexed>();

  constructor() {
    super();
    this.annotation = null;
    this.bytes = new Uint8Array(0);
    this.meta = [];
    this.json = null;
    this.heading = 'Inspector';
    this.hovered = null;
    this.selected = null;
    this.copied = '';
  }

  static override styles = [
    shared,
    css`
      :host {
        display: block;
        min-width: 0;
      }
      header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-block-end: 8px;
      }
      header h3 {
        margin: 0;
        flex: 1;
        font-size: 1rem;
      }
      dl.meta {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 2px 12px;
        margin: 0 0 12px;
        font-size: 0.875rem;
      }
      dl.meta dt {
        color: var(--mc-text-muted);
      }
      dl.meta dd {
        margin: 0;
        overflow-wrap: anywhere;
        font-family: var(--mc-mono);
      }
      .errors {
        border: 1px solid color-mix(in oklab, var(--mc-danger), transparent 50%);
        color: var(--mc-danger);
        border-radius: 8px;
        padding: 6px 10px;
        margin: 0 0 12px;
        font-size: 0.875rem;
      }
      .errors ul {
        margin: 0;
        padding-inline-start: 1.2em;
      }
      .hex {
        font-family: var(--mc-mono);
        font-size: 0.8125rem;
        line-height: 1.5;
        overflow-x: auto;
        background: var(--mc-surface-2);
        border-radius: 8px;
        padding: 8px;
        margin-block-end: 12px;
      }
      .row {
        display: flex;
        gap: 12px;
        white-space: pre;
      }
      .off {
        color: var(--mc-text-muted);
        user-select: none;
      }
      .bytes,
      .ascii {
        display: flex;
      }
      .bytes span {
        width: 2.6ch;
        text-align: center;
        cursor: pointer;
        border-radius: 3px;
      }
      .bytes span:nth-child(8) {
        margin-inline-end: 0.8ch;
      }
      .ascii span {
        width: 1ch;
        text-align: center;
        cursor: pointer;
      }
      .bytes span.hl,
      .ascii span.hl {
        background: color-mix(in oklab, var(--mc-accent), transparent 65%);
      }
      .bytes span.sel,
      .ascii span.sel {
        background: var(--mc-accent);
        color: var(--mc-accent-text);
      }
      .bytes span.dec {
        text-decoration: underline dotted var(--mc-ok);
      }
      ul.tree,
      ul.tree ul {
        list-style: none;
        margin: 0;
        padding-inline-start: 1.1em;
      }
      ul.tree {
        padding: 0;
        font-size: 0.875rem;
      }
      .node {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 2px 8px;
        padding: 2px 6px;
        border-radius: 6px;
        cursor: pointer;
        border-inline-start: 3px solid transparent;
      }
      .node:hover,
      .node.hl {
        background: var(--mc-accent-soft);
      }
      .node.sel {
        outline: 2px solid var(--mc-accent);
        outline-offset: -2px;
      }
      .node.decrypted {
        border-inline-start-color: var(--mc-ok);
        background: color-mix(in oklab, var(--mc-ok), transparent 90%);
      }
      .node .name {
        font-weight: 600;
      }
      .node .range {
        color: var(--mc-text-muted);
        font-family: var(--mc-mono);
        font-size: 0.75rem;
      }
      .node .value {
        font-family: var(--mc-mono);
        overflow-wrap: anywhere;
        min-width: 0;
      }
      .node .meaning {
        color: var(--mc-text-muted);
        flex-basis: 100%;
        padding-inline-start: 0.5em;
      }
      .badge {
        font-size: 0.7rem;
        padding: 0 6px;
        border-radius: 999px;
        background: var(--mc-ok);
        color: var(--mc-surface);
      }
      .bitdiagram {
        display: inline-flex;
        font-family: var(--mc-mono);
        font-size: 0.75rem;
        border: 1px solid var(--mc-border);
        border-radius: 4px;
        overflow: hidden;
      }
      .bitdiagram span {
        width: 1.6ch;
        text-align: center;
        color: var(--mc-text-muted);
        border-inline-end: 1px solid var(--mc-border);
      }
      .bitdiagram span:last-child {
        border-inline-end: 0;
      }
      .bitdiagram span.on {
        background: var(--mc-accent-soft);
        color: var(--mc-text);
        font-weight: 700;
      }
      .copied {
        font-size: 0.8rem;
        color: var(--mc-ok);
      }
    `,
  ];

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('annotation')) {
      this.#index = this.annotation ? index(this.annotation) : new Map();
      this.hovered = null;
      this.selected = null;
    }
  }

  /** Byte range of a node id. */
  #range(id: string | null): [number, number] | null {
    if (!id) return null;
    const e = this.#index.get(id);
    return e ? [e.node.offset, e.node.offset + e.node.length] : null;
  }

  /** Selects the deepest node covering `offset` (as a click on that byte does). */
  selectByte(offset: number): void {
    if (this.annotation) this.selected = deepestNodeAt(this.annotation, offset);
  }

  selectNode(id: string | null): void {
    this.selected = id;
  }

  async #copy(what: 'hex' | 'json'): Promise<void> {
    const text = what === 'hex' ? toHex(this.bytes) : JSON.stringify(this.json, jsonReplacer, 2);
    try {
      await navigator.clipboard.writeText(text);
      this.copied = what === 'hex' ? 'Hex copied' : 'JSON copied';
    } catch {
      this.copied = 'Copy failed';
    }
    this.dispatchEvent(new CustomEvent('mc-copy', { detail: { what, text }, bubbles: true, composed: true }));
  }

  #hexDump(): TemplateResult {
    const b = this.bytes;
    const hl = this.#range(this.hovered);
    const sel = this.#range(this.selected);
    const decrypted = new Set<number>();
    for (const e of this.#index.values()) {
      if (e.node.decrypted && !e.node.bits) for (let i = e.node.offset; i < e.node.offset + e.node.length; i++) decrypted.add(i);
    }
    const cls = (i: number): string => {
      const c: string[] = [];
      if (sel && i >= sel[0] && i < sel[1]) c.push('sel');
      else if (hl && i >= hl[0] && i < hl[1]) c.push('hl');
      if (decrypted.has(i)) c.push('dec');
      return c.join(' ');
    };
    const rows: TemplateResult[] = [];
    for (let r = 0; r < b.length; r += 16) {
      const idx = Array.from({ length: Math.min(16, b.length - r) }, (_, k) => r + k);
      rows.push(html`<div class="row">
        <span class="off">${r.toString(16).padStart(4, '0')}</span>
        <span class="bytes">${idx.map(
          (i) => html`<span data-byte=${i} class=${cls(i)} @mouseenter=${() => this.#hoverByte(i)} @click=${() => this.selectByte(i)}
            >${b[i]!.toString(16).padStart(2, '0')}</span
          >`,
        )}</span>
        <span class="ascii" aria-hidden="true">${idx.map(
          (i) => html`<span data-ascii=${i} class=${cls(i)} @mouseenter=${() => this.#hoverByte(i)} @click=${() => this.selectByte(i)}
            >${printable(b[i]!)}</span
          >`,
        )}</span>
      </div>`);
    }
    return html`<div class="hex" role="group" aria-label="Hex dump" @mouseleave=${() => (this.hovered = null)}>${rows}</div>`;
  }

  #hoverByte(i: number): void {
    if (this.annotation) this.hovered = deepestNodeAt(this.annotation, i);
  }

  #bits(parent: AnnotationNode, n: AnnotationNode): TemplateResult {
    const mask = n.bits?.mask ?? 0;
    // A decrypted parent's plaintext byte is not in `bytes` (those are the ciphertext): use the
    // parent's "0x.." value, or failing that rebuild the bits from this field's value.
    let byte = this.bytes[parent.offset] ?? 0;
    if (parent.decrypted) {
      const hex = /^0x([0-9a-f]{2})$/i.exec(parent.value.trim());
      const shift = mask ? 31 - Math.clz32(mask & -mask) : 0;
      byte = hex ? parseInt(hex[1]!, 16) : ((Number.parseInt(n.value, 10) || 0) << shift) & mask;
    }
    return html`<span class="bitdiagram" aria-label=${`bits ${mask.toString(2).padStart(8, '0')}`}>${[7, 6, 5, 4, 3, 2, 1, 0].map(
      (bit) => html`<span class=${mask & (1 << bit) ? 'on' : ''}>${mask & (1 << bit) ? (byte >> bit) & 1 : '·'}</span>`,
    )}</span>`;
  }

  #node(n: AnnotationNode, id: string, parent: AnnotationNode | null): TemplateResult {
    const isSel = this.selected === id;
    const isHl = !isSel && this.hovered === id;
    const kids = n.children ?? [];
    const range = n.bits ? `bits ${n.bits.mask.toString(2).padStart(8, '0')}` : n.length === 1 ? `[${n.offset}]` : `[${n.offset}..${n.offset + n.length - 1}]`;
    return html`<li role="treeitem" aria-selected=${isSel ? 'true' : 'false'} aria-expanded=${kids.length ? 'true' : nothing}>
      <div
        class="node ${isSel ? 'sel' : ''} ${isHl ? 'hl' : ''} ${n.decrypted ? 'decrypted' : ''}"
        data-node=${id}
        data-name=${n.name}
        tabindex="0"
        @mouseenter=${() => (this.hovered = id)}
        @mouseleave=${() => (this.hovered = this.hovered === id ? null : this.hovered)}
        @focus=${() => (this.hovered = id)}
        @click=${(e: Event) => {
          e.stopPropagation();
          this.selected = isSel ? null : id;
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.selected = isSel ? null : id;
          }
        }}
      >
        <span class="name">${n.name}</span>
        <span class="range">${range}</span>
        ${n.bits && parent ? this.#bits(parent, n) : nothing}
        <span class="value">${n.value}</span>
        ${n.decrypted ? html`<span class="badge" title="decrypted plaintext">decrypted</span>` : nothing}
        ${n.meaning ? html`<span class="meaning">${n.meaning}</span>` : nothing}
      </div>
      ${kids.length ? html`<ul role="group">${kids.map((c, i) => this.#node(c, `${id}.${i}`, n))}</ul>` : nothing}
    </li>`;
  }

  override render() {
    const a = this.annotation;
    return html`
      <header>
        <h3>${this.heading}</h3>
        <span class="copied" role="status">${this.copied}</span>
        <button data-action="copy-hex" @click=${() => void this.#copy('hex')}>Copy hex</button>
        <button data-action="copy-json" @click=${() => void this.#copy('json')}>Copy JSON</button>
      </header>
      ${this.meta.length
        ? html`<dl class="meta">${this.meta.map((m) => html`<dt>${m.label}</dt><dd data-meta=${m.label}>${m.value}</dd>`)}</dl>`
        : nothing}
      ${a && a.errors.length
        ? html`<div class="errors" role="note" data-field="errors">
            <strong>Problems</strong>
            <ul>${a.errors.map((e) => html`<li>${e}</li>`)}</ul>
          </div>`
        : nothing}
      ${this.#hexDump()}
      ${a ? html`<ul class="tree" role="tree" aria-label="Fields">${this.#node(a, '0', null)}</ul>` : nothing}
    `;
  }
}

/** JSON.stringify replacer: bytes as hex. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array ? toHex(value) : value;
}

customElements.define('mc-packet-inspector', McPacketInspector);

declare global {
  interface HTMLElementTagNameMap {
    'mc-packet-inspector': McPacketInspector;
  }
}
