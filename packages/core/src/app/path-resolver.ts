/**
 * Resolves the hop hashes of a packet path to known contacts (issue #3, reused by the path
 * visualisation). A path is the concatenation of the 1..3-byte hashes (pubkey prefixes) of the
 * repeaters a flood packet passed through, oldest first (mesh-packet-format.md §1.2); a hash is
 * ambiguous when several known contacts share that prefix. Only repeaters and room servers
 * forward packets, so when a hash matches one of those the chat / sensor matches are ignored.
 */

import { ContactType, PATH_LEN_UNKNOWN, decodePathLen } from '../protocol/constants.js';
import { fromHex, toHex } from '../util/bytes.js';
import type { ContactRecord } from '../store/schema.js';

/** The contact fields path resolution needs. */
export type PathContact = Pick<ContactRecord, 'pubKey' | 'name' | 'type'>;

export interface ResolvedHop<C extends PathContact = PathContact> {
  /** Hop hash as lowercase hex ("a3", or "a3b4" for 2-byte hashes). */
  hash: string;
  /** Contacts this hash may be (repeaters / rooms preferred), in name order. */
  candidates: readonly C[];
  /** The single matching contact's name; undefined when unknown or ambiguous. */
  name?: string;
  /** More than one candidate. */
  ambiguous: boolean;
  /** Display text: the name, the hex hash ("a3") when unknown, "a3?" when ambiguous. */
  label: string;
  /** Tooltip: "a3: Alice" / "a3: unknown node" / "a3: Alice, Bob (ambiguous)". */
  title: string;
}

export interface ResolvePathOptions {
  /** Bytes per hop hash for a `Uint8Array` / `number[]` path (default 1). */
  hashSize?: number;
  /** This radio: a hash matching it resolves to `self.name` (default "You"). */
  self?: { pubKey: Uint8Array; name?: string };
}

/** Splits concatenated path bytes into hop hashes of `hashSize` bytes (a trailing partial hash is dropped). */
export function splitPathHashes(path: Uint8Array, hashSize = 1): Uint8Array[] {
  const s = Math.max(1, Math.floor(hashSize));
  const out: Uint8Array[] = [];
  for (let i = 0; i + s <= path.length; i += s) out.push(path.slice(i, i + s));
  return out;
}

function startsWith(key: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length === 0 || prefix.length > key.length) return false;
  for (let i = 0; i < prefix.length; i++) if (key[i] !== prefix[i]) return false;
  return true;
}

function forwards(c: PathContact): boolean {
  return c.type === ContactType.REPEATER || c.type === ContactType.ROOM;
}

function displayName(c: PathContact): string {
  return c.name || toHex(c.pubKey.subarray(0, 6));
}

export interface ResolveHopOptions extends Pick<ResolvePathOptions, 'self'> {
  /**
   * Prefer repeaters / room servers when any match (default true: only they forward packets).
   * False for hashes that name an endpoint (e.g. a payload's src / dest hash).
   */
  preferForwarders?: boolean;
}

/**
 * Resolves one hop hash. Generic so callers can pass richer contact objects and get the same
 * objects back as candidates (the path view, path-geometry.ts).
 */
export function resolveHop<C extends PathContact>(hash: Uint8Array, contacts: readonly C[], opts: ResolveHopOptions = {}): ResolvedHop<C> {
  const hex = toHex(hash);
  const self = opts.self;
  if (self && startsWith(self.pubKey, hash)) {
    const name = self.name || 'You';
    return { hash: hex, candidates: [], name, ambiguous: false, label: name, title: `${hex}: ${name}` };
  }
  const matches = contacts.filter((c) => startsWith(c.pubKey, hash));
  const fwd = opts.preferForwarders === false ? [] : matches.filter(forwards);
  const candidates = (fwd.length ? fwd : matches).slice().sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' }));
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only) {
    const name = displayName(only);
    return { hash: hex, candidates, name, ambiguous: false, label: name, title: `${hex}: ${name}` };
  }
  if (candidates.length === 0) return { hash: hex, candidates, ambiguous: false, label: hex, title: `${hex}: unknown node` };
  return { hash: hex, candidates, ambiguous: true, label: `${hex}?`, title: `${hex}: ${candidates.map(displayName).join(', ')} (ambiguous)` };
}

/**
 * Resolves every hop of a path. `hashes` is either the raw path bytes (`Uint8Array` or byte
 * values, split by `opts.hashSize`) or a list of per-hop hashes (bytes or hex strings, as the
 * packet log rows hold them).
 */
export function resolvePath(
  hashes: Uint8Array | readonly number[] | readonly (string | Uint8Array)[],
  contacts: readonly PathContact[],
  opts: ResolvePathOptions = {},
): ResolvedHop[] {
  let list: Uint8Array[];
  if (hashes instanceof Uint8Array) list = splitPathHashes(hashes, opts.hashSize);
  else if (hashes.length > 0 && typeof hashes[0] === 'number') list = splitPathHashes(Uint8Array.from(hashes as readonly number[]), opts.hashSize);
  else list = (hashes as readonly (string | Uint8Array)[]).map((h) => (typeof h === 'string' ? fromHex(h) : h));
  return list.map((h) => resolveHop(h, contacts, opts));
}

/** Path separator used for name chains. */
export const PATH_SEPARATOR = ' > ';

/** "Alice > a3 > Bob?" */
export function formatResolvedPath(hops: readonly ResolvedHop[], sep = PATH_SEPARATOR): string {
  return hops.map((h) => h.label).join(sep);
}

/** Tooltip for a whole path: one "hash: name" line per hop. */
export function resolvedPathTitle(hops: readonly ResolvedHop[]): string {
  return hops.map((h) => h.title).join('\n');
}

export interface PathLabel {
  /** Hop count; null when the path length is unknown (direct-routed message, no known path). */
  hops: number | null;
  /** Resolved hops when the path bytes are known (empty otherwise). */
  resolved: ResolvedHop[];
  /** "Alice > Bob" (names on, path known) or the hop-count label. */
  label: string;
  /** True when `label` is the name chain of `resolved` (false: the hop-count label). */
  named: boolean;
  /** Per-hop tooltip (empty without path bytes). */
  title: string;
}

/**
 * The label for a path given its encoded path_len and (optionally) its bytes. With `names` and
 * known bytes the hops are rendered as a name chain; otherwise `countLabel` (e.g. "2 hops") is
 * used. 0 hops never becomes a chain.
 */
export function pathLabel(
  o: { pathLen: number; path?: Uint8Array | undefined; countLabel: string },
  contacts: readonly PathContact[],
  opts: { names: boolean; self?: ResolvePathOptions['self'] },
): PathLabel {
  const b = o.pathLen & 0xff;
  if (b === PATH_LEN_UNKNOWN) return { hops: null, resolved: [], label: o.countLabel, title: '', named: false };
  const info = decodePathLen(b);
  const bytes = o.path && o.path.length >= info.byteLength ? o.path.subarray(0, info.byteLength) : undefined;
  const resolved = bytes && info.hops > 0 ? resolvePath(bytes, contacts, { hashSize: info.hashSize, ...(opts.self ? { self: opts.self } : {}) }) : [];
  const title = resolvedPathTitle(resolved);
  if (opts.names && resolved.length > 0) return { hops: info.hops, resolved, label: formatResolvedPath(resolved), title, named: true };
  return { hops: info.hops, resolved, label: o.countLabel, title, named: false };
}
