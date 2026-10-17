/**
 * Clickable nodes in displayed paths: every hop that resolves to exactly one known contact links
 * to its contact page (`/contact/:key`). Ambiguous / unknown hops and this radio stay plain text.
 *
 * Test hooks: `a[data-node-link="<key>"]`, `[data-hop="<hash>"]` on every hop.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { PATH_SEPARATOR, type PathLabel, type PathRequest, type ResolvedHop } from '@meshcore-web/core/app';
import { toHex } from '@meshcore-web/core/util/bytes';
import { hrefFor } from '../router.js';
import { hopsLink, pathViewButton } from './path-dialog.js';

export function contactHref(key: string): string {
  return hrefFor(`/contact/${key}`);
}

/** Link clicks must not reach row handlers (packet rows open the inspector on click). */
const stop = (e: Event): void => e.stopPropagation();

/** `label` linking to the contact page of `key` (plain text without a key). */
export function nodeLink(label: string | TemplateResult, key: string | undefined, title?: string): TemplateResult {
  if (!key) return html`<span title=${title ?? nothing}>${label}</span>`;
  return html`<a class="node-link" href=${contactHref(key)} data-node-link=${key} title=${title ?? 'Contact details'} @click=${stop} @keydown=${stop}>${label}</a>`;
}

/** The contact key of a hop that resolves to exactly one known contact. */
export function hopKey(h: ResolvedHop): string | undefined {
  const only = h.candidates.length === 1 ? h.candidates[0] : undefined;
  return only ? toHex(only.pubKey) : undefined;
}

/**
 * The hops of a path, each linked to its contact where known. `names` shows resolved names
 * (else the hex hashes).
 */
export function pathHops(hops: readonly ResolvedHop[], opts: { names?: boolean; sep?: string } = {}): TemplateResult {
  const names = opts.names ?? true;
  const sep = opts.sep ?? PATH_SEPARATOR;
  return html`${hops.map(
    (h, i) => html`${i ? sep : ''}<span data-hop=${h.hash}>${nodeLink(names ? h.label : h.hash, hopKey(h), h.title)}</span>`,
  )}`;
}

/**
 * A displayed path label: the name chain with per-node links plus a small path-view button when
 * names are shown, else the clickable hop-count label (as before).
 */
export function pathLabelView(p: PathLabel, req: PathRequest | null): TemplateResult {
  if (!p.named) return hopsLink(p.label, req);
  return html`${pathHops(p.resolved)}${req ? pathViewButton(req) : nothing}`;
}
