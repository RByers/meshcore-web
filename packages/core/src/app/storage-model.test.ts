import { describe, expect, it, vi } from 'vitest';
import type { RadioDbStats } from '../store/db-stats.js';
import type { DeviceRecord } from '../store/schema.js';
import { signal } from './signal.js';
import { StorageModel } from './storage-model.js';
import { connectedApp } from './testing.js';

function device(pubKey: string): DeviceRecord {
  return { pubKey, name: pubKey, firstConnected: 0, lastConnected: 0, transport: 'emulator' };
}

function fakeStats(pubKey: string, approxBytes: number): RadioDbStats {
  const counts = { frames: 0, packets: approxBytes, contacts: 0, messages: 0, channels: 0, settings: 0 };
  return { pubKey, exists: true, counts, bytesByStore: { ...counts }, approxBytes };
}

describe('StorageModel', () => {
  it('reports the connected radio’s stored packets and an approximate size', async () => {
    const t = await connectedApp();
    await t.store.packets.append({ direction: 'rx', bytes: new Uint8Array(64), ts: 1 });
    const storage = t.app.storage;
    await storage.refresh();
    const key = t.app.connection.pubKey.peek()!;
    const entry = storage.byDevice.value[key];
    expect(entry?.status).toBe('ready');
    expect(entry?.stats?.counts.packets).toBe(await t.store.packets.count());
    expect(entry?.stats?.counts.packets).toBeGreaterThanOrEqual(1);
    expect(entry?.stats?.counts.contacts).toBe(await t.store.contacts.count());
    expect(entry?.stats?.approxBytes).toBeGreaterThan(64);
    expect(storage.totalBytes.value).toBe(entry?.stats?.approxBytes);
    expect(storage.loading.value).toBe(false);
  });

  it('marks loading, keeps previous stats, records per-radio errors and coalesces refreshes', async () => {
    const devices = signal<readonly DeviceRecord[]>([device('aa'), device('bb')]);
    let size = 10;
    const gates: Array<() => void> = [];
    const stats = vi.fn(async (pubKey: string) => {
      await new Promise<void>((r) => gates.push(r));
      if (pubKey === 'bb') throw new Error('boom');
      return fakeStats(pubKey, size);
    });
    const m = new StorageModel({ devices, storeOptions: () => ({}), stats });

    const first = m.refresh();
    expect(m.loading.value).toBe(true);
    expect(m.byDevice.value['aa']).toMatchObject({ status: 'loading', stats: null });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates.shift()!();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(m.byDevice.value['aa']).toMatchObject({ status: 'ready', stats: { approxBytes: 10 } });
    // a second call while running schedules exactly one more pass
    size = 20;
    const second = m.refresh();
    void m.refresh();
    gates.shift()!();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    // second pass: previous stats kept while loading
    expect(m.byDevice.value['aa']).toMatchObject({ status: 'loading', stats: { approxBytes: 10 } });
    expect(m.byDevice.value['bb']).toMatchObject({ status: 'loading', error: null });
    gates.shift()!();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates.shift()!();
    await Promise.all([first, second]);
    expect(stats).toHaveBeenCalledTimes(4);
    expect(m.byDevice.value['aa']).toMatchObject({ status: 'ready', stats: { approxBytes: 20 } });
    expect(m.byDevice.value['bb']).toMatchObject({ status: 'error', stats: null, error: 'boom' });
    expect(m.totalBytes.value).toBe(20);
    expect(m.loading.value).toBe(false);
  });
});
