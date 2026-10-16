import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { encodeCommand } from '../protocol/encode.js';
import { encodeDeviceFrame } from '../protocol/encode-frame.js';
import type { FrameRecord } from './schema.js';
import { ImportError } from './time-log.js';
import { frameKind } from './frame-log.js';
import { openStore } from './test-helpers.js';

const OK = Uint8Array.of(0x00);
const DEVICE_QUERY = encodeCommand({ kind: 'deviceQuery', appVersion: 3 } as Parameters<typeof encodeCommand>[0]);

describe('FrameLog', () => {
  it('derives code, size and kind', async () => {
    const s = await openStore();
    const inRec = await s.frames.append({ direction: 'in', bytes: OK, ts: 10 });
    expect(inRec).toMatchObject({ id: 1, ts: 10, direction: 'in', code: 0, kind: 'ok', size: 1 });
    const outRec = await s.frames.append({ direction: 'out', bytes: DEVICE_QUERY, ts: 11 });
    expect(outRec.kind).toBe('deviceQuery');
    expect(outRec.code).toBe(DEVICE_QUERY[0]);
    const custom = await s.frames.append({ direction: 'in', bytes: Uint8Array.of(0x77), kind: 'mine' });
    expect(custom.kind).toBe('mine');
    expect(frameKind('in', new Uint8Array(0))).toBe('unknown');
    expect(frameKind('out', Uint8Array.of(0xfe))).toBe('unknown');
    expect(await s.frames.get(1)).toEqual(inRec);
    s.close();
  });

  it('pages newest-first with offset, filters by direction/code/kind/time and counts', async () => {
    const s = await openStore();
    const inputs = [];
    for (let i = 0; i < 25; i++) {
      inputs.push({ direction: i % 2 ? ('out' as const) : ('in' as const), bytes: i % 2 ? DEVICE_QUERY : OK, ts: 1000 + i });
    }
    await s.frames.appendMany(inputs);
    const p1 = await s.frames.query({ limit: 10 });
    expect(p1.items.map((f) => f.ts)).toEqual(Array.from({ length: 10 }, (_, i) => 1024 - i));
    expect(p1.hasMore).toBe(true);
    const p3 = await s.frames.query({ limit: 10, offset: 20 });
    expect(p3.items.map((f) => f.ts)).toEqual([1004, 1003, 1002, 1001, 1000]);
    expect(p3.hasMore).toBe(false);
    const asc = await s.frames.query({ limit: 3, order: 'asc', from: 1010 });
    expect(asc.items.map((f) => f.ts)).toEqual([1010, 1011, 1012]);
    const outs = await s.frames.query({ direction: 'out', from: 1005, to: 1011 });
    expect(outs.items.map((f) => f.ts)).toEqual([1011, 1009, 1007, 1005]);
    const byCode = await s.frames.query({ code: 0, to: 1004 });
    expect(byCode.items.map((f) => f.ts)).toEqual([1004, 1002, 1000]);
    const byKind = await s.frames.query({ kind: 'deviceQuery', limit: 2 });
    expect(byKind.items.map((f) => f.ts)).toEqual([1023, 1021]);
    expect(await s.frames.count()).toBe(25);
    expect(await s.frames.count({ direction: 'in' })).toBe(13);
    expect(await s.frames.count({ kind: 'ok', from: 1020 })).toBe(3);
    expect((await s.frames.latest(2)).map((f) => f.ts)).toEqual([1024, 1023]);
    s.close();
  });

  it('orders equal timestamps by id', async () => {
    const s = await openStore();
    await s.frames.appendMany([1, 2, 3].map(() => ({ direction: 'in' as const, bytes: OK, ts: 5 })));
    expect((await s.frames.query()).items.map((f) => f.id)).toEqual([3, 2, 1]);
    expect((await s.frames.query({ order: 'asc' })).items.map((f) => f.id)).toEqual([1, 2, 3]);
    s.close();
  });

  it('export / import round trip with bytes as hex', async () => {
    const a = await openStore();
    await a.frames.append({ direction: 'in', bytes: OK, ts: 1 });
    await a.frames.append({ direction: 'out', bytes: DEVICE_QUERY, ts: 2 });
    const exported = await a.frames.export();
    expect(exported.format).toBe('meshcore-web/frames');
    expect(exported.count).toBe(2);
    expect(exported.items[1]!.bytes).toBe(Array.from(DEVICE_QUERY, (b) => b.toString(16).padStart(2, '0')).join(''));
    const json = JSON.stringify(exported);

    const b = await openStore(2);
    await b.frames.append({ direction: 'in', bytes: OK, ts: 0 });
    expect(await b.frames.import(json)).toBe(2);
    const all = (await b.frames.query({ order: 'asc' })).items;
    expect(all.map((f) => f.ts)).toEqual([0, 1, 2]);
    const strip = (f: FrameRecord) => ({ ...f, id: 0 });
    expect(all.slice(1).map(strip)).toEqual((await a.frames.query({ order: 'asc' })).items.map(strip));
    expect(all[2]!.bytes).toBeInstanceOf(Uint8Array);

    await expect(b.frames.import({ format: 'meshcore-web/packets', version: 1, items: [] })).rejects.toBeInstanceOf(ImportError);
    await expect(
      b.frames.import({ format: 'meshcore-web/frames', version: 1, items: [{ ts: 1, direction: 'in', bytes: 'zz' }] }),
    ).rejects.toThrow(/item 0/);
    await expect(
      b.frames.import({ format: 'meshcore-web/frames', version: 1, items: [{ ts: 1, direction: 'sideways', bytes: '00' }] }),
    ).rejects.toThrow(/direction/);
    expect(await b.frames.count()).toBe(3); // failed imports wrote nothing
    a.close();
    b.close();
  });

  it('import can preserve ids', async () => {
    const a = await openStore();
    await a.frames.appendMany([1, 2].map((ts) => ({ direction: 'in' as const, bytes: OK, ts })));
    const b = await openStore(2);
    await b.frames.import(await a.frames.export(), { preserveIds: true });
    expect((await b.frames.query({ order: 'asc' })).items.map((f) => f.id)).toEqual([1, 2]);
    a.close();
    b.close();
  });

  it('prunes by age and by count, oldest first', async () => {
    const s = await openStore(1, { retention: { frames: { maxCount: 5 } } });
    await s.frames.appendMany(Array.from({ length: 10 }, (_, i) => ({ direction: 'in' as const, bytes: OK, ts: i * 1000 })));
    expect(await s.frames.prune({ maxAgeMs: 3500 }, 9000)).toBe(6); // ts < 5500 removed
    expect((await s.frames.query({ order: 'asc' })).items.map((f) => f.ts)).toEqual([6000, 7000, 8000, 9000]);
    expect(await s.frames.prune({ maxCount: 2 })).toBe(2);
    expect((await s.frames.query({ order: 'asc' })).items.map((f) => f.ts)).toEqual([8000, 9000]);
    expect(await s.frames.prune({ maxCount: 2 })).toBe(0);
    // configured default (maxCount 5)
    await s.frames.appendMany(Array.from({ length: 6 }, () => ({ direction: 'in' as const, bytes: OK, ts: 20_000 })));
    expect(s.frames.retention.maxCount).toBe(5);
    expect(s.frames.retention.maxAgeMs).toBeGreaterThan(0); // DEFAULT_RETENTION merged in
    expect(await s.frames.prune(undefined, 20_000)).toBe(3);
    expect(await s.frames.count()).toBe(5);
    s.close();
  });

  it('clear empties the log', async () => {
    const s = await openStore();
    await s.frames.append({ direction: 'in', bytes: OK });
    expect(await s.frames.clear()).toBe(1);
    expect(await s.frames.count()).toBe(0);
    s.close();
  });

  it('emits frame and logChanged events', async () => {
    const s = await openStore();
    const seen: string[] = [];
    s.events.on('frame', (f) => seen.push(`frame:${f.kind}`));
    s.events.on('logChanged', (e) => seen.push(`${e.store}:${e.reason}:${e.removed}:${e.added}`));
    await s.frames.append({ direction: 'in', bytes: OK, ts: 1 });
    await s.frames.prune({ maxCount: 0 });
    await s.frames.import({ format: 'meshcore-web/frames', version: 1, items: [{ ts: 1, direction: 'in', bytes: '00' }] });
    await s.frames.clear();
    expect(seen).toEqual(['frame:ok', 'frames:prune:1:0', 'frames:import:0:1', 'frames:clear:1:0']);
    s.close();
  });

  it('a throwing listener does not fail the write', async () => {
    const s = await openStore();
    const origError = console.error;
    const errors: unknown[] = [];
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      s.events.on('frame', () => {
        throw new Error('listener bug');
      });
      await expect(s.frames.append({ direction: 'in', bytes: OK })).resolves.toMatchObject({ kind: 'ok' });
      expect(errors).toHaveLength(1);
    } finally {
      console.error = origError;
    }
    s.close();
  });

  it('encodeDeviceFrame output is logged with its decoded kind', async () => {
    const s = await openStore();
    const bytes = encodeDeviceFrame({ kind: 'currTime', code: 0x09, epochSecs: 1234 });
    expect((await s.frames.append({ direction: 'in', bytes })).kind).toBe('currTime');
    s.close();
  });
});
