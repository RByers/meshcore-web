/**
 * Clickable nodes in displayed paths: every hop that resolves to exactly one known contact links
 * to its node page (`/node/:key`); ambiguous / unknown hops link to the node page of the bare hash
 * (`/node/<hash>`: candidates, or what the packet log heard). This radio stays plain text.
 *
 * Test hooks: `a[data-node-link="<key>"]`, `a[data-hash-link="<hash>"]`, `[data-hop="<hash>"]` on every hop.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { PATH_SEPARATOR, type NodeTab, type PathLabel, type PathRequest, type ResolvedHop } from '@meshcore-web/core/app';
import { toHex } from '@meshcore-web/core/util/bytes';
import { hrefFor } from '../router.js';
import { hopsLink, pathViewButton } from './path-dialog.js';

/** The node page of `key` (a full key, a prefix or a hop hash); Info unless `tab` says otherwise. */
export function nodeHref(key: string, tab?: NodeTab): string {
  return hrefFor(tab && tab !== 'info' ? `/node/${key}/${tab}` : `/node/${key}`);
}

/**
 * A contact's local note after its name: smaller, muted text (`.contact-note` in `shared` styles).
 * Nothing when there's no note. Test hook: `[data-field="contact-note"]`.
 */
export function contactNote(note: string | undefined): TemplateResult | typeof nothing {
  return note ? html`<span class="contact-note" data-field="contact-note">${note}</span>` : nothing;
}

/** Link clicks must not reach row handlers (packet rows open the inspector on click). */
const stop = (e: Event): void => e.stopPropagation();

/** `label` linking to the node page of `key` (plain text without a key). */
export function nodeLink(label: string | TemplateResult, key: string | undefined, title?: string): TemplateResult {
  if (!key) return html`<span title=${title ?? nothing}>${label}</span>`;
  return html`<a class="node-link" href=${nodeHref(key)} data-node-link=${key} title=${title ?? 'Node details'} @click=${stop} @keydown=${stop}>${label}</a>`;
}

/** `label` linking to the node page of an unresolved / ambiguous hop hash. */
export function hashLink(label: string | TemplateResult, hash: string, title?: string): TemplateResult {
  return html`<a class="node-link" href=${nodeHref(hash)} data-hash-link=${hash} title=${title ?? 'Nodes with this hash'} @click=${stop} @keydown=${stop}>${label}</a>`;
}

/** The contact key of a hop that resolves to exactly one known contact. */
export function hopKey(h: ResolvedHop): string | undefined {
  const only = h.candidates.length === 1 ? h.candidates[0] : undefined;
  return only ? toHex(only.pubKey) : undefined;
}

/** Looks up a contact's local note by key ('' when none), e.g. `(k) => app.contacts.noteFor(k)`. */
export type NoteLookup = (key: string) => string;

/** A hop's tooltip, with the linked contact's note appended when it has one. */
function hopTitle(h: ResolvedHop, key: string | undefined, notes: NoteLookup | undefined): string {
  const note = key && notes ? notes(key) : '';
  return note ? `${h.title} (${note})` : h.title;
}

/**
 * The hops of a path, each linked to its contact where known. `names` shows resolved names
 * (else the hex hashes). Chains stay compact: a contact's note (`notes`) goes in the hop's tooltip.
 */
export function pathHops(hops: readonly ResolvedHop[], opts: { names?: boolean; sep?: string; notes?: NoteLookup } = {}): TemplateResult {
  const names = opts.names ?? true;
  const sep = opts.sep ?? PATH_SEPARATOR;
  return html`${hops.map((h, i) => {
    const key = hopKey(h);
    const label = names ? h.label : h.hash;
    const title = hopTitle(h, key, opts.notes);
    // this radio resolves with no candidates but a name: plain text
    const self = !key && h.candidates.length === 0 && h.name !== undefined;
    return html`${i ? sep : ''}<span data-hop=${h.hash}>${key || self ? nodeLink(label, key, title) : hashLink(label, h.hash, title)}</span>`;
  })}`;
}

/**
 * A displayed path label: the name chain with per-node links plus a small path-view button when
 * names are shown, else the clickable hop-count label (as before). `notes` adds hop notes to tooltips.
 */
export function pathLabelView(p: PathLabel, req: PathRequest | null, notes?: NoteLookup): TemplateResult {
  if (!p.named) return hopsLink(p.label, req);
  return html`${pathHops(p.resolved, notes ? { notes } : {})}${req ? pathViewButton(req) : nothing}`;
}
