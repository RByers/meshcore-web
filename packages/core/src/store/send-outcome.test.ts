/**
 * Send outcomes on tx packet rows (PacketRecord.send): live correlation in RadioStore.captureFrame
 * and the frame-log backfill. Frame layouts: companion-protocol.md §4 (commands), §5.1 (RESP_SENT
 * 0x06: [1]flood [2..5]tag u32 [6..9]est_timeout u32), §3 (RESP_ERR 0x01: [1]err code), §6
 * (SEND_CONFIRMED 0x82: [1..4]ack code [5..8]round trip ms u32).
 */

import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { RouteType, PayloadType } from '../packet/constants.js';
import { concatBytes, fromHex } from '../util/bytes.js';
import { packetInputFromCommand } from './packet-log.js';
import { RadioStore } from './radio-store.js';
import type { RadioStoreEvents } from './events.js';
import { SEND_BACKFILL_SETTING, backfillSentPackets, runSendBackfillOnce } from './send-backfill.js';
import { SendCorrelator } from './send-correlator.js';
import { freshFactory, key32, openStore } from './test-helpers.js';
import { tryDecodeCommand } from '../protocol/decode-command.js';

const hex = (s: string) => fromHex(s.replace(/\s/g, ''));
const text = (s: string) => new TextEncoder().encode(s);

/** §4 CMD 2: [1]txt_type [2]attempt [3..6]timestamp [7..12]recipient prefix6 [13..]text */
const dmCmd = (prefixFill = '22', msg = 'hi') => concatBytes(hex(`02 00 00 01000000 ${prefixFill.repeat(6)}`), text(msg));
/** §4 CMD 3: [1]txt_type [2]channel_idx [3..6]timestamp [7..]text */
const chanCmd = (idx = 2) => concatBytes(hex(`03 00 ${idx.toString(16).padStart(2, '0')} 01000000`), text('all'));
/** §5.1 RESP_SENT: flood, tag 0x12345678 (LE 78563412), est. timeout 1000 ms (LE e8030000). */
const sent = (flood: 0 | 1, tagLe = '78563412') => hex(`06 0${flood} ${tagLe} e8030000`);
/** §6 SEND_CONFIRMED: ack code, round trip 300 ms (LE 2c010000). */
const confirmed = (tagLe = '78563412') => hex(`82 ${tagLe} 2c010000`);
const OK = hex('00');
const ERR_NOT_FOUND = hex('01 02');
const DEVICE_QUERY = hex('16 03');

function collect<K extends keyof RadioStoreEvents>(s: RadioStore, ev: K): RadioStoreEvents[K][] {
  const out: RadioStoreEvents[K][] = [];
  s.events.on(ev, (e) => out.push(e));
  return out;
}

describe('live send outcome (RadioStore.captureFrame)', () => {
  it('DM: pending → sent (RESP_SENT fields, route from the flood flag) → confirmed (SEND_CONFIRMED rtt)', async () => {
    const s = await openStore();
    const updates = collect(s, 'packetUpdated');
    const { packet } = await s.captureFrame('out', dmCmd(), { ts: 1000 });
    expect(packet).toMatchObject({ routeType: -1, send: { status: 'pending', peer: '222222222222' } });

    await s.captureFrame('in', sent(0), { ts: 1010 });
    let row = await s.packets.get(packet!.id);
    expect(row).toMatchObject({
      routeType: RouteType.DIRECT,
      send: { status: 'sent', peer: '222222222222', flood: false, tag: 0x12345678, estTimeoutMs: 1000, respondedAt: 1010 },
    });

    await s.captureFrame('in', confirmed(), { ts: 1500 });
    row = await s.packets.get(packet!.id);
    expect(row!.send).toEqual({
      status: 'confirmed',
      peer: '222222222222',
      flood: false,
      tag: 0x12345678,
      estTimeoutMs: 1000,
      respondedAt: 1010,
      confirmedAt: 1500,
      rttMs: 300,
    });
    expect(updates.map((u) => u.record.send?.status)).toEqual(['sent', 'confirmed']);
    expect(updates[0]!.previous.send?.status).toBe('pending');
    // a duplicate confirmation changes nothing
    await s.captureFrame('in', confirmed(), { ts: 1600 });
    expect(updates).toHaveLength(2);
    s.close();
  });

  it('flood: SENT [1]=1 sets FLOOD on a DM; a route fixed by the command is kept', async () => {
    const s = await openStore();
    const dm = (await s.captureFrame('out', dmCmd())).packet!;
    await s.captureFrame('in', sent(1));
    expect(await s.packets.get(dm.id)).toMatchObject({ routeType: RouteType.FLOOD, send: { status: 'sent', flood: true } });
    // channel text answers OK (§4 CMD 3): sent, no tag; route stays FLOOD from the command
    const ch = (await s.captureFrame('out', chanCmd(2))).packet!;
    expect(ch.send).toEqual({ status: 'pending', channelIdx: 2 });
    await s.captureFrame('in', OK, { ts: 77 });
    expect(await s.packets.get(ch.id)).toMatchObject({ routeType: RouteType.FLOOD, send: { status: 'sent', channelIdx: 2, respondedAt: 77 } });
    s.close();
  });

  it('pending → failed on RESP_ERR (error name and code)', async () => {
    const s = await openStore();
    const dm = (await s.captureFrame('out', dmCmd())).packet!;
    await s.captureFrame('in', ERR_NOT_FOUND, { ts: 5 });
    expect((await s.packets.get(dm.id))!.send).toEqual({ status: 'failed', peer: '222222222222', error: 'NOT_FOUND', errCode: 2, respondedAt: 5 });
    expect((await s.packets.get(dm.id))!.routeType).toBe(-1);
    s.close();
  });

  it('a response only answers the latest command; pushes do not consume it', async () => {
    const s = await openStore();
    const dm = (await s.captureFrame('out', dmCmd())).packet!;
    await s.captureFrame('out', DEVICE_QUERY); // a newer, non-transmitting command
    await s.captureFrame('in', sent(0));
    expect((await s.packets.get(dm.id))!.send!.status).toBe('pending');
    const dm2 = (await s.captureFrame('out', dmCmd('33'))).packet!;
    await s.captureFrame('in', hex('83')); // MSG_WAITING push in between
    await s.captureFrame('in', sent(0));
    expect((await s.packets.get(dm2.id))!.send!.status).toBe('sent');
    s.close();
  });

  it('a repeated ACK code confirms the most recent unconfirmed DM', async () => {
    const s = await openStore();
    const a = (await s.captureFrame('out', dmCmd('22', 'a'))).packet!;
    await s.captureFrame('in', sent(0));
    const b = (await s.captureFrame('out', dmCmd('22', 'b'))).packet!;
    await s.captureFrame('in', sent(0));
    await s.captureFrame('in', confirmed());
    expect((await s.packets.get(a.id))!.send!.status).toBe('sent');
    expect((await s.packets.get(b.id))!.send!.status).toBe('confirmed');
    await s.captureFrame('in', confirmed());
    expect((await s.packets.get(a.id))!.send!.status).toBe('confirmed');
    s.close();
  });

  it('SEND_CONFIRMED after a reconnect (new store instance) is matched from the stored rows', async () => {
    const factory = freshFactory();
    const s1 = await RadioStore.open(key32(1), { factory });
    const dm = (await s1.captureFrame('out', dmCmd())).packet!;
    await s1.captureFrame('in', sent(0));
    s1.close();
    const s2 = await RadioStore.open(key32(1), { factory });
    await s2.captureFrame('in', confirmed(), { ts: 9 });
    expect((await s2.packets.get(dm.id))!.send).toMatchObject({ status: 'confirmed', confirmedAt: 9, rttMs: 300 });
    s2.close();
  });

  it('send round-trips through export / import', async () => {
    const s = await openStore();
    await s.captureFrame('out', dmCmd(), { ts: 1 });
    await s.captureFrame('in', sent(1), { ts: 2 });
    await s.captureFrame('in', confirmed(), { ts: 3 });
    await s.captureFrame('out', chanCmd(4), { ts: 4 });
    await s.captureFrame('in', ERR_NOT_FOUND, { ts: 5 });
    const before = (await s.packets.query({ order: 'asc' })).items.map((r) => r.send);
    const exp = JSON.parse(JSON.stringify(await s.packets.export())) as unknown;
    await s.packets.clear();
    expect(await s.packets.import(exp)).toBe(2);
    const after = (await s.packets.query({ order: 'asc' })).items.map((r) => r.send);
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ status: 'confirmed', flood: true, rttMs: 300 });
    expect(after[1]).toMatchObject({ status: 'failed', channelIdx: 4, error: 'NOT_FOUND' });
    // invalid send objects are rejected
    const bad = { format: 'meshcore-web/packets', version: 1, items: [{ ...(exp as { items: object[] }).items[0], send: { status: 'nope' } }] };
    await expect(s.packets.import(bad)).rejects.toThrow(/send|status/);
    s.close();
  });
});

describe('SendCorrelator', () => {
  it('leaves a row pending on an unrelated response and bounds the ACK lookback', () => {
    const c = new SendCorrelator<string>(2);
    const dm = { routeType: -1, payloadType: PayloadType.TXT_MSG };
    c.command('a', dm);
    expect(c.device(0x05, null, 1)).toEqual([]); // e.g. SELF_INFO: not a send response
    for (const h of ['b', 'c', 'd']) {
      c.command(h, dm);
      expect(c.device(0x06, { kind: 'sent', code: 0x06, flood: false, tag: 7, tagBytes: new Uint8Array(4), estTimeoutMs: 1 }, 2)).toHaveLength(1);
    }
    expect(c.confirm(7, 1, 3)?.handle).toBe('d');
    expect(c.confirm(7, 1, 3)?.handle).toBe('c');
    expect(c.confirm(7, 1, 3)).toBeNull(); // 'b' fell out of the lookback of 2
  });
});

/** Writes frames as an older client would have (no tx rows) and returns their ids. */
async function seedFrames(s: RadioStore, frames: [dir: 'in' | 'out', bytes: Uint8Array, ts: number][]): Promise<number[]> {
  const ids: number[] = [];
  for (const [direction, bytes, ts] of frames) ids.push((await s.frames.append({ direction, bytes, ts })).id);
  return ids;
}

describe('backfillSentPackets', () => {
  it('creates missing tx rows with the frame ts / sourceFrameId and their send outcome', async () => {
    const s = await openStore();
    const [dmF, , , chF, , advF] = await seedFrames(s, [
      ['out', dmCmd(), 100],
      ['in', sent(1), 101],
      ['in', confirmed(), 400],
      ['out', chanCmd(3), 500],
      ['in', ERR_NOT_FOUND, 501],
      ['out', hex('07 00'), 600], // zero-hop advert, no response logged
      ['out', DEVICE_QUERY, 700], // not a transmission
      ['in', OK, 701],
    ]);
    const changed = collect(s, 'logChanged');
    expect(await backfillSentPackets(s, { batchSize: 3 })).toEqual({ framesScanned: 8, added: 3, updated: 0 });
    const rows = (await s.packets.query({ order: 'asc' })).items;
    expect(rows.map((r) => [r.ts, r.sourceFrameId, r.send?.status])).toEqual([
      [100, dmF, 'confirmed'],
      [500, chF, 'failed'],
      [600, advF, 'pending'],
    ]);
    expect(rows[0]).toMatchObject({
      direction: 'tx',
      source: 'sent',
      payloadType: PayloadType.TXT_MSG,
      routeType: RouteType.FLOOD,
      decodedSummary: 'TXT_MSG → 222222222222: "hi"',
      send: { status: 'confirmed', peer: '222222222222', flood: true, tag: 0x12345678, estTimeoutMs: 1000, respondedAt: 101, confirmedAt: 400, rttMs: 300 },
    });
    expect(rows[1]!.send).toEqual({ status: 'failed', channelIdx: 3, error: 'NOT_FOUND', errCode: 2, respondedAt: 501 });
    expect(changed).toEqual([{ store: 'packets', reason: 'backfill', removed: 0, added: 3, updated: 0 }]);

    // re-running is a no-op
    expect(await backfillSentPackets(s, { batchSize: 2 })).toEqual({ framesScanned: 8, added: 0, updated: 0 });
    expect(await s.packets.count()).toBe(3);
    expect(changed).toHaveLength(1);
    s.close();
  });

  it('enriches existing tx rows that lack `send` and leaves rx rows and correlated rows alone', async () => {
    const s = await openStore();
    const [dmF] = await seedFrames(s, [
      ['out', dmCmd(), 100],
      ['in', sent(0), 101],
    ]);
    // a row as logged before `send` existed (#9): no send, route unknown
    const cmd = tryDecodeCommand(dmCmd());
    if (!cmd.ok) throw new Error('decode');
    const { send: _drop, ...old } = packetInputFromCommand(cmd.command, { ts: 100, sourceFrameId: dmF! })!;
    const oldRow = await s.packets.append(old);
    expect(oldRow.send).toBeUndefined();
    // a row captured live afterwards (already has send) and an rx row
    const live = (await s.captureFrame('out', dmCmd('33'), { ts: 200 })).packet!;
    await s.captureFrame('in', sent(1), { ts: 201 });
    const liveBefore = await s.packets.get(live.id);

    expect(await backfillSentPackets(s)).toMatchObject({ added: 0, updated: 1 });
    expect(await s.packets.get(oldRow.id)).toMatchObject({
      routeType: RouteType.DIRECT,
      send: { status: 'sent', peer: '222222222222', flood: false, tag: 0x12345678, respondedAt: 101 },
    });
    expect(await s.packets.get(live.id)).toEqual(liveBefore);
    expect(await s.packets.count()).toBe(2);
    expect(await backfillSentPackets(s)).toMatchObject({ added: 0, updated: 0 });
    s.close();
  });

  it('stops at upToFrameId', async () => {
    const s = await openStore();
    const [, , last] = await seedFrames(s, [
      ['out', dmCmd(), 1],
      ['in', sent(0), 2],
      ['out', chanCmd(), 3],
    ]);
    expect(await backfillSentPackets(s, { upToFrameId: last! - 1 })).toEqual({ framesScanned: 2, added: 1, updated: 0 });
    s.close();
  });

  it('runSendBackfillOnce records completion and does not run again', async () => {
    const s = await openStore();
    await seedFrames(s, [['out', dmCmd(), 1]]);
    expect(await runSendBackfillOnce(s, { now: 42 })).toEqual({ framesScanned: 1, added: 1, updated: 0 });
    expect(await s.settings.get(SEND_BACKFILL_SETTING)).toEqual({ framesScanned: 1, added: 1, updated: 0, at: 42 });
    await s.packets.clear();
    expect(await runSendBackfillOnce(s)).toBeNull();
    expect(await s.packets.count()).toBe(0);
    s.close();
  });
});
