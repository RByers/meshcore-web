/**
 * Correlates the `tx` packet rows logged from host commands with the device frames that report
 * what happened to them, so {@link PacketRecord.send} records the outcome (companion-protocol.md):
 *
 * - The companion protocol is strictly request → response, one command at a time (CompanionClient
 *   queues commands and resolves each with the next non-push frame), so the first response frame
 *   (code < 0x80) after a command frame answers it: RESP_SENT 0x06 (§5.1: flood flag, tag, est.
 *   timeout) or OK 0x00 → `sent`; RESP_ERR 0x01 / DISABLED 0x0F → `failed`. Any other response
 *   leaves the row `pending`. A newer command frame ends the wait (its own response follows).
 * - PUSH SEND_CONFIRMED 0x82 (§6.5: ack code = SENT tag, round-trip ms) confirms the most recent
 *   `sent` TXT_MSG row expecting that ACK code. The radio's ACK table has 8 slots, so a bounded
 *   list of unconfirmed rows is kept.
 *
 * The same correlator drives live capture (RadioStore.captureFrame) and the frame-log backfill
 * (send-backfill.ts), so both produce identical results. It is synchronous and does no I/O: feed
 * it frames in log order and apply the updates it returns. `H` is the caller's row handle (an id
 * live, a record object in the backfill).
 */

import { PayloadType, RouteType } from '../packet/constants.js';
import { isPushCode } from '../protocol/constants.js';
import type { DeviceFrame } from '../protocol/types.js';
import type { PacketSend } from './schema.js';

/** The fields of a tx row the correlator reads. */
export interface SendTarget {
  routeType: number;
  payloadType: number;
  /** Absent = treat as `pending`. */
  send?: PacketSend;
}

/** A row whose `send` (and possibly `routeType`) changed. */
export interface SendUpdate<H> {
  handle: H;
  send: PacketSend;
  /** Set when SENT's flood flag fixed a route type the command left unknown (-1). */
  routeType?: number;
}

/** Unconfirmed DMs kept for SEND_CONFIRMED matching (the radio's ACK table holds 8). */
export const SEND_CONFIRM_LOOKBACK = 64;

interface Entry<H> {
  handle: H;
  routeType: number;
  payloadType: number;
  send: PacketSend;
}

/** True when a row in this state can still be confirmed by a SEND_CONFIRMED push. */
export function awaitsAck(t: SendTarget): boolean {
  return t.payloadType === PayloadType.TXT_MSG && t.send?.status === 'sent' && t.send.tag !== undefined && t.send.tag !== 0;
}

export class SendCorrelator<H> {
  #awaiting: Entry<H> | null = null;
  /** Oldest first. */
  #unconfirmed: Entry<H>[] = [];

  constructor(readonly lookback = SEND_CONFIRM_LOOKBACK) {}

  /**
   * A command frame went to the device. `handle` / `target` = the tx row it created, or null for a
   * command that does not transmit (its response is then not ours to record).
   */
  command(handle: H | null, target?: SendTarget): void {
    this.#awaiting = null;
    if (handle === null || !target) return;
    const e: Entry<H> = { handle, routeType: target.routeType, payloadType: target.payloadType, send: target.send ?? { status: 'pending' } };
    if (e.send.status === 'pending') this.#awaiting = e;
    else this.#watch(e);
  }

  /**
   * A device frame arrived: its code and, when decoded, the frame (only SENT / OK / ERR / DISABLED
   * and SEND_CONFIRMED are read). Returns the rows it changed.
   */
  device(code: number, frame: DeviceFrame | null, ts: number): SendUpdate<H>[] {
    if (isPushCode(code)) {
      if (frame?.kind !== 'sendConfirmed') return [];
      const u = this.confirm(frame.ackCode, frame.roundTripMs, ts);
      return u ? [u] : [];
    }
    const e = this.#awaiting;
    this.#awaiting = null;
    if (!e || !frame) return [];
    let send: PacketSend;
    let routeType: number | undefined;
    switch (frame.kind) {
      case 'sent':
        send = { ...e.send, status: 'sent', flood: frame.flood, tag: frame.tag, estTimeoutMs: frame.estTimeoutMs, respondedAt: ts };
        if (e.routeType < 0) routeType = frame.flood ? RouteType.FLOOD : RouteType.DIRECT;
        break;
      case 'ok':
        send = { ...e.send, status: 'sent', respondedAt: ts };
        break;
      case 'err':
        send = { ...e.send, status: 'failed', error: frame.errName, errCode: frame.errCode, respondedAt: ts };
        break;
      case 'disabled':
        send = { ...e.send, status: 'failed', error: 'DISABLED', respondedAt: ts };
        break;
      default:
        return [];
    }
    e.send = send;
    if (routeType !== undefined) e.routeType = routeType;
    this.#watch(e);
    return [routeType !== undefined ? { handle: e.handle, send, routeType } : { handle: e.handle, send }];
  }

  /**
   * Applies a SEND_CONFIRMED to the newest watched row expecting `ackCode`; null when none is
   * watched (the caller may then look further back in the store).
   */
  confirm(ackCode: number, rttMs: number, ts: number): SendUpdate<H> | null {
    for (let i = this.#unconfirmed.length - 1; i >= 0; i--) {
      const e = this.#unconfirmed[i]!;
      if (e.send.tag !== ackCode) continue;
      this.#unconfirmed.splice(i, 1);
      e.send = confirmedSend(e.send, rttMs, ts);
      return { handle: e.handle, send: e.send };
    }
    return null;
  }

  #watch(e: Entry<H>): void {
    if (!awaitsAck(e)) return;
    this.#unconfirmed.push(e);
    if (this.#unconfirmed.length > this.lookback) this.#unconfirmed.shift();
  }
}

/** `send` after a SEND_CONFIRMED push (round trip as measured by the radio). */
export function confirmedSend(send: PacketSend, rttMs: number, ts: number): PacketSend {
  return { ...send, status: 'confirmed', confirmedAt: ts, rttMs };
}
