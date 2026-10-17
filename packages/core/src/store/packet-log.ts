/**
 * Log of every over-the-air packet the radio reports or sends (roadmap goal 3), with radio
 * metadata. Packet envelope / hash per docs/mesh-packet-format.md §1.
 */

import type { Command, DeviceFrame } from '../protocol/types.js';
import { TxtType } from '../protocol/constants.js';
import { toHex } from '../util/bytes.js';
import { PayloadType, RouteType, payloadTypeName, routeTypeName } from '../packet/constants.js';
import { packetHash, parsePacket } from '../packet/packet.js';
import { buildTracePayload } from '../packet/payloads.js';
import {
  INDEX,
  STORE,
  type PacketBytesFormat,
  type PacketDirection,
  type PacketRecord,
  type PacketSource,
} from './schema.js';
import { safeEmit } from './events.js';
import { packetSourceOf, sourceMatches } from './packet-source.js';
import { combine } from './frame-log.js';
import {
  TimeLog,
  optNumber,
  optString,
  reqNumber,
  reqOneOf,
  reqString,
  type LogQueryBase,
  type QueryPlan,
} from './time-log.js';

export interface PacketInput {
  direction: PacketDirection;
  bytes: Uint8Array;
  /** Default 'packet' (a full over-the-air packet that is parsed for type/route/path/hash). */
  format?: PacketBytesFormat;
  /** Default 'other'. */
  source?: PacketSource;
  ts?: number;
  snr?: number;
  rssi?: number;
  sourceFrameId?: number;
  /** For `format: 'payload'` (no envelope): what is known about the packet. Default -1. */
  routeType?: number;
  payloadType?: number;
  pathLen?: number;
  /** Default: a short structural summary such as `GRP_TXT FLOOD 2 hops, 48 B`. */
  decodedSummary?: string;
}

export interface PacketQuery extends LogQueryBase {
  direction?: PacketDirection;
  payloadType?: number;
  routeType?: number;
  source?: PacketSource;
  /** Exact packet hash hex (finds re-heard copies of one packet). Results ordered by id. */
  hash?: string;
  /**
   * Source node: a public key or key prefix hex (at least 1 byte). Matches packets whose source
   * hash byte matches and whose full source key, when known, agrees (see packet-source.ts). Uses
   * the `srcHash_ts` index. Takes precedence over `hash`.
   */
  src?: string;
  /** Extra residual predicate (applied before offset/limit, and by count/export). */
  match?: (r: PacketRecord) => boolean;
}

const PACKET_SOURCES = ['logRxData', 'rawData', 'traceData', 'sent', 'import', 'other'] as const;

/** Derives the stored record (minus id) from an input: parses the envelope and hashes it. */
export async function packetRecordFromInput(input: PacketInput, now: number): Promise<Omit<PacketRecord, 'id'>> {
  const format = input.format ?? 'packet';
  let routeType = input.routeType ?? -1;
  let payloadType = input.payloadType ?? -1;
  let pathLen = input.pathLen ?? -1;
  let hash = '';
  let parseError: string | undefined;
  let summary: string | undefined;
  if (format === 'packet') {
    try {
      const p = parsePacket(input.bytes);
      routeType = p.routeType;
      payloadType = p.payloadType;
      pathLen = p.pathLen;
      hash = toHex(await packetHash(p));
      summary = `${payloadTypeName(p.payloadType)} ${routeTypeName(p.routeType)} ${p.pathHashCount} hop${p.pathHashCount === 1 ? '' : 's'}, ${input.bytes.length} B`;
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
      summary = `unparsable, ${input.bytes.length} B`;
    }
  } else if (format === 'none') {
    summary = payloadType >= 0 ? `${payloadTypeName(payloadType)} (requested)` : 'requested transmission';
  } else {
    if (payloadType >= 0) {
      hash = toHex(await packetHash({ payloadType, pathLen: Math.max(0, pathLen), payload: input.bytes }));
      summary = `${payloadTypeName(payloadType)} payload, ${input.bytes.length} B`;
    } else {
      summary = `payload, ${input.bytes.length} B`;
    }
  }
  const rec: Omit<PacketRecord, 'id'> = {
    ts: input.ts ?? now,
    direction: input.direction,
    bytes: input.bytes,
    format,
    source: input.source ?? 'other',
    routeType,
    payloadType,
    pathLen,
    hash,
  };
  if (input.snr !== undefined) rec.snr = input.snr;
  if (input.rssi !== undefined) rec.rssi = input.rssi;
  if (input.sourceFrameId !== undefined) rec.sourceFrameId = input.sourceFrameId;
  const decodedSummary = input.decodedSummary ?? summary;
  if (decodedSummary !== undefined) rec.decodedSummary = decodedSummary;
  if (parseError !== undefined) rec.parseError = parseError;
  withSource(rec);
  return rec;
}

/** Sets `srcHash` / `srcKey` from the record's bytes (dropping any stale values). */
function withSource<T extends Omit<PacketRecord, 'id'>>(rec: T): T {
  delete rec.srcHash;
  delete rec.srcKey;
  const src = packetSourceOf(rec);
  if (src) {
    rec.srcHash = src.srcHash;
    if (src.srcKey !== undefined) rec.srcKey = src.srcKey;
  }
  return rec;
}

/** One packet in a {@link PacketLog.sourceActivity} scan. */
export interface SourceSighting {
  id: number;
  ts: number;
  direction: PacketDirection;
  payloadType: number;
  /** The packet carried the full source key (so it is certainly from the node). */
  keyed: boolean;
}

/**
 * Maps a decoded device push that carries an over-the-air packet to a {@link PacketInput}:
 * LOG_RX_DATA (full packet), RAW_DATA (RAW_CUSTOM payload), TRACE_DATA (trace payload rebuilt
 * from the push fields) and CONTROL_DATA (CONTROL payload). Returns null for other frames.
 */
export function packetInputFromFrame(frame: DeviceFrame, meta: { ts?: number; sourceFrameId?: number } = {}): PacketInput | null {
  const base = {
    direction: 'rx' as const,
    ...(meta.ts !== undefined ? { ts: meta.ts } : {}),
    ...(meta.sourceFrameId !== undefined ? { sourceFrameId: meta.sourceFrameId } : {}),
  };
  switch (frame.kind) {
    case 'logRxData':
      return { ...base, bytes: frame.packet, format: 'packet', source: 'logRxData', snr: frame.snr, rssi: frame.rssi };
    case 'rawData':
      return {
        ...base,
        bytes: frame.payload,
        format: 'payload',
        source: 'rawData',
        snr: frame.snr,
        rssi: frame.rssi,
        payloadType: PayloadType.RAW_CUSTOM,
        routeType: RouteType.DIRECT,
        pathLen: 0,
      };
    case 'traceData':
      return {
        ...base,
        bytes: buildTracePayload({ tag: frame.tag, authCode: frame.authCode, flags: frame.flags, hashes: frame.pathHashes }),
        format: 'payload',
        source: 'traceData',
        snr: frame.finalSnr,
        payloadType: PayloadType.TRACE,
        routeType: RouteType.DIRECT,
        pathLen: frame.snrs.length, // on air, a TRACE path carries one SNR byte per hop (hashes live in the payload)
      };
    case 'controlData':
      return {
        ...base,
        bytes: frame.payload,
        format: 'payload',
        source: 'other',
        snr: frame.snr,
        rssi: frame.rssi,
        payloadType: PayloadType.CONTROL,
        pathLen: frame.pathLen,
      };
    default:
      return null;
  }
}

/** Names resolved from the store for a sent-packet summary. */
export interface CommandPacketNames {
  /** Name of the contact a command addresses (by its pubkey / prefix). */
  peer?: string;
  /** Name of the channel a channel command addresses. */
  channel?: string;
}

const quoted = (s: string): string => JSON.stringify(s.length > 60 ? `${s.slice(0, 59)}…` : s);
const hex6 = (b: Uint8Array): string => toHex(b.subarray(0, 6));

/**
 * Maps a host command that makes the radio transmit to a `tx` {@link PacketInput}, or null for
 * commands that do not transmit. The companion protocol does not echo transmitted packets, so the
 * record holds what the command asked for (companion-protocol.md §4; firmware MyMesh.cpp
 * handleCmdFrame):
 * - SEND_RAW_PACKET (0x41): the complete packet → `format: 'packet'`.
 * - SEND_RAW_DATA (0x19, RAW_CUSTOM via `sendDirect` along the given path), SEND_CONTROL_DATA
 *   (0x37, CONTROL via `sendZeroHop`), SEND_TRACE_PATH (0x24, TRACE via `sendDirect`: tag, auth,
 *   flags, then the path hashes appended to the payload, path_len 0): the exact payload →
 *   `format: 'payload'`.
 * - Everything the firmware builds and encrypts itself (TXT_MSG, GRP_TXT, GRP_DATA, ADVERT,
 *   REQ, ANON_REQ): no bytes → `format: 'none'`, with the requested fields in `decodedSummary`.
 *   Route type is set only where the firmware fixes it (channel text / adverts: flood or zero-hop);
 *   DMs and requests go direct or flood depending on the contact's stored path, so -1.
 */
export function packetInputFromCommand(
  cmd: Command,
  meta: { ts?: number; sourceFrameId?: number; names?: CommandPacketNames } = {},
): PacketInput | null {
  const base = {
    direction: 'tx' as const,
    source: 'sent' as const,
    ...(meta.ts !== undefined ? { ts: meta.ts } : {}),
    ...(meta.sourceFrameId !== undefined ? { sourceFrameId: meta.sourceFrameId } : {}),
  };
  const peer = (key: Uint8Array): string => meta.names?.peer ?? hex6(key);
  const channel = (idx: number): string => meta.names?.channel ?? `slot ${idx}`;
  const none = (payloadType: number, decodedSummary: string, routeType = -1, pathLen = -1): PacketInput => ({
    ...base,
    bytes: new Uint8Array(0),
    format: 'none',
    payloadType,
    routeType,
    pathLen,
    decodedSummary,
  });
  const name = payloadTypeName;
  switch (cmd.kind) {
    case 'sendTxtMsg': {
      const t = cmd.txtType ?? TxtType.PLAIN;
      const kind = t === TxtType.CLI_DATA ? ' CLI' : t === TxtType.SIGNED_PLAIN ? ' signed' : '';
      const attempt = cmd.attempt ? ` (attempt ${cmd.attempt})` : '';
      return none(PayloadType.TXT_MSG, `${name(PayloadType.TXT_MSG)}${kind} → ${peer(cmd.recipient)}: ${quoted(cmd.text)}${attempt}`);
    }
    case 'sendChannelTxtMsg':
      return none(PayloadType.GRP_TXT, `${name(PayloadType.GRP_TXT)} ${channel(cmd.channelIdx)}: ${quoted(cmd.text)}`, RouteType.FLOOD, 0);
    case 'sendChannelData': {
      const direct = cmd.pathLen !== undefined && cmd.pathLen !== 0xff;
      const hex = cmd.dataType.toString(16).padStart(4, '0');
      return none(
        PayloadType.GRP_DATA,
        `${name(PayloadType.GRP_DATA)} ${channel(cmd.channelIdx)}: data type 0x${hex}, ${cmd.payload.length} B`,
        direct ? RouteType.DIRECT : RouteType.FLOOD,
        direct ? (cmd.pathLen ?? -1) : 0,
      );
    }
    case 'sendSelfAdvert':
      return none(PayloadType.ADVERT, `${name(PayloadType.ADVERT)} self (${cmd.flood ? 'flood' : 'zero-hop'})`, cmd.flood ? RouteType.FLOOD : RouteType.DIRECT, 0);
    case 'shareContact':
      return none(PayloadType.ADVERT, `${name(PayloadType.ADVERT)} sharing ${peer(cmd.pubKey)} (zero-hop)`, RouteType.DIRECT, 0);
    case 'sendLogin':
      return none(PayloadType.ANON_REQ, `${name(PayloadType.ANON_REQ)} login → ${peer(cmd.pubKey)}`);
    case 'sendAnonReq':
      return none(PayloadType.ANON_REQ, `${name(PayloadType.ANON_REQ)} → ${peer(cmd.pubKey)}, ${cmd.data.length} B`);
    case 'sendStatusReq':
      return none(PayloadType.REQ, `${name(PayloadType.REQ)} status → ${peer(cmd.pubKey)}`);
    case 'sendTelemetryReq':
      // no pubKey = the radio's own telemetry: answered locally, nothing is transmitted
      return cmd.pubKey ? none(PayloadType.REQ, `${name(PayloadType.REQ)} telemetry → ${peer(cmd.pubKey)}`) : null;
    case 'sendBinaryReq': {
      const hex = (cmd.data[0] ?? 0).toString(16).padStart(2, '0');
      return none(PayloadType.REQ, `${name(PayloadType.REQ)} type 0x${hex} → ${peer(cmd.pubKey)}, ${cmd.data.length} B`);
    }
    case 'sendPathDiscoveryReq':
      // firmware clears the contact's path for this request, so it always floods
      return none(PayloadType.REQ, `${name(PayloadType.REQ)} path discovery → ${peer(cmd.pubKey)}`, RouteType.FLOOD, 0);
    case 'sendTracePath': {
      const flags = Math.max(0, [1, 2, 4, 8].indexOf(cmd.pathHashSize ?? 1));
      return {
        ...base,
        bytes: buildTracePayload({ tag: cmd.tag, authCode: cmd.authCode, flags, hashes: cmd.path }),
        format: 'payload',
        payloadType: PayloadType.TRACE,
        routeType: RouteType.DIRECT,
        pathLen: 0,
      };
    }
    case 'sendRawData':
      return { ...base, bytes: cmd.payload, format: 'payload', payloadType: PayloadType.RAW_CUSTOM, routeType: RouteType.DIRECT, pathLen: cmd.pathLen };
    case 'sendControlData':
      return { ...base, bytes: cmd.payload, format: 'payload', payloadType: PayloadType.CONTROL, routeType: RouteType.DIRECT, pathLen: 0 };
    case 'sendRawPacket':
      return { ...base, bytes: cmd.packet, format: 'packet' };
    default:
      return null;
  }
}

export class PacketLog extends TimeLog<PacketRecord, PacketQuery> {
  protected readonly storeName = STORE.packets;
  protected readonly tsIndex = INDEX.packets.ts;
  protected readonly exportFormat = 'meshcore-web/packets';

  protected emitRecord(record: PacketRecord): void {
    safeEmit(this.emitter, 'packet', record);
  }

  async append(input: PacketInput): Promise<PacketRecord> {
    const rec = await packetRecordFromInput(input, this.now());
    const [out] = await this.insert([rec]);
    return out!;
  }

  /** Appends several packets in one transaction (hashes are computed first). */
  async appendMany(inputs: readonly PacketInput[]): Promise<PacketRecord[]> {
    const now = this.now();
    const recs = await Promise.all(inputs.map((i) => packetRecordFromInput(i, now)));
    return this.insert(recs);
  }

  /** Appends the packet carried by `frame` if it is a packet-bearing push; else resolves null. */
  async appendFromFrame(frame: DeviceFrame, meta: { ts?: number; sourceFrameId?: number } = {}): Promise<PacketRecord | null> {
    const input = packetInputFromFrame(frame, meta);
    return input ? this.append(input) : null;
  }

  /** All stored copies of one packet (same hash), oldest first. */
  async byHash(hash: string): Promise<PacketRecord[]> {
    return this.db.getAll<PacketRecord>(this.storeName, { index: INDEX.packets.hash, query: this.db.only(hash.toLowerCase()) });
  }

  /** Normalised `src` query value: lowercase hex, at least one byte, or null. */
  static srcQuery(node: string): string | null {
    const n = node.trim().toLowerCase();
    return /^([0-9a-f]{2})+$/.test(n) ? n : null;
  }

  /**
   * Every logged packet from source node `node` (key or key prefix hex) in the ts window, oldest
   * first, as light rows (no bytes kept). One `srcHash_ts` index range scan.
   */
  async sourceActivity(node: string, q: { from?: number; to?: number } = {}): Promise<SourceSighting[]> {
    const n = PacketLog.srcQuery(node);
    if (!n) return [];
    const range = this.tsRange([n.slice(0, 2)], q);
    return this.db.transaction(this.storeName, 'readonly', async (t) => {
      const out: SourceSighting[] = [];
      await t.store<PacketRecord>(this.storeName).each({ index: INDEX.packets.srcHashTs, query: range }, (r) => {
        if (sourceMatches(r, n)) out.push({ id: r.id, ts: r.ts, direction: r.direction, payloadType: r.payloadType, keyed: r.srcKey !== undefined });
      });
      return out;
    });
  }

  protected plan(q: PacketQuery): QueryPlan<PacketRecord> {
    const { direction, routeType, source, payloadType } = q;
    const dirF = direction === undefined ? undefined : (r: PacketRecord) => r.direction === direction;
    const routeF = routeType === undefined ? undefined : (r: PacketRecord) => r.routeType === routeType;
    const srcF = source === undefined ? undefined : (r: PacketRecord) => r.source === source;
    const ptF = payloadType === undefined ? undefined : (r: PacketRecord) => r.payloadType === payloadType;
    const m = q.match;
    if (q.src !== undefined) {
      // an invalid node matches nothing ('' is never a stored srcHash)
      const n = PacketLog.srcQuery(q.src) ?? '';
      const hashF = q.hash === undefined ? undefined : (r: PacketRecord) => r.hash === q.hash!.toLowerCase();
      return {
        index: INDEX.packets.srcHashTs,
        query: this.tsRange([n.slice(0, 2)], q),
        ...combine([(r: PacketRecord) => sourceMatches(r, n), dirF, routeF, srcF, ptF, hashF, m]),
      };
    }
    if (q.hash !== undefined) {
      return {
        index: INDEX.packets.hash,
        query: this.db.only(q.hash.toLowerCase()),
        ...combine([this.tsFilter(q), dirF, routeF, srcF, ptF, m]),
      };
    }
    if (payloadType !== undefined) {
      return { index: INDEX.packets.payloadTypeTs, query: this.tsRange([payloadType], q), ...combine([dirF, routeF, srcF, m]) };
    }
    if (direction !== undefined) {
      return { index: INDEX.packets.directionTs, query: this.tsRange([direction], q), ...combine([routeF, srcF, m]) };
    }
    return { index: INDEX.packets.ts, query: this.tsRange([], q), ...combine([routeF, srcF, m]) };
  }

  protected validateImported(o: Record<string, unknown>, bytes: Uint8Array): Omit<PacketRecord, 'id'> {
    const rec: Omit<PacketRecord, 'id'> = {
      ts: reqNumber(o, 'ts'),
      direction: reqOneOf(o, 'direction', ['rx', 'tx'] as const),
      bytes,
      format: reqOneOf(o, 'format', ['packet', 'payload', 'none'] as const),
      source: reqOneOf(o, 'source', PACKET_SOURCES),
      routeType: reqNumber(o, 'routeType'),
      payloadType: reqNumber(o, 'payloadType'),
      pathLen: reqNumber(o, 'pathLen'),
      hash: reqString(o, 'hash').toLowerCase(),
    };
    const snr = optNumber(o, 'snr');
    const rssi = optNumber(o, 'rssi');
    const sourceFrameId = optNumber(o, 'sourceFrameId');
    const decodedSummary = optString(o, 'decodedSummary');
    const parseError = optString(o, 'parseError');
    if (snr !== undefined) rec.snr = snr;
    if (rssi !== undefined) rec.rssi = rssi;
    if (sourceFrameId !== undefined) rec.sourceFrameId = sourceFrameId;
    if (decodedSummary !== undefined) rec.decodedSummary = decodedSummary;
    if (parseError !== undefined) rec.parseError = parseError;
    // derived from the bytes, never trusted from the file
    return withSource(rec);
  }
}
