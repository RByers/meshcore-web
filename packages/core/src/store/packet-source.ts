/**
 * The originating node of a logged packet, as far as its plaintext reveals it
 * (mesh-packet-format.md §2): ADVERT carries the full public key, ANON_REQ the sender's full
 * public key, REQ / RESPONSE / TXT_MSG / PATH a 1-byte source hash (the first byte of the
 * sender's public key). Group messages hide the sender inside the encrypted payload, and
 * ACK / TRACE / CONTROL / RAW_CUSTOM name no source, so those have none.
 *
 * Stored on each packet record (`srcHash`, `srcKey`) so the packet log can be searched by source
 * through the `srcHash_ts` index.
 */

import { PayloadType } from '../packet/constants.js';
import { parsePacket } from '../packet/packet.js';
import { parsePayload } from '../packet/payloads.js';
import { toHex } from '../util/bytes.js';
import type { PacketBytesFormat } from './schema.js';

export interface PacketSourceIds {
  /** First byte of the source's public key, 2 hex chars. */
  srcHash: string;
  /** The source's full public key hex, when the packet carries it. */
  srcKey?: string;
}

const hex2 = (n: number): string => (n & 0xff).toString(16).padStart(2, '0');

/** Source ids of a packet record's bytes; null when the packet names no source or does not parse. Never throws. */
export function packetSourceOf(rec: { format: PacketBytesFormat; bytes: Uint8Array; payloadType: number }): PacketSourceIds | null {
  if (rec.format === 'none') return null;
  try {
    let payloadType = rec.payloadType;
    let payload = rec.bytes;
    if (rec.format === 'packet') {
      const p = parsePacket(rec.bytes);
      payloadType = p.payloadType;
      payload = p.payload;
    }
    switch (payloadType) {
      case PayloadType.ADVERT:
      case PayloadType.ANON_REQ:
      case PayloadType.REQ:
      case PayloadType.RESPONSE:
      case PayloadType.TXT_MSG:
      case PayloadType.PATH:
        break;
      default:
        return null;
    }
    const p = parsePayload(payloadType, payload);
    switch (p.kind) {
      case 'advert': {
        const key = toHex(p.publicKey);
        return { srcHash: key.slice(0, 2), srcKey: key };
      }
      case 'anonReq': {
        const key = toHex(p.senderPublicKey);
        return { srcHash: key.slice(0, 2), srcKey: key };
      }
      case 'req':
      case 'response':
      case 'txtMsg':
      case 'path':
        return { srcHash: hex2(p.srcHash) };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * True when a record with these source ids may come from the node `node` (a public key or key
 * prefix hex, at least one byte): the hash byte matches, and a known full key agrees with it.
 * A hash-only source (most packet types) can't tell apart nodes that share the first key byte.
 */
export function sourceMatches(rec: { srcHash?: string; srcKey?: string }, node: string): boolean {
  if (rec.srcHash === undefined || !node.startsWith(rec.srcHash)) return false;
  return rec.srcKey === undefined || rec.srcKey.startsWith(node) || node.startsWith(rec.srcKey);
}
