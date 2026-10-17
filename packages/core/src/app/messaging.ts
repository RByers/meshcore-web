/**
 * Pure helpers for contacts, direct messages and channels: byte budgets, the reply and
 * "sender: text" conventions, path labels, contact share strings and channel PSK parsing
 * (feature-inventory.md §2.4, §3.4, §3.6, §3.8; companion-protocol.md §8).
 */

import { MAX_TEXT_LEN, PATH_LEN_UNKNOWN, PUBLIC_CHANNEL_SECRET_HEX, ContactType, decodePathLen } from '../protocol/constants.js';
import { parsePacket } from '../packet/packet.js';
import { hashtagChannelPsk, parseAdvertPayload } from '../packet/payloads.js';
import { PayloadType } from '../packet/constants.js';
import { base64Decode, fromHex, toHex, utf8Encode } from '../util/bytes.js';
import { smazEncodeIfSmaller } from '../util/smaz.js';

// ---------------------------------------------------------------------------
// Byte budgets
// ---------------------------------------------------------------------------

/** UTF-8 byte length of `text`. */
export function textByteLength(text: string): number {
  return utf8Encode(text).length;
}

/**
 * Maximum text bytes the user may type. Direct: MAX_TEXT_LEN (160). Channel: the device sends
 * `"<name>: <text>"` and truncates it to 160 bytes, so the name and ": " come off the budget
 * (companion-protocol.md §8). `prefix` (e.g. a reply's "@[name] ") is subtracted too.
 */
export function messageByteLimit(convType: 'contact' | 'channel', selfName: string, prefix = ''): number {
  const base = convType === 'channel' ? MAX_TEXT_LEN - textByteLength(`${selfName}: `) : MAX_TEXT_LEN;
  return Math.max(0, base - textByteLength(prefix));
}

export interface ByteBudget {
  used: number;
  limit: number;
  remaining: number;
  /** used > limit */
  over: boolean;
}

export function byteBudget(text: string, limit: number): ByteBudget {
  const used = textByteLength(text);
  return { used, limit, remaining: limit - used, over: used > limit };
}

// ---------------------------------------------------------------------------
// SMAZ compression (MeshCore Open compatible, feature-inventory.md §2.4a)
// ---------------------------------------------------------------------------

/**
 * Whether `text` is one of MeshCore Open's structured payloads, which it never compresses:
 * "g:" (GIF), "m:" (map/location) and, for DMs, "V1|". Checked on the trimmed text.
 */
export function isStructuredPayload(convType: 'contact' | 'channel', text: string): boolean {
  const t = text.trim();
  return t.startsWith('g:') || t.startsWith('m:') || (convType === 'contact' && t.startsWith('V1|'));
}

/**
 * The text actually sent for `text` (MeshCore Open `prepareContactOutboundText` /
 * `prepareChannelOutboundText`): with compression on, `"s:" + base64(smaz(text))` when that is
 * shorter, else `text`. Channel texts are compressed without the sender name (the device adds
 * "<name>: " in front of the envelope); a reply's "@[name] " prefix is part of `text`.
 */
export function outboundText(convType: 'contact' | 'channel', text: string, compress: boolean): string {
  if (!compress || isStructuredPayload(convType, text)) return text;
  return smazEncodeIfSmaller(text);
}

// ---------------------------------------------------------------------------
// Reply and channel sender conventions
// ---------------------------------------------------------------------------

/** "@[name] text" (feature-inventory.md §2.4). */
export function replyPrefix(name: string): string {
  return `@[${name}] `;
}

export function formatReply(name: string, text: string): string {
  return `${replyPrefix(name)}${text}`;
}

/** Splits "@[name] text"; null when `text` is not a reply. */
export function parseReply(text: string): { name: string; text: string } | null {
  const m = /^@\[([^\]]*)\]\s?([\s\S]*)$/.exec(text);
  if (!m) return null;
  return { name: m[1]!, text: m[2]! };
}

/**
 * Splits a channel payload "sender: text" (the device does this already for CHANNEL_MSG
 * frames; this is for texts stored without a sender).
 */
export function splitChannelSender(text: string): { senderName?: string; text: string } {
  const i = text.indexOf(': ');
  if (i <= 0) return { text };
  return { senderName: text.slice(0, i), text: text.slice(i + 2) };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface PathDisplay {
  kind: 'direct' | 'hops' | 'flood';
  hops: number;
  /** "direct", "N hops" or "flood" (feature-inventory.md §3.4). */
  label: string;
}

/** Label for a contact's out_path_len (0xFF = no known path → flood). */
export function pathDisplay(outPathLen: number): PathDisplay {
  if ((outPathLen & 0xff) === PATH_LEN_UNKNOWN) return { kind: 'flood', hops: 0, label: 'flood' };
  const { hops } = decodePathLen(outPathLen);
  if (hops === 0) return { kind: 'direct', hops: 0, label: 'direct' };
  return { kind: 'hops', hops, label: hops === 1 ? '1 hop' : `${hops} hops` };
}

/**
 * Label for the path_len byte of a received message: 0xFF means it came direct (no hop info),
 * otherwise it was flooded through N hops.
 */
export function receivedPathLabel(pathLen: number): string {
  // 0xFF: the packet followed a stored (direct) route; each repeater strips itself from such a
  // path, so the hop count is unknown on arrival (MyMesh.cpp onMessageRecv).
  if ((pathLen & 0xff) === PATH_LEN_UNKNOWN) return 'direct route';
  const { hops } = decodePathLen(pathLen);
  return hops === 0 ? 'zero hop' : hops === 1 ? '1 hop' : `${hops} hops`;
}

/** Hop count of a received message: 0 = heard directly, null = direct-routed (hops unknown). */
export function receivedHops(pathLen: number): number | null {
  if ((pathLen & 0xff) === PATH_LEN_UNKNOWN) return null;
  return decodePathLen(pathLen).hops;
}

export interface ReceivedSignal {
  /** See {@link receivedHops}. */
  hops: number | null;
  /** True only for a flood message with an empty path: the sender was heard directly. */
  zeroHop: boolean;
  /** "zero hop" / "N hops" / "direct route" ({@link receivedPathLabel}). */
  pathLabel: string;
  /**
   * SNR to show next to the message: only for zero-hop messages, since for a relayed message
   * the radio's SNR describes the last hop, not the sender (issue #11).
   */
  snr?: number;
  /** The raw last-hop SNR as received (for details / tooltips), whatever the hop count. */
  lastHopSnr?: number;
}

/** What the message view shows about how a received message arrived. */
export function receivedSignal(m: { pathLen: number; snr?: number | undefined }): ReceivedSignal {
  const hops = receivedHops(m.pathLen);
  const zeroHop = hops === 0;
  const out: ReceivedSignal = { hops, zeroHop, pathLabel: receivedPathLabel(m.pathLen) };
  if (m.snr !== undefined) {
    out.lastHopSnr = m.snr;
    if (zeroHop) out.snr = m.snr;
  }
  return out;
}

export type ContactKind = 'chat' | 'repeater' | 'room' | 'sensor';

export function contactTypeName(type: number): ContactKind {
  if (type === ContactType.REPEATER) return 'repeater';
  if (type === ContactType.ROOM) return 'room';
  if (type === ContactType.SENSOR) return 'sensor';
  return 'chat';
}

// ---------------------------------------------------------------------------
// Contact sharing
// ---------------------------------------------------------------------------

export const CONTACT_URL_SCHEME = 'meshcore://';

export function contactShareUrl(advertPacket: Uint8Array): string {
  return `${CONTACT_URL_SCHEME}${toHex(advertPacket)}`;
}

export type ContactShare =
  | {
      kind: 'advert';
      /** The full advert packet, as EXPORT_CONTACT returns it. */
      packet: Uint8Array;
      pubKey: Uint8Array;
      name: string;
      type: number;
      lat?: number;
      lon?: number;
    }
  | { kind: 'pubKey'; pubKey: Uint8Array };

function cleanHex(s: string): string {
  return s.replace(/[\s:,-]/g, '').toLowerCase();
}

/**
 * Parses what a user pastes to add a contact: `meshcore://<hex advert packet>`, the bare advert
 * hex, or a 32-byte public key in hex. Throws an Error with a user-facing message otherwise.
 */
export function parseContactShare(input: string): ContactShare {
  let s = input.trim();
  if (s.toLowerCase().startsWith(CONTACT_URL_SCHEME)) s = s.slice(CONTACT_URL_SCHEME.length);
  s = cleanHex(s);
  if (!s) throw new Error('Paste a meshcore:// link, an advert in hex or a public key');
  if (!/^[0-9a-f]+$/.test(s) || s.length % 2 !== 0) throw new Error('Not valid hex');
  const bytes = fromHex(s);
  if (bytes.length === 32) return { kind: 'pubKey', pubKey: bytes };
  let packet;
  try {
    packet = parsePacket(bytes);
  } catch {
    throw new Error('Not a MeshCore advert');
  }
  if (packet.payloadType !== PayloadType.ADVERT) throw new Error('Not a MeshCore advert');
  let advert;
  try {
    advert = parseAdvertPayload(packet.payload);
  } catch {
    throw new Error('Advert is truncated');
  }
  const out: ContactShare = {
    kind: 'advert',
    packet: bytes,
    pubKey: advert.publicKey,
    name: advert.app.name ?? '',
    type: advert.app.nodeType,
  };
  if (advert.app.latitude !== undefined && advert.app.longitude !== undefined) {
    out.lat = advert.app.latitude;
    out.lon = advert.app.longitude;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** Channel names are stored in a 32-byte NUL-terminated field. */
export const CHANNEL_NAME_MAX_BYTES = 31;

export function publicChannelPsk(): Uint8Array {
  return fromHex(PUBLIC_CHANNEL_SECRET_HEX);
}

export type ChannelKind = 'public' | 'hashtag' | 'private';

export function channelKind(name: string, psk: Uint8Array): ChannelKind {
  if (toHex(psk.subarray(0, 16)) === PUBLIC_CHANNEL_SECRET_HEX && psk.subarray(16).every((b) => b === 0)) return 'public';
  if (name.startsWith('#')) return 'hashtag';
  return 'private';
}

export { base64Decode, base64Encode } from '../util/bytes.js';

/**
 * Parses a channel PSK as typed by a user: 32 hex digits (separators ignored) or base64 of 16
 * bytes (as the MeshCore apps show it). SET_CHANNEL only carries 128-bit secrets
 * (companion-protocol.md §4 CMD 32). Throws with a user-facing message otherwise.
 */
export function parsePsk(input: string): Uint8Array {
  const raw = input.trim();
  const hex = cleanHex(raw);
  if (/^[0-9a-f]+$/.test(hex) && hex.length === 32) return fromHex(hex);
  const b = base64Decode(raw);
  if (b && b.length === 16) return b;
  if ((/^[0-9a-f]+$/.test(hex) && hex.length === 64) || b?.length === 32) throw new Error('256-bit keys are not supported by the radio; use a 16-byte key');
  throw new Error('Key must be 16 bytes: 32 hex digits or base64');
}

/**
 * Resolves the PSK for a new channel: an explicit key wins; otherwise "#name" derives the
 * hashtag key, "Public" uses the well-known key, and anything else gets a random 16-byte key.
 */
export async function resolveChannelPsk(name: string, psk?: string, random: (n: number) => Uint8Array = randomBytes): Promise<Uint8Array> {
  if (psk && psk.trim()) return parsePsk(psk);
  if (name.startsWith('#')) return hashtagChannelPsk(name);
  if (name.trim().toLowerCase() === 'public') return publicChannelPsk();
  return random(16);
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** Validates a channel name; returns an error message or null. */
export function channelNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Name is required';
  if (n === '#') return 'Hashtag channels need a name after #';
  if (textByteLength(n) > CHANNEL_NAME_MAX_BYTES) return `Name is longer than ${CHANNEL_NAME_MAX_BYTES} bytes`;
  return null;
}
