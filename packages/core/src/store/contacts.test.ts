import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { ContactType } from '../protocol/constants.js';
import { hexKey, key32, makeContact, openStore } from './test-helpers.js';

describe('ContactsRepo', () => {
  it('upserts device contacts and preserves local fields', async () => {
    const s = await openStore();
    const r1 = await s.contacts.upsertFromDevice(makeContact(2), 111);
    expect(r1).toMatchObject({
      key: hexKey(2),
      name: 'node-2',
      unreadCount: 0,
      notes: '',
      favourite: false,
      muted: false,
      onDevice: true,
      updatedAt: 111,
      lastSeen: 1_700_000_000_000,
    });
    expect(r1.pubKey).toEqual(key32(2));
    await s.contacts.updateLocal(key32(2), { notes: 'roof', favourite: true, unreadCount: 3 });
    const r2 = await s.contacts.upsertFromDevice(makeContact(2, { name: 'renamed', lastAdvert: 1_600_000_000 }));
    expect(r2).toMatchObject({ name: 'renamed', notes: 'roof', favourite: true, unreadCount: 3, lastSeen: 1_700_000_000_000 });
    expect(await s.contacts.updateLocal(hexKey(9), { notes: 'x' })).toBeUndefined();
    s.close();
  });

  it('lists sorted by name, finds by prefix, touches, deletes', async () => {
    const s = await openStore();
    await s.contacts.upsertFromDevice(makeContact(3, { name: 'charlie' }));
    await s.contacts.upsertFromDevice(makeContact(1, { name: 'Alice' }));
    await s.contacts.upsertFromDevice(makeContact(2, { name: 'bob' }));
    expect((await s.contacts.list()).map((c) => c.name)).toEqual(['Alice', 'bob', 'charlie']);
    const found = await s.contacts.findByPrefix(key32(2).subarray(0, 6));
    expect(found.map((c) => c.name)).toEqual(['bob']);
    expect(await s.contacts.findByPrefix('ff')).toEqual([]);
    expect((await s.contacts.touch(key32(1), 2_000_000_000_000))!.lastSeen).toBe(2_000_000_000_000);
    expect((await s.contacts.touch(key32(1), 5))!.lastSeen).toBe(2_000_000_000_000);
    await s.contacts.delete(key32(3));
    expect(await s.contacts.count()).toBe(2);
    expect(await s.contacts.get(key32(3))).toBeUndefined();
    s.close();
  });

  it('full sync marks missing contacts as not on device; removal push keeps history', async () => {
    const s = await openStore();
    await s.contacts.syncFromDevice([makeContact(1), makeContact(2)], { full: true });
    await s.contacts.syncFromDevice([makeContact(2)], { full: true });
    expect((await s.contacts.get(key32(1)))!.onDevice).toBe(false);
    expect((await s.contacts.get(key32(2)))!.onDevice).toBe(true);
    await s.contacts.markRemovedFromDevice(key32(2));
    expect((await s.contacts.get(key32(2)))!.onDevice).toBe(false);
    s.close();
  });

  it('emits contact and unread events', async () => {
    const s = await openStore();
    const ev: string[] = [];
    s.events.on('contact', (e) => ev.push(e.type === 'put' ? `put:${e.record.name}` : `delete:${e.key.slice(0, 2)}`));
    s.events.on('unread', (e) => ev.push(`unread:${e.count}`));
    await s.contacts.upsertFromDevice(makeContact(4, { type: ContactType.CHAT }));
    await s.contacts.updateLocal(key32(4), { unreadCount: 2 });
    await s.contacts.delete(key32(4));
    expect(ev).toEqual(['put:node-4', 'put:node-4', 'unread:2', 'delete:04']);
    s.close();
  });

  it('keeps the optional local SMAZ setting across device syncs (absent = off, no migration)', async () => {
    const s = await openStore();
    const c = makeContact(0x42);
    const first = await s.contacts.upsertFromDevice(c);
    expect(first.smaz).toBeUndefined();
    await s.contacts.updateLocal(c.pubKey, { smaz: true });
    await s.contacts.upsertFromDevice({ ...c, name: 'Renamed' });
    await s.contacts.syncFromDevice([c], { full: true });
    expect(await s.contacts.get(c.pubKey)).toMatchObject({ smaz: true, name: c.name });
    await s.contacts.updateLocal(c.pubKey, { smaz: false });
    expect((await s.contacts.get(c.pubKey))?.smaz).toBe(false);
    s.close();
  });
});
