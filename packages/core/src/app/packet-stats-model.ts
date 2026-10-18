/**
 * Packet log statistics (the "Stats" tab of /packets, docs/packet-stats.md §1): loads every logged
 * over-the-air packet in a date range, derives one compact {@link StatPacket} per record (who sent
 * it, last hop, distance, airtime…) and aggregates them for charts.
 *
 * Derivation is two-stage so it stays cheap for thousands of packets:
 * 1. async, once per record while loading / live-tailing: the structural view (`viewPacket`) and,
 *    for GRP_TXT with a known channel PSK, the decrypted `"sender: text"` sender name; for text
 *    messages (GRP_TXT, and TXT_MSG with the opt-in DM keys) whether the text was SMAZ-compressed;
 * 2. sync, in a `computed`: attribution against the contacts / this radio (`resolveHop`), distance
 *    and airtime. Cached per record and recomputed only when contacts, SELF_INFO or the channel
 *    list change.
 *
 * Packet layouts: docs/mesh-packet-format.md §1 (envelope, path oldest → newest forwarder), §3
 * (payloads). Names and channel PSKs come from `PacketLogModel.context`.
 */

import { TxtType, decodePathLen, isValidPathLen } from '../protocol/constants.js';
import type { SelfInfo } from '../protocol/types.js';
import { PayloadType, hasTransportCodes, isDirectRoute, isFloodRoute, payloadTypeName, routeTypeName } from '../packet/constants.js';
import { decryptPayload, parseGrpTxtPlaintext } from '../packet/payloads.js';
import { decodeReceivedText } from '../store/messages.js';
import type { RadioStore } from '../store/radio-store.js';
import type { ContactRecord, PacketRecord } from '../store/schema.js';
import { fromHex, toHex, utf8Encode } from '../util/bytes.js';
import type { Unsubscribe } from '../util/events.js';
import { loraAirtimeMs, loraParamsFromSelfInfo, type LoraParams } from './airtime.js';
import type { ConnectionModel } from './connection.js';
import { boundsOf, haversineMeters, hasLocation, type Bounds, type LatLon } from './geo.js';
import type { DrillSource, PacketFilter, SharedPacketFilter } from './packet-log-model.js';
import { decryptDm, viewPacket, type DmKeys, type PacketView, type SummaryContext } from './packet-summary.js';
import type { PathEndpoint, PathGeoNode } from './path-geometry.js';
import { resolveHop } from './path-resolver.js';
import type { PathUsageMap, PathUsageRoute, PathUsageStop } from './path-usage.js';
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

/**
 * How a text message (TXT_MSG / GRP_TXT, plain or signed text) went on the air
 * (docs/packet-stats.md §1.2): 'smaz' = a MeshCore Open SMAZ envelope (`"s:" + base64`,
 * feature-inventory.md §2.4a), 'plain' = uncompressed, 'unknown' = not decrypted (no key, not
 * for this radio, malformed).
 */
export type TextCompression = 'smaz' | 'plain' | 'unknown';

/** UTF-8 sizes of a text message: `plain` = the readable text, `sent` = what went on the air. */
export interface TextBytes {
  plain: number;
  sent: number;
}

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
  /**
   * The node whose transmission this radio heard (docs/packet-stats.md §1.3): a flood's last path
   * entry, the source when heard zero-hop; null when unknown (TRACE, and DIRECT / TRANSPORT_DIRECT
   * routes, whose forwarders remove themselves from the path).
   */
  lastHop: NodeRef | null;
  /** Flood-routed with an empty path: heard straight from the source. */
  direct: boolean;
  /** Every path entry resolved (forwarders preferred), oldest forwarder first; [] when direct / TRACE / unknown. */
  path: readonly NodeRef[];
  /** Hop hashes joined with '>' ('' = direct): the identity of a path. */
  pathKey: string;
  /** The payload's destination hash hex (TXT_MSG, REQ, RESPONSE, PATH, ANON_REQ); null for the others. */
  destHash: string | null;
  /** Metres from this radio to the source (or the earliest located hop); null when unknown. */
  distanceM: number | null;
  /** Estimated time on air at the radio's current LoRa parameters; null when unknown. */
  airtimeMs: number | null;
  /** Text messages only (see {@link TextCompression}); null for every other packet and for CLI DMs. */
  compression: TextCompression | null;
  /**
   * Sizes of the text (channel messages: the part after "sender: "); `plain === sent` when
   * 'plain'. Null when not a decrypted text, or for an outgoing text whose logged copy was cut.
   */
  textBytes: TextBytes | null;
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

/** Packets per node (sources, or the first / last node of the path): see {@link nodeStats}. */
export interface SourceStats {
  /** Top {@link TOP_SOURCES} nodes, count desc. */
  top: SourceCount[];
  /** Packets without a node (no source; for path ends, no path). */
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

/** Group text messages (GRP_TXT) of one channel. */
export interface ChannelMessageCount {
  /** {@link StatPacket.channel}: the channel name, or `channel xx` (the hash) when not known. */
  channel: string;
  count: number;
  /** Of `count`, sent by this radio. */
  sent: number;
  bytes: number;
}

/** Text message counts by {@link TextCompression}; `text` = smaz + plain + unknown. */
export interface CompressionCounts {
  text: number;
  smaz: number;
  plain: number;
  unknown: number;
}

/** SMAZ compression usage over the filtered text messages (docs/packet-stats.md §1.6). */
export interface CompressionStats extends CompressionCounts {
  /** smaz / (smaz + plain): share of the decrypted texts that were compressed; null when none. */
  compressedShare: number | null;
  /** Totals over the 'smaz' packets whose sizes are known (`textBytes`). */
  smazPlainBytes: number;
  smazSentBytes: number;
  /** smazPlainBytes − smazSentBytes. */
  bytesSaved: number;
  /** bytesSaved / smazPlainBytes; null when no sizes are known. */
  savingsRatio: number | null;
  byCategory: { dm: CompressionCounts; channel: CompressionCounts };
  byDirection: { in: CompressionCounts; out: CompressionCounts };
  /** Distinct sources (`nodeId`, this radio included) of at least one 'smaz' packet. */
  compressedSources: number;
}

export type BinSetting = number | 'auto';

/** A packet field the stats can be drilled down by (docs/packet-stats.md §6). */
export type StatsFilterField = 'source' | 'type' | 'route' | 'direction' | 'category' | 'channel' | 'hops' | 'compression' | 'pathStart' | 'pathEnd' | 'lastHop';

/**
 * One drill-down filter. `value` is the key the aggregations produce for the field: source →
 * `nodeId(source)` ('' = unattributed), type → typeName, route → routeName ('unknown' when
 * not known), direction → 'in' / 'out', category, channel → channel name (channel packets only),
 * hops → `String(hops)`, compression → 'smaz' / 'plain' / 'unknown' (text messages only),
 * pathStart / pathEnd → `nodeId` of the first / last path entry (packets with a path only),
 * lastHop → `nodeId` of {@link StatPacket.lastHop} (received packets with a last hop only).
 * `label` is the caller's display text (chips).
 */
export interface StatsFilter {
  field: StatsFilterField;
  value: string;
  label: string;
}

/** Display name of each filter field (chips). */
export const STATS_FIELD_LABEL: Readonly<Record<StatsFilterField, string>> = {
  source: 'Source',
  type: 'Packet type',
  route: 'Route type',
  direction: 'Direction',
  category: 'Category',
  channel: 'Channel',
  hops: 'Hops',
  compression: 'Compression',
  pathStart: 'First in path',
  pathEnd: 'Last in path',
  lastHop: 'Last hop',
};

const DIRECTION_FILTER_LABEL: Readonly<Record<StatDirection, string>> = { in: 'Received', out: 'Sent' };

/** The payload type number named `typeName` (a {@link StatPacket.typeName}); undefined for 'UNKNOWN'. */
export function payloadTypeOfName(typeName: string): number | undefined {
  for (let n = 0; n < 16; n++) if (payloadTypeName(n) === typeName) return n;
  return undefined;
}

/** The route type number named `routeName` (a {@link StatPacket.routeName}); undefined for 'unknown'. */
export function routeTypeOfName(routeName: string): number | undefined {
  for (let n = 0; n < 4; n++) if (routeTypeName(n) === routeName) return n;
  return undefined;
}

/**
 * The drill-down view of a packet log filter (docs/packet-stats.md §6): direction, a single
 * payload type and a single route type from the native fields, then {@link PacketFilter.drill}.
 * Several payload / route types (picked on the Packets tab) have no drill-down equivalent.
 */
export function statsFiltersOf(f: PacketFilter): StatsFilter[] {
  const out: StatsFilter[] = [];
  const drill = f.drill ?? [];
  if (f.direction) {
    const value: StatDirection = f.direction === 'tx' ? 'out' : 'in';
    out.push({ field: 'direction', value, label: DIRECTION_FILTER_LABEL[value] });
  }
  if (f.payloadTypes?.length === 1) {
    const name = payloadTypeName(f.payloadTypes[0]!);
    out.push({ field: 'type', value: name, label: name });
  }
  if (f.routeTypes?.length === 1) {
    const name = routeTypeName(f.routeTypes[0]!);
    out.push({ field: 'route', value: name, label: name });
  }
  for (const d of drill) if (!out.some((x) => x.field === d.field)) out.push(d);
  return out;
}

/**
 * `f` with drill-down `d` added, replacing any criterion on the same field: direction, type and
 * route go to the native fields when the key maps to a number (else, e.g. 'UNKNOWN' / 'unknown',
 * to `drill`); the other fields to `drill`.
 */
export function withStatsFilter(f: PacketFilter, d: StatsFilter): PacketFilter {
  const entry: StatsFilter = { field: d.field, value: d.value, label: d.label };
  const out = withoutStatsFilter(f, d.field);
  const native =
    d.field === 'direction'
      ? d.value === 'in' || d.value === 'out'
      : d.field === 'type'
        ? payloadTypeOfName(d.value) !== undefined
        : d.field === 'route'
          ? routeTypeOfName(d.value) !== undefined
          : false;
  if (!native) return { ...out, drill: [...(out.drill ?? []), entry] };
  if (d.field === 'direction') return { ...out, direction: d.value === 'out' ? 'tx' : 'rx' };
  if (d.field === 'type') return { ...out, payloadTypes: [payloadTypeOfName(d.value)!] };
  return { ...out, routeTypes: [routeTypeOfName(d.value)!] };
}

/** `f` without any criterion on drill-down field `field` (type / route: every payload / route type). */
export function withoutStatsFilter(f: PacketFilter, field: StatsFilterField): PacketFilter {
  const out: PacketFilter = { ...f };
  if (field === 'direction') delete out.direction;
  if (field === 'type') delete out.payloadTypes;
  if (field === 'route') delete out.routeTypes;
  const drill = (f.drill ?? []).filter((x) => x.field !== field);
  if (drill.length) out.drill = drill;
  else delete out.drill;
  return out;
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
    case 'compression':
      return p.compression;
    case 'pathStart':
      return p.path[0] ? nodeId(p.path[0]) : null;
    case 'pathEnd': {
      const last = p.path[p.path.length - 1];
      return last ? nodeId(last) : null;
    }
    case 'lastHop':
      return p.direction === 'in' && p.lastHop ? nodeId(p.lastHop) : null;
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

/** SNR / RSSI summary of a set of received packets; the means / extremes are null when none had a value. */
export interface SnrSummary {
  /** Packets. */
  count: number;
  /** Of `count`, with an SNR. */
  snrCount: number;
  meanSnr: number | null;
  minSnr: number | null;
  maxSnr: number | null;
  /** Mean over the packets with an RSSI. */
  meanRssi: number | null;
}

/** One received packet heard from a last hop ({@link ContactStats.lastHopSignal}). */
export interface LastHopSignalPoint {
  ts: number;
  snr: number | null;
  rssi: number | null;
  /** Heard straight from its source (zero-hop flood; {@link StatPacket.direct}), else relayed. */
  direct: boolean;
  /** PacketRecord.id. */
  id: number;
}

/** How this radio hears one last-hop node ({@link lastHopSignalStats}). */
export interface LastHopSignal extends SnrSummary {
  node: NodeRef;
  /** ts of the newest packet. */
  lastTs: number;
  /** Of `count`, heard straight from the source (zero hop: the node is the source). */
  direct: number;
  /** Of `count`, relayed (the node is the last forwarder). */
  relayed: number;
}

/** Received packets per last hop ({@link PacketStatsModel.lastHops}). */
export interface LastHopStats {
  /** Top {@link TOP_SOURCES} last hops, count desc. */
  top: LastHopSignal[];
  /** Received packets without a last hop (TRACE, direct routes, unattributed zero-hop). */
  unattributed: number;
  /** Last hops beyond the top list. */
  others: number;
  /** Packets from those last hops. */
  othersPackets: number;
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
  /**
   * Received packets whose last hop ({@link StatPacket.lastHop}) is the contact, whatever their
   * source: how well this radio hears the contact (relayed traffic for a repeater). Ascending ts.
   */
  lastHopOf: readonly StatPacket[];
  /** `lastHopOf`, ascending ts. */
  lastHopSignal: LastHopSignalPoint[];
  /** SNR / RSSI over `lastHopOf`. */
  lastHopSummary: SnrSummary;
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

const SERIES_DESCRIPTIONS: Readonly<Record<string, string>> = {
  [SERIES_DMS]: 'TXT_MSG: direct messages between two nodes, including CLI commands to repeaters and room server posts.',
  [SERIES_ADVERTS]: 'ADVERT: nodes announcing their name, type, public key and location.',
  [SERIES_ACKS]: 'ACK: delivery acknowledgements for direct messages and keep-alives.',
  [SERIES_PATHS]: 'PATH: the route a flooded packet took, sent back to its sender so it can reply direct (often carrying an ACK or reply).',
  [SERIES_TRACES]: 'TRACE: trace-route packets that collect the SNR at each hop.',
  [SERIES_REQUESTS]:
    'REQ, RESPONSE and ANON_REQ: requests to a node and their replies, e.g. logins to repeaters / room servers, status, telemetry, neighbours and access lists.',
  [SERIES_CONTROL]: 'CONTROL: unencrypted control packets, e.g. node discovery requests and responses.',
  [SERIES_UNKNOWN_CHANNELS]: 'GRP_TXT and GRP_DATA on channels this radio has no key for (the channel hash matches none of your channels).',
  [SERIES_OTHER]: 'MULTIPART, RAW_CUSTOM and unknown payload types.',
};

/**
 * What packets a timeline series counts (hover text). Any key that is not a fixed series is a
 * known channel.
 */
export function timelineSeriesDescription(key: string): string {
  return SERIES_DESCRIPTIONS[key] ?? `GRP_TXT and GRP_DATA: channel messages and data on ${key}.`;
}
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

/** The path-map endpoint of a node reference: this radio, a contact, a hash, a channel sender name, or unknown (null). */
export function nodeEndpoint(n: NodeRef | null): PathEndpoint {
  if (!n) return { kind: 'unknown', label: 'Origin' };
  if (n.self) return { kind: 'self' };
  if (n.key) return { kind: 'contact', key: n.key };
  if (n.hash) return { kind: 'hash', hash: n.hash };
  return { kind: 'name', name: n.label };
}

/** The fields of a {@link StatPacket} its route depends on. */
export type RoutablePacket = Pick<StatPacket, 'direction' | 'routeType' | 'payloadType' | 'hops' | 'pathKey' | 'source' | 'destHash'>;

/**
 * The route a packet's path describes (docs/packet-stats.md §1.7, mesh-packet-format.md §1.3), or
 * null when it has none worth drawing:
 * - FLOOD / TRANSPORT_FLOOD received: the hops taken so far, so source → hops → this radio (a
 *   0-hop packet is the source heard directly; unattributed with 0 hops: null). Sent floods
 *   carry no path yet: null.
 * - DIRECT / TRANSPORT_DIRECT: the hops still to travel, so (this radio when sent, else an unknown
 *   origin) → hops → the destination hash (unknown when the payload has none). A received direct
 *   packet with no hops left (delivered to us), or any direct packet with neither hops nor a
 *   destination, says nothing: null.
 * - TRACE (path = SNRs) and unknown hop counts: null. An unknown route type is read as a flood
 *   when it has hops, else null.
 */
export function statPacketRoute(p: RoutablePacket): Omit<PathUsageRoute, 'count'> | null {
  if (p.payloadType === PayloadType.TRACE || p.hops === null) return null;
  const hashes = p.pathKey ? p.pathKey.split('>') : [];
  if (isDirectRoute(p.routeType)) {
    const to: PathEndpoint = p.destHash ? { kind: 'hash', hash: p.destHash } : { kind: 'unknown', label: 'Destination' };
    if (!hashes.length && (p.direction === 'in' || to.kind === 'unknown')) return null;
    return { hashes, from: p.direction === 'out' ? { kind: 'self' } : { kind: 'unknown', label: 'Origin' }, to };
  }
  if (!isFloodRoute(p.routeType) && !hashes.length) return null;
  if (p.direction === 'out' || (!p.source && !hashes.length)) return null;
  return { hashes, from: nodeEndpoint(p.source), to: { kind: 'self' } };
}

function endpointId(e: PathEndpoint): string {
  switch (e.kind) {
    case 'self':
      return 'self';
    case 'contact':
      return `k:${e.key}`;
    case 'hash':
      return `h:${e.hash}`;
    case 'name':
      return `n:${e.name}`;
    case 'point':
      return `p:${e.key ?? e.name}@${e.lat},${e.lon}`;
    case 'unknown':
      return `?:${e.label}`;
  }
}

/** The routes of `points` ({@link statPacketRoute}), one per distinct (from, path, to), busiest first. */
export function packetRoutes(points: readonly RoutablePacket[]): PathUsageRoute[] {
  const m = new Map<string, PathUsageRoute>();
  for (const p of points) {
    const r = statPacketRoute(p);
    if (!r) continue;
    const id = `${endpointId(r.from)}|${p.pathKey}|${endpointId(r.to)}`;
    const g = m.get(id);
    if (g) g.count++;
    else m.set(id, { ...r, count: 1 });
  }
  return [...m.entries()].sort(([ia, a], [ib, b]) => b.count - a.count || ia.localeCompare(ib)).map(([, r]) => r);
}

/** How many of the newest listed packets the Packets list "Map" button maps ({@link PacketStatsModel.recentRoutes}). */
export const MAP_PACKET_LIMIT = 500;

/** The routes of the newest packets, for the Packets list map ({@link recentPacketRoutes}). */
export interface RecentRoutes {
  /** {@link packetRoutes} of the newest packets considered. */
  routes: readonly PathUsageRoute[];
  /** Packets considered: the newest `limit` (fewer when fewer match). */
  packets: number;
  /** Packets among them that have a route ({@link statPacketRoute} non-null). */
  mapped: number;
}

/** The routes of the newest `limit` of `points` (ascending ts), with how many were considered / mapped. */
export function recentPacketRoutes(points: readonly RoutablePacket[], limit = MAP_PACKET_LIMIT): RecentRoutes {
  const recent = points.slice(-limit);
  const routes = packetRoutes(recent);
  return { routes, packets: recent.length, mapped: routes.reduce((n, r) => n + r.count, 0) };
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
  /** See {@link StatPacket.compression} (the text itself is never kept). */
  compression: TextCompression | null;
  textBytes: TextBytes | null;
}

type Channels = SummaryContext['channels'];

/** What stage 1 depends on besides the record: GRP_TXT on the channel PSKs, TXT_MSG on the DM keys. */
interface DeriveSig {
  ch: string;
  dm: string;
}

function channelsSignature(chs: Channels): string {
  return chs.map((c) => `${c.hash}:${c.name}:${toHex(c.psk)}`).join('|');
}

function dmSignature(dm: DmKeys | null): string {
  return dm ? `${toHex(dm.selfPublicKey)}>${dm.contacts.map(toHex).join(',')}` : '';
}

/** A cached raw point is still valid under `now` when the keys it depended on are unchanged. */
function reusable(raw: RawPoint, was: DeriveSig, now: DeriveSig): boolean {
  const kind = raw.view.payload?.kind;
  return (kind !== 'grpTxt' || was.ch === now.ch) && (kind !== 'txtMsg' || was.dm === now.dm);
}

/** Text types whose compression is counted: plain and signed text; CLI data / commands are not text. */
function isTextType(txtType: number): boolean {
  return txtType === TxtType.PLAIN || txtType === TxtType.SIGNED_PLAIN;
}

const NOT_TEXT = { compression: null, textBytes: null } as const;
const UNKNOWN_TEXT = { compression: 'unknown', textBytes: null } as const;

/** Classifies decrypted text exactly as received messages are (`decodeReceivedText`). */
function classifyText(text: string, txtType: number): Pick<RawPoint, 'compression' | 'textBytes'> {
  if (!isTextType(txtType)) return NOT_TEXT;
  const sent = utf8Encode(text).length;
  const r = decodeReceivedText(text, txtType);
  return r.compressed ? { compression: 'smaz', textBytes: { plain: utf8Encode(r.text).length, sent } } : { compression: 'plain', textBytes: { plain: sent, sent } };
}

/** The packet log cuts the text of a requested transmission to 59 characters + '…' (packet-log.ts `quoted`). */
const LOGGED_TEXT_MAX = 60;
/** `…: "<json string>"[ (attempt n)]` at the end of a requested TXT_MSG / GRP_TXT summary. */
const LOGGED_TEXT_RE = /: ("(?:[^"\\]|\\.)*")(?: \(attempt \d+\))?$/;

/**
 * An outgoing text the radio built itself (`format: 'none'`, packetInputFromCommand): the only
 * copy of the wire text (the envelope when compressed) is the one quoted in `decodedSummary`.
 * A cut copy still shows whether it was an envelope, but not the sizes.
 */
function classifyRequested(rec: PacketRecord): Pick<RawPoint, 'compression' | 'textBytes'> {
  const summary = rec.decodedSummary ?? '';
  if (rec.payloadType === PayloadType.TXT_MSG && summary.startsWith(`${payloadTypeName(PayloadType.TXT_MSG)} CLI `)) return NOT_TEXT;
  const m = LOGGED_TEXT_RE.exec(summary);
  let text: unknown;
  try {
    text = m?.[1] !== undefined ? JSON.parse(m[1]) : undefined;
  } catch {
    text = undefined;
  }
  if (typeof text !== 'string') return UNKNOWN_TEXT;
  if (text.length === LOGGED_TEXT_MAX && text.endsWith('…')) {
    return /^s:[A-Za-z0-9+/]+$/.test(text.slice(0, -1)) ? { compression: 'smaz', textBytes: null } : { compression: 'plain', textBytes: null };
  }
  return classifyText(text, TxtType.PLAIN);
}

async function derive(rec: PacketRecord, channels: Channels, dm: DmKeys | null): Promise<RawPoint> {
  const view = viewPacket(rec);
  const raw: RawPoint = { rec, view, ...NOT_TEXT };
  const p = view.payload;
  if (rec.format === 'none') {
    if (rec.direction === 'tx' && (rec.payloadType === PayloadType.TXT_MSG || rec.payloadType === PayloadType.GRP_TXT)) Object.assign(raw, classifyRequested(rec));
    return raw;
  }
  if (p?.kind === 'txtMsg') {
    Object.assign(raw, UNKNOWN_TEXT);
    const t = dm ? await decryptDm(p, dm) : null;
    if (t !== null && t !== 'malformed') Object.assign(raw, classifyText(t.text, t.txtType));
    return raw;
  }
  if (p?.kind !== 'grpTxt') return raw;
  Object.assign(raw, UNKNOWN_TEXT);
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
      const t = parseGrpTxtPlaintext(pt);
      if (t.senderName) raw.sender = t.senderName;
      // the envelope is the text after "sender: ", as on receive (messageInputFromChannelFrame)
      Object.assign(raw, classifyText(t.message, t.txtType));
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
  // a DIRECT path is the route still to travel and each forwarder removes itself from it
  // (mesh-packet-format.md §1.3), so the transmitter this radio heard is not recorded
  const directRoute = isDirectRoute(rec.routeType);
  const direct = !isTrace && !directRoute && view.hops === 0;
  const path = isTrace ? [] : view.path.map((h) => R.hop(h, true).ref);
  const lastEntry = path[path.length - 1];
  const lastHop = isTrace || directRoute ? null : (lastEntry ?? (direct ? source : null));

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
    destHash: p && (p.kind === 'txtMsg' || p.kind === 'req' || p.kind === 'response' || p.kind === 'path' || p.kind === 'anonReq') ? hex2(p.destHash) : null,
    distanceM,
    airtimeMs: radio && bytes > 0 ? loraAirtimeMs(bytes, radio) : null,
    compression: raw.compression,
    textBytes: raw.textBytes,
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

function zeroCounts(): CompressionCounts {
  return { text: 0, smaz: 0, plain: 0, unknown: 0 };
}

function compressionStats(pts: readonly StatPacket[]): CompressionStats {
  const all = zeroCounts();
  const byCategory = { dm: zeroCounts(), channel: zeroCounts() };
  const byDirection = { in: zeroCounts(), out: zeroCounts() };
  const sources = new Set<string>();
  let plainBytes = 0;
  let sentBytes = 0;
  for (const p of pts) {
    const c = p.compression;
    if (c === null) continue;
    for (const k of [all, p.category === 'dm' ? byCategory.dm : p.category === 'channel' ? byCategory.channel : null, byDirection[p.direction]]) {
      if (!k) continue;
      k.text++;
      k[c]++;
    }
    if (c !== 'smaz') continue;
    if (p.source) sources.add(nodeId(p.source));
    if (p.textBytes) {
      plainBytes += p.textBytes.plain;
      sentBytes += p.textBytes.sent;
    }
  }
  const decrypted = all.smaz + all.plain;
  return {
    ...all,
    compressedShare: decrypted ? all.smaz / decrypted : null,
    smazPlainBytes: plainBytes,
    smazSentBytes: sentBytes,
    bytesSaved: plainBytes - sentBytes,
    savingsRatio: plainBytes ? (plainBytes - sentBytes) / plainBytes : null,
    byCategory,
    byDirection,
    compressedSources: sources.size,
  };
}

/**
 * GRP_TXT messages per channel, by count desc then name. Messages without a channel (a sent message
 * logged without its bytes) are left out.
 */
export function channelMessageCounts(pts: readonly StatPacket[]): ChannelMessageCount[] {
  const m = new Map<string, ChannelMessageCount>();
  for (const p of pts) {
    if (p.payloadType !== PayloadType.GRP_TXT || p.channel === null) continue;
    let c = m.get(p.channel);
    if (!c) m.set(p.channel, (c = { channel: p.channel, count: 0, sent: 0, bytes: 0 }));
    c.count++;
    if (p.direction === 'out') c.sent++;
    c.bytes += p.bytes;
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel));
}

/**
 * Packets per node `pick` attributes them to (by count desc, then bytes, then label): the top
 * {@link TOP_SOURCES}, the packets with no node (`pick` → null) and the nodes beyond the top.
 */
export function nodeStats(pts: readonly StatPacket[], pick: (p: StatPacket) => NodeRef | null | undefined): SourceStats {
  const m = new Map<string, SourceCount>();
  let unattributed = 0;
  for (const p of pts) {
    const node = pick(p);
    if (!node) {
      unattributed++;
      continue;
    }
    const id = nodeId(node);
    let s = m.get(id);
    if (!s) m.set(id, (s = { node, count: 0, bytes: 0, airtimeMs: 0 }));
    s.count++;
    s.bytes += p.bytes;
    s.airtimeMs += p.airtimeMs ?? 0;
  }
  const all = [...m.values()].sort((a, b) => b.count - a.count || b.bytes - a.bytes || a.node.label.localeCompare(b.node.label));
  const rest = all.slice(TOP_SOURCES);
  return { top: all.slice(0, TOP_SOURCES), unattributed, others: rest.length, othersPackets: rest.reduce((n, s) => n + s.count, 0) };
}

/** Accumulates an {@link SnrSummary}. */
class SnrAcc {
  count = 0;
  snrN = 0;
  snrSum = 0;
  min = Infinity;
  max = -Infinity;
  rssiN = 0;
  rssiSum = 0;

  add(p: Pick<StatPacket, 'snr' | 'rssi'>): void {
    this.count++;
    if (p.snr !== null) {
      this.snrN++;
      this.snrSum += p.snr;
      this.min = Math.min(this.min, p.snr);
      this.max = Math.max(this.max, p.snr);
    }
    if (p.rssi !== null) {
      this.rssiN++;
      this.rssiSum += p.rssi;
    }
  }

  summary(): SnrSummary {
    const any = this.snrN > 0;
    return {
      count: this.count,
      snrCount: this.snrN,
      meanSnr: any ? this.snrSum / this.snrN : null,
      minSnr: any ? this.min : null,
      maxSnr: any ? this.max : null,
      meanRssi: this.rssiN ? this.rssiSum / this.rssiN : null,
    };
  }
}

/** SNR / RSSI summary of `pts` (every packet counts; the means skip missing values). */
export function snrSummary(pts: readonly Pick<StatPacket, 'snr' | 'rssi'>[]): SnrSummary {
  const acc = new SnrAcc();
  for (const p of pts) acc.add(p);
  return acc.summary();
}

/**
 * Signal per last hop over the received packets of `pts` (docs/packet-stats.md §1.6): the radio's
 * SNR / RSSI measure the link from the last hop to this radio. Grouped by `nodeId`, so an
 * ambiguous hop hash is its own row (`a3?`). Sent packets are skipped; received ones without a
 * last hop are `unattributed`. By count desc, then label; top {@link TOP_SOURCES}.
 */
export function lastHopSignalStats(pts: readonly StatPacket[]): LastHopStats {
  const m = new Map<string, { node: NodeRef; acc: SnrAcc; lastTs: number; direct: number }>();
  let unattributed = 0;
  for (const p of pts) {
    if (p.direction !== 'in') continue;
    const node = p.lastHop;
    if (!node) {
      unattributed++;
      continue;
    }
    const id = nodeId(node);
    let e = m.get(id);
    if (!e) m.set(id, (e = { node, acc: new SnrAcc(), lastTs: p.ts, direct: 0 }));
    e.acc.add(p);
    e.lastTs = Math.max(e.lastTs, p.ts);
    if (p.direct) e.direct++;
  }
  const all = [...m.values()]
    .map((e): LastHopSignal => ({ node: e.node, ...e.acc.summary(), lastTs: e.lastTs, direct: e.direct, relayed: e.acc.count - e.direct }))
    .sort((a, b) => b.count - a.count || a.node.label.localeCompare(b.node.label));
  const rest = all.slice(TOP_SOURCES);
  return { top: all.slice(0, TOP_SOURCES), unattributed, others: rest.length, othersPackets: rest.reduce((n, s) => n + s.count, 0) };
}

/** A counted node placed on a map (see {@link placeNodeCounts}). */
export interface PlacedNodeCount extends LatLon {
  /** `nodeId(node)`. */
  id: string;
  node: NodeRef;
  count: number;
  /** The map node's kind (repeater, self…) when it resolved to one. */
  kind?: PathGeoNode['kind'];
  /** The position is an estimate (ambiguous hash / interpolated). */
  approximate: boolean;
}

export interface PlacedNodeCounts {
  /** Busiest first. */
  markers: PlacedNodeCount[];
  /** Largest marker count (0 when none). */
  maxCount: number;
  /** Nodes that could not be placed, and the packets they count. */
  unplaced: number;
  unplacedPackets: number;
  bounds: Bounds | null;
}

/**
 * Places the counted nodes of `s` (e.g. {@link PacketStatsModel.pathStarts}) where the paths map
 * `usage` (`PathModel.routesUsage` of the same packets' routes) put them, so both maps agree,
 * estimates included. A node is matched by public key, else by hop hash; a hash placed at several
 * estimated positions takes the busiest. Nodes the map left off count as unplaced.
 */
export function placeNodeCounts(s: SourceStats, usage: PathUsageMap): PlacedNodeCounts {
  const byKey = new Map<string, PathUsageStop>();
  const byHash = new Map<string, PathUsageStop>();
  for (const st of usage.stops) {
    if (st.node) byKey.set(st.node.key.toLowerCase(), st);
    const h = st.hash?.toLowerCase();
    if (h && (byHash.get(h)?.count ?? -1) < st.count) byHash.set(h, st);
  }
  const markers: PlacedNodeCount[] = [];
  let unplaced = 0;
  let unplacedPackets = 0;
  for (const { node, count } of s.top) {
    const st = (node.key && byKey.get(node.key.toLowerCase())) || (node.hash ? byHash.get(node.hash.toLowerCase()) : undefined);
    if (!st) {
      unplaced++;
      unplacedPackets += count;
      continue;
    }
    markers.push({ id: nodeId(node), node, count, lat: st.lat, lon: st.lon, approximate: st.approximate, ...(st.node ? { kind: st.node.kind } : {}) });
  }
  markers.sort((a, b) => b.count - a.count);
  return { markers, maxCount: markers[0]?.count ?? 0, unplaced, unplacedPackets, bounds: boundsOf(markers) };
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
  /**
   * The packet log's filter (PacketLogModel.sharedFilter), shared with the Packets tab: its
   * `from` / `to` are the date range, every other criterion narrows `points`.
   */
  filter: SharedPacketFilter;
  /** Names / channel PSKs (PacketLogModel.context). A change of the channel list reloads. */
  context: ReadonlySignal<SummaryContext>;
  /** DM keys (PacketLogModel.dmKeys) for classifying TXT_MSG text; a change of the keys reloads. */
  dmKeys?: ReadonlySignal<DmKeys | null>;
  /** Stored contacts (ContactsModel.contacts). */
  contacts: ReadonlySignal<readonly ContactRecord[]>;
  /** Resolves when the models feeding `context` / `contacts` have settled (tests). */
  ready?: () => Promise<unknown>;
}

export class PacketStatsModel extends StoreBoundModel implements DrillSource {
  readonly #deps: PacketStatsDeps;
  readonly #shared: SharedPacketFilter;
  readonly #bin = signal<BinSetting>('auto');
  readonly #raw = signal<readonly RawPoint[]>([]);
  readonly #bounds = signal<{ first: number; last: number } | null>(null);
  #rawIds = new Set<number>();
  /** Raw points by id from the last load, reused while the channel list is unchanged. */
  #rawCache = new Map<number, RawPoint>();
  #rawCacheSig: DeriveSig = { ch: '', dm: '' };
  /** Key signatures the current / last load used (undefined before the first). */
  #usedSig: DeriveSig | undefined;
  readonly #dmSig: ReadonlySignal<string>;
  #live: Promise<void> = Promise.resolve();
  /** Collects live appends while a load runs (null otherwise). */
  #liveSink: RawPoint[] | null = null;
  readonly #contactStats = new Map<string, ReadonlySignal<ContactStats>>();
  readonly #binning: ReadonlySignal<Binning | null>;
  readonly #knownChannels: ReadonlySignal<ReadonlySet<string>>;
  readonly #byId: ReadonlySignal<ReadonlyMap<number, StatPacket>>;
  readonly #watchers = new Set<{ appended(rec: PacketRecord): void; reloaded(): void }>();
  /** The range the current / last load used (undefined before the first). */
  #usedRange: StatsRange | undefined;
  #gen = 0;

  /** Selected date range: the shared filter's `from` / `to` (default: the whole log). */
  readonly range: ReadonlySignal<StatsRange>;
  /** Bin size setting for the timeline / utilisation over time. */
  readonly bin: ReadonlySignal<BinSetting> = this.#bin.readonly;
  /** ts of the oldest / newest logged packet (whole log, not the range). */
  readonly bounds: ReadonlySignal<{ first: number; last: number } | null> = this.#bounds.readonly;
  /** The radio's LoRa parameters used for airtime (from SELF_INFO), null when unknown. */
  readonly radio: ReadonlySignal<LoraParams | null>;
  /**
   * Drill-down view of the shared filter ({@link statsFiltersOf}: AND, at most one per field); in
   * memory only, kept across range changes.
   */
  readonly filters: ReadonlySignal<readonly StatsFilter[]>;
  /** One point per logged packet in the range, ascending ts, ignoring the filters. */
  readonly allPoints: ReadonlySignal<readonly StatPacket[]>;
  /**
   * `allPoints` matching every criterion of the shared filter (drill-downs, and the packet log's
   * direction / types / routes / source / node / text): what every aggregation below counts.
   */
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
  /** Packets per first path entry (the forwarder nearest the start of the path); no path → `unattributed`. */
  readonly pathStarts: ReadonlySignal<SourceStats>;
  /** Packets per last path entry (for a received flood, the forwarder this radio heard); no path → `unattributed`. */
  readonly pathEnds: ReadonlySignal<SourceStats>;
  /** Signal (SNR / RSSI) of the received `points` per last hop ({@link lastHopSignalStats}). */
  readonly lastHops: ReadonlySignal<LastHopStats>;
  readonly timeline: ReadonlySignal<Timeline>;
  readonly utilization: ReadonlySignal<Utilization>;
  readonly hops: ReadonlySignal<HopCount[]>;
  /** Group messages of `points` per channel ({@link channelMessageCounts}). */
  readonly channelMessages: ReadonlySignal<ChannelMessageCount[]>;
  /** SMAZ compression usage of the text messages in `points`. */
  readonly compression: ReadonlySignal<CompressionStats>;
  /** The routes of `points` for the "packet paths" map ({@link packetRoutes}). */
  readonly routes: ReadonlySignal<readonly PathUsageRoute[]>;
  /**
   * The routes of the newest {@link MAP_PACKET_LIMIT} of `points` (what the Packets list shows,
   * newest first) for its "Map" button, with how many packets were considered and how many had
   * a route ({@link recentPacketRoutes}). Map it with `PathModel.routesUsage(…, { directed: true })`.
   */
  readonly recentRoutes: ReadonlySignal<RecentRoutes>;

  constructor(connection: ConnectionModel, deps: PacketStatsDeps) {
    super(connection);
    this.#deps = deps;
    this.#shared = deps.filter;
    const shared = deps.filter.filter;
    this.range = computed(
      () => {
        const f = shared.value;
        return { from: f.from ?? null, to: f.to ?? null };
      },
      { equals: (a, b) => a.from === b.from && a.to === b.to },
    );
    this.filters = computed(() => statsFiltersOf(shared.value), { equals: sameFilters });
    this.#dmSig = computed(() => dmSignature(deps.dmKeys?.value ?? null));
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
    this.#byId = computed(() => new Map(this.allPoints.value.map((p) => [p.id, p])));
    this.points = computed(() => {
      const all = this.allPoints.value;
      const f = shared.value;
      const drill = f.drill ?? [];
      // the log's own criteria; the range is what allPoints was loaded for
      const log: PacketFilter = { ...f };
      delete log.drill;
      delete log.from;
      delete log.to;
      const byLog = Object.keys(log).length > 0;
      if (!byLog && !drill.length) return all;
      const raws = this.#raw.value; // allPoints[i] is derived from raws[i]
      return all.filter((p, i) => {
        if (!drill.every((d) => matchesFilter(p, d))) return false;
        const rec = raws[i]?.rec;
        return !byLog || (rec !== undefined && this.#shared.matches(rec, log));
      });
    });
    this.unfilteredCount = computed(() => this.allPoints.value.length);

    this.window = computed(() => {
      const r = this.range.value;
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

    this.bySource = computed(() => nodeStats(this.points.value, (p) => p.source));
    this.pathStarts = computed(() => nodeStats(this.points.value, (p) => p.path[0]));
    this.pathEnds = computed(() => nodeStats(this.points.value, (p) => p.path[p.path.length - 1]));
    this.lastHops = computed(() => lastHopSignalStats(this.points.value));

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
    this.channelMessages = computed(() => channelMessageCounts(this.points.value));
    this.compression = computed(() => compressionStats(this.points.value));
    this.routes = computed(() => packetRoutes(this.points.value));
    this.recentRoutes = computed(() => recentPacketRoutes(this.points.value));
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
    const lastHopOf: StatPacket[] = [];
    for (const p of this.allPoints.value) {
      if (p.source?.key === key) from.push(p);
      else if (p.path.some((n) => n.key === key)) via.push(p);
      if (p.direction === 'in' && p.lastHop?.key === key) lastHopOf.push(p);
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
      lastHopOf,
      lastHopSignal: lastHopOf.map((p) => ({ ts: p.ts, snr: p.snr, rssi: p.rssi, direct: p.direct, id: p.id })),
      lastHopSummary: snrSummary(lastHopOf),
    };
  }

  /**
   * Selects the date range (inclusive epoch ms, null = open): the shared filter's `from` / `to`, so
   * the packet log follows. Resolves when both have reloaded.
   */
  async setRange(r: StatsRange): Promise<void> {
    const from = r.from !== null && Number.isFinite(r.from) ? r.from : null;
    const to = r.to !== null && Number.isFinite(r.to) ? r.to : null;
    const cur = this.range.peek();
    if (cur.from === from && cur.to === to) return this.settled();
    const log = this.#shared.setFilter({ from: from ?? undefined, to: to ?? undefined });
    await Promise.all([log, this.reload()]);
  }

  /**
   * Adds a drill-down filter to the shared filter, replacing any criterion on the same field
   * (see {@link withStatsFilter}). `points` update at once; resolves when the packet log has reloaded.
   */
  addFilter(f: StatsFilter): Promise<void> {
    return this.#shared.setFilter(withStatsFilter(this.#shared.filter.peek(), f), { replace: true });
  }

  /** Removes the criterion on `field` (no-op when there is none). */
  removeFilter(field: StatsFilterField): Promise<void> {
    const cur = this.#shared.filter.peek();
    const next = withoutStatsFilter(cur, field);
    if (Object.keys(next).length === Object.keys(cur).length) return Promise.resolve();
    return this.#shared.setFilter(next, { replace: true });
  }

  /** Clears every criterion of the shared filter except the date range. */
  clearFilters(): Promise<void> {
    const cur = this.#shared.filter.peek();
    const keep: PacketFilter = {};
    if (cur.from !== undefined) keep.from = cur.from;
    if (cur.to !== undefined) keep.to = cur.to;
    if (Object.keys(cur).length === Object.keys(keep).length) return Promise.resolve();
    return this.#shared.setFilter(keep, { replace: true });
  }

  // ---- DrillSource (the packet log matches PacketFilter.drill with these) ----

  /** The derived point of record `id` in the current range, if any. */
  point(id: number): StatPacket | undefined {
    return this.#byId.peek().get(id);
  }

  /** Resolves once the pending load / reload has finished (without waiting for `deps.ready`). */
  async loaded(): Promise<void> {
    await super.settled();
  }

  watch(l: { appended(rec: PacketRecord): void; reloaded(): void }): Unsubscribe {
    this.#watchers.add(l);
    return () => void this.#watchers.delete(l);
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
      // the shared filter's from / to (setRange, or the Packets tab's date inputs)
      effect(() => {
        const r = this.range.value;
        const used = this.#usedRange;
        if (used !== undefined && (r.from !== used.from || r.to !== used.to)) untracked(() => void this.reload());
      }),
      // channel PSKs decide GRP_TXT senders / text, DM keys TXT_MSG text: re-derive when they change
      effect(() => {
        const ch = channelsSignature(this.#deps.context.value.channels);
        const dm = this.#dmSig.value;
        const used = this.#usedSig;
        if (used !== undefined && (ch !== used.ch || dm !== used.dm)) untracked(() => void this.reload());
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
    const dm = this.#deps.dmKeys?.peek() ?? null;
    const sig: DeriveSig = { ch: channelsSignature(channels), dm: this.#dmSig.peek() };
    this.#usedSig = sig;
    const r = this.range.peek();
    this.#usedRange = r;
    const [recs, bounds] = await Promise.all([
      store.packets.all({ ...(r.from !== null ? { from: r.from } : {}), ...(r.to !== null ? { to: r.to } : {}) }),
      store.packets.tsBounds(),
    ]);
    const was = this.#rawCacheSig;
    const cached = this.#rawCache;
    const raws = await Promise.all(
      recs.map((rec) => {
        const c = cached.get(rec.id);
        return c && reusable(c, was, sig) ? c : derive(rec, channels, dm);
      }),
    );
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
    for (const w of [...this.#watchers]) w.reloaded();
  }

  protected reset(): void {
    this.#gen++;
    this.#usedSig = undefined;
    this.#usedRange = undefined;
    this.#rawIds = new Set();
    this.#rawCache = new Map();
    this.#rawCacheSig = { ch: '', dm: '' };
    batch(() => {
      this.#raw.value = [];
      this.#bounds.value = null;
    });
  }

  #inRange(ts: number): boolean {
    const r = this.range.peek();
    return (r.from === null || ts >= r.from) && (r.to === null || ts <= r.to);
  }

  async #append(store: RadioStore, rec: PacketRecord): Promise<void> {
    if (this.store !== store) return;
    this.#bounds.value = mergeBounds(this.#bounds.peek(), [rec.ts]);
    if (!this.#inRange(rec.ts) || this.#rawIds.has(rec.id)) return;
    const raw = await derive(rec, this.#deps.context.peek().channels, this.#deps.dmKeys?.peek() ?? null);
    if (this.store !== store || this.#rawIds.has(rec.id) || !this.#inRange(rec.ts)) return;
    this.#rawIds.add(rec.id);
    this.#liveSink?.push(raw);
    const used = this.#usedSig;
    if (used !== undefined && used.ch === this.#rawCacheSig.ch && used.dm === this.#rawCacheSig.dm) this.#rawCache.set(rec.id, raw);
    const cur = this.#raw.peek();
    const last = cur[cur.length - 1];
    if (!last || compareRaw(last, raw) <= 0) {
      this.#raw.value = [...cur, raw];
    } else {
      let lo = 0;
      let hi = cur.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (compareRaw(cur[mid]!, raw) <= 0) lo = mid + 1;
        else hi = mid;
      }
      this.#raw.value = [...cur.slice(0, lo), raw, ...cur.slice(lo)];
    }
    for (const w of [...this.#watchers]) w.appended(rec);
  }
}

function mergeBounds(b: { first: number; last: number } | null, ts: readonly number[]): { first: number; last: number } | null {
  let out = b;
  for (const t of ts) out = out ? { first: Math.min(out.first, t), last: Math.max(out.last, t) } : { first: t, last: t };
  return out;
}

function sameFilters(a: readonly StatsFilter[], b: readonly StatsFilter[]): boolean {
  return a.length === b.length && a.every((x, i) => x.field === b[i]?.field && x.value === b[i]?.value && x.label === b[i]?.label);
}

function sameParams(a: LoraParams | null, b: LoraParams | null): boolean {
  return a === b || (a !== null && b !== null && a.sf === b.sf && a.bwKhz === b.bwKhz && a.cr === b.cr);
}

function selfNode(si: SelfInfo | null, store: RadioStore | null): SelfNode | null {
  if (si) return { key: toHex(si.pubKey), pubKey: si.pubKey, name: si.name || 'You', lat: si.lat, lon: si.lon };
  if (store) return { key: store.pubKey, pubKey: fromHex(store.pubKey), name: 'You', lat: 0, lon: 0 };
  return null;
}
