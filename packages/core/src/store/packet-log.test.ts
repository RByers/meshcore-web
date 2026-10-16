import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { sha256 } from '../packet/crypto.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import { buildTracePayload } from '../packet/payloads.js';
import { toHex } from '../util/bytes.js';
import type { DeviceFrame } from '../protocol/types.js';
import { packetInputFromFrame } from './packet-log.js';
import { advertPacket, grpTxtPacket, openStore } from './test-helpers.js';

describe('PacketLog', () => {
  it('parses the envelope and stores the §1.4 packet hash', async () => {
    const s = await openStore();
    const bytes = grpTxtPacket(2);
    const rec = await s.packets.append({ direction: 'rx', bytes, ts: 50, snr: 5.25, rssi: -90, sourceFrameId: 9, source: 'logRxData' });
    // header 0x15 = FLOOD(1) | GRP_TXT(5) << 2; path_len 0x02; 2 path bytes; 20-byte payload
    expect(bytes[0]).toBe(0x15);
    expect(rec).toMatchObject({
      id: 1,
      ts: 50,
      direction: 'rx',
      format: 'packet',
      source: 'logRxData',
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.GRP_TXT,
      pathLen: 2,
      snr: 5.25,
      rssi: -90,
      sourceFrameId: 9,
      decodedSummary: 'GRP_TXT FLOOD 2 hops, 24 B',
    });
    // hash = SHA256(payload_type ‖ payload)[0..8]
    const expected = toHex((await sha256(Uint8Array.of(PayloadType.GRP_TXT), bytes.subarray(4))).subarray(0, 8));
    expect(rec.hash).toBe(expected);
    expect(rec.parseError).toBeUndefined();
    s.close();
  });

  it('keeps unparsable packets with a parse error', async () => {
    const s = await openStore();
    const rec = await s.packets.append({ direction: 'rx', bytes: Uint8Array.of(0x15) });
    expect(rec.payloadType).toBe(-1);
    expect(rec.routeType).toBe(-1);
    expect(rec.hash).toBe('');
    expect(rec.parseError).toBeTruthy();
    s.close();
  });

  it('maps packet-bearing pushes and ignores others', async () => {
    const rx: DeviceFrame = { kind: 'logRxData', code: 0x88, snr: -2.5, rssi: -101, packet: grpTxtPacket(1) };
    expect(packetInputFromFrame(rx, { ts: 7, sourceFrameId: 3 })).toEqual({
      direction: 'rx',
      ts: 7,
      sourceFrameId: 3,
      bytes: rx.packet,
      format: 'packet',
      source: 'logRxData',
      snr: -2.5,
      rssi: -101,
    });
    const raw: DeviceFrame = { kind: 'rawData', code: 0x84, snr: 1, rssi: -50, payload: Uint8Array.of(1, 2, 3) };
    expect(packetInputFromFrame(raw)).toMatchObject({ format: 'payload', source: 'rawData', payloadType: PayloadType.RAW_CUSTOM });
    const trace: DeviceFrame = {
      kind: 'traceData',
      code: 0x89,
      pathLen: 2,
      flags: 0,
      pathHashSize: 1,
      tag: 0x01020304,
      authCode: 0x0a0b0c0d,
      pathHashes: Uint8Array.of(0xaa, 0xbb),
      hops: [Uint8Array.of(0xaa), Uint8Array.of(0xbb)],
      snrs: [1, 2],
      finalSnr: 3.5,
    };
    const ti = packetInputFromFrame(trace)!;
    expect(ti.bytes).toEqual(buildTracePayload({ tag: 0x01020304, authCode: 0x0a0b0c0d, flags: 0, hashes: Uint8Array.of(0xaa, 0xbb) }));
    expect(ti).toMatchObject({ payloadType: PayloadType.TRACE, source: 'traceData', snr: 3.5, pathLen: 2 });
    expect(packetInputFromFrame({ kind: 'ok', code: 0x00 })).toBeNull();

    const s = await openStore();
    const rec = await s.packets.appendFromFrame(raw);
    expect(rec).toMatchObject({ format: 'payload', payloadType: PayloadType.RAW_CUSTOM, decodedSummary: 'RAW_CUSTOM payload, 3 B' });
    expect(rec!.hash).toBe(toHex((await sha256(Uint8Array.of(PayloadType.RAW_CUSTOM), raw.payload)).subarray(0, 8)));
    expect(await s.packets.appendFromFrame({ kind: 'msgWaiting', code: 0x83 })).toBeNull();
    s.close();
  });

  it('queries by time range, type, direction, route and hash with paging', async () => {
    const s = await openStore();
    const inputs = [];
    for (let i = 0; i < 12; i++) {
      inputs.push({
        direction: i < 8 ? ('rx' as const) : ('tx' as const),
        bytes: i % 3 === 0 ? advertPacket(i) : grpTxtPacket(i % 4, i),
        ts: 100 + i,
        source: i < 8 ? ('logRxData' as const) : ('sent' as const),
      });
    }
    await s.packets.appendMany(inputs);
    const adverts = await s.packets.query({ payloadType: PayloadType.ADVERT });
    expect(adverts.items.map((p) => p.ts)).toEqual([109, 106, 103, 100]);
    const advertsRx = await s.packets.query({ payloadType: PayloadType.ADVERT, direction: 'rx', from: 101 });
    expect(advertsRx.items.map((p) => p.ts)).toEqual([106, 103]);
    const tx = await s.packets.query({ direction: 'tx', order: 'asc', limit: 2 });
    expect(tx.items.map((p) => p.ts)).toEqual([108, 109]);
    expect(tx.hasMore).toBe(true);
    const page2 = await s.packets.query({ direction: 'tx', order: 'asc', limit: 2, offset: 2 });
    expect(page2.items.map((p) => p.ts)).toEqual([110, 111]);
    expect(page2.hasMore).toBe(false);
    const direct = await s.packets.query({ routeType: RouteType.DIRECT, to: 105 });
    expect(direct.items.map((p) => p.ts)).toEqual([103, 100]);
    expect(await s.packets.count({ source: 'sent' })).toBe(4);
    expect(await s.packets.count({ payloadType: PayloadType.GRP_TXT })).toBe(8);
    expect(await s.packets.count({ from: 105, to: 107 })).toBe(3);

    // Same packet heard twice (different path) shares a hash.
    const a = await s.packets.append({ direction: 'rx', bytes: grpTxtPacket(0, 0x42), ts: 200 });
    const b = await s.packets.append({ direction: 'rx', bytes: grpTxtPacket(3, 0x42), ts: 201 });
    expect(a.hash).toBe(b.hash);
    expect((await s.packets.byHash(a.hash.toUpperCase())).map((p) => p.id)).toEqual([a.id, b.id]);
    expect((await s.packets.query({ hash: a.hash, from: 201 })).items.map((p) => p.id)).toEqual([b.id]);
    s.close();
  });

  it('export / import round trip and validation', async () => {
    const a = await openStore();
    await a.packets.append({ direction: 'rx', bytes: grpTxtPacket(1), ts: 1, snr: 2, rssi: -70 });
    await a.packets.append({ direction: 'tx', bytes: advertPacket(), ts: 2, source: 'sent' });
    await a.packets.appendFromFrame({ kind: 'rawData', code: 0x84, snr: 1, rssi: -50, payload: Uint8Array.of(9) }, { ts: 3 });
    const exp = await a.packets.export();
    expect(exp.format).toBe('meshcore-web/packets');
    expect(typeof exp.items[0]!.bytes).toBe('string');
    const b = await openStore(2);
    expect(await b.packets.import(JSON.stringify(exp))).toBe(3);
    const strip = <T extends { id: number }>(r: T) => ({ ...r, id: 0 });
    expect((await b.packets.query({ order: 'asc' })).items.map(strip)).toEqual((await a.packets.query({ order: 'asc' })).items.map(strip));
    await expect(b.packets.import({ ...exp, items: [{ ...exp.items[0]!, source: 'bogus' }] })).rejects.toThrow(/source/);
    await expect(b.packets.import({ ...exp, items: [{ ...exp.items[0]!, ts: 'x' }] })).rejects.toThrow(/ts/);
    await expect(b.packets.import('{"format":"meshcore-web/packets","version":2,"items":[]}')).rejects.toThrow(/v1/);
    // Filtered export
    expect((await a.packets.export({ direction: 'tx' })).items.map((p) => p.ts)).toEqual([2]);
    a.close();
    b.close();
  });

  it('prunes by age and count', async () => {
    const s = await openStore(1, { retention: { packets: { maxCount: 3, maxAgeMs: 10_000 } } });
    await s.packets.appendMany(Array.from({ length: 6 }, (_, i) => ({ direction: 'rx' as const, bytes: grpTxtPacket(0, i), ts: i * 5000 })));
    // now = 25000: age removes ts < 15000 (3 records); 3 left = maxCount.
    expect(await s.packets.prune(undefined, 25_000)).toBe(3);
    expect(await s.packets.prune({ maxCount: 1 })).toBe(2);
    expect((await s.packets.latest()).map((p) => p.ts)).toEqual([25_000]);
    const r = await s.prune(1_000_000);
    expect(r).toEqual({ frames: 0, packets: 1 });
    s.close();
  });

  it('emits packet events', async () => {
    const s = await openStore();
    const got: number[] = [];
    s.events.on('packet', (p) => got.push(p.payloadType));
    await s.packets.append({ direction: 'rx', bytes: advertPacket() });
    expect(got).toEqual([PayloadType.ADVERT]);
    s.close();
  });
});

describe('log queries with a residual `match` predicate', () => {
  it('applies match before offset/limit and in count/export, combined with indexed filters', async () => {
    const s = await openStore();
    for (let i = 0; i < 6; i++) await s.packets.append({ direction: i % 2 ? 'tx' : 'rx', bytes: grpTxtPacket(i % 3), ts: 100 + i });
    const even = (r: { pathLen: number }) => r.pathLen === 0;
    const page = await s.packets.query({ match: even, order: 'asc', limit: 1, offset: 1 });
    expect(page.items.map((r) => r.ts)).toEqual([103]);
    expect(page.hasMore).toBe(false);
    expect(await s.packets.count({ match: even })).toBe(2);
    expect(await s.packets.count({ match: even, direction: 'tx' })).toBe(1);
    expect(await s.packets.count({ match: even, payloadType: PayloadType.GRP_TXT })).toBe(2);
    expect((await s.packets.export({ match: even })).count).toBe(2);
    await s.frames.append({ direction: 'out', bytes: Uint8Array.of(0x16, 3), ts: 1 });
    await s.frames.append({ direction: 'in', bytes: Uint8Array.of(0x00), ts: 2 });
    expect(await s.frames.count({ match: (r) => r.size === 2 })).toBe(1);
    expect(await s.frames.count({ match: (r) => r.size === 2, direction: 'in' })).toBe(0);
    expect(await s.frames.count({ match: (r) => r.size === 2, code: 0x16 })).toBe(1);
    s.close();
  });
});
