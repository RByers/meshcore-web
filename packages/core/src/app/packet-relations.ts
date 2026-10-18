/**
 * Request ↔ reply pairing between packet log entries (the packet view's "Reply →" / "← Request"
 * links). Only exact pairings, never src/dest-hash or timing heuristics.
 *
 * Key-less rules ({@link relationKeysOf}):
 * - `ack`: our sent DM (TXT_MSG tx row, `send.tag` = the expected ACK code from RESP_SENT) ↔ every
 *   received ACK (mesh-packet-format.md §3.4) or MULTIPART ACK (§3.11) carrying that code. Each
 *   retry is its own row with its own code. CLI text (tag 0) is never ACKed.
 * - `trace`: TRACE packets (§3.10) with the same cleartext tag. Our sent TRACE is the request; a
 *   received TRACE whose SNR list covers the whole hop list (`path_len << path_sz ≥ hashes_len`,
 *   firmware `Mesh::onRecvPacket`: the trace reached its end) is the reply; a received one still
 *   in progress (a hop forwarding it, overheard) is a `hop` of the same trace.
 * - `discover`: CONTROL DISCOVER_REQ ↔ DISCOVER_RESP (§3.12) with the same tag, from any node.
 *
 * Rules that need the radio's private key (opt-in; {@link decryptedRelationKeysOf}, run async):
 * - `response`: our sent REQ (status / telemetry / binary / path discovery) or non-login ANON_REQ
 *   (tx row, `send.tag` = RESP_SENT's tag) ↔ the RESPONSE (§3.2), or PATH with a RESPONSE extra
 *   (§3.9), from that contact echoing the tag. Firmware: `BaseChatMesh::sendRequest` /
 *   `sendAnonReq` put `tag = getCurrentTimeUnique()` as the request's first 4 plaintext bytes and
 *   companion `MyMesh` reports it in RESP_SENT; servers reflect it (`RPT handleRequest`,
 *   `handleAnon*Req`: `memcpy(reply_data, &sender_timestamp, 4)`). Scoped to the contact (its
 *   first 4 key bytes) since tags are only clock seconds. Logins are not paired: RESP_SENT's tag is
 *   the contact's first 4 key bytes (`pending_login`) and the login response starts with the
 *   server's clock (`RPT handleLoginReq`), so nothing in the exchange matches exactly.
 * - `ack` (decrypted): a received TXT_MSG from a contact to us is an ACK request keyed by the code
 *   the firmware ACKs it with (`BCM onPeerDataRecv`: plain → SHA256(plaintext[0..5+len) ‖ sender
 *   key), signed plain / room posts → SHA256(plaintext[0..9+len) ‖ our key)); CLI types are not
 *   ACKed. A PATH carrying an ACK extra (a flood DM's ACK, §3.9) is an ACK reply with its code.
 *
 * Rules map one record to {@link RelationKey}s; records sharing a key relate according to their
 * roles. Records with the same packet hash are copies of one packet and never relate to each other
 * (the inspector counts them as copies).
 */

import { PayloadType } from '../packet/constants.js';
import { parsePacket } from '../packet/packet.js';
import {
  ackCodeForTxtPlaintext,
  decryptPayload,
  parsePathPlaintext,
  parsePayload,
  parseResponsePlaintext,
  type ParsedPayload,
} from '../packet/payloads.js';
import { ControlType } from '../protocol/constants.js';
import type { PacketRecord } from '../store/schema.js';
import { fromHex, readU32LE, toHex } from '../util/bytes.js';
import type { DmKeys } from './packet-summary.js';

/** Which pairing rule linked two packets. */
export type RelationRule = 'ack' | 'trace' | 'discover' | 'response';

/** A record's part in an exchange: what asks, what answers, or (TRACE) the same packet mid-path. */
export type RelationRole = 'request' | 'reply' | 'hop';

/** One pairing key of a record: records with equal `rule` + `key` relate (see {@link relationBetween}). */
export interface RelationKey {
  rule: RelationRule;
  /** The rule's match value (ACK code / tag as u32). */
  key: number;
  role: RelationRole;
  /** Narrows the key to one peer (`response`: the contact's first 4 key bytes, hex). */
  scope?: string;
}

/**
 * What the *other* packet is to this one:
 * - `ack`: it acknowledges this DM; `acked`: it is the DM this ACK acknowledges;
 * - `reply`: it answers this request; `request`: it is the request this one answers;
 * - `hop`: the same TRACE heard at another stage of its path.
 */
export type PacketRelation = 'ack' | 'acked' | 'reply' | 'request' | 'hop';

export interface RelatedPacket {
  /** The other packet record's id. */
  id: number;
  relation: PacketRelation;
  rule: RelationRule;
}

/**
 * The log scans whose records a key-less rule derives keys from (the index build reads only these).
 * Our DMs and requests carry no bytes: only their tx rows have keys without decryption.
 */
export const RELATION_SCANS: readonly { payloadType: number; direction?: 'tx' }[] = [
  { payloadType: PayloadType.TXT_MSG, direction: 'tx' },
  { payloadType: PayloadType.REQ, direction: 'tx' },
  { payloadType: PayloadType.ANON_REQ, direction: 'tx' },
  { payloadType: PayloadType.ACK },
  { payloadType: PayloadType.MULTIPART },
  { payloadType: PayloadType.TRACE },
  { payloadType: PayloadType.CONTROL },
];

/** Payload types {@link decryptedRelationKeysOf} derives keys from (with the radio's private key). */
export const DECRYPTED_RELATION_PAYLOAD_TYPES: readonly number[] = [PayloadType.TXT_MSG, PayloadType.RESPONSE, PayloadType.PATH];

/** True when the record has bytes that {@link decryptedRelationKeysOf} may derive keys from. */
export function needsDecryption(r: PacketRecord): boolean {
  return r.format !== 'none' && DECRYPTED_RELATION_PAYLOAD_TYPES.includes(r.payloadType);
}

/** The `response` rule's scope for a contact key (or key prefix of ≥ 4 bytes, hex); null when shorter. */
function peerScope(keyHex: string): string | null {
  const h = keyHex.toLowerCase();
  return h.length >= 8 && /^[0-9a-f]+$/.test(h) ? h.slice(0, 8) : null;
}

/** The relation of `other` to `self` within one key, or null when the roles do not pair. */
export function relationBetween(rule: RelationRule, self: RelationRole, other: RelationRole): PacketRelation | null {
  if (self === 'hop' || other === 'hop') return rule === 'trace' ? 'hop' : null;
  if (self === 'request' && other === 'reply') return rule === 'ack' ? 'ack' : 'reply';
  if (self === 'reply' && other === 'request') return rule === 'ack' ? 'acked' : 'request';
  return null;
}

interface RecordPayload {
  payload: ParsedPayload;
  /** Path entry count (for TRACE: the SNRs appended so far). */
  pathCount: number;
}

/** Parses a record's payload (whole packet or bare payload); null for no bytes or unparsable. */
function recordPayload(r: PacketRecord): RecordPayload | null {
  try {
    if (r.format === 'packet') {
      const p = parsePacket(r.bytes);
      return { payload: parsePayload(p.payloadType, p.payload), pathCount: p.pathHashCount };
    }
    if (r.format === 'payload' && r.payloadType >= 0) {
      // TRACE payload records keep the SNR count as path_len (hash-size bits 0)
      return { payload: parsePayload(r.payloadType, r.bytes), pathCount: r.pathLen >= 0 ? r.pathLen & 0x3f : 0 };
    }
  } catch {
    // unparsable bytes pair with nothing
  }
  return null;
}

/** The pairing keys of one packet record (phase 1 rules). Never throws. */
export function relationKeysOf(r: PacketRecord): RelationKey[] {
  if (r.format === 'none') {
    // our DM: the radio's RESP_SENT tag is the ACK code to expect (0 for CLI text: not ACKed)
    const tag = r.send?.tag;
    if (r.direction !== 'tx' || tag === undefined) return [];
    if (r.payloadType === PayloadType.TXT_MSG) return tag !== 0 ? [{ rule: 'ack', key: tag >>> 0, role: 'request' }] : [];
    if (r.payloadType !== PayloadType.REQ && r.payloadType !== PayloadType.ANON_REQ) return [];
    // our request: RESP_SENT's tag is the timestamp its response echoes (decryptedRelationKeysOf)
    const scope = r.send?.peer !== undefined ? peerScope(r.send.peer) : null;
    if (scope === null) return [];
    // a login's RESP_SENT tag is the contact's first 4 key bytes instead (`pending_login`), and its
    // response starts with the server's clock: not pairable
    if (r.payloadType === PayloadType.ANON_REQ && tag >>> 0 === readU32LE(fromHex(scope), 0)) return [];
    return [{ rule: 'response', key: tag >>> 0, role: 'request', scope }];
  }
  const rp = recordPayload(r);
  if (!rp) return [];
  const p = rp.payload;
  switch (p.kind) {
    case 'ack':
      return [{ rule: 'ack', key: p.ackCodeU32, role: 'reply' }];
    case 'multipart':
      return p.ackCode ? [{ rule: 'ack', key: readU32LE(p.ackCode, 0), role: 'reply' }] : [];
    case 'trace': {
      let role: RelationRole;
      if (r.direction === 'tx') role = 'request';
      else role = rp.pathCount << p.pathSz >= p.hashes.length ? 'reply' : 'hop';
      return [{ rule: 'trace', key: p.tag, role }];
    }
    case 'control':
      // the catch-all variant's `subType: number` defeats narrowing on subType alone
      if (!('tag' in p)) return [];
      return [{ rule: 'discover', key: p.tag, role: p.subType === ControlType.NODE_DISCOVER_REQ ? 'request' : 'reply' }];
    default:
      return [];
  }
}

/**
 * The pairing keys only decryption reveals (see the module comment): a TXT_MSG / RESPONSE / PATH
 * between this radio and a known contact, MAC-checked with that contact's shared secret. Empty for
 * other records and packets between other nodes; the direction-dependent keys are also left out
 * when the 1-byte hashes cannot tell who sent it (a contact sharing our hash). Never throws.
 */
export async function decryptedRelationKeysOf(r: PacketRecord, dm: DmKeys): Promise<RelationKey[]> {
  if (!needsDecryption(r)) return [];
  const p = recordPayload(r)?.payload;
  if (!p || (p.kind !== 'txtMsg' && p.kind !== 'response' && p.kind !== 'path')) return [];
  const mine = dm.selfPublicKey[0];
  for (const c of dm.contacts) {
    const fromPeer = c[0] === p.srcHash && mine === p.destHash;
    const toPeer = c[0] === p.destHash && mine === p.srcHash;
    if (!fromPeer && !toPeer) continue;
    try {
      const secret = await dm.sharedSecret(c);
      if (!secret) continue;
      const pt = await decryptPayload(p, secret);
      if (!pt) continue;
      // the MAC verified: the packet is between us and `c`
      const fromContact = fromPeer && !toPeer;
      const scope = toHex(c.subarray(0, 4));
      if (p.kind === 'txtMsg') {
        if (!fromContact) return [];
        const code = await ackCodeForTxtPlaintext(pt, { senderPublicKey: c, receiverPublicKey: dm.selfPublicKey });
        return code ? [{ rule: 'ack', key: readU32LE(code, 0), role: 'request' }] : [];
      }
      if (p.kind === 'response') {
        return fromContact ? [{ rule: 'response', key: parseResponsePlaintext(pt).tag, role: 'reply', scope }] : [];
      }
      const path = parsePathPlaintext(pt);
      if (!path.hasExtra || path.extra.length < 4) return [];
      if (path.extraType === PayloadType.ACK) return [{ rule: 'ack', key: readU32LE(path.extra, 0), role: 'reply' }];
      if (path.extraType === PayloadType.RESPONSE && fromContact) return [{ rule: 'response', key: readU32LE(path.extra, 0), role: 'reply', scope }];
      return [];
    } catch {
      return []; // decrypted, but the plaintext is malformed
    }
  }
  return [];
}

const keyId = (k: Pick<RelationKey, 'rule' | 'key' | 'scope'>): string => `${k.rule}:${k.key}${k.scope === undefined ? '' : `@${k.scope}`}`;

const sameKeys = (a: readonly RelationKey[], b: readonly RelationKey[]): boolean =>
  a.length === b.length && a.every((k, i) => k.rule === b[i]!.rule && k.key === b[i]!.key && k.role === b[i]!.role && k.scope === b[i]!.scope);

/**
 * In-memory index of the records' pairing keys: key → member ids with their role, id → its keys.
 * {@link related} costs O(members of the record's keys), independent of the log size.
 */
export class PacketRelationIndex {
  readonly #byKey = new Map<string, Map<number, RelationRole>>();
  readonly #byId = new Map<number, { hash: string; keys: readonly RelationKey[] }>();

  /** Number of records with at least one key. */
  get size(): number {
    return this.#byId.size;
  }

  /** Indexes a record by its {@link relationKeysOf}; true when its keys changed. */
  add(r: PacketRecord): boolean {
    return this.set(r.id, r.hash, relationKeysOf(r));
  }

  /** Replaces the keys of record `id` (empty = removes it); true when they changed. */
  set(id: number, hash: string, keys: readonly RelationKey[]): boolean {
    const prev = this.#byId.get(id);
    if (prev ? sameKeys(prev.keys, keys) && prev.hash === hash : keys.length === 0) return false;
    if (prev) this.#unlink(id, prev.keys);
    if (keys.length === 0) {
      this.#byId.delete(id);
      return true;
    }
    this.#byId.set(id, { hash, keys });
    for (const k of keys) {
      const kid = keyId(k);
      let members = this.#byKey.get(kid);
      if (!members) this.#byKey.set(kid, (members = new Map()));
      members.set(id, k.role);
    }
    return true;
  }

  delete(id: number): boolean {
    const prev = this.#byId.get(id);
    if (!prev) return false;
    this.#unlink(id, prev.keys);
    this.#byId.delete(id);
    return true;
  }

  clear(): void {
    this.#byKey.clear();
    this.#byId.clear();
  }

  /** The packets related to record `id`, ordered by id (oldest first). */
  related(id: number): RelatedPacket[] {
    const self = this.#byId.get(id);
    if (!self) return [];
    const out: RelatedPacket[] = [];
    const seen = new Set<number>();
    for (const k of self.keys) {
      for (const [other, role] of this.#byKey.get(keyId(k)) ?? []) {
        if (other === id || seen.has(other)) continue;
        const o = this.#byId.get(other);
        if (self.hash !== '' && o?.hash === self.hash) continue; // a copy of the same packet
        const relation = relationBetween(k.rule, k.role, role);
        if (!relation) continue;
        seen.add(other);
        out.push({ id: other, relation, rule: k.rule });
      }
    }
    return out.sort((a, b) => a.id - b.id);
  }

  #unlink(id: number, keys: readonly RelationKey[]): void {
    for (const k of keys) {
      const members = this.#byKey.get(keyId(k));
      if (!members) continue;
      members.delete(id);
      if (members.size === 0) this.#byKey.delete(keyId(k));
    }
  }
}
