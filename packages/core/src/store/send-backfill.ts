/**
 * One-time rebuild of sent-packet history from the frame log, so the packet log (kept forever) is
 * the permanent record of what this radio transmitted while frames age out:
 *
 * - command frames that make the radio transmit but have no `tx` packet row (captured before
 *   sends were logged as packets, or whose row is missing) get one (packetInputFromCommand, with
 *   the frame's ts and `sourceFrameId`);
 * - the frames that followed (RESP_SENT / OK / ERR, SEND_CONFIRMED) fill in `send` on those rows
 *   and on existing tx rows that lack it, through the same {@link SendCorrelator} live capture uses.
 *
 * Idempotent: rows are matched by `sourceFrameId` and only written when something changed, so a
 * re-run is a no-op. Frames are read oldest-first in id-ordered batches, one read and one write
 * transaction per batch. {@link runSendBackfillOnce} guards the automatic run with a per-radio
 * setting.
 */

import { RESP, PUSH } from '../protocol/constants.js';
import { decodeFrame } from '../protocol/decode.js';
import { tryDecodeCommand } from '../protocol/decode-command.js';
import type { Command, DeviceFrame } from '../protocol/types.js';
import { toHex } from '../util/bytes.js';
import { safeEmit } from './events.js';
import { packetInputFromCommand, packetRecordFromInput, type CommandPacketNames } from './packet-log.js';
import type { RadioStore } from './radio-store.js';
import { INDEX, STORE, type FrameRecord, type PacketRecord, type PacketSend } from './schema.js';
import { SendCorrelator } from './send-correlator.js';

/** Per-radio setting written once the automatic backfill has completed ({@link SendBackfillResult} + `at`). */
export const SEND_BACKFILL_SETTING = 'packets.sendBackfill';

export interface SendBackfillOptions {
  /** Only frames with id ≤ this (default: all). Frames captured meanwhile are handled live. */
  upToFrameId?: number;
  /** Frames per transaction (default 2000). */
  batchSize?: number;
  /** Checked before each batch; true stops early (counts so far are returned). */
  cancelled?: () => boolean;
}

export interface SendBackfillResult {
  framesScanned: number;
  /** tx rows created. */
  added: number;
  /** Existing tx rows whose `send` / route type changed. */
  updated: number;
}

/** Response / push codes the correlator reads; other frames are not decoded. */
const DECODED_IN = new Set<number>([RESP.OK, RESP.ERR, RESP.SENT, RESP.DISABLED, PUSH.SEND_CONFIRMED]);

/** A tx row being rebuilt / enriched; `counted` once it is in `added` or `updated`. */
type Row = { rec: Omit<PacketRecord, 'id'> & { id?: number }; counted: boolean };

/** Rebuilds missing tx rows and their send outcomes from the frame log. See the module doc. */
export async function backfillSentPackets(store: RadioStore, opts: SendBackfillOptions = {}): Promise<SendBackfillResult> {
  const batchSize = Math.max(1, opts.batchSize ?? 2000);
  const upTo = opts.upToFrameId ?? Infinity;
  const { db } = store;

  // existing tx rows by the command frame that logged them (tx rows are a small share of the log)
  const existing = new Map<number, Row>();
  await db.transaction(STORE.packets, 'readonly', (t) =>
    t.store<PacketRecord>(STORE.packets).each({ index: INDEX.packets.directionTs, query: db.range(['tx', -Infinity], ['tx', Infinity]) }, (r) => {
      if (r.source === 'sent' && r.sourceFrameId !== undefined) existing.set(r.sourceFrameId, { rec: r, counted: false });
    }),
  );

  const corr = new SendCorrelator<Row>();
  const names = new Map<string, CommandPacketNames>();
  const result: SendBackfillResult = { framesScanned: 0, added: 0, updated: 0 };
  const commandNames = async (cmd: Command): Promise<CommandPacketNames> => {
    const k = nameKey(cmd);
    let n = names.get(k);
    if (!n) names.set(k, (n = await store.commandNames(cmd)));
    return n;
  };

  let after = 0;
  for (;;) {
    if (after >= upTo) break;
    if (opts.cancelled?.()) break;
    const frames = await db.iterate<FrameRecord>(STORE.frames, { query: db.range(after, upTo === Infinity ? undefined : upTo, true, false), limit: batchSize });
    if (frames.length === 0) break;
    after = frames[frames.length - 1]!.id;
    result.framesScanned += frames.length;
    const added: Row[] = [];
    const touched = new Set<Row>();
    for (const f of frames) {
      if (f.direction === 'out') {
        let row = existing.get(f.id);
        if (row?.rec.send === undefined) {
          const res = tryDecodeCommand(f.bytes);
          const input = res.ok ? packetInputFromCommand(res.command, { ts: f.ts, sourceFrameId: f.id, names: await commandNames(res.command) }) : null;
          if (row && input?.send) {
            row.rec.send = input.send; // an older row: start it pending, with its peer / channel
            touched.add(row);
          } else if (!row && input) {
            row = { rec: await packetRecordFromInput(input, f.ts), counted: false };
            added.push(row);
          }
        }
        corr.command(row ?? null, row?.rec);
      } else {
        let decoded: DeviceFrame | null = null;
        if (DECODED_IN.has(f.code)) {
          try {
            decoded = decodeFrame(f.bytes);
          } catch {
            decoded = null;
          }
        }
        for (const u of corr.device(f.code, decoded, f.ts)) {
          const rec = u.handle.rec;
          if (sameSend(rec.send, u.send) && (u.routeType === undefined || u.routeType === rec.routeType)) continue;
          rec.send = u.send;
          if (u.routeType !== undefined) rec.routeType = u.routeType;
          touched.add(u.handle);
        }
      }
    }
    const puts: PacketRecord[] = [];
    for (const row of touched) {
      if (row.rec.id === undefined) continue; // new in this batch: added below with its changes
      if (!row.counted) result.updated++;
      row.counted = true;
      puts.push(row.rec as PacketRecord);
    }
    const ids = await store.packets.writeBatch(
      added.map((r) => r.rec),
      puts,
    );
    added.forEach((r, i) => {
      r.rec.id = ids[i]!;
      r.counted = true; // counted as added, not updated
    });
    result.added += added.length;
  }
  if (result.added + result.updated > 0) {
    safeEmit(store.events, 'logChanged', { store: 'packets', reason: 'backfill', removed: 0, added: result.added, updated: result.updated });
  }
  return result;
}

/**
 * Runs {@link backfillSentPackets} unless this radio's {@link SEND_BACKFILL_SETTING} says it has
 * already completed; records completion (not when cancelled: the next run starts over). Resolves
 * null when skipped.
 */
export async function runSendBackfillOnce(
  store: RadioStore,
  opts: SendBackfillOptions & { now?: number } = {},
): Promise<SendBackfillResult | null> {
  if ((await store.settings.get<unknown>(SEND_BACKFILL_SETTING)) !== undefined) return null;
  const result = await backfillSentPackets(store, opts);
  if (opts.cancelled?.()) return result; // possibly incomplete: the next run starts over
  await store.settings.set(SEND_BACKFILL_SETTING, { ...result, at: opts.now ?? store.clock.now() });
  return result;
}

function nameKey(cmd: Command): string {
  if (cmd.kind === 'sendChannelTxtMsg' || cmd.kind === 'sendChannelData') return `c${cmd.channelIdx}`;
  if (cmd.kind === 'sendTxtMsg') return `k${hex6(cmd.recipient)}`;
  if ('pubKey' in cmd && cmd.pubKey instanceof Uint8Array) return `k${hex6(cmd.pubKey)}`;
  return '';
}

const hex6 = (b: Uint8Array): string => toHex(b.subarray(0, 6));

function sameSend(a: PacketSend | undefined, b: PacketSend): boolean {
  if (!a) return false;
  const ka = Object.keys(a) as (keyof PacketSend)[];
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}
