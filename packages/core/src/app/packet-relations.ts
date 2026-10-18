/**
 * Request ↔ reply pairing between packet log entries (the packet view's "Reply →" / "← Request"
 * links). Only exact, key-less pairings (phase 1):
 *
 * - `ack`: our sent DM (TXT_MSG tx row, `send.tag` = the expected ACK code from RESP_SENT) ↔ every
 *   received ACK (mesh-packet-format.md §3.4) or MULTIPART ACK (§3.11) carrying that code. Each
 *   retry is its own row with its own code. CLI text (tag 0) is never ACKed.
 * - `trace`: TRACE packets (§3.10) with the same cleartext tag. Our sent TRACE is the request; a
 *   received TRACE whose SNR list covers the whole hop list (`path_len << path_sz ≥ hashes_len`,
 *   firmware `Mesh::onRecvPacket`: the trace reached its end) is the reply; a received one still
 *   in progress (a hop forwarding it, overheard) is a `hop` of the same trace.
 * - `discover`: CONTROL DISCOVER_REQ ↔ DISCOVER_RESP (§3.12) with the same tag, from any node.
 *
 * Rules map one record to {@link RelationKey}s; records sharing a key relate according to their
 * roles. Records with the same packet hash are copies of one packet and never relate to each other
 * (the inspector counts them as copies). Later rules (decryption-based: our REQ ↔ the RESPONSE
 * echoing its tag, ACKs inside PATH packets) add keys of new `rule`s to the same index.
 */

import { PayloadType } from '../packet/constants.js';
import { parsePacket } from '../packet/packet.js';
import { parsePayload, type ParsedPayload } from '../packet/payloads.js';
import { ControlType } from '../protocol/constants.js';
import type { PacketRecord } from '../store/schema.js';
import { readU32LE } from '../util/bytes.js';

/** Which pairing rule linked two packets. */
export type RelationRule = 'ack' | 'trace' | 'discover';

/** A record's part in an exchange: what asks, what answers, or (TRACE) the same packet mid-path. */
export type RelationRole = 'request' | 'reply' | 'hop';

/** One pairing key of a record: records with equal `rule` + `key` relate (see {@link relationBetween}). */
export interface RelationKey {
  rule: RelationRule;
  /** The rule's match value (ACK code / tag as u32). */
  key: number;
  role: RelationRole;
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

/** Payload types any rule derives keys from (the index build scans only these). */
export const RELATION_PAYLOAD_TYPES: readonly number[] = [PayloadType.TXT_MSG, PayloadType.ACK, PayloadType.MULTIPART, PayloadType.TRACE, PayloadType.CONTROL];

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
    if (r.direction === 'tx' && r.payloadType === PayloadType.TXT_MSG && tag !== undefined && tag !== 0) {
      return [{ rule: 'ack', key: tag >>> 0, role: 'request' }];
    }
    return [];
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

const keyId = (k: Pick<RelationKey, 'rule' | 'key'>): string => `${k.rule}:${k.key}`;

const sameKeys = (a: readonly RelationKey[], b: readonly RelationKey[]): boolean =>
  a.length === b.length && a.every((k, i) => k.rule === b[i]!.rule && k.key === b[i]!.key && k.role === b[i]!.role);

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
