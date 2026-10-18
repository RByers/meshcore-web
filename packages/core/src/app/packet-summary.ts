/**
 * One-line descriptions of logged over-the-air packets and companion frames for list rows, plus
 * the node references a packet carries (for the packet log's node filter).
 * Layouts: docs/mesh-packet-format.md §1, §3; docs/companion-protocol.md §4-§6.
 */

import { toHex } from '../util/bytes.js';
import { smazTryDecode } from '../util/smaz.js';
import { ContactType, cmdName, decodePathLen, deviceFrameName, isValidPathLen } from '../protocol/constants.js';
import { PayloadType, payloadTypeName, routeTypeName } from '../packet/constants.js';
import { parsePacket, splitPath } from '../packet/packet.js';
import {
  decryptPayload,
  parseGrpDataPlaintext,
  parseGrpTxtPlaintext,
  parsePayload,
  parseTxtMsgPlaintext,
  type ParsedPayload,
  type PeerDatagramPayload,
  type TxtMsgPlaintext,
} from '../packet/payloads.js';
import type { FrameRecord, PacketRecord, PacketSendStatus } from '../store/schema.js';

/** Names and keys known to the store, used to resolve hashes and decrypt channel traffic. */
export interface SummaryContext {
  /** Known nodes (contacts, plus the radio itself), public key hex. */
  nodes: readonly { key: string; name: string }[];
  /** Channels with their 1-byte hash (SHA256(psk)[0]). */
  channels: readonly { name: string; psk: Uint8Array; hash: number }[];
}

export const EMPTY_SUMMARY_CONTEXT: SummaryContext = { nodes: [], channels: [] };

/** Structural view of a packet record (no decryption). */
export interface PacketView {
  typeName: string;
  /** Route type name, or '' when unknown (payload-only records). */
  routeName: string;
  /** Hop count (path entries; SNR entries for TRACE), null when unknown. */
  hops: number | null;
  /** Path entries as hex (empty for TRACE, whose path holds SNRs). */
  path: string[];
  /** Node hashes (path entries, src/dest hashes) and full / prefix public keys found in the packet. */
  nodeHashes: string[];
  nodeKeys: string[];
  /** Sync one-line summary (no decrypted content). */
  summary: string;
  /** Source / destination named by the payload ({@link packetEndpoints}). */
  endpoints: PacketEndpoints;
  /** The parsed payload, when it parsed. */
  payload?: ParsedPayload;
  /** The payload bytes (the record's bytes for payload-only records). */
  payloadBytes: Uint8Array;
  error?: string;
}

/**
 * The nodes a packet's payload names as its ends (docs/mesh-packet-format.md): REQ / RESPONSE /
 * TXT_MSG / PATH carry `dest_hash` and `src_hash` (§3.0: `dest_pubkey[0]`, `src_pubkey[0]`);
 * ANON_REQ carries `dest_hash` and the sender's full public key (§3.8). Other payloads name none.
 */
export interface PacketEndpoints {
  /** The source: a 1-byte hash as hex ("a3"), or ANON_REQ's full sender key (64 hex). */
  src: string | null;
  /** The destination's 1-byte hash as hex. */
  dst: string | null;
}

const NO_ENDPOINTS: PacketEndpoints = { src: null, dst: null };

/** {@link PacketEndpoints} of a parsed payload (none for other payloads, or when it didn't parse). */
export function packetEndpoints(p: ParsedPayload | undefined): PacketEndpoints {
  switch (p?.kind) {
    case 'req':
    case 'response':
    case 'txtMsg':
    case 'path':
      return { src: hex2(p.srcHash), dst: hex2(p.destHash) };
    case 'anonReq':
      return { src: toHex(p.senderPublicKey), dst: hex2(p.destHash) };
    default:
      return NO_ENDPOINTS;
  }
}

const NODE_TYPE: Record<number, string> = Object.fromEntries(Object.entries(ContactType).map(([k, v]) => [v, k.toLowerCase()]));

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** Name for a 1-byte node hash (or a longer hash / prefix hex), else the hex itself. */
export function nodeLabel(ctx: SummaryContext, hashHex: string): string {
  const h = hashHex.toLowerCase();
  const matches = ctx.nodes.filter((n) => n.key.startsWith(h));
  if (matches.length === 1) return matches[0]!.name || h;
  if (matches.length > 1) return `${h} (${matches.map((m) => m.name).join('|')})`;
  return h;
}

/** Name for a public key or key prefix, else its first 4 bytes. */
export function keyLabel(ctx: SummaryContext, keyHex: string): string {
  const k = keyHex.toLowerCase();
  const m = ctx.nodes.filter((n) => n.key.startsWith(k));
  return m.length === 1 && m[0]!.name ? m[0]!.name : `${k.slice(0, 8)}…`;
}

function quote(s: string, max = 60): string {
  const t = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return JSON.stringify(t);
}

/** Parses a packet record into its structural view. Never throws. */
export function viewPacket(rec: PacketRecord, ctx: SummaryContext = EMPTY_SUMMARY_CONTEXT): PacketView {
  let payloadType = rec.payloadType;
  let payloadBytes = rec.bytes;
  let routeName = rec.routeType >= 0 ? routeTypeName(rec.routeType) : '';
  let hops: number | null = null;
  let path: string[] = [];
  const nodeHashes: string[] = [];
  const nodeKeys: string[] = [];
  let error: string | undefined;
  if (rec.format === 'packet') {
    try {
      const p = parsePacket(rec.bytes);
      payloadType = p.payloadType;
      payloadBytes = p.payload;
      routeName = routeTypeName(p.routeType);
      hops = p.pathHashCount;
      if (p.payloadType !== PayloadType.TRACE) path = splitPath(p.path, p.pathHashSize).map(toHex);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  } else if (rec.pathLen >= 0 && isValidPathLen(rec.pathLen)) {
    hops = decodePathLen(rec.pathLen).hops;
  }
  nodeHashes.push(...path);
  const typeName = payloadType >= 0 ? payloadTypeName(payloadType) : 'UNKNOWN';
  const view: PacketView = { typeName, routeName, hops, path, nodeHashes, nodeKeys, summary: '', endpoints: NO_ENDPOINTS, payloadBytes };
  if (rec.format === 'none') {
    // a requested transmission: no bytes, only what the command asked for
    view.summary = rec.decodedSummary ?? `${typeName} (requested)`;
    return view;
  }
  if (error !== undefined) {
    view.error = error;
    view.summary = `unparsable: ${error}`;
    return view;
  }
  let payload: ParsedPayload | undefined;
  try {
    payload = parsePayload(payloadType, payloadBytes);
    view.payload = payload;
    view.endpoints = packetEndpoints(payload);
  } catch (e) {
    view.error = e instanceof Error ? e.message : String(e);
    view.summary = `${typeName} (malformed: ${view.error})`;
    return view;
  }
  view.summary = describePayload(typeName, payload, ctx, nodeHashes, nodeKeys);
  return view;
}

function describePayload(typeName: string, p: ParsedPayload, ctx: SummaryContext, hashes: string[], keys: string[]): string {
  switch (p.kind) {
    case 'req':
    case 'response':
    case 'txtMsg':
    case 'path': {
      const src = hex2(p.srcHash);
      const dst = hex2(p.destHash);
      hashes.push(src, dst);
      return `${typeName} ${nodeLabel(ctx, src)} → ${nodeLabel(ctx, dst)}`;
    }
    case 'ack':
      return `${typeName} ${toHex(p.ackCode)}`;
    case 'advert': {
      const key = toHex(p.publicKey);
      keys.push(key);
      const a = p.app;
      const name = a.name !== undefined ? quote(a.name, 32) : key.slice(0, 8);
      const type = NODE_TYPE[a.nodeType] ?? `type ${a.nodeType}`;
      const loc = a.latitude !== undefined && a.longitude !== undefined ? ` ${a.latitude.toFixed(4)},${a.longitude.toFixed(4)}` : '';
      return `${typeName} ${name} (${type})${loc}`;
    }
    case 'grpTxt':
    case 'grpData': {
      const ch = ctx.channels.filter((c) => c.hash === p.channelHash);
      return `${typeName} ${ch.length ? ch.map((c) => c.name).join('|') : `channel ${hex2(p.channelHash)}`}${ch.length ? '' : ' (no key)'}`;
    }
    case 'anonReq': {
      const key = toHex(p.senderPublicKey);
      keys.push(key);
      const dst = hex2(p.destHash);
      hashes.push(dst);
      return `${typeName} ${keyLabel(ctx, key)} → ${nodeLabel(ctx, dst)}`;
    }
    case 'trace': {
      const list = splitPath(p.hashes, p.hashSize).map(toHex);
      hashes.push(...list);
      return `${typeName} tag ${p.tag.toString(16).padStart(8, '0')} via ${list.length ? list.map((h) => nodeLabel(ctx, h)).join(' → ') : '(none)'}`;
    }
    case 'multipart':
      return `${typeName} ${payloadTypeName(p.innerType)}${p.ackCode ? ` ${toHex(p.ackCode)}` : ''} (${p.remaining} remaining)`;
    case 'control':
      if ('publicKey' in p) {
        const key = toHex(p.publicKey);
        keys.push(key);
        return `${typeName} DISCOVER_RESP ${keyLabel(ctx, key)} (${NODE_TYPE[p.nodeType] ?? p.nodeType}) ${p.snr} dB`;
      }
      if ('typeFilter' in p) return `${typeName} DISCOVER_REQ tag ${p.tag.toString(16).padStart(8, '0')}`;
      return `${typeName} sub-type 0x${hex2(p.subType)}`;
    case 'rawCustom':
      return `${typeName} ${p.data.length} B`;
    case 'unknown':
      return `${typeName} ${p.data.length} B`;
  }
}

/**
 * Keys for decrypting direct messages to / from this radio in summaries (only available when the
 * user opted in to storing the radio's private key).
 */
export interface DmKeys {
  selfPublicKey: Uint8Array;
  /** Known contact public keys. */
  contacts: readonly Uint8Array[];
  /** ECDH shared secret with a contact (callers cache it); null if it cannot be computed. */
  sharedSecret(peer: Uint8Array): Promise<Uint8Array | null>;
}

/**
 * Full summary: the structural one, plus decrypted content where a channel PSK from `ctx`
 * verifies (GRP_TXT shows the text, GRP_DATA the data type and length), and, with `dm` keys, the
 * text of TXT_MSG packets between this radio and a contact.
 */
export async function summarizePacket(
  rec: PacketRecord,
  ctx: SummaryContext = EMPTY_SUMMARY_CONTEXT,
  view = viewPacket(rec, ctx),
  dm?: DmKeys,
): Promise<string> {
  const p = view.payload;
  // a DM's text needs the radio's private key (opt-in); say so rather than look like a non-message
  if (p?.kind === 'txtMsg') return (dm ? await dmSummary(p, view, dm) : null) ?? `${view.summary} (encrypted)`;
  if (!p || (p.kind !== 'grpTxt' && p.kind !== 'grpData')) return view.summary;
  for (const ch of ctx.channels) {
    if (ch.hash !== p.channelHash) continue;
    let pt: Uint8Array | null = null;
    try {
      pt = await decryptPayload(p, ch.psk);
    } catch {
      pt = null;
    }
    if (!pt) continue;
    try {
      if (p.kind === 'grpTxt') {
        const t = parseGrpTxtPlaintext(pt);
        const smaz = smazTryDecode(t.message);
        return `${view.typeName} ${ch.name}: ${quote(t.text)}${smaz === null ? '' : ` (SMAZ: ${quote(smaz)})`}`;
      }
      const d = parseGrpDataPlaintext(pt);
      return `${view.typeName} ${ch.name}: data type 0x${d.dataType.toString(16).padStart(4, '0')}, ${d.dataLen} B`;
    } catch {
      return `${view.typeName} ${ch.name} (decrypted, malformed)`;
    }
  }
  return view.summary;
}

async function dmSummary(p: PeerDatagramPayload, view: PacketView, dm: DmKeys): Promise<string | null> {
  const r = await decryptDm(p, dm);
  if (r === null) return null;
  if (r === 'malformed') return `${view.summary} (decrypted, malformed)`;
  return `${view.summary}: ${quote(r.text)}`;
}

/**
 * Decrypts a TXT_MSG between this radio and a known contact (either direction): the parsed
 * plaintext, 'malformed' when a contact's key verified but the plaintext did not parse, or null
 * when no shared secret decrypts it.
 */
export async function decryptDm(p: PeerDatagramPayload, dm: DmKeys): Promise<TxtMsgPlaintext | 'malformed' | null> {
  const mine = dm.selfPublicKey[0];
  for (const c of dm.contacts) {
    if (!((c[0] === p.srcHash && mine === p.destHash) || (c[0] === p.destHash && mine === p.srcHash))) continue;
    const secret = await dm.sharedSecret(c);
    if (!secret) continue;
    let pt: Uint8Array | null = null;
    try {
      pt = await decryptPayload(p, secret);
    } catch {
      pt = null;
    }
    if (!pt) continue;
    try {
      return parseTxtMsgPlaintext(pt);
    } catch {
      return 'malformed';
    }
  }
  return null;
}

/** True when the packet references `node` (hex: a 1-3 byte hash or a public key / prefix). */
export function packetMentionsNode(view: Pick<PacketView, 'nodeHashes' | 'nodeKeys'>, node: string): boolean {
  const n = node.trim().toLowerCase();
  if (!n) return true;
  // a node hash h matches a key prefix n when one is a prefix of the other
  if (view.nodeHashes.some((h) => n.startsWith(h) || h.startsWith(n))) return true;
  return view.nodeKeys.some((k) => k.startsWith(n) || (n.length > k.length && n.startsWith(k)));
}

// ---------------------------------------------------------------------------
// Send outcome (tx rows)
// ---------------------------------------------------------------------------

/** A sent (tx) row's send outcome as shown in the packet log: {@link PacketSendStatus} plus `no-ack`. */
export type SendDisplayStatus = PacketSendStatus | 'no-ack';

export interface SendOutcomeLabel {
  status: SendDisplayStatus;
  /** Compact marker for the list row: "…", "✓", "✓✓ 1.2 s", "✗ NOT_FOUND", "no ACK". */
  text: string;
  /** Longer explanation (tooltip). */
  title: string;
}

/** "850 ms" below a second, else "1.2 s". */
export function formatDurationMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The send outcome of a tx row for display, or null for rx rows and rows without `send`.
 * The radio sends no push on an ACK timeout, so a DM still `sent` once `ts + estTimeoutMs` is
 * before `now` (pass the app clock) shows as `no-ack`.
 */
export function sendOutcomeLabel(rec: Pick<PacketRecord, 'direction' | 'ts' | 'payloadType' | 'send'>, now: number): SendOutcomeLabel | null {
  const s = rec.send;
  if (rec.direction !== 'tx' || !s) return null;
  switch (s.status) {
    case 'pending':
      return { status: 'pending', text: '…', title: 'Pending: sent to the radio, no response yet' };
    case 'failed':
      return { status: 'failed', text: `✗ ${s.error ?? 'ERR'}`, title: `Failed: the radio rejected it${s.error ? ` (${s.error})` : ''}` };
    case 'confirmed': {
      const rtt = s.rttMs !== undefined ? formatDurationMs(s.rttMs) : '';
      return { status: 'confirmed', text: rtt ? `✓✓ ${rtt}` : '✓✓', title: `Delivered: ACK received${rtt ? `, round trip ${rtt}` : ''}` };
    }
    case 'sent': {
      const dm = rec.payloadType === PayloadType.TXT_MSG && s.tag !== undefined && s.tag !== 0;
      if (dm && s.estTimeoutMs !== undefined && now > rec.ts + s.estTimeoutMs) {
        return { status: 'no-ack', text: 'no ACK', title: `No ACK: not confirmed within the radio's estimated ${formatDurationMs(s.estTimeoutMs)}` };
      }
      const route = s.flood === undefined ? '' : s.flood ? ' (flood)' : ' (direct)';
      return { status: 'sent', text: '✓', title: `Sent: the radio transmitted it${route}${dm ? '; waiting for the ACK' : ''}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** Protocol name of a frame code ('DEVICE_QUERY', 'SELF_INFO', 'LOG_RX_DATA', …). */
export function frameCodeName(direction: FrameRecord['direction'], code: number): string {
  if (code < 0) return 'EMPTY';
  return (direction === 'out' ? cmdName(code) : deviceFrameName(code)) ?? `0x${hex2(code)}`;
}
