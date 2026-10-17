/** ContactsModel actions not covered by messaging-models.test.ts: favourites, share, refreshOne, remove keeping history, bulk remove and stale selection. */

import { describe, expect, it, vi } from 'vitest';
import { bytesEqual, toHex } from '../util/bytes.js';
import { parsePacket } from '../packet/packet.js';
import { parseAdvertPayload } from '../packet/payloads.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import type { AirPacket } from '../emulator/virtual-mesh.js';
import { connectedApp } from './testing.js';
import { contactLastHeard, contactsNotHeardSince, STALE_PERIODS, type ContactView } from './contacts-model.js';
import type { MessageRecord } from '../store/schema.js';

async function connected() {
  const { app, scenario: s } = await connectedApp({ scenario: { defaultAckDelayMs: 0 } });
  const m = app.contacts;
  await vi.waitFor(() => expect(m.views.value).toHaveLength(6));
  await m.settled();
  return { app, s, m, store: app.connection.store.value!, hex: { alice: toHex(s.keys.alice), bob: toHex(s.keys.bob), carol: toHex(s.keys.carol) } };
}

describe('ContactsModel actions', () => {
  it('setFavourite is local and survives refresh() and a device sync', async () => {
    const { app, s, m, store, hex } = await connected();
    expect(m.view(hex.bob)!.favourite).toBe(false);
    await m.setFavourite(hex.bob, true);
    await m.settled();
    expect(m.view(hex.bob)!.favourite).toBe(true);
    expect((await store.contacts.get(hex.bob))!.favourite).toBe(true);

    await m.refresh(); // full GET_CONTACTS → syncFromDevice
    expect(m.view(hex.bob)!.favourite).toBe(true);
    // a direct sync with the device's (non-favourite) record keeps the local flag too
    const client = app.connection.client.value!;
    const bobOnDevice = client.findContact(s.keys.bob);
    expect(bobOnDevice).toBeDefined();
    await store.contacts.syncFromDevice([bobOnDevice!], { full: false });
    expect((await store.contacts.get(hex.bob))!.favourite).toBe(true);

    await m.setFavourite(hex.bob, false);
    await m.refresh();
    expect(m.view(hex.bob)!.favourite).toBe(false);
    m.setFilter('favourites');
    expect(m.visible.value.map((v) => v.name)).toEqual(['Alice']); // Alice: FAVOURITE flag on the device
  });

  it("share() re-broadcasts the contact's advert zero-hop on the mesh", async () => {
    const { s, m, hex } = await connected();
    const heardByBob = new Promise<AirPacket>((resolve) => {
      s.mesh.events.on('deliver', (e) => {
        if (e.from === 'self' && e.to === 'bob') resolve(e);
      });
    });
    const sent = s.mesh.log.length;
    await m.share(hex.alice);
    expect(s.emulator.airLog.at(-1)).toMatchObject({ type: 'shareContact' });
    const tx = s.mesh.log.slice(sent).filter((a) => a.from === 'self');
    expect(tx).toHaveLength(1);
    const p = parsePacket(tx[0]!.packet);
    // RPT isShare: TRANSPORT_DIRECT with transport codes {0, 0}, no path, ADVERT payload
    expect(p.routeType).toBe(RouteType.TRANSPORT_DIRECT);
    expect(p.payloadType).toBe(PayloadType.ADVERT);
    expect(p.path.length).toBe(0);
    const advert = parseAdvertPayload(p.payload);
    expect(bytesEqual(advert.publicKey, s.keys.alice)).toBe(true);
    expect(advert.app.name).toBe('Alice');
    expect(bytesEqual((await heardByBob).packet, tx[0]!.packet)).toBe(true);
  });

  it('refreshOne() re-reads one contact from the device', async () => {
    const { s, m, hex } = await connected();
    expect(m.view(hex.bob)!.name).toBe('Bob');
    // changed on the device behind the app's back (no push)
    s.emulator.addContact({ pubKey: s.keys.bob, name: 'Robert', lastMod: s.startSecs + 10 });
    expect(m.view(hex.bob)!.name).toBe('Bob');
    const c = await m.refreshOne(hex.bob);
    expect(c?.name).toBe('Robert');
    expect(m.view(hex.bob)!.name).toBe('Robert');
    expect(m.view(hex.carol)!.name).toBe('Carol');
  });

  it('remove(key, { keepMessages: true }) deletes the contact but keeps its history', async () => {
    const { s, m, store, hex } = await connected();
    expect((await store.messages.list(hex.alice)).items.map((x) => x.text)).toEqual(['Hi! Are you on the mesh today?']);
    await m.remove(hex.alice, { keepMessages: true });
    expect(m.find(hex.alice)).toBeUndefined();
    expect(s.emulator.getContact(s.keys.alice)).toBeUndefined();
    expect(await store.contacts.get(hex.alice)).toBeUndefined();
    expect((await store.messages.list(hex.alice)).items.map((x) => x.text)).toEqual(['Hi! Are you on the mesh today?']);
  });

  it('removeMany() removes several contacts from device, store and messages with progress', async () => {
    const { s, m, store, hex } = await connected();
    const progress: [number, number][] = [];
    const r = await m.removeMany([hex.alice, hex.bob], { onProgress: (d, t) => progress.push([d, t]) });
    expect(r).toEqual({ removed: [hex.alice, hex.bob], failed: [] });
    expect(progress).toEqual([[0, 2], [1, 2], [2, 2]]);
    expect(s.emulator.getContact(s.keys.alice)).toBeUndefined();
    expect(s.emulator.getContact(s.keys.bob)).toBeUndefined();
    expect(await store.contacts.get(hex.alice)).toBeUndefined();
    expect(await store.contacts.get(hex.bob)).toBeUndefined();
    expect((await store.messages.list(hex.alice)).items).toEqual([]);
    expect(m.find(hex.alice)).toBeUndefined();
    expect(m.find(hex.bob)).toBeUndefined();
    expect(m.view(hex.carol)!.name).toBe('Carol');
  });

  it('removeMany() continues past a failure, reports it and reloads explicitly once', async () => {
    const { app, s, m, store, hex } = await connected();
    const client = app.connection.client.value!;
    const real = client.removeContact.bind(client);
    const boom = new Error('radio said no');
    vi.spyOn(client, 'removeContact').mockImplementation((pk) => (toHex(pk instanceof Uint8Array ? pk : pk.pubKey) === hex.bob ? Promise.reject(boom) : real(pk)));
    // store events reload too (coalesced); count them so only removeMany's own reload remains
    let storeReloads = 0;
    const offs = [
      store.events.on('contact', () => storeReloads++),
      store.events.on('message', (e) => void (e.type === 'delete' && storeReloads++)),
    ];
    const reload = vi.spyOn(m, 'reload');
    const progress: number[] = [];
    const r = await m.removeMany([hex.alice, hex.bob, hex.carol], { keepMessages: true, onProgress: (d) => progress.push(d) });
    offs.forEach((off) => off());
    expect(r.removed).toEqual([hex.alice, hex.carol]);
    expect(r.failed).toEqual([{ key: hex.bob, error: boom }]);
    expect(progress).toEqual([0, 1, 2, 3]);
    expect(reload.mock.calls.length - storeReloads).toBe(1);
    expect(s.emulator.getContact(s.keys.bob)).toBeDefined();
    expect(m.find(hex.bob)).toBeDefined();
    expect(m.find(hex.alice)).toBeUndefined();
    expect(m.find(hex.carol)).toBeUndefined();
    // keepMessages applies to every key
    expect((await store.messages.list(hex.alice)).items).toHaveLength(1);
  });
});

describe('stale contact selection', () => {
  const NOW = 1_800_000_000_000;
  const DAY = 86_400_000;
  function view(key: string, o: Partial<Pick<ContactView, 'lastSeen' | 'directSnrAt' | 'lastMessage' | 'favourite'>> = {}): ContactView {
    return { key, lastSeen: 0, directSnrAt: 0, lastMessage: undefined, favourite: false, ...o } as ContactView;
  }
  const msg = (direction: 'in' | 'out', receivedAt: number) => ({ direction, receivedAt }) as MessageRecord;

  it('STALE_PERIODS are ascending presets from 1 day to 1 year', () => {
    expect(STALE_PERIODS.map((p) => p.label)).toEqual(['1 day', '1 week', '2 weeks', '1 month', '3 months', '6 months', '1 year']);
    expect(STALE_PERIODS[0]!.ms).toBe(DAY);
    expect(STALE_PERIODS.at(-1)!.ms).toBe(365 * DAY);
    for (let i = 1; i < STALE_PERIODS.length; i++) expect(STALE_PERIODS[i]!.ms).toBeGreaterThan(STALE_PERIODS[i - 1]!.ms);
  });

  it('last heard is the latest advert, zero-hop packet or incoming message; outgoing does not count', () => {
    expect(contactLastHeard(view('a'))).toBe(0);
    expect(contactLastHeard(view('a', { lastSeen: 5, directSnrAt: 7 }))).toBe(7);
    expect(contactLastHeard(view('a', { lastSeen: 5, lastMessage: msg('in', 9) }))).toBe(9);
    expect(contactLastHeard(view('a', { lastSeen: 5, lastMessage: msg('out', 9) }))).toBe(5);
  });

  it('selects contacts heard strictly before the cutoff, never-heard included, favourites excluded by default', () => {
    const cutoff = NOW - 7 * DAY;
    const vs = [
      view('never'),
      view('justBefore', { lastSeen: cutoff - 1 }),
      view('atCutoff', { lastSeen: cutoff }),
      view('recentMsg', { lastSeen: cutoff - DAY, lastMessage: msg('in', NOW - DAY) }),
      view('recentDirect', { directSnrAt: NOW }),
      view('onlySentTo', { lastSeen: cutoff - DAY, lastMessage: msg('out', NOW) }),
      view('favNever', { favourite: true }),
    ];
    expect(contactsNotHeardSince(vs, cutoff).map((v) => v.key)).toEqual(['never', 'justBefore', 'onlySentTo']);
    expect(contactsNotHeardSince(vs, cutoff, { includeFavourites: true }).map((v) => v.key)).toEqual([
      'never',
      'justBefore',
      'onlySentTo',
      'favNever',
    ]);
  });
});
