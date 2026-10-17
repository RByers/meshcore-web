/**
 * Recovers the path of received messages and direct (zero-hop) signal reports from the packets
 * the radio logs (LOG_RX_DATA). Message frames only carry path_len (companion-protocol.md,
 * CONTACT_MSG_RECV_V3 / CHANNEL_MSG_RECV_V3), but the radio pushes every packet it hears, path
 * included, before it processes it (Dispatcher::checkRecv → logRx → onRecvPacket). So a
 * message's packet is the earliest not-yet-claimed logged flood packet of the right type whose
 * path_len matches and whose cleartext header names the right sender / channel
 * (mesh-packet-format.md §3.2 TXT_MSG: dest_hash, src_hash; §3.6 GRP_TXT: channel_hash).
 *
 * This is a heuristic (1-byte hashes collide), so it only ever adds information: when no packet
 * matches, the message simply has no path. Re-heard copies of a claimed packet (same packet
 * hash) are claimed with it, so they cannot be attributed to the next message.
 */

import { PayloadType, RouteType, isFloodRoute } from '../packet/constants.js';
import { parsePacket, type ParsedPacket } from '../packet/packet.js';
import { parseAdvertPayload } from '../packet/payloads.js';
import { PATH_LEN_UNKNOWN, decodePathLen } from '../protocol/constants.js';
import type { PacketRecord } from '../store/schema.js';
import { toHex } from '../util/bytes.js';

interface RxEntry {
  ts: number;
  hash: string;
  packet: ParsedPacket;
  claimed: boolean;
}

export interface RxPathCorrelatorOptions {
  /** How many recent packets to remember (default 128). */
  capacity?: number;
  /** Ignore packets older than this relative to the message (default 10 min). */
  maxAgeMs?: number;
}

/** A packet heard directly (zero hop) from a node whose public key it carries. */
export interface DirectHearing {
  /** Public key hex. */
  key: string;
  snr: number;
  ts: number;
}

export class RxPathCorrelator {
  readonly #entries: RxEntry[] = [];
  readonly #capacity: number;
  readonly #maxAgeMs: number;

  constructor(opts: RxPathCorrelatorOptions = {}) {
    this.#capacity = opts.capacity ?? 128;
    this.#maxAgeMs = opts.maxAgeMs ?? 10 * 60_000;
  }

  /** Number of remembered packets (tests). */
  get size(): number {
    return this.#entries.length;
  }

  /**
   * Remembers a logged packet. Returns a {@link DirectHearing} when it is a zero-hop advert
   * (flood with an empty path, or direct with an empty path — adverts are only ever direct-routed
   * when sent zero hop) and the radio reported its SNR.
   */
  observe(r: Pick<PacketRecord, 'direction' | 'format' | 'bytes' | 'ts' | 'hash' | 'snr'>): DirectHearing | null {
    if (r.direction !== 'rx' || r.format !== 'packet') return null;
    let packet: ParsedPacket;
    try {
      packet = parsePacket(r.bytes);
    } catch {
      return null;
    }
    this.#entries.push({ ts: r.ts, hash: r.hash, packet, claimed: false });
    if (this.#entries.length > this.#capacity) this.#entries.splice(0, this.#entries.length - this.#capacity);
    if (packet.payloadType !== PayloadType.ADVERT || packet.pathHashCount !== 0 || r.snr === undefined) return null;
    if (packet.routeType !== RouteType.FLOOD && packet.routeType !== RouteType.DIRECT) return null;
    try {
      return { key: toHex(parseAdvertPayload(packet.payload).publicKey), snr: r.snr, ts: r.ts };
    } catch {
      return null;
    }
  }

  #claim(now: number, pathLen: number, payloadType: number, match: (payload: Uint8Array) => boolean): Uint8Array | undefined {
    const raw = pathLen & 0xff;
    if (raw === PATH_LEN_UNKNOWN) return undefined; // direct-routed: the path was consumed on the way
    const { hops } = decodePathLen(raw);
    if (hops === 0) return undefined;
    const e = this.#entries.find(
      (x) =>
        !x.claimed &&
        x.packet.payloadType === payloadType &&
        isFloodRoute(x.packet.routeType) &&
        x.packet.pathLen === raw &&
        x.ts <= now + 1000 &&
        now - x.ts <= this.#maxAgeMs &&
        match(x.packet.payload),
    );
    if (!e) return undefined;
    for (const x of this.#entries) if (x === e || (e.hash && x.hash === e.hash)) x.claimed = true;
    return e.packet.path.slice();
  }

  /**
   * Path of an incoming DM / room message: a TXT_MSG flood packet from `senderHash`
   * (pubkey[0]) to `selfHash` with the same path_len. Undefined when none matches.
   */
  claimContactMessage(o: { pathLen: number; senderHash: number; selfHash?: number; now: number }): Uint8Array | undefined {
    return this.#claim(o.now, o.pathLen, PayloadType.TXT_MSG, (p) => p.length >= 2 && p[1] === o.senderHash && (o.selfHash === undefined || p[0] === o.selfHash));
  }

  /** Path of an incoming channel message: a GRP_TXT flood packet for `channelHash`. */
  claimChannelMessage(o: { pathLen: number; channelHash: number; now: number }): Uint8Array | undefined {
    return this.#claim(o.now, o.pathLen, PayloadType.GRP_TXT, (p) => p.length >= 1 && p[0] === o.channelHash);
  }

  clear(): void {
    this.#entries.length = 0;
  }
}
