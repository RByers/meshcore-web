/**
 * Regions (flood scopes, mesh-packet-format.md §1.2): the saved list of known region names
 * (global, in the PreferencesStore), fetched from one repeater at a time with the anon regions
 * request (§3.8), their transport keys for matching TRANSPORT_FLOOD codes, and the radio's default scope.
 *
 * Region names are stored without the '#'; the public region key is SHA256("#name")[0..16].
 * Per-channel scope lives on `ChannelRecord.region` (see `ChatModel.setRegion`).
 */

import type { CompanionClient } from '../client/companion-client.js';
import type { Contact } from '../protocol/types.js';
import { sha256Sync } from '../emulator/crypto-sync.js';
import { matchRegionCode, type RegionKeys } from '../packet/regions.js';
import { concatBytes, fromHex, utf8Decode, utf8Encode } from '../util/bytes.js';
import type { ConnectionModel, PreferencesStore } from './connection.js';
import type { FloodScopeView } from './device-settings-model.js';
import { computed, effect, signal, untracked, type ReadonlySignal, type Signal } from './signal.js';

export const PREF_REGIONS = 'meshcore-web.regions';

/** `ChannelRecord.region` sentinel: send to this channel as a plain (unscoped) flood (firmware v12+). */
export const UNSCOPED_REGION = '!unscoped';

/**
 * A channel's scope choice: a region name (no '#'), {@link UNSCOPED_REGION}, or undefined (the
 * radio's default scope applies).
 */
export type ChannelRegion = string | undefined;

/** `ANON_REQ_TYPE_REGIONS` (simple_repeater/MyMesh.cpp). §3.8 */
export const ANON_REQ_REGIONS = 0x01;

/** Region names are at most 30 UTF-8 bytes (`RegionEntry.name[31]`, `default_scope_name[31]`). */
export const MAX_REGION_NAME_BYTES = 30;

/** Trims and drops a leading '#'. */
export function normalizeRegionName(name: string): string {
  return name.trim().replace(/^#/, '');
}

/** An error message for an invalid (normalised) region name, or null when it is valid. */
export function validateRegionName(name: string): string | null {
  if (!name) return 'Region name is empty';
  if (utf8Encode(name).length > MAX_REGION_NAME_BYTES) return `Region name must be at most ${MAX_REGION_NAME_BYTES} bytes`;
  if (!/^[a-z0-9-]+$/.test(name)) return 'Region name may only use lowercase letters, digits and "-"';
  return null;
}

/** Public region key SHA256("#name")[0..16], synchronously (`regionKey` in packet/packet). §1.2 */
export function regionKeySync(name: string): Uint8Array {
  return sha256Sync(utf8Encode(`#${normalizeRegionName(name)}`)).slice(0, 16);
}

/**
 * Parses the BINARY_RESPONSE data of an anon regions request: `[now u32][ASCII "a,b,*"]`
 * (the tag is already stripped; `RegionMap::exportNamesTo`, names without '#'). Drops the
 * wildcard '*', empty entries and names we cannot use (private '$…', invalid characters).
 */
export function parseRegionsReply(data: Uint8Array): string[] {
  if (data.length <= 4) return [];
  const out: string[] = [];
  for (const raw of utf8Decode(data.subarray(4), true).split(',')) {
    const n = normalizeRegionName(raw);
    if (n && validateRegionName(n) === null && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Request data for the anon regions request: `[0x01][reply_path_len][reply_path]`. §3.8 */
export function regionsRequestData(replyPathLen: number, replyPath: Uint8Array = new Uint8Array(0)): Uint8Array {
  return concatBytes(Uint8Array.of(ANON_REQ_REGIONS, replyPathLen & 0xff), replyPath);
}

/** Reverses a path's hops (each `hashSize` bytes), for the reply path. */
export function reverseHops(path: Uint8Array, hashSize: number): Uint8Array {
  const w = Math.max(1, hashSize);
  if (path.length % w !== 0) return path.slice().reverse();
  const out = new Uint8Array(path.length);
  const hops = path.length / w;
  for (let i = 0; i < hops; i++) out.set(path.subarray((hops - 1 - i) * w, (hops - i) * w), i * w);
  return out;
}

function loadNames(prefs: PreferencesStore): string[] {
  try {
    const v: unknown = JSON.parse(prefs.getItem(PREF_REGIONS) ?? '[]');
    if (!Array.isArray(v)) return [];
    return sortNames(v.filter((x): x is string => typeof x === 'string').map(normalizeRegionName).filter((n) => validateRegionName(n) === null));
  } catch {
    return [];
  }
}

function sortNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

export interface RadioDefaultRegion {
  name: string;
  key: Uint8Array;
}

export interface FetchRegionsOptions {
  signal?: AbortSignal;
  /** Overrides the request timeout (est_timeout + the client's grace). */
  timeoutMs?: number;
}

export interface RegionsModelDeps {
  preferences: PreferencesStore;
  /** The repeaters to ask come from these contacts (AppModel passes `app.contacts.contacts`). */
  contacts: ReadonlySignal<readonly Contact[]>;
  /** The radio's default flood scope (AppModel passes `app.deviceSettings.defaultFloodScope`). */
  defaultScope?: ReadonlySignal<FloodScopeView | null | undefined>;
  /** Reads the radio's default scope into `defaultScope`; called on connect while it is unknown. */
  loadDefaultScope?: () => Promise<void>;
  /**
   * Keeps the temporary zero-hop path of a fetch out of the contact's path history (AppModel
   * passes `app.contactPaths`).
   */
  pathHistory?: { ignorePath(contactKey: string, pathLen: number, path: Uint8Array): () => void };
}

export class RegionsModel {
  readonly #prefs: PreferencesStore;
  readonly #names: Signal<readonly string[]>;
  readonly #deps: RegionsModelDeps;
  readonly #offs: Array<() => void> = [];

  /** Saved region names (no '#'), sorted, deduplicated. */
  readonly names: ReadonlySignal<readonly string[]>;

  /** The radio's default flood scope (name without '#'); null = none; undefined = not known (yet). */
  readonly radioDefault: ReadonlySignal<RadioDefaultRegion | null | undefined>;

  /**
   * Name → 16-byte transport key for every region we can recognise: the saved names (public
   * hashtag keys) plus the radio's default scope with the key the radio stores.
   */
  readonly keys: ReadonlySignal<RegionKeys>;

  constructor(
    private readonly connection: ConnectionModel,
    deps: RegionsModelDeps,
  ) {
    this.#deps = deps;
    this.#prefs = deps.preferences;
    this.#names = signal<readonly string[]>(loadNames(this.#prefs));
    this.names = this.#names.readonly;
    this.radioDefault = computed(() => {
      const v = deps.defaultScope?.value;
      if (v === undefined || v === null) return v;
      return { name: normalizeRegionName(v.name), key: fromHex(v.keyHex) };
    });
    this.keys = computed(() => {
      const m = new Map<string, Uint8Array>();
      for (const n of this.#names.value) m.set(n, regionKeySync(n));
      const def = this.radioDefault.value;
      if (def && def.name) m.set(def.name, def.key);
      return m;
    });
    if (deps.loadDefaultScope) {
      const load = deps.loadDefaultScope;
      // once per connection; untracked: the request's synchronous frame handlers must not
      // become dependencies of this effect
      let loadedFor: CompanionClient | null = null;
      this.#offs.push(
        effect(() => {
          if (!this.connection.connected.value) return;
          const client = this.connection.client.value;
          if (!client || client === loadedFor) return;
          loadedFor = client;
          untracked(() => {
            if (deps.defaultScope?.peek() === undefined) void load();
          });
        }),
      );
    }
  }

  dispose(): void {
    for (const off of this.#offs.splice(0)) off();
  }

  #save(names: readonly string[]): void {
    this.#names.value = names;
    this.#prefs.setItem(PREF_REGIONS, JSON.stringify(names));
  }

  /** The transport key for `name`: the radio's own key for its default scope, else the public key. */
  keyFor(name: string): Uint8Array {
    const n = normalizeRegionName(name);
    return this.keys.peek().get(n) ?? regionKeySync(n);
  }

  /** Adds a region name ('#' optional). Throws on an invalid name; false when already saved. */
  add(name: string): boolean {
    const n = normalizeRegionName(name);
    const err = validateRegionName(n);
    if (err) throw new Error(err);
    const cur = this.#names.peek();
    if (cur.includes(n)) return false;
    this.#save(sortNames([...cur, n]));
    return true;
  }

  /** Adds every valid name not saved yet; returns how many were new. Invalid names are skipped. */
  addAll(names: readonly string[]): number {
    const cur = this.#names.peek();
    const fresh = [...new Set(names.map(normalizeRegionName))].filter((n) => validateRegionName(n) === null && !cur.includes(n));
    if (fresh.length) this.#save(sortNames([...cur, ...fresh]));
    return fresh.length;
  }

  /**
   * Removes a saved name. Channels of the connected radio that were scoped to it go back to the
   * radio default.
   */
  async remove(name: string): Promise<void> {
    const n = normalizeRegionName(name);
    const cur = this.#names.peek();
    if (cur.includes(n)) this.#save(cur.filter((x) => x !== n));
    const store = this.connection.store.peek();
    if (!store) return;
    for (const ch of await store.channels.list()) if (ch.region === n) await store.channels.update(ch.key, { region: null });
  }

  /**
   * The saved region whose key gives transport code `code` for this packet, or null when none
   * or more than one does (ambiguous).
   */
  resolveCode(code: number, payloadType: number, payload: Uint8Array): string | null {
    return matchRegionCode(this.keys.peek(), code, payloadType, payload);
  }

  #client(): CompanionClient {
    const c = this.connection.client.peek();
    if (!c?.connected) throw new Error('Not connected');
    return c;
  }

  /**
   * Asks one repeater for its regions (anon request 0x01; repeaters answer it only when it
   * arrives direct-routed). A repeater with a known path is asked along it (reply path = the
   * reversed hops); one without is asked zero-hop by setting its path to direct for the request
   * and resetting it afterwards. Resolves with the usable names (not added to the list); rejects
   * on timeout / abort.
   */
  async fetchFromRepeater(pubKeyHex: string, opts: FetchRegionsOptions = {}): Promise<string[]> {
    const client = this.#client();
    opts.signal?.throwIfAborted();
    const pubKey = fromHex(pubKeyHex.toLowerCase());
    const c = client.findContact(pubKey);
    if (!c) throw new Error('Unknown contact');
    const unknownPath = c.outPathInfo.isFlood;
    const data = unknownPath ? regionsRequestData(0) : regionsRequestData(c.outPathLen, reverseHops(c.outPath, c.outPathInfo.hashSize));
    const release = unknownPath ? this.#deps.pathHistory?.ignorePath(pubKeyHex, 0, new Uint8Array(0)) : undefined;
    try {
      if (unknownPath) {
        await client.addOrUpdateContact({
          pubKey: c.pubKey,
          type: c.type,
          flags: c.flags,
          outPathLen: 0,
          outPath: new Uint8Array(0),
          name: c.name,
          lastAdvert: c.lastAdvert,
          lat: c.lat,
          lon: c.lon,
        });
        opts.signal?.throwIfAborted();
      }
      const req = client.anonRequest(c.pubKey, data, opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {});
      return parseRegionsReply(await abortable(req, opts.signal));
    } finally {
      if (unknownPath) {
        if (client.connected) await client.resetPath(c.pubKey).catch(() => undefined);
        // the zero-hop and restored records are stored by the capture pipeline
        await this.connection.capture?.idle().catch(() => undefined);
        release?.();
      }
    }
  }
}

function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

