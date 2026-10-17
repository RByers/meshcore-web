import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { ContactType } from '../protocol/constants.js';
import { RadioStore } from './radio-store.js';
import { CONTACTS_SINCE_SETTING } from './contacts.js';
import { freshFactory, hexKey, key32, makeContact, openStore } from './test-helpers.js';

describe('ContactsRepo', () => {
  it('upserts device contacts and preserves local fields', async () => {
    const s = await openStore();
    const r1 = await s.contacts.upsertFromDevice(makeContact(2), 1_800_000_000_000);
    expect(r1).toMatchObject({
      key: hexKey(2),
      name: 'node-2',
      unreadCount: 0,
      notes: '',
      favourite: false,
      muted: false,
      onDevice: true,
      updatedAt: 1_800_000_000_000,
      lastSeen: 1_700_000_000_000,
    });
    expect(r1.pubKey).toEqual(key32(2));
    await s.contacts.updateLocal(key32(2), { notes: 'roof', favourite: true, unreadCount: 3 });
    const r2 = await s.contacts.upsertFromDevice(makeContact(2, { name: 'renamed', lastMod: 1_600_000_000 }), 1_800_000_000_000);
    expect(r2).toMatchObject({ name: 'renamed', notes: 'roof', favourite: true, unreadCount: 3, lastSeen: 1_700_000_000_000 });
    expect(await s.contacts.updateLocal(hexKey(9), { notes: 'x' })).toBeUndefined();
    s.close();
  });

  it("takes lastSeen from lastmod (our radio's clock), not the sender's advert timestamp", async () => {
    const s = await openStore();
    const now = 1_792_000_000_000; // Oct 2026
    // a node whose clock was never set adverts from 15 May 2024 (firmware VolatileRTCClock default)
    const r1 = await s.contacts.upsertFromDevice(makeContact(1, { lastAdvert: 1_715_770_400, lastMod: 1_791_990_000 }), now);
    expect(r1.lastSeen).toBe(1_791_990_000_000);
    // a sender clock in the future is ignored too
    const r2 = await s.contacts.upsertFromDevice(makeContact(2, { lastAdvert: 1_900_000_000, lastMod: 1_791_990_000 }), now);
    expect(r2.lastSeen).toBe(1_791_990_000_000);
    // a future lastSeen stored by an older version (from the advert time) is dropped
    await s.contacts.upsertFromDevice(makeContact(3, { lastMod: 0 }), now);
    await s.contacts.updateLocal(key32(3), { lastSeen: 1_900_000_000_000 });
    const r3 = await s.contacts.upsertFromDevice(makeContact(3, { lastMod: 1_791_000_000 }), now);
    expect(r3.lastSeen).toBe(1_791_000_000_000);
    // a lastmod in the future (our radio's clock is wrong) doesn't count; small skew does
    const r4 = await s.contacts.upsertFromDevice(makeContact(4, { lastMod: 1_793_000_000 }), now);
    expect(r4.lastSeen).toBe(0);
    const r5 = await s.contacts.upsertFromDevice(makeContact(5, { lastMod: 1_792_000_060 }), now);
    expect(r5.lastSeen).toBe(1_792_000_060_000);
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

  it('saves the sync cursor with the contacts and returns a device snapshot across reopen', async () => {
    const factory = freshFactory();
    const s = await RadioStore.open(key32(1), { factory });
    expect(await s.contacts.deviceSnapshot()).toBeUndefined(); // never synced
    await s.contacts.syncFromDevice([makeContact(1), makeContact(2, { lastMod: 1_700_000_005 })], { full: true, since: 1_700_000_005 });
    await s.contacts.updateLocal(key32(1), { notes: 'roof', unreadCount: 2 });
    await s.contacts.markRemovedFromDevice(key32(2)); // CONTACT_DELETED push: no longer on the device
    await s.contacts.syncFromDevice([makeContact(3)]); // a push refresh: cursor untouched
    expect(await s.settings.get(CONTACTS_SINCE_SETTING)).toBe(1_700_000_005);
    s.close();

    const again = await RadioStore.open(key32(1), { factory });
    const snap = await again.contacts.deviceSnapshot();
    expect(snap?.since).toBe(1_700_000_005);
    // on-device contacts only, with device fields only (app-local ones stripped)
    expect(snap?.contacts.map((c) => c.name).sort()).toEqual(['node-1', 'node-3']);
    expect(snap?.contacts.find((c) => c.name === 'node-1')).toEqual(makeContact(1));

    await again.contacts.syncFromDevice([makeContact(1, { lastMod: 1_700_000_009 })], { since: 1_700_000_009 });
    expect((await again.contacts.deviceSnapshot())?.since).toBe(1_700_000_009);
    await again.contacts.syncFromDevice([], { full: true, since: 0 }); // device emptied: next sync is full
    expect(await again.contacts.deviceSnapshot()).toBeUndefined();
    again.close();
  });
});
