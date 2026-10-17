/**
 * Watches the packets the radio logs (LOG_RX_DATA: every packet it hears, with SNR / RSSI,
 * before it processes it — Dispatcher::checkRecv → logRx) for zero-hop adverts, whose SNR is
 * the link quality to that node itself (issue #11). Relayed packets only tell us about the last
 * hop. Recent packets are remembered for matching them to messages later.
 */

import { PayloadType, RouteType } from '../packet/constants.js';
import { parsePacket, type ParsedPacket } from '../packet/packet.js';
import { parseAdvertPayload } from '../packet/payloads.js';
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

  constructor(opts: RxPathCorrelatorOptions = {}) {
    this.#capacity = opts.capacity ?? 128;
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

  clear(): void {
    this.#entries.length = 0;
  }
}
