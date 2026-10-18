/** ContactsModel actions not covered by messaging-models.test.ts: favourites, notes, share, refreshOne, remove keeping history, bulk remove, stale and far-away selection. */

import { describe, expect, it, vi } from 'vitest';
import { bytesEqual, toHex } from '../util/bytes.js';
import { parsePacket } from '../packet/packet.js';
import { parseAdvertPayload } from '../packet/payloads.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import type { AirPacket } from '../emulator/virtual-mesh.js';
import { connectedApp } from './testing.js';
import {
  contactDistance,
  contactLastHeard,
  contactsFartherThan,
  contactsNotHeardSince,
  DISTANCE_PRESETS,
  STALE_PERIODS,
  type ContactView,
} from './contacts-model.js';
import { destinationPoint } from './geo.js';
import type { MessageRecord } from '../store/schema.js';
import { ContactType, PATH_LEN_UNKNOWN } from '../protocol/constants.js';
import { scenarioKey } from '../emulator/scenarios.js';

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

  it('setNote is local, trimmed, searchable and survives refresh() and a device sync', async () => {
    const { app, s, m, store, hex } = await connected();
    expect(m.view(hex.bob)!.note).toBe('');
    expect(m.noteFor(hex.bob)).toBe('');
    expect(m.noteFor(undefined)).toBe('');
    await m.setNote(hex.bob.toUpperCase(), '  Owes me a pint  \n');
    expect(m.view(hex.bob)!.note).toBe('Owes me a pint');
    expect(m.noteFor(hex.bob)).toBe('Owes me a pint');
    expect(m.noteFor(hex.bob.toUpperCase())).toBe('Owes me a pint');
    expect((await store.contacts.get(hex.bob))!.notes).toBe('Owes me a pint');

    await m.refresh(); // full GET_CONTACTS → syncFromDevice
    expect(m.view(hex.bob)!.note).toBe('Owes me a pint');
    const bobOnDevice = app.connection.client.value!.findContact(s.keys.bob);
    expect(bobOnDevice).toBeDefined();
    await store.contacts.syncFromDevice([bobOnDevice!], { full: false });
    expect((await store.contacts.get(hex.bob))!.notes).toBe('Owes me a pint');
    await m.reload();
    expect(m.noteFor(hex.bob)).toBe('Owes me a pint');

    // search matches the note text, case-insensitively
    m.setSearch('PINT');
    expect(m.visible.value.map((v) => v.name)).toEqual(['Bob']);

    await m.setNote(hex.bob, '   ');
    expect(m.view(hex.bob)!.note).toBe('');
    expect(m.noteFor(hex.bob)).toBe('');
    expect((await store.contacts.get(hex.bob))!.notes).toBe('');
    expect(m.visible.value).toEqual([]);
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

describe('far-away contact selection', () => {
  const ME = { lat: 47.6062, lon: -122.3321 };
  function view(key: string, at: { lat: number; lon: number } | null, favourite = false): ContactView {
    return { key, favourite, record: { lat: at?.lat ?? 0, lon: at?.lon ?? 0 } } as ContactView;
  }
  const north = (m: number) => destinationPoint(ME, 0, m);

  it('DISTANCE_PRESETS are ascending presets from 1 km to 1000 km', () => {
    expect(DISTANCE_PRESETS[0]).toEqual({ label: '1 km', meters: 1_000 });
    expect(DISTANCE_PRESETS.at(-1)).toEqual({ label: '1000 km', meters: 1_000_000 });
    for (let i = 1; i < DISTANCE_PRESETS.length; i++) expect(DISTANCE_PRESETS[i]!.meters).toBeGreaterThan(DISTANCE_PRESETS[i - 1]!.meters);
  });

  it('distance is to the advertised location; unknown when either side has none (0,0 = none)', () => {
    expect(contactDistance(view('a', north(12_000)), ME)).toBeCloseTo(12_000, 0);
    expect(contactDistance(view('a', null), ME)).toBeUndefined();
    expect(contactDistance(view('a', north(5)), null)).toBeUndefined();
    expect(contactDistance(view('a', north(5)), { lat: 0, lon: 0 })).toBeUndefined();
  });

  it('selects contacts strictly farther than the distance, skipping no-location and (by default) favourites', () => {
    const vs = [
      view('near', north(9_000)),
      view('far', north(11_000)),
      view('noLoc', null),
      view('veryFar', north(800_000)),
      view('favFar', north(50_000), true),
    ];
    expect(contactsFartherThan(vs, ME, 10_000).map((v) => v.key)).toEqual(['far', 'veryFar']);
    expect(contactsFartherThan(vs, ME, 10_000, { includeFavourites: true }).map((v) => v.key)).toEqual(['far', 'veryFar', 'favFar']);
    expect(contactsFartherThan(vs, ME, 100_000).map((v) => v.key)).toEqual(['veryFar']);
    // without our own position nothing is selected
    expect(contactsFartherThan(vs, null, 10_000)).toEqual([]);
    expect(contactsFartherThan(vs, { lat: 0, lon: 0 }, 10_000)).toEqual([]);
  });
});

describe('ContactsModel.addFromAdvert', () => {
  it('adds a heard node with ADD_UPDATE_CONTACT even in manual-add mode, keeping its advert fields', async () => {
    const { app, m, store } = await connected();
    const client = app.connection.client.value!;
    await client.setManualAddContacts(true);
    expect(client.selfInfo?.manualAddContacts ?? 0).toBe(1);

    const key = toHex(scenarioKey('dave'));
    expect(m.view(key)).toBeUndefined();
    const rec = await m.addFromAdvert({ key, name: ' Dave ', type: ContactType.ROOM, lat: 51.5, lon: -0.12, advertTimestamp: 1_700_000_123 });
    expect(rec).toMatchObject({ key, name: 'Dave', type: ContactType.ROOM, lastAdvert: 1_700_000_123, outPathLen: PATH_LEN_UNKNOWN, onDevice: true });
    expect(rec.lat).toBeCloseTo(51.5, 5);
    expect(rec.lon).toBeCloseTo(-0.12, 5);
    expect((await store.contacts.get(key))!.name).toBe('Dave');
    expect(m.view(key)).toMatchObject({ name: 'Dave', typeName: 'room' });
    expect(client.findContact(scenarioKey('dave'))).toBeDefined();
  });

  it('names a nameless advert by its key prefix', async () => {
    const { m } = await connected();
    const key = toHex(scenarioKey('erin'));
    const rec = await m.addFromAdvert({ key, name: '', type: ContactType.CHAT, advertTimestamp: 5 });
    expect(rec.name).toBe(key.slice(0, 12));
    expect(rec).toMatchObject({ lat: 0, lon: 0 });
  });
});
