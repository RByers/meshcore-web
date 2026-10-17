import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { approxValueBytes, radioDbStats } from './db-stats.js';
import { RadioStore } from './radio-store.js';
import { radioDbName } from './schema.js';
import { freshFactory, grpTxtPacket, hexKey, key32, makeContact } from './test-helpers.js';

describe('approxValueBytes', () => {
  it('sums binary lengths, UTF-16 strings, 8-byte numbers, 1-byte booleans and keys', () => {
    expect(approxValueBytes(Uint8Array.of(1, 2, 3))).toBe(3);
    expect(approxValueBytes(new ArrayBuffer(7))).toBe(7);
    expect(approxValueBytes(new DataView(new ArrayBuffer(5)))).toBe(5);
    expect(approxValueBytes('abc')).toBe(6);
    expect(approxValueBytes(1.5)).toBe(8);
    expect(approxValueBytes(true)).toBe(1);
    expect(approxValueBytes(null)).toBe(0);
    expect(approxValueBytes(undefined)).toBe(0);
    expect(approxValueBytes([1, 'a', Uint8Array.of(9)])).toBe(8 + 2 + 1);
    // keys: "id" 4 + "bytes" 10 + "ok" 4; values: 8 + 4 + 1
    expect(approxValueBytes({ id: 1, bytes: new Uint8Array(4), ok: false })).toBe(4 + 8 + 10 + 4 + 4 + 1);
    expect(approxValueBytes({ a: { b: 'xy' } })).toBe(2 + (2 + 4));
    expect(approxValueBytes(new Map([['k', 1]]))).toBe(2 + 8);
  });
});

describe('radioDbStats', () => {
  it('counts records per store and estimates their size', async () => {
    const factory = freshFactory();
    const s = await RadioStore.open(key32(0x01), { factory });
    const empty = await radioDbStats(key32(0x01), { factory });
    expect(empty).toMatchObject({ pubKey: hexKey(0x01), exists: true, approxBytes: 0 });
    expect(empty.counts).toEqual({ frames: 0, packets: 0, contacts: 0, messages: 0, channels: 0, settings: 0 });

    await s.packets.append({ direction: 'rx', bytes: grpTxtPacket(), ts: 1 });
    await s.packets.append({ direction: 'rx', bytes: grpTxtPacket(2), ts: 2 });
    await s.frames.append({ direction: 'in', bytes: Uint8Array.of(0) });
    await s.contacts.upsertFromDevice(makeContact(5));
    const setting = { key: 'x', value: 'hello' };
    await s.settings.set(setting.key, setting.value);

    const st = await radioDbStats(hexKey(0x01).toUpperCase(), { factory });
    expect(st.counts).toEqual({ frames: 1, packets: 2, contacts: 1, messages: 0, channels: 0, settings: 1 });
    // the stored setting record is exactly { key, value }
    expect(st.bytesByStore.settings).toBe(approxValueBytes(setting));
    expect(st.bytesByStore.packets).toBeGreaterThan(2 * grpTxtPacket().length);
    expect(st.approxBytes).toBe(Object.values(st.bytesByStore).reduce((a, b) => a + b, 0));

    await s.packets.append({ direction: 'rx', bytes: new Uint8Array(200), ts: 3 });
    const more = await radioDbStats(key32(0x01), { factory });
    expect(more.counts.packets).toBe(3);
    expect(more.approxBytes).toBeGreaterThanOrEqual(st.approxBytes + 200);
    s.close();
  });

  it('reports a missing database without creating it', async () => {
    const factory = freshFactory();
    const st = await radioDbStats(key32(0x02), { factory });
    expect(st).toMatchObject({ exists: false, approxBytes: 0 });
    expect(st.counts.packets).toBe(0);
    const names = (await factory.databases()).map((d) => d.name);
    expect(names).not.toContain(radioDbName(key32(0x02)));
  });

  it('rejects when IndexedDB is unavailable', async () => {
    const g = globalThis as { indexedDB?: unknown };
    const saved = g.indexedDB;
    delete g.indexedDB;
    try {
      await expect(radioDbStats(key32(0x03))).rejects.toThrow(/IndexedDB is not available/);
    } finally {
      if (saved !== undefined) g.indexedDB = saved;
    }
  });
});
