/**
 * Contact paths (issue #6): set a contact's out_path, remember every path used with its delivery
 * statistics, and list the repeaters a path can be built from. Mirrors MeshCore Open's routing
 * sheet / path history (lib/models/path_history.dart, lib/services/path_history_service.dart):
 *
 * - A path is remembered per contact (out_path_len byte + hop hashes, or flood). Each DM counts
 *   as one attempt for every distinct path it was sent over (retries that fall back to flood add
 *   a flood attempt). Delivery (SEND_CONFIRMED for one of the message's ACK codes) is a success
 *   for the path that ACK was sent on and a failure for the message's other paths; a final
 *   timeout is a failure for all of them. A late ACK turns that failure back into a success.
 * - Paths the device learns by itself (PATH_UPDATED, adverts) are added with 0/0 counts, like
 *   MeshCore Open's `handlePathUpdated`.
 * - History is stored locally on the contact record (`ContactRecord.pathHistory`), newest first,
 *   capped at {@link MAX_PATH_HISTORY} entries.
 *
 * Setting a path: flood → RESET_PATH (as MeshCore Open's `clearContactPath`); a hop list →
 * ADD_UPDATE_CONTACT with the contact's own type / flags / name / last_advert and the new
 * out_path_len / out_path (companion-protocol.md §4 CMD 9). The capture pipeline persists the
 * device's re-read record.
 */

import type { SendProgress } from '../client/types.js';
import { ContactType, PATH_LEN_UNKNOWN, decodePathLen, encodePathLen } from '../protocol/constants.js';
import type { RadioStore } from '../store/radio-store.js';
import type { ContactRecord, PathHistoryEntry, PathResult } from '../store/schema.js';
import { fromHex, toHex } from '../util/bytes.js';
import type { ConnectionModel } from './connection.js';
import type { ContactsModel } from './contacts-model.js';
import { hasLocation } from './geo.js';
import { contactTypeName, type ContactKind } from './messaging.js';
import { splitHops } from './remote-admin-model.js';
import { StoreBoundModel } from './store-bound.js';
import { computed, type ReadonlySignal } from './signal.js';

/** Remembered paths per contact (MeshCore Open keeps up to 100; a short list is enough here). */
export const MAX_PATH_HISTORY = 20;

/** Firmware MAX_PATH_SIZE: at most 64 path bytes. */
const MAX_PATH_BYTES = 64;

/** A path given by hop hashes (all the same size, 1..3 bytes) or 'flood'. */
export type PathInput = 'flood' | readonly Uint8Array[];

/** A repeater (or room server) a path hop can go through. */
export interface PathCandidate {
  key: string;
  name: string;
  kind: ContactKind;
  pubKey: Uint8Array;
  /** First bytes of the public key as hex (6 bytes). */
  prefix: string;
  lat: number;
  lon: number;
  hasLocation: boolean;
}

/** One hop of a path, with the candidates whose key starts with its hash. */
export interface ResolvedPathHop {
  hash: Uint8Array;
  hex: string;
  matches: readonly PathCandidate[];
  /** "Name", "A | B" when ambiguous, or the hex when unknown. */
  label: string;
}

export interface ResolvedPath {
  kind: 'flood' | 'direct' | 'hops';
  pathLen: number;
  hashSize: number;
  hops: readonly ResolvedPathHop[];
  /** "flood", "direct", or "Hilltop → 7f → …". */
  label: string;
}

export interface PathHistoryView extends ResolvedPath {
  /** Stable id: "flood" or "<pathLen>:<hex>". */
  id: string;
  entry: PathHistoryEntry;
  /** True when this is the contact's current out_path. */
  current: boolean;
}

/** Stable identity of a path. */
export function pathId(pathLen: number, path: Uint8Array): string {
  const b = pathLen & 0xff;
  if (b === PATH_LEN_UNKNOWN) return 'flood';
  return `${b}:${toHex(path.subarray(0, decodePathLen(b).byteLength))}`;
}

/** Encodes a hop list as (out_path_len, out_path). Throws on mixed sizes or > 64 bytes. */
export function encodeHops(hops: readonly Uint8Array[]): { pathLen: number; path: Uint8Array } {
  const size = hops[0]?.length ?? 1;
  if (hops.some((h) => h.length !== size)) throw new Error('All hops must use the same hash size');
  if (size < 1 || size > 3) throw new Error('Hop hashes are 1, 2 or 3 bytes');
  if (hops.length * size > MAX_PATH_BYTES) throw new Error(`A path is at most ${MAX_PATH_BYTES} bytes`);
  const path = new Uint8Array(hops.length * size);
  hops.forEach((h, i) => path.set(h, i * size));
  return { pathLen: encodePathLen(hops.length, size), path };
}

/** Repeaters and room servers (MeshCore Open's path editor offers both) as path candidates. */
export function pathCandidates(contacts: readonly ContactRecord[], exclude?: string): PathCandidate[] {
  return contacts
    .filter((c) => (c.type === ContactType.REPEATER || c.type === ContactType.ROOM) && c.key !== exclude)
    .map((c) => ({
      key: c.key,
      name: c.name || toHex(c.pubKey.subarray(0, 6)),
      kind: contactTypeName(c.type),
      pubKey: c.pubKey,
      prefix: toHex(c.pubKey.subarray(0, 6)),
      lat: c.lat,
      lon: c.lon,
      hasLocation: hasLocation(c),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key));
}

function startsWith(key: Uint8Array, hash: Uint8Array): boolean {
  if (hash.length === 0 || hash.length > key.length) return false;
  for (let i = 0; i < hash.length; i++) if (key[i] !== hash[i]) return false;
  return true;
}

/** Resolves an encoded path against the candidates (hop hash = public key prefix). */
export function resolvePathHops(pathLen: number, path: Uint8Array, candidates: readonly PathCandidate[]): ResolvedPath {
  const info = decodePathLen(pathLen);
  if (info.isFlood) return { kind: 'flood', pathLen: info.raw, hashSize: 0, hops: [], label: 'flood' };
  const hops = splitHops(path.subarray(0, info.byteLength), info.hashSize).map((hash): ResolvedPathHop => {
    const matches = candidates.filter((c) => startsWith(c.pubKey, hash));
    const hex = toHex(hash);
    return { hash, hex, matches, label: matches.length ? matches.map((m) => m.name).join(' | ') : hex };
  });
  if (hops.length === 0) return { kind: 'direct', pathLen: info.raw, hashSize: info.hashSize, hops, label: 'direct' };
  return { kind: 'hops', pathLen: info.raw, hashSize: info.hashSize, hops, label: hops.map((h) => h.label).join(' → ') };
}

/** Applies one change to a contact's history (pure; newest first, capped). */
export function updateHistory(
  history: readonly PathHistoryEntry[] | undefined,
  pathLen: number,
  path: Uint8Array,
  change: (e: PathHistoryEntry) => PathHistoryEntry,
  opts: { touch?: boolean; create?: boolean } = {},
): PathHistoryEntry[] {
  const id = pathId(pathLen, path);
  const list = [...(history ?? [])];
  const idx = list.findIndex((e) => pathId(e.pathLen, e.path) === id);
  const b = pathLen & 0xff;
  const base: PathHistoryEntry =
    idx >= 0
      ? list[idx]!
      : {
          pathLen: b,
          path: b === PATH_LEN_UNKNOWN ? new Uint8Array(0) : path.slice(0, decodePathLen(b).byteLength),
          attempts: 0,
          successes: 0,
          failures: 0,
          lastUsed: 0,
        };
  if (idx < 0 && opts.create === false) return list;
  const next = change(base);
  if (idx >= 0) list.splice(idx, 1);
  if (idx < 0 || opts.touch) list.unshift(next);
  else list.splice(idx, 0, next);
  return list.slice(0, MAX_PATH_HISTORY);
}

/** Per-message path accounting for one DM (fed by ChatModel's send progress). */
export interface DmPathTracker {
  progress(p: SendProgress): void;
}

/** What ChatModel needs to record DM path statistics. */
export interface DmPathRecorder {
  track(contactKey: string): DmPathTracker;
}

interface Used {
  pathLen: number;
  path: Uint8Array;
}

export class ContactPathsModel extends StoreBoundModel implements DmPathRecorder {
  #queue: Promise<unknown> = Promise.resolve();

  /** Repeaters / room servers known to us, by name. */
  readonly candidates: ReadonlySignal<readonly PathCandidate[]>;

  constructor(
    connection: ConnectionModel,
    private readonly contacts: ContactsModel,
  ) {
    super(connection);
    this.candidates = computed(() => pathCandidates(this.contacts.contacts.value));
  }

  protected override bind(store: RadioStore) {
    // paths the device learnt (PATH_UPDATED → re-read, adverts, syncs) join the history at 0/0
    return store.events.on('contact', (e) => {
      if (e.type !== 'put') return;
      const r = e.record;
      if ((r.outPathLen & 0xff) === PATH_LEN_UNKNOWN || !decodePathLen(r.outPathLen).valid) return;
      const id = pathId(r.outPathLen, r.outPath);
      if (r.pathHistory?.some((x) => pathId(x.pathLen, x.path) === id)) return;
      void this.#mutate(r.key, r.outPathLen, r.outPath, (x) => ({ ...x, observed: x.attempts === 0 ? true : x.observed, lastUsed: Date.now() }), { touch: true });
    });
  }

  protected async load(): Promise<void> {
    // state lives on the contact records (ContactsModel)
  }

  protected reset(): void {}

  /** Resolves when every queued history write has been stored and the contacts reloaded (tests). */
  async idle(): Promise<void> {
    let q: Promise<unknown>;
    do {
      q = this.#queue;
      await q;
    } while (q !== this.#queue);
    await this.contacts.settled();
  }

  /** Repeaters a path to `contactKey` can use (the contact itself excluded). Tracked. */
  candidatesFor(contactKey: string): readonly PathCandidate[] {
    const k = contactKey.toLowerCase();
    return this.candidates.value.filter((c) => c.key !== k);
  }

  /** The contact's current out_path, resolved. Tracked. */
  current(contactKey: string): ResolvedPath | undefined {
    const c = this.#contact(contactKey);
    return c ? resolvePathHops(c.outPathLen, c.outPath, this.candidates.value) : undefined;
  }

  /**
   * Remembered paths, most recently used first, resolved against the known repeaters. Tracked.
   */
  history(contactKey: string): readonly PathHistoryView[] {
    const c = this.#contact(contactKey);
    if (!c) return [];
    const cur = pathId(c.outPathLen, c.outPath);
    const cands = this.candidates.value;
    return [...(c.pathHistory ?? [])]
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .map((entry) => {
        const id = pathId(entry.pathLen, entry.path);
        return { ...resolvePathHops(entry.pathLen, entry.path, cands), id, entry, current: id === cur };
      });
  }

  /** Default hop hash size for new paths: the radio's path hash mode + 1 (v10+), else 1. */
  readonly defaultHashSize: ReadonlySignal<number> = computed(() => (this.connection.deviceInfo.value?.pathHashMode ?? 0) + 1);

  /**
   * Sets the path the radio uses for `contactKey`: 'flood' (RESET_PATH) or a hop list
   * (ADD_UPDATE_CONTACT with out_path). Resolves once the re-read record is stored.
   */
  async setPath(contactKey: string, path: PathInput): Promise<void> {
    const client = this.connection.client.peek();
    if (!client?.connected) throw new Error('Not connected');
    const key = fromHex(contactKey.toLowerCase());
    const c = client.findContact(key) ?? this.contacts.find(contactKey);
    if (!c) throw new Error('Unknown contact');
    let pathLen = PATH_LEN_UNKNOWN;
    let bytes: Uint8Array = new Uint8Array(0);
    if (path === 'flood') {
      await client.resetPath(c.pubKey);
    } else {
      ({ pathLen, path: bytes } = encodeHops(path));
      await client.addOrUpdateContact({
        pubKey: c.pubKey,
        type: c.type,
        flags: c.flags,
        outPathLen: pathLen,
        outPath: bytes,
        name: c.name,
        // the contact's own advert time, never our clock (the firmware uses it as a replay guard)
        lastAdvert: c.lastAdvert,
        lat: c.lat,
        lon: c.lon,
      });
    }
    await this.#mutate(contactKey, pathLen, bytes, (x) => ({ ...x, lastUsed: Date.now(), observed: false }), { touch: true });
    await this.connection.capture?.idle();
    await this.contacts.reload();
  }

  /** Forgets one remembered path. */
  async forget(contactKey: string, id: string): Promise<void> {
    const store = this.store;
    if (!store) throw new Error('Not connected');
    await this.#enqueue(async () => {
      const rec = await store.contacts.get(contactKey.toLowerCase());
      if (!rec?.pathHistory) return;
      await store.contacts.updateLocal(rec.key, { pathHistory: rec.pathHistory.filter((e) => pathId(e.pathLen, e.path) !== id) });
    });
  }

  /** Starts the path accounting of one outgoing DM. */
  track(contactKey: string): DmPathTracker {
    const key = contactKey.toLowerCase();
    const byAck = new Map<number, string>();
    const used = new Map<string, Used>();
    let lastId: string | undefined;
    let outcome: 'pending' | 'delivered' | 'failed' = 'pending';
    const now = (): number => this.connection.client.peek()?.clock.now() ?? Date.now();
    const record = (id: string, result: PathResult | 'attempt' | 'late', rtt?: number): void => {
      const u = used.get(id);
      if (!u) return;
      const t = now();
      void this.#mutate(
        key,
        u.pathLen,
        u.path,
        (x) => {
          if (result === 'attempt') return { ...x, attempts: x.attempts + 1, lastUsed: t };
          if (result === 'failure') return { ...x, failures: x.failures + 1, lastResult: 'failure' };
          const s: PathHistoryEntry = {
            ...x,
            successes: x.successes + 1,
            failures: result === 'late' ? Math.max(0, x.failures - 1) : x.failures,
            lastResult: 'success',
            lastSuccess: t,
          };
          if (rtt !== undefined) s.roundTripMs = rtt;
          return s;
        },
        { touch: result === 'attempt' },
      );
    };
    return {
      progress: (p) => {
        if (p.status === 'sent') {
          const c = this.connection.client.peek()?.findContact(fromHex(key));
          const flood = p.flood ?? (!c || (c.outPathLen & 0xff) === PATH_LEN_UNKNOWN);
          const u: Used = flood || !c ? { pathLen: PATH_LEN_UNKNOWN, path: new Uint8Array(0) } : { pathLen: c.outPathLen, path: c.outPath.slice() };
          const id = pathId(u.pathLen, u.path);
          if (p.ackCode !== undefined) byAck.set(p.ackCode, id);
          lastId = id;
          if (!used.has(id)) {
            used.set(id, u);
            record(id, 'attempt');
          }
        } else if (p.status === 'delivered') {
          if (outcome === 'delivered') return;
          const id = (p.ackCode !== undefined ? byAck.get(p.ackCode) : undefined) ?? lastId;
          if (id === undefined) return;
          if (outcome === 'failed') {
            record(id, 'late', p.roundTripMs);
          } else {
            record(id, 'success', p.roundTripMs);
            for (const other of used.keys()) if (other !== id) record(other, 'failure');
          }
          outcome = 'delivered';
        } else if (p.status === 'failed') {
          if (outcome !== 'pending') return;
          for (const id of used.keys()) record(id, 'failure');
          outcome = 'failed';
        }
      },
    };
  }

  #contact(contactKey: string): ContactRecord | undefined {
    const k = contactKey.toLowerCase();
    return this.contacts.contacts.value.find((c) => c.key === k);
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch((err: unknown) => this.onError(err));
    return run;
  }

  #mutate(
    contactKey: string,
    pathLen: number,
    path: Uint8Array,
    change: (e: PathHistoryEntry) => PathHistoryEntry,
    opts: { touch?: boolean } = {},
  ): Promise<void> {
    const store = this.store;
    if (!store) return Promise.resolve();
    return this.#enqueue(async () => {
      const rec = await store.contacts.get(contactKey.toLowerCase());
      if (!rec) return;
      await store.contacts.updateLocal(rec.key, { pathHistory: updateHistory(rec.pathHistory, pathLen, path, change, opts) });
    });
  }
}
