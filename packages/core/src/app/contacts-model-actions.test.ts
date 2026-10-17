/** ContactsModel actions not covered by messaging-models.test.ts: favourites, share, refreshOne, remove keeping history. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { bytesEqual, toHex } from '../util/bytes.js';
import { parsePacket } from '../packet/packet.js';
import { parseAdvertPayload } from '../packet/payloads.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import type { AirPacket } from '../emulator/virtual-mesh.js';
import { AppModel, createEmulatorTransportFactory } from './app-model.js';
import { memoryPreferences } from './connection.js';

const apps: AppModel[] = [];

async function connected() {
  const emulator = createEmulatorTransportFactory({ defaultAckDelayMs: 0 });
  const app = new AppModel({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, createEmulatorTransport: emulator, preferences: memoryPreferences() });
  apps.push(app);
  expect(await app.connection.connect('emulator')).toBe(true);
  await app.connection.capture!.idle();
  const s = emulator.scenario();
  const m = app.contacts;
  await vi.waitFor(() => expect(m.views.value).toHaveLength(6));
  await m.settled();
  return { app, s, m, store: app.connection.store.value!, hex: { alice: toHex(s.keys.alice), bob: toHex(s.keys.bob), carol: toHex(s.keys.carol) } };
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
});

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
});
