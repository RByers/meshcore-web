import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { DevicesRepo } from './devices.js';
import { RadioStore } from './radio-store.js';
import { DEVICES_DB_NAME, radioDbName } from './schema.js';
import { freshFactory, hexKey, key32, openStore } from './test-helpers.js';
import type { DeviceInfo, SelfInfo } from '../protocol/types.js';

describe('SettingsRepo', () => {
  it('get / set / delete / all with events', async () => {
    const s = await openStore();
    const ev: unknown[] = [];
    s.events.on('setting', (e) => ev.push([e.key, e.value]));
    expect(await s.settings.get('theme')).toBeUndefined();
    expect(await s.settings.get('theme', 'dark')).toBe('dark');
    await s.settings.set('theme', 'light');
    await s.settings.set('retry', { max: 5, bytes: Uint8Array.of(1) });
    expect(await s.settings.get<string>('theme', 'dark')).toBe('light');
    expect(await s.settings.all()).toEqual({ theme: 'light', retry: { max: 5, bytes: Uint8Array.of(1) } });
    await s.settings.delete('theme');
    expect(await s.settings.get('theme')).toBeUndefined();
    expect(ev).toEqual([
      ['theme', 'light'],
      ['retry', { max: 5, bytes: Uint8Array.of(1) }],
      ['theme', undefined],
    ]);
    s.close();
  });
});

describe('DevicesRepo', () => {
  const deviceInfo: DeviceInfo = { firmwareVerCode: 14, firmwareVersion: 'v1.18.0', manufacturer: 'Heltec' };

  it('records connections, lists most recent first, updates and forgets', async () => {
    const factory = freshFactory();
    const d = await DevicesRepo.open({ factory });
    expect(d.db.name).toBe(DEVICES_DB_NAME);
    const ev: string[] = [];
    d.events.on('device', (e) => ev.push(e.type));
    const a = await d.recordConnection({ pubKey: key32(1), name: 'A', transport: 'serial', deviceInfo }, 100);
    expect(a).toMatchObject({ pubKey: hexKey(1), name: 'A', firstConnected: 100, lastConnected: 100, transport: 'serial', deviceInfo });
    await d.recordConnection({ pubKey: key32(2), selfInfo: { name: 'B-self' } as SelfInfo, transport: 'ble', bleDeviceId: 'ble-1' }, 200);
    const again = await d.recordConnection({ pubKey: hexKey(1) }, 300);
    expect(again).toMatchObject({ name: 'A', firstConnected: 100, lastConnected: 300, transport: 'serial', deviceInfo });
    expect((await d.list()).map((r) => r.name)).toEqual(['A', 'B-self']);
    expect(await d.update(key32(2), { name: 'Bee' })).toMatchObject({ name: 'Bee', lastConnected: 200, bleDeviceId: 'ble-1' });
    expect((await d.get(key32(1)))?.bleDeviceId).toBeUndefined();
    expect(await d.update(key32(9), { name: 'x' })).toBeUndefined();

    const store = await RadioStore.open(key32(2), { factory });
    await store.settings.set('k', 1);
    store.close();
    await d.forget(key32(2), { deleteData: true });
    expect(await d.get(key32(2))).toBeUndefined();
    const reopened = await RadioStore.open(key32(2), { factory });
    expect(await reopened.settings.get('k')).toBeUndefined();
    reopened.close();
    expect(ev).toEqual(['put', 'put', 'put', 'put', 'delete']);
    d.close();
  });

  it('persists across reopen', async () => {
    const factory = freshFactory();
    const d1 = await DevicesRepo.open({ factory });
    await d1.recordConnection({ pubKey: key32(1), name: 'A', transport: 'emulator' });
    d1.close();
    const d2 = await DevicesRepo.open({ factory });
    expect((await d2.list()).map((r) => r.transport)).toEqual(['emulator']);
    d2.close();
    expect(radioDbName(key32(1))).not.toBe(DEVICES_DB_NAME);
  });
});
