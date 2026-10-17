/**
 * Packet log statistics (the "Stats" tab of /packets, docs/packet-stats.md §1): loads every logged
 * over-the-air packet in a date range, derives one compact {@link StatPacket} per record (who sent
 * it, last hop, distance, airtime…) and aggregates them for charts.
 *
 * Derivation is two-stage so it stays cheap for thousands of packets:
 * 1. async, once per record while loading / live-tailing: the structural view (`viewPacket`) and,
 *    for GRP_TXT with a known channel PSK, the decrypted `"sender: text"` sender name;
 * 2. sync, in a `computed`: attribution against the contacts / this radio (`resolveHop`), distance
 *    and airtime. Cached per record and recomputed only when contacts, SELF_INFO or the channel
 *    list change.
 *
 * Packet layouts: docs/mesh-packet-format.md §1 (envelope, path oldest → newest forwarder), §3
 * (payloads). Names and channel PSKs come from `PacketLogModel.context`.
 */

import { decodePathLen, isValidPathLen } from '../protocol/constants.js';
import type { SelfInfo } from '../protocol/types.js';
import { PayloadType, hasTransportCodes } from '../packet/constants.js';
import { decryptPayload, parseGrpTxtPlaintext } from '../packet/payloads.js';
import type { RadioStore } from '../store/radio-store.js';
import type { ContactRecord, PacketRecord } from '../store/schema.js';
import { fromHex, toHex } from '../util/bytes.js';
import { loraAirtimeMs, loraParamsFromSelfInfo, type LoraParams } from './airtime.js';
import type { ConnectionModel } from './connection.js';
import { haversineMeters, hasLocation, type LatLon } from './geo.js';
import { viewPacket, type PacketView, type SummaryContext } from './packet-summary.js';
import { resolveHop } from './path-resolver.js';
import { batch, computed, effect, signal, untracked, type ReadonlySignal } from './signal.js';
import { StoreBoundModel } from './store-bound.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Epoch ms, inclusive; null = unbounded. */
export interface StatsRange {
  from: number | null;
  to: number | null;
}

/** A node a packet is attributed to (source / last hop). */
export interface NodeRef {
  /** 1-byte (or longer) hash hex, or the public key / prefix the packet carried ('' for a channel sender known only by name). */
  hash: string;
  /** Full public key hex when uniquely resolved to a contact or to this radio. */
  key?: string;
  /** Display label: contact name, this radio's name, the advertised name, or the hex ('a3?' when ambiguous, per resolveHop). */
  label: string;
  /** True when resolved uniquely to a contact / this radio. */
  resolved: boolean;
  /** True when the node is this radio. */
  self?: boolean;
}

export type TrafficCategory = 'dm' | 'channel' | 'advert' | 'ack' | 'trace' | 'path' | 'control' | 'other';
export type StatDirection = 'in' | 'out';

export interface StatPacket {
  /** PacketRecord.id (the UI links to /packets/:id). */
  id: number;
  ts: number;
  direction: StatDirection;
  /**
   * On-air size: the record's bytes for a full packet; for a payload-only record the payload
   * plus the envelope it implies (header, path_len, path, transport codes); 0 when unknown
   * (a requested transmission the firmware builds itself).
   */
  bytes: number;
  /** -1 unknown. */
  payloadType: number;
  /** 'TXT_MSG', … 'UNKNOWN'. */
  typeName: string;
  /** -1 unknown. */
  routeType: number;
  /** '' unknown. */
  routeName: string;
  /** Path entry count (TRACE: SNR entry count), null when unknown. */
  hops: number | null;
  snr: number | null;
  rssi: number | null;
  category: TrafficCategory;
  /** GRP_TXT / GRP_DATA: the channel name when the hash matches a known channel, else `channel xx`. */
  channel: string | null;
  /** Who originated the packet (best effort, docs/packet-stats.md §1.3); null when unattributable. */
  source: NodeRef | null;
  /** The last forwarder; the source when heard directly; null when unknown. */
  lastHop: NodeRef | null;
  /** The path is empty (heard straight from the source). */
  direct: boolean;
  /** Every path entry resolved (forwarders preferred), oldest forwarder first; [] when direct / TRACE / unknown. */
  path: readonly NodeRef[];
  /** Hop hashes joined with '>' ('' = direct): the identity of a path. */
  pathKey: string;
  /** Metres from this radio to the source (or the earliest located hop); null when unknown. */
  distanceM: number | null;
  /** Estimated time on air at the radio's current LoRa parameters; null when unknown. */
  airtimeMs: number | null;
}

export interface StatsSummary {
  packets: number;
  bytes: number;
  /** Sum of the known airtimes; null when the radio parameters are unknown. */
  airtimeMs: number | null;
  /** airtimeMs / spanMs (capped at 1); null when either is unknown / zero. */
  airtimeFraction: number | null;
  /** Unique sources (resolved and unresolved). */
  sources: number;
  /** Length of the statistics window (see {@link PacketStatsModel.window}); 0 when empty. */
  spanMs: number;
}

export interface SourceCount {
  node: NodeRef;
  count: number;
  bytes: number;
  airtimeMs: number;
}

export interface SourceStats {
  /** Top {@link TOP_SOURCES} sources, count desc. */
  top: SourceCount[];
  /** Packets without a source. */
  unattributed: number;
  /** Nodes beyond the top list. */
  others: number;
  /** Packets from those nodes. */
  othersPackets: number;
}

export interface TimelineBin {
  /** Bin start, epoch ms. */
  t: number;
  /** Packet count per series name (every series present, 0 when none). */
  series: Record<string, number>;
}

export interface Timeline {
  binMs: number;
  bins: TimelineBin[];
  /**
   * The non-empty series by packet count desc, {@link SERIES_OTHER} last: one per known channel, then
   * {@link SERIES_UNKNOWN_CHANNELS}, {@link SERIES_DMS}, {@link SERIES_ADVERTS}, {@link SERIES_ACKS},
   * {@link SERIES_PATHS}, {@link SERIES_TRACES}, {@link SERIES_REQUESTS}, {@link SERIES_CONTROL}.
   */
  series: string[];
}

export interface Breakdown {
  name: string;
  count: number;
  bytes: number;
  airtimeMs: number;
}

export interface Utilization {
  /** Same bins as the timeline. `fraction` = airtime / bin length. */
  overTime: { t: number; airtimeMs: number; fraction: number }[];
  /** By payload type name. All breakdowns are sorted by airtime, then count, desc. */
  byType: Breakdown[];
  /** By route type name ('unknown' when not known). */
  byRoute: Breakdown[];
  /** 'in' / 'out'. */
  byDirection: Breakdown[];
  byCategory: Breakdown[];
  /** Channel traffic only. */
  byChannel: Breakdown[];
}

export interface HopCount {
  hops: number;
  count: number;
}

export type BinSetting = number | 'auto';

/** A packet field the stats can be drilled down by (docs/packet-stats.md §6). */
export type StatsFilterField = 'source' | 'type' | 'route' | 'direction' | 'category' | 'channel' | 'hops';

/**
 * One drill-down filter. `value` is the key the aggregations produce for the field: source →
 * `nodeId(source)` ('' = unattributed), type → typeName, route → routeName ('unknown' when
 * not known), direction → 'in' / 'out', category, channel → channel name (channel packets only),
 * hops → `String(hops)`. `label` is the caller's display text (chips).
 */
export interface StatsFilter {
  field: StatsFilterField;
  value: string;
  label: string;
}

/** The packet's key for a filter field; null when the packet has none (never matches). */
export function filterKey(p: StatPacket, field: StatsFilterField): string | null {
  switch (field) {
    case 'source':
      return p.source ? nodeId(p.source) : '';
    case 'type':
      return p.typeName;
    case 'route':
      return p.routeName || 'unknown';
    case 'direction':
      return p.direction;
    case 'category':
      return p.category;
    case 'channel':
      return p.category === 'channel' ? p.channel : null;
    case 'hops':
      return p.hops === null ? null : String(p.hops);
  }
}

export function matchesFilter(p: StatPacket, f: StatsFilter): boolean {
  return filterKey(p, f.field) === f.value;
}

/** The points matching every filter (AND); the same array when there are none. */
export function filterPoints(points: readonly StatPacket[], filters: readonly StatsFilter[]): readonly StatPacket[] {
  if (filters.length === 0) return points;
  return points.filter((p) => filters.every((f) => matchesFilter(p, f)));
}

/** One distinct path a contact's packets arrived over. */
export interface ContactPathStats {
  /** '' = direct. */
  pathKey: string;
  hops: readonly NodeRef[];
  count: number;
  lastTs: number;
  meanSnr: number | null;
  /** count / packets from the contact. */
  share: number;
}

/** Per-contact statistics for the contact page's Stats tab (docs/packet-stats.md §5). */
export interface ContactStats {
  /** Packets whose source is the contact. */
  from: readonly StatPacket[];
  /** Packets the contact forwarded for someone else (it is in the path, the source is not the contact). */
  via: readonly StatPacket[];
  /** Packets *from* the contact per bin (same bins as the global timeline). */
  timeline: Timeline;
  /** Count desc. */
  paths: ContactPathStats[];
  /** `from`, ascending ts. */
  signal: { ts: number; snr: number | null; rssi: number | null; hops: number | null; pathKey: string; id: number }[];
  hops: HopCount[];
}

export const SERIES_DMS = 'DMs';
export const SERIES_ADVERTS = 'Adverts';
export const SERIES_ACKS = 'ACKs';
export const SERIES_PATHS = 'Paths';
export const SERIES_TRACES = 'Traces';
/** REQ / RESPONSE / ANON_REQ (logins, status, telemetry, …). */
export const SERIES_REQUESTS = 'Requests';
export const SERIES_CONTROL = 'Control';
/** GRP_TXT / GRP_DATA whose channel hash matches no known channel. */
export const SERIES_UNKNOWN_CHANNELS = 'Unknown channels';
/** MULTIPART, RAW_CUSTOM and unknown payload types. */
export const SERIES_OTHER = 'Other';
/** Size of {@link SourceStats.top}. */
export const TOP_SOURCES = 50;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Round bin steps, 1 min … 1 day. */
export const BIN_STEPS: readonly number[] = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];
/** The automatic bin size gives at most this many bins (and ≥ 60 except for short spans). */
export const MAX_AUTO_BINS = 150;
/** A manual bin size giving more bins than this falls back to the automatic one. */
export const MAX_BINS = 2000;

/** The smallest round step giving at most {@link MAX_AUTO_BINS} bins over `spanMs` (1 day at most). */
export function autoBinMs(spanMs: number): number {
  for (const s of BIN_STEPS) if (Math.floor(Math.max(0, spanMs) / s) + 1 <= MAX_AUTO_BINS) return s;
  return DAY;
}

/** Category of a payload type. */
export function trafficCategory(payloadType: number): TrafficCategory {
  switch (payloadType) {
    case PayloadType.TXT_MSG:
      return 'dm';
    case PayloadType.GRP_TXT:
    case PayloadType.GRP_DATA:
      return 'channel';
    case PayloadType.ADVERT:
      return 'advert';
    case PayloadType.ACK:
      return 'ack';
    case PayloadType.TRACE:
      return 'trace';
    case PayloadType.PATH:
      return 'path';
    case PayloadType.CONTROL:
      return 'control';
    default:
      return 'other';
  }
}

/** Stable identity of a node reference (for grouping / colouring): the key when resolved, else hash or label. */
export function nodeId(n: NodeRef): string {
  if (n.key) return n.key;
  return n.hash ? `#${n.hash}` : `@${n.label}`;
}

/** On-air size of a record (see {@link StatPacket.bytes}). */
export function onAirBytes(rec: Pick<PacketRecord, 'format' | 'bytes' | 'pathLen' | 'routeType'>): number {
  if (rec.format === 'packet') return rec.bytes.length;
  if (rec.format === 'none') return 0;
  const path = rec.pathLen >= 0 && isValidPathLen(rec.pathLen) ? decodePathLen(rec.pathLen).byteLength : 0;
  return 2 + (hasTransportCodes(rec.routeType) ? 4 : 0) + path + rec.bytes.length;
}

// ---------------------------------------------------------------------------
// Stage 1: per-record async derivation
// ---------------------------------------------------------------------------

interface RawPoint {
  rec: PacketRecord;
  view: PacketView;
  /** GRP_TXT: the channel whose PSK decrypted it. */
  channel?: string;
  /** GRP_TXT: "sender" of the decrypted "sender: text". */
  sender?: string;
}

type Channels = SummaryContext['channels'];

function channelsSignature(chs: Channels): string {
  return chs.map((c) => `${c.hash}:${c.name}:${toHex(c.psk)}`).join('|');
}

async function derive(rec: PacketRecord, channels: Channels): Promise<RawPoint> {
  const view = viewPacket(rec);
  const raw: RawPoint = { rec, view };
  const p = view.payload;
  if (p?.kind !== 'grpTxt') return raw;
  for (const ch of channels) {
    if (ch.hash !== p.channelHash) continue;
    let pt: Uint8Array | null = null;
    try {
      pt = await decryptPayload(p, ch.psk);
    } catch {
      pt = null;
    }
    if (!pt) continue;
    raw.channel = ch.name;
    try {
      const s = parseGrpTxtPlaintext(pt).senderName;
      if (s) raw.sender = s;
    } catch {
      // decrypted but malformed: the channel is still known
    }
    break;
  }
  return raw;
}

function compareRaw(a: RawPoint, b: RawPoint): number {
  return a.rec.ts - b.rec.ts || a.rec.id - b.rec.id;
}

// ---------------------------------------------------------------------------
// Stage 2: attribution (sync)
// ---------------------------------------------------------------------------

interface SelfNode extends LatLon {
  key: string;
  pubKey: Uint8Array;
  name: string;
}

interface HopMatch {
  ref: NodeRef;
  contact?: ContactRecord;
}

/** Contact lookups for one (contacts, self) snapshot, with per-hash memoisation. */
class Resolver {
  readonly #byFirst = new Map<number, ContactRecord[]>();
  readonly #byKey = new Map<string, ContactRecord>();
  readonly #byName = new Map<string, ContactRecord[]>();
  readonly #memo = new Map<string, HopMatch>();
  readonly selfRef: NodeRef | null;

  constructor(
    contacts: readonly ContactRecord[],
    readonly self: SelfNode | null,
  ) {
    for (const c of contacts) {
      const first = c.pubKey[0];
      if (first !== undefined) {
        const l = this.#byFirst.get(first);
        if (l) l.push(c);
        else this.#byFirst.set(first, [c]);
      }
      this.#byKey.set(c.key.toLowerCase(), c);
      if (c.name) {
        const n = this.#byName.get(c.name);
        if (n) n.push(c);
        else this.#byName.set(c.name, [c]);
      }
    }
    this.selfRef = self ? { hash: self.key.slice(0, 2), key: self.key, label: self.name, resolved: true, self: true } : null;
  }

  /** A 1..3-byte hop / src hash. Forwarders (repeaters / rooms) are preferred for path hops. */
  hop(hashHex: string, preferForwarders: boolean): HopMatch {
    const memoKey = `${preferForwarders ? 'f' : 'e'}${hashHex}`;
    const hit = this.#memo.get(memoKey);
    if (hit) return hit;
    let out: HopMatch;
    try {
      const hash = fromHex(hashHex);
      const subset = this.#byFirst.get(hash[0] ?? -1) ?? [];
      const self = this.self ? { pubKey: this.self.pubKey, name: this.self.name } : undefined;
      const r = resolveHop(hash, subset, { preferForwarders, ...(self ? { self } : {}) });
      const only = r.candidates.length === 1 ? r.candidates[0] : undefined;
      if (only) out = { ref: { hash: r.hash, key: only.key, label: r.label, resolved: true }, contact: only };
      else if (r.candidates.length === 0 && r.name !== undefined && this.selfRef) out = { ref: { ...this.selfRef, hash: r.hash } };
      else out = { ref: { hash: r.hash, label: r.label, resolved: false } };
    } catch {
      out = { ref: { hash: hashHex, label: hashHex, resolved: false } };
    }
    this.#memo.set(memoKey, out);
    return out;
  }

  /** A full public key (adverts, ANON_REQ). */
  key(keyHex: string, fallbackLabel: string): HopMatch {
    const k = keyHex.toLowerCase();
    if (this.self && this.selfRef && this.self.key === k) return { ref: { ...this.selfRef, hash: k } };
    const c = this.#byKey.get(k);
    if (c) return { ref: { hash: k, key: c.key, label: c.name || fallbackLabel, resolved: true }, contact: c };
    return { ref: { hash: k, label: fallbackLabel, resolved: false } };
  }

  /** A channel sender name: a contact (or this radio) with exactly that name. */
  name(name: string): HopMatch {
    const cs = this.#byName.get(name) ?? [];
    const selfMatch = this.self !== null && this.self.name === name;
    if (cs.length === 1 && !selfMatch) {
      const c = cs[0]!;
      return { ref: { hash: c.key.slice(0, 2), key: c.key, label: name, resolved: true }, contact: c };
    }
    if (cs.length === 0 && selfMatch && this.selfRef) return { ref: this.selfRef };
    return { ref: { hash: '', label: name, resolved: false } };
  }
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function toStat(raw: RawPoint, R: Resolver, channels: Channels, radio: LoraParams | null): StatPacket {
  const { rec, view } = raw;
  const p = view.payload;
  const direction: StatDirection = rec.direction === 'tx' ? 'out' : 'in';
  const bytes = onAirBytes(rec);
  const payloadType = rec.payloadType;

  let channel: string | null = null;
  if (p && (p.kind === 'grpTxt' || p.kind === 'grpData')) {
    const names = channels.filter((c) => c.hash === p.channelHash).map((c) => c.name);
    channel = raw.channel ?? (names.length ? names.join('|') : `channel ${hex2(p.channelHash)}`);
  }

  let src: HopMatch | null = null;
  let advertPos: LatLon | null = null;
  if (direction === 'out') {
    src = R.selfRef ? { ref: R.selfRef } : null;
  } else if (p) {
    switch (p.kind) {
      case 'advert': {
        const key = toHex(p.publicKey);
        src = R.key(key, p.app.name || `${key.slice(0, 8)}…`);
        const pos = { lat: p.app.latitude ?? 0, lon: p.app.longitude ?? 0 };
        if (hasLocation(pos)) advertPos = pos;
        break;
      }
      case 'txtMsg':
      case 'req':
      case 'response':
      case 'path':
        src = R.hop(hex2(p.srcHash), false);
        break;
      case 'anonReq': {
        const key = toHex(p.senderPublicKey);
        src = R.key(key, `${key.slice(0, 8)}…`);
        break;
      }
      case 'grpTxt':
        src = raw.sender !== undefined ? R.name(raw.sender) : null;
        break;
      default:
        src = null;
    }
  }
  const source = src?.ref ?? null;

  const isTrace = payloadType === PayloadType.TRACE;
  const direct = !isTrace && view.hops === 0;
  const path = isTrace ? [] : view.path.map((h) => R.hop(h, true).ref);
  const lastEntry = path[path.length - 1];
  const lastHop = isTrace ? null : (lastEntry ?? (direct ? source : null));

  let distanceM: number | null = null;
  const self = R.self;
  if (direction === 'in' && self && hasLocation(self)) {
    let at: LatLon | null = advertPos ?? (src?.contact && hasLocation(src.contact) ? src.contact : null);
    if (!at) {
      for (const h of view.path) {
        const c = R.hop(h, true).contact;
        if (c && hasLocation(c)) {
          at = c;
          break;
        }
      }
    }
    if (at) distanceM = haversineMeters(self, at);
  }

  return {
    id: rec.id,
    ts: rec.ts,
    direction,
    bytes,
    payloadType,
    typeName: view.typeName,
    routeType: rec.routeType,
    routeName: view.routeName,
    hops: view.hops,
    snr: rec.snr ?? null,
    rssi: rec.rssi ?? null,
    category: trafficCategory(payloadType),
    channel,
    source,
    lastHop,
    direct,
    path,
    pathKey: isTrace ? '' : view.path.join('>'),
    distanceM,
    airtimeMs: radio && bytes > 0 ? loraAirtimeMs(bytes, radio) : null,
  };
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function breakdown(points: readonly StatPacket[], key: (p: StatPacket) => string | null): Breakdown[] {
  const m = new Map<string, Breakdown>();
  for (const p of points) {
    const name = key(p);
    if (name === null) continue;
    let b = m.get(name);
    if (!b) m.set(name, (b = { name, count: 0, bytes: 0, airtimeMs: 0 }));
    b.count++;
    b.bytes += p.bytes;
    b.airtimeMs += p.airtimeMs ?? 0;
  }
  return [...m.values()].sort((a, b) => b.airtimeMs - a.airtimeMs || b.count - a.count || a.name.localeCompare(b.name));
}

/** Timeline series of a point given the known channel names. */
function seriesOf(p: StatPacket, known: ReadonlySet<string>): string {
  switch (p.payloadType) {
    case PayloadType.GRP_TXT:
    case PayloadType.GRP_DATA:
      return p.channel !== null && known.has(p.channel) ? p.channel : SERIES_UNKNOWN_CHANNELS;
    case PayloadType.TXT_MSG:
      return SERIES_DMS;
    case PayloadType.ADVERT:
      return SERIES_ADVERTS;
    case PayloadType.ACK:
      return SERIES_ACKS;
    case PayloadType.PATH:
      return SERIES_PATHS;
    case PayloadType.TRACE:
      return SERIES_TRACES;
    case PayloadType.REQ:
    case PayloadType.RESPONSE:
    case PayloadType.ANON_REQ:
      return SERIES_REQUESTS;
    case PayloadType.CONTROL:
      return SERIES_CONTROL;
    default:
      return SERIES_OTHER;
  }
}

interface Binning {
  binMs: number;
  start: number;
  n: number;
}

function buildTimeline(pts: readonly StatPacket[], b: Binning | null, known: ReadonlySet<string>): Timeline {
  const counts = new Map<string, number>();
  for (const p of pts) {
    const s = seriesOf(p, known);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const series = [...counts.entries()]
    .filter(([k]) => k !== SERIES_OTHER)
    .sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0]))
    .map(([k]) => k);
  if (counts.has(SERIES_OTHER)) series.push(SERIES_OTHER);
  if (!b) return { binMs: autoBinMs(0), bins: [], series };
  const bins: TimelineBin[] = [];
  for (let i = 0; i < b.n; i++) bins.push({ t: b.start + i * b.binMs, series: Object.fromEntries(series.map((s) => [s, 0])) });
  for (const p of pts) {
    const bin = bins[Math.floor((p.ts - b.start) / b.binMs)];
    if (!bin) continue;
    const s = seriesOf(p, known);
    bin.series[s] = (bin.series[s] ?? 0) + 1;
  }
  return { binMs: b.binMs, bins, series };
}

function hopCounts(pts: readonly StatPacket[]): HopCount[] {
  const m = new Map<number, number>();
  for (const p of pts) if (p.hops !== null) m.set(p.hops, (m.get(p.hops) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([hops, count]) => ({ hops, count }));
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface PacketStatsDeps {
  /** Names / channel PSKs (PacketLogModel.context). A change of the channel list reloads. */
  context: ReadonlySignal<SummaryContext>;
  /** Stored contacts (ContactsModel.contacts). */
  contacts: ReadonlySignal<readonly ContactRecord[]>;
  /** Resolves when the models feeding `context` / `contacts` have settled (tests). */
  ready?: () => Promise<unknown>;
}

export class PacketStatsModel extends StoreBoundModel {
  readonly #deps: PacketStatsDeps;
  readonly #range = signal<StatsRange>({ from: null, to: null });
  readonly #bin = signal<BinSetting>('auto');
  readonly #filters = signal<readonly StatsFilter[]>([]);
  readonly #raw = signal<readonly RawPoint[]>([]);
  readonly #bounds = signal<{ first: number; last: number } | null>(null);
  #rawIds = new Set<number>();
  /** Raw points by id from the last load, reused while the channel list is unchanged. */
  #rawCache = new Map<number, RawPoint>();
  #rawCacheSig = '';
  /** Channel signature the current / last load used (undefined before the first). */
  #usedSig: string | undefined;
  #live: Promise<void> = Promise.resolve();
  /** Collects live appends while a load runs (null otherwise). */
  #liveSink: RawPoint[] | null = null;
  readonly #contactStats = new Map<string, ReadonlySignal<ContactStats>>();
  readonly #binning: ReadonlySignal<Binning | null>;
  readonly #knownChannels: ReadonlySignal<ReadonlySet<string>>;
  #gen = 0;

  /** Selected date range (default: the whole log). */
  readonly range: ReadonlySignal<StatsRange> = this.#range.readonly;
  /** Bin size setting for the timeline / utilisation over time. */
  readonly bin: ReadonlySignal<BinSetting> = this.#bin.readonly;
  /** ts of the oldest / newest logged packet (whole log, not the range). */
  readonly bounds: ReadonlySignal<{ first: number; last: number } | null> = this.#bounds.readonly;
  /** The radio's LoRa parameters used for airtime (from SELF_INFO), null when unknown. */
  readonly radio: ReadonlySignal<LoraParams | null>;
  /** Drill-down filters (AND, at most one per field); in memory only, kept across range changes. */
  readonly filters: ReadonlySignal<readonly StatsFilter[]> = this.#filters.readonly;
  /** One point per logged packet in the range, ascending ts, ignoring the filters. */
  readonly allPoints: ReadonlySignal<readonly StatPacket[]>;
  /** `allPoints` matching the filters: what every aggregation below counts. */
  readonly points: ReadonlySignal<readonly StatPacket[]>;
  /** `allPoints.length` ("showing X of Y"). */
  readonly unfilteredCount: ReadonlySignal<number>;
  /**
   * The time window the aggregations cover: the range, with open ends taken from `allPoints`
   * (not the filtered points, so axes stay put while drilling down); null when empty.
   */
  readonly window: ReadonlySignal<{ from: number; to: number } | null>;
  readonly summary: ReadonlySignal<StatsSummary>;
  readonly bySource: ReadonlySignal<SourceStats>;
  readonly timeline: ReadonlySignal<Timeline>;
  readonly utilization: ReadonlySignal<Utilization>;
  readonly hops: ReadonlySignal<HopCount[]>;

  constructor(connection: ConnectionModel, deps: PacketStatsDeps) {
    super(connection);
    this.#deps = deps;
    this.radio = computed(() => loraParamsFromSelfInfo(connection.selfInfo.value), { equals: sameParams });

    const resolver = computed(() => new Resolver(deps.contacts.value, selfNode(connection.selfInfo.value, connection.store.value)));
    const channels = computed(() => deps.context.value.channels);
    // per-record cache, valid for one (resolver, channels, radio) snapshot
    let cache = new Map<number, StatPacket>();
    let cacheFor: readonly unknown[] = [];
    this.allPoints = computed(() => {
      const R = resolver.value;
      const chs = channels.value;
      const radio = this.radio.value;
      const raws = this.#raw.value;
      if (cacheFor[0] !== R || cacheFor[1] !== chs || cacheFor[2] !== radio) {
        cache = new Map();
        cacheFor = [R, chs, radio];
      }
      const next = new Map<number, StatPacket>();
      const out = raws.map((raw) => {
        const s = cache.get(raw.rec.id) ?? toStat(raw, R, chs, radio);
        next.set(raw.rec.id, s);
        return s;
      });
      cache = next;
      return out;
    });
    this.points = computed(() => filterPoints(this.allPoints.value, this.#filters.value));
    this.unfilteredCount = computed(() => this.allPoints.value.length);

    this.window = computed(() => {
      const r = this.#range.value;
      const pts = this.allPoints.value;
      const from = r.from ?? pts[0]?.ts ?? r.to;
      const to = r.to ?? pts[pts.length - 1]?.ts ?? r.from;
      if (from === null || from === undefined || to === null || to === undefined) return null;
      return { from, to: Math.max(from, to) };
    });

    this.summary = computed(() => {
      const pts = this.points.value;
      const w = this.window.value;
      const spanMs = w ? w.to - w.from : 0;
      let bytes = 0;
      let air = 0;
      let anyAir = false;
      const sources = new Set<string>();
      for (const p of pts) {
        bytes += p.bytes;
        if (p.airtimeMs !== null) {
          air += p.airtimeMs;
          anyAir = true;
        }
        if (p.source) sources.add(nodeId(p.source));
      }
      const airtimeMs = this.radio.value && anyAir ? air : this.radio.value ? 0 : null;
      return {
        packets: pts.length,
        bytes,
        airtimeMs,
        // a window shorter than the airtime it holds (one burst) would read > 100 %: cap at 1
        airtimeFraction: airtimeMs !== null && spanMs > 0 ? airtimeMs / Math.max(spanMs, airtimeMs) : null,
        sources: sources.size,
        spanMs,
      };
    });

    this.bySource = computed(() => {
      const m = new Map<string, SourceCount>();
      let unattributed = 0;
      for (const p of this.points.value) {
        if (!p.source) {
          unattributed++;
          continue;
        }
        const id = nodeId(p.source);
        let s = m.get(id);
        if (!s) m.set(id, (s = { node: p.source, count: 0, bytes: 0, airtimeMs: 0 }));
        s.count++;
        s.bytes += p.bytes;
        s.airtimeMs += p.airtimeMs ?? 0;
      }
      const all = [...m.values()].sort((a, b) => b.count - a.count || b.bytes - a.bytes || a.node.label.localeCompare(b.node.label));
      const rest = all.slice(TOP_SOURCES);
      return { top: all.slice(0, TOP_SOURCES), unattributed, others: rest.length, othersPackets: rest.reduce((n, s) => n + s.count, 0) };
    });

    const binning = (this.#binning = computed((): Binning | null => {
      const w = this.window.value;
      if (!w) return null;
      const span = w.to - w.from;
      const setting = this.#bin.value;
      const auto = autoBinMs(span);
      const binMs = setting === 'auto' || Math.floor(span / setting) + 1 > MAX_BINS ? auto : setting;
      const start = Math.floor(w.from / binMs) * binMs;
      const n = Math.floor((w.to - start) / binMs) + 1;
      return { binMs, start, n };
    }));
    this.#knownChannels = computed(() => new Set(channels.value.map((c) => c.name)));

    this.timeline = computed(() => buildTimeline(this.points.value, binning.value, this.#knownChannels.value));

    this.utilization = computed(() => {
      const pts = this.points.value;
      const b = binning.value;
      const overTime: Utilization['overTime'] = [];
      if (b) {
        for (let i = 0; i < b.n; i++) overTime.push({ t: b.start + i * b.binMs, airtimeMs: 0, fraction: 0 });
        for (const p of pts) {
          const o = overTime[Math.floor((p.ts - b.start) / b.binMs)];
          if (o && p.airtimeMs !== null) o.airtimeMs += p.airtimeMs;
        }
        for (const o of overTime) o.fraction = o.airtimeMs / b.binMs;
      }
      return {
        overTime,
        byType: breakdown(pts, (p) => p.typeName),
        byRoute: breakdown(pts, (p) => p.routeName || 'unknown'),
        byDirection: breakdown(pts, (p) => p.direction),
        byCategory: breakdown(pts, (p) => p.category),
        byChannel: breakdown(pts, (p) => (p.category === 'channel' ? p.channel : null)),
      };
    });

    this.hops = computed(() => hopCounts(this.points.value));
  }

  /** Statistics of one contact (public key hex), from `allPoints` (the filters don't apply); cached per key. */
  forContact(key: string): ReadonlySignal<ContactStats> {
    const k = key.toLowerCase();
    let s = this.#contactStats.get(k);
    if (!s) {
      s = computed(() => this.#contactStatsOf(k));
      this.#contactStats.set(k, s);
    }
    return s;
  }

  #contactStatsOf(key: string): ContactStats {
    const from: StatPacket[] = [];
    const via: StatPacket[] = [];
    for (const p of this.allPoints.value) {
      if (p.source?.key === key) from.push(p);
      else if (p.path.some((n) => n.key === key)) via.push(p);
    }
    const byPath = new Map<string, { pathKey: string; hops: readonly NodeRef[]; count: number; lastTs: number; snrSum: number; snrN: number }>();
    for (const p of from) {
      let e = byPath.get(p.pathKey);
      if (!e) byPath.set(p.pathKey, (e = { pathKey: p.pathKey, hops: p.path, count: 0, lastTs: p.ts, snrSum: 0, snrN: 0 }));
      e.count++;
      if (p.ts >= e.lastTs) {
        e.lastTs = p.ts;
        e.hops = p.path;
      }
      if (p.snr !== null) {
        e.snrSum += p.snr;
        e.snrN++;
      }
    }
    const paths = [...byPath.values()]
      .sort((a, b) => b.count - a.count || b.lastTs - a.lastTs)
      .map((e) => ({ pathKey: e.pathKey, hops: e.hops, count: e.count, lastTs: e.lastTs, meanSnr: e.snrN ? e.snrSum / e.snrN : null, share: e.count / from.length }));
    return {
      from,
      via,
      timeline: buildTimeline(from, this.#binning.value, this.#knownChannels.value),
      paths,
      signal: from.map((p) => ({ ts: p.ts, snr: p.snr, rssi: p.rssi, hops: p.hops, pathKey: p.pathKey, id: p.id })),
      hops: hopCounts(from),
    };
  }

  /** Selects the date range (inclusive epoch ms, null = open) and reloads. */
  setRange(r: StatsRange): Promise<void> {
    const from = r.from !== null && Number.isFinite(r.from) ? r.from : null;
    const to = r.to !== null && Number.isFinite(r.to) ? r.to : null;
    const cur = this.#range.peek();
    if (cur.from === from && cur.to === to) return this.settled();
    this.#range.value = { from, to };
    return this.reload();
  }

  /** Adds a drill-down filter, replacing any existing one on the same field. */
  addFilter(f: StatsFilter): void {
    const cur = this.#filters.peek();
    const i = cur.findIndex((x) => x.field === f.field);
    const next = { field: f.field, value: f.value, label: f.label };
    this.#filters.value = i < 0 ? [...cur, next] : cur.map((x, j) => (j === i ? next : x));
  }

  removeFilter(field: StatsFilterField): void {
    const cur = this.#filters.peek();
    if (cur.some((x) => x.field === field)) this.#filters.value = cur.filter((x) => x.field !== field);
  }

  clearFilters(): void {
    if (this.#filters.peek().length) this.#filters.value = [];
  }

  /** Timeline bin size in ms, or 'auto' (60–150 bins on round steps). */
  setBin(bin: BinSetting): void {
    this.#bin.value = bin === 'auto' || !(Number.isFinite(bin) && bin > 0) ? 'auto' : bin;
  }

  /** Resolves when loads, context changes and live appends have been applied. */
  override async settled(): Promise<void> {
    await this.#deps.ready?.();
    await super.settled();
    await this.#live;
    await super.settled();
  }

  protected override bind(store: RadioStore) {
    const offs = [
      store.events.on('packet', (rec) => {
        this.#live = this.#live.then(() => this.#append(store, rec)).catch((err: unknown) => this.onError(err));
      }),
      store.events.on('logChanged', (e) => {
        if (e.store === 'packets') void this.reload();
      }),
      // channel PSKs decide GRP_TXT senders: re-derive when the channel list changes
      effect(() => {
        const sig = channelsSignature(this.#deps.context.value.channels);
        if (this.#usedSig !== undefined && sig !== this.#usedSig) untracked(() => void this.reload());
      }),
    ];
    return () => offs.forEach((off) => off());
  }

  protected async load(store: RadioStore): Promise<void> {
    const gen = ++this.#gen;
    // live packets appended while this load runs (the query may or may not have seen them)
    const liveDuringLoad: RawPoint[] = [];
    this.#liveSink = liveDuringLoad;
    const channels = this.#deps.context.peek().channels;
    const sig = channelsSignature(channels);
    this.#usedSig = sig;
    const r = this.#range.peek();
    const [recs, bounds] = await Promise.all([
      store.packets.all({ ...(r.from !== null ? { from: r.from } : {}), ...(r.to !== null ? { to: r.to } : {}) }),
      store.packets.tsBounds(),
    ]);
    const reuse = sig === this.#rawCacheSig ? this.#rawCache : new Map<number, RawPoint>();
    const raws = await Promise.all(recs.map((rec) => reuse.get(rec.id) ?? derive(rec, channels)));
    if (this.#liveSink === liveDuringLoad) this.#liveSink = null;
    if (gen !== this.#gen || this.store !== store) return;
    const loaded = new Set(raws.map((x) => x.rec.id));
    const extra = liveDuringLoad.filter((x) => !loaded.has(x.rec.id) && this.#inRange(x.rec.ts));
    const all = extra.length ? [...raws, ...extra].sort(compareRaw) : raws;
    this.#rawCache = new Map(all.map((x) => [x.rec.id, x]));
    this.#rawCacheSig = sig;
    this.#rawIds = new Set(all.map((x) => x.rec.id));
    batch(() => {
      this.#raw.value = all;
      this.#bounds.value = mergeBounds(bounds, extra.map((x) => x.rec.ts));
    });
  }

  protected reset(): void {
    this.#gen++;
    this.#usedSig = undefined;
    this.#rawIds = new Set();
    this.#rawCache = new Map();
    this.#rawCacheSig = '';
    batch(() => {
      this.#raw.value = [];
      this.#bounds.value = null;
    });
  }

  #inRange(ts: number): boolean {
    const r = this.#range.peek();
    return (r.from === null || ts >= r.from) && (r.to === null || ts <= r.to);
  }

  async #append(store: RadioStore, rec: PacketRecord): Promise<void> {
    if (this.store !== store) return;
    this.#bounds.value = mergeBounds(this.#bounds.peek(), [rec.ts]);
    if (!this.#inRange(rec.ts) || this.#rawIds.has(rec.id)) return;
    const raw = await derive(rec, this.#deps.context.peek().channels);
    if (this.store !== store || this.#rawIds.has(rec.id) || !this.#inRange(rec.ts)) return;
    this.#rawIds.add(rec.id);
    this.#liveSink?.push(raw);
    if (this.#usedSig !== undefined && this.#usedSig === this.#rawCacheSig) this.#rawCache.set(rec.id, raw);
    const cur = this.#raw.peek();
    const last = cur[cur.length - 1];
    if (!last || compareRaw(last, raw) <= 0) {
      this.#raw.value = [...cur, raw];
      return;
    }
    let lo = 0;
    let hi = cur.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareRaw(cur[mid]!, raw) <= 0) lo = mid + 1;
      else hi = mid;
    }
    this.#raw.value = [...cur.slice(0, lo), raw, ...cur.slice(lo)];
  }
}

function mergeBounds(b: { first: number; last: number } | null, ts: readonly number[]): { first: number; last: number } | null {
  let out = b;
  for (const t of ts) out = out ? { first: Math.min(out.first, t), last: Math.max(out.last, t) } : { first: t, last: t };
  return out;
}

function sameParams(a: LoraParams | null, b: LoraParams | null): boolean {
  return a === b || (a !== null && b !== null && a.sf === b.sf && a.bwKhz === b.bwKhz && a.cr === b.cr);
}

function selfNode(si: SelfInfo | null, store: RadioStore | null): SelfNode | null {
  if (si) return { key: toHex(si.pubKey), pubKey: si.pubKey, name: si.name || 'You', lat: si.lat, lon: si.lon };
  if (store) return { key: store.pubKey, pubKey: fromHex(store.pubKey), name: 'You', lat: 0, lon: 0 };
  return null;
}
