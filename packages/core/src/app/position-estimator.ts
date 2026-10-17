/**
 * Approximate positions for nodes that never advertised a location (issue #7). A node is in
 * radio range of the first repeater that relayed its flood packets (mesh-packet-format.md §1.2:
 * every repeater appends its hash, so path[0] heard the source directly) and of the last hop of
 * the out_path we use to reach it. Following the issue author's follow-up ("position them
 * according to the most recent repeater we've seen them hop through, to account for the
 * possibility that they may be moving") the estimate is a point a short fixed distance from the
 * located repeater the node was MOST RECENTLY heard through, on a bearing derived from the
 * node's key and nudged so estimates fan out around a busy repeater instead of stacking on it
 * or on other markers.
 *
 * Pure functions (`packetEvidence`, `messageEvidence`, `outPathEvidence`, `estimatePositions`)
 * plus `PositionEstimatorModel` (`app.positions`), which feeds them from the store with a bounded
 * lookback while the "approximate positions" app setting is on.
 */

import { ContactType, PATH_LEN_UNKNOWN, decodePathLen } from '../protocol/constants.js';
import { PayloadType, RouteType, isFloodRoute } from '../packet/constants.js';
import { parsePacket } from '../packet/packet.js';
import { parseAdvertPayload } from '../packet/payloads.js';
import type { SelfInfo } from '../protocol/types.js';
import type { RadioStore } from '../store/radio-store.js';
import type { ContactRecord, MessageRecord, PacketRecord } from '../store/schema.js';
import { bytesEqual, toHex } from '../util/bytes.js';
import type { Clock } from '../util/clock.js';
import type { ConnectionModel } from './connection.js';
import type { ContactsModel } from './contacts-model.js';
import { destinationPoint, haversineMeters, hasLocation, type LatLon } from './geo.js';
import { resolveHop } from './path-resolver.js';
import { computed, effect, signal, untracked, type ReadonlySignal } from './signal.js';
import { StoreBoundModel } from './store-bound.js';

/** Where a sighting came from. */
export type EvidenceSource = 'packet' | 'message' | 'outPath';

/**
 * One sighting: `node` was within radio range of `via` at `ts`. The node is named by its full
 * key (adverts, ANON_REQ, DM conversations, contacts), its 1-byte src_hash (peer datagrams) or
 * the "sender:" name of a channel message; `via` is a hop hash or 'self' (heard by this radio
 * with a zero-hop path).
 */
export interface AdjacencyEvidence {
  /** Dedupe key ("p:<packet id>", "m:<message id>", "o:<contact key>"). */
  id: string;
  /** Epoch ms. */
  ts: number;
  source: EvidenceSource;
  node: { key: string } | { hash: Uint8Array } | { name: string };
  via: Uint8Array | 'self';
}

export interface PositionEstimate extends LatLon {
  /** The estimated contact's key. */
  key: string;
  /** The located repeater (or this radio) it was last heard through. */
  viaKey: string;
  viaName: string;
  /** Epoch ms of that sighting. */
  observedAt: number;
  source: EvidenceSource;
  approximate: true;
}

/** The contact fields the estimator needs. */
export type EstimatorContact = Pick<ContactRecord, 'key' | 'pubKey' | 'name' | 'type' | 'lat' | 'lon'>;

export interface EstimateOptions {
  contacts: readonly EstimatorContact[];
  evidence: readonly AdjacencyEvidence[];
  /** This radio: anchors zero-hop sightings when it has a location. */
  self?: (Pick<SelfInfo, 'pubKey' | 'name'> & LatLon) | null;
  /** Current time (epoch ms) for `maxAgeMs`. */
  now: number;
  /** Packet / message sightings older than this are ignored (default 7 days; out_paths never expire). */
  maxAgeMs?: number;
  /** Distance of an estimate from its repeater (default {@link ESTIMATE_DISTANCE_M}). */
  distanceM?: number;
}

/** Distance (m) between an estimate and the repeater it was heard through. */
export const ESTIMATE_DISTANCE_M = 400;
/** Default lookback for packet / message sightings. */
export const ESTIMATE_MAX_AGE_MS = 7 * 86_400_000;

/** FNV-1a of a string → a stable bearing in [0, 360). */
function keyBearing(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

function firstHash(path: Uint8Array, hashSize: number): Uint8Array | undefined {
  return path.length >= hashSize && hashSize > 0 ? path.slice(0, hashSize) : undefined;
}

/**
 * A received flood packet whose source is identifiable: ADVERT (public key, §3.5), ANON_REQ
 * (sender public key at payload[1..33], §3.8), REQ / RESPONSE / TXT_MSG / PATH (src_hash at
 * payload[1], §3.0). path[0] (or this radio for an empty path) heard the source directly.
 * Zero-hop direct-routed adverts count too (sent zero hop); other direct packets carry no
 * source-side hop. Null for anything else.
 */
export function packetEvidence(r: Pick<PacketRecord, 'id' | 'ts' | 'direction' | 'format' | 'bytes'>): AdjacencyEvidence | null {
  if (r.direction !== 'rx' || r.format !== 'packet') return null;
  let p;
  try {
    p = parsePacket(r.bytes);
  } catch {
    return null;
  }
  const flood = isFloodRoute(p.routeType);
  const zeroHopAdvert = p.payloadType === PayloadType.ADVERT && p.routeType === RouteType.DIRECT && p.pathHashCount === 0;
  if (!flood && !zeroHopAdvert) return null;
  let via: Uint8Array | 'self';
  if (p.pathHashCount === 0) via = 'self';
  else {
    const h = firstHash(p.path, p.pathHashSize);
    if (!h) return null;
    via = h;
  }
  let node: AdjacencyEvidence['node'];
  const pl = p.payload;
  switch (p.payloadType) {
    case PayloadType.ADVERT:
      try {
        node = { key: toHex(parseAdvertPayload(pl).publicKey) };
      } catch {
        return null;
      }
      break;
    case PayloadType.ANON_REQ:
      if (pl.length < 33) return null;
      node = { key: toHex(pl.subarray(1, 33)) };
      break;
    case PayloadType.REQ:
    case PayloadType.RESPONSE:
    case PayloadType.TXT_MSG:
    case PayloadType.PATH:
      if (pl.length < 2) return null;
      node = { hash: pl.slice(1, 2) };
      break;
    default:
      return null;
  }
  return { id: `p:${r.id}`, ts: r.ts, source: 'packet', node, via };
}

/**
 * An incoming message with a known flood path (`MessageRecord.path`, issue #3): DMs / room posts
 * name the conversation's contact, channel messages their "sender:" name. path_len 0 is a
 * zero-hop flood (heard by this radio); 0xFF (direct / unknown) yields nothing.
 */
export function messageEvidence(m: Pick<MessageRecord, 'id' | 'receivedAt' | 'direction' | 'convType' | 'convKey' | 'senderName' | 'pathLen' | 'path'>): AdjacencyEvidence | null {
  if (m.direction !== 'in') return null;
  const raw = m.pathLen & 0xff;
  if (raw === PATH_LEN_UNKNOWN) return null;
  let node: AdjacencyEvidence['node'];
  if (m.convType === 'contact') node = { key: m.convKey.toLowerCase() };
  else if (m.senderName) node = { name: m.senderName };
  else return null;
  const info = decodePathLen(raw);
  let via: Uint8Array | 'self';
  if (info.hops === 0) via = 'self';
  else {
    const h = m.path ? firstHash(m.path, info.hashSize) : undefined;
    if (!h) return null;
    via = h;
  }
  return { id: `m:${m.id}`, ts: m.receivedAt, source: 'message', node, via };
}

/**
 * A contact's stored out_path: its LAST hop delivers to the contact, so it is in range; an empty
 * (zero-hop) path means this radio reaches it directly. Timestamped with the path's `lastUsed`
 * in the path history (issue #6) when known, else the contact's lastmod.
 */
export function outPathEvidence(c: Pick<ContactRecord, 'key' | 'outPathLen' | 'outPath' | 'lastMod' | 'lastSeen' | 'pathHistory'>): AdjacencyEvidence | null {
  const raw = c.outPathLen & 0xff;
  if (raw === PATH_LEN_UNKNOWN) return null;
  const info = decodePathLen(raw);
  let via: Uint8Array | 'self';
  if (info.hops === 0) via = 'self';
  else {
    const bytes = c.outPath.subarray(0, info.byteLength);
    if (bytes.length < info.byteLength || info.hashSize < 1) return null;
    via = bytes.slice(bytes.length - info.hashSize);
  }
  const hist = c.pathHistory?.find((e) => e.pathLen === c.outPathLen && bytesEqual(e.path, c.outPath.subarray(0, info.byteLength)));
  const ts = hist?.lastUsed || (c.lastMod > 0 ? c.lastMod * 1000 : c.lastSeen);
  return { id: `o:${c.key}`, ts, source: 'outPath', node: { key: c.key }, via };
}

interface Anchor extends LatLon {
  key: string;
  name: string;
}

function forwards(c: EstimatorContact): boolean {
  return c.type === ContactType.REPEATER || c.type === ContactType.ROOM;
}

/**
 * Estimates a position for every contact without a location that has a sighting through a
 * located repeater / room server (or through this radio, when it has a location): the most
 * recent sighting wins. Ambiguous hashes (several contacts share the prefix) are ignored, both
 * for the node and for the repeater. Results are sorted by key and deterministic.
 */
export function estimatePositions(o: EstimateOptions): PositionEstimate[] {
  const { contacts, evidence } = o;
  const now = o.now;
  const maxAge = o.maxAgeMs ?? ESTIMATE_MAX_AGE_MS;
  const dist = o.distanceM ?? ESTIMATE_DISTANCE_M;
  const byKey = new Map(contacts.map((c) => [c.key.toLowerCase(), c]));
  const self = o.self && hasLocation(o.self) ? { key: toHex(o.self.pubKey), name: o.self.name || 'You', lat: o.self.lat, lon: o.self.lon } : null;

  // hop hashes repeat a lot (1-byte hashes: at most 256 values), so resolve each once
  const memo = new Map<string, EstimatorContact | undefined>();
  const unique = (hash: Uint8Array, endpoint: boolean): EstimatorContact | undefined => {
    const k = `${endpoint ? 'n' : 'v'}${toHex(hash)}`;
    if (memo.has(k)) return memo.get(k);
    const hop = resolveHop(hash, contacts, endpoint ? { preferForwarders: false } : {});
    const c = hop.ambiguous ? undefined : hop.candidates[0];
    memo.set(k, c);
    return c;
  };
  const target = (n: AdjacencyEvidence['node']): EstimatorContact | undefined => {
    let c: EstimatorContact | undefined;
    if ('key' in n) c = byKey.get(n.key.toLowerCase());
    else if ('hash' in n) c = unique(n.hash, true);
    else {
      const named = contacts.filter((x) => x.name === n.name);
      c = named.length === 1 ? named[0] : undefined;
    }
    return c && !hasLocation(c) ? c : undefined;
  };
  const anchor = (via: AdjacencyEvidence['via'], node: EstimatorContact): Anchor | undefined => {
    if (via === 'self') return self ?? undefined;
    const c = unique(via, false);
    if (!c || c.key === node.key || !forwards(c) || !hasLocation(c)) return undefined;
    return { key: c.key, name: c.name || c.key.slice(0, 12), lat: c.lat, lon: c.lon };
  };

  const best = new Map<string, { ev: AdjacencyEvidence; via: Anchor }>();
  for (const ev of evidence) {
    if (ev.source !== 'outPath' && now - ev.ts > maxAge) continue;
    const node = target(ev.node);
    if (!node) continue;
    const prev = best.get(node.key);
    if (prev && prev.ev.ts >= ev.ts) continue;
    const via = anchor(ev.via, node);
    if (via) best.set(node.key, { ev, via });
  }

  // placement: fixed distance from the anchor, bearing from the key, nudged away from other markers
  const occupied: LatLon[] = contacts.filter((c) => hasLocation(c)).map((c) => ({ lat: c.lat, lon: c.lon }));
  if (self) occupied.push(self);
  const minSep = dist * 0.6;
  const out: PositionEstimate[] = [];
  for (const key of [...best.keys()].sort()) {
    const { ev, via } = best.get(key)!;
    const base = keyBearing(key);
    let chosen: LatLon | undefined;
    let fallback: { p: LatLon; d: number } | undefined;
    search: for (let ring = 0; ring < 4; ring++) {
      const r = dist * (1 + ring * 0.6);
      for (let i = 0; i < 12; i++) {
        const p = destinationPoint(via, base + i * 30 + (ring % 2) * 15, r);
        let d = Infinity;
        for (const q of occupied) d = Math.min(d, haversineMeters(p, q));
        if (d >= minSep) {
          chosen = p;
          break search;
        }
        if (!fallback || d > fallback.d) fallback = { p, d };
      }
    }
    const p = chosen ?? fallback!.p;
    occupied.push(p);
    out.push({ key, lat: p.lat, lon: p.lon, viaKey: via.key, viaName: via.name, observedAt: ev.ts, source: ev.source, approximate: true });
  }
  return out;
}

export interface PositionEstimatorOptions {
  /** Time source for the lookback (default: the connection's clock). */
  clock?: Clock;
  /** Lookback for packets / messages (default 7 days). */
  maxAgeMs?: number;
  /** Most recent packets loaded from the log (default 500, plus up to as many adverts). */
  packetLimit?: number;
  /** Most recent messages loaded per DM / channel conversation (default 50). */
  messageLimit?: number;
}

/** Sightings kept in memory (oldest dropped first). */
const MAX_EVIDENCE = 3000;

/**
 * `app.positions`: estimated positions of contacts without a location while `enabled` (the
 * "approximate positions" app setting) is on; empty otherwise. Loads sightings from the last
 * `packetLimit` received packets / adverts and recent messages within the lookback when a store
 * opens or the setting is turned on, then follows new packets and messages incrementally. Stored
 * out_paths come straight from the contacts.
 */
export class PositionEstimatorModel extends StoreBoundModel {
  readonly #evidence = signal<ReadonlyMap<string, AdjacencyEvidence>>(new Map());
  readonly #enabled: ReadonlySignal<boolean>;
  readonly #clock: Clock;
  readonly #maxAgeMs: number;
  readonly #packetLimit: number;
  readonly #messageLimit: number;
  readonly #offEnabled: () => void;

  /** Estimates for contacts without a location (empty while the setting is off). */
  readonly estimates: ReadonlySignal<readonly PositionEstimate[]>;

  constructor(
    connection: ConnectionModel,
    contacts: ContactsModel,
    enabled: ReadonlySignal<boolean>,
    opts: PositionEstimatorOptions = {},
  ) {
    super(connection);
    this.#enabled = enabled;
    this.#clock = opts.clock ?? connection.clock;
    this.#maxAgeMs = opts.maxAgeMs ?? ESTIMATE_MAX_AGE_MS;
    this.#packetLimit = opts.packetLimit ?? 500;
    this.#messageLimit = opts.messageLimit ?? 50;
    this.estimates = computed(() => {
      if (!this.#enabled.value) return [];
      const list = contacts.contacts.value;
      const evidence = [...this.#evidence.value.values()];
      for (const c of list) {
        if (hasLocation(c)) continue;
        const e = outPathEvidence(c);
        if (e) evidence.push(e);
      }
      const si = connection.selfInfo.value;
      return estimatePositions({ contacts: list, evidence, self: si, now: this.#clock.now(), maxAgeMs: this.#maxAgeMs });
    });
    let first = true;
    this.#offEnabled = effect(() => {
      void this.#enabled.value;
      if (first) {
        first = false;
        return;
      }
      untracked(() => void this.reload());
    });
  }

  protected override bind(store: RadioStore) {
    const offs = [
      store.events.on('packet', (r) => {
        if (this.#enabled.peek()) this.#add([packetEvidence(r)]);
      }),
      store.events.on('message', (e) => {
        if (e.type !== 'delete' && this.#enabled.peek()) this.#add([messageEvidence(e.record)]);
      }),
      store.events.on('logChanged', (e) => {
        if (e.store === 'packets') void this.reload();
      }),
    ];
    return () => offs.forEach((off) => off());
  }

  #add(list: readonly (AdjacencyEvidence | null)[]): void {
    const items = list.filter((e): e is AdjacencyEvidence => e !== null);
    if (items.length === 0) return;
    const next = new Map(this.#evidence.peek());
    for (const e of items) {
      next.delete(e.id);
      next.set(e.id, e);
    }
    for (const k of next.keys()) {
      if (next.size <= MAX_EVIDENCE) break;
      next.delete(k);
    }
    this.#evidence.value = next;
  }

  protected async load(store: RadioStore): Promise<void> {
    if (!this.#enabled.peek()) {
      this.#evidence.value = new Map();
      return;
    }
    const from = this.#clock.now() - this.#maxAgeMs;
    const limit = this.#packetLimit;
    const [recent, adverts, contactList, channels] = await Promise.all([
      store.packets.query({ direction: 'rx', from, limit }),
      store.packets.query({ payloadType: PayloadType.ADVERT, direction: 'rx', from, limit }),
      store.contacts.list(),
      store.channels.list(),
    ]);
    const convKeys = [...contactList.filter((c) => !hasLocation({ lat: c.lat, lon: c.lon })).map((c) => c.key), ...channels.map((c) => c.key)];
    const pages = await Promise.all(convKeys.map((k) => store.messages.list(k, { limit: this.#messageLimit })));
    const ev = new Map<string, AdjacencyEvidence>();
    const put = (e: AdjacencyEvidence | null) => {
      if (e && e.ts >= from) ev.set(e.id, e);
    };
    for (const r of [...recent.items, ...adverts.items].sort((a, b) => a.ts - b.ts)) put(packetEvidence(r));
    for (const page of pages) for (const m of page.items) put(messageEvidence(m));
    this.#evidence.value = ev;
  }

  protected reset(): void {
    this.#evidence.value = new Map();
  }

  override dispose(): void {
    this.#offEnabled();
    super.dispose();
  }
}
