/**
 * Switching radios: every store-bound model reloads from the newly connected radio's own store
 * (store-bound.ts follows `connection.store`), so nothing from the previous radio leaks across,
 * and reconnecting the first radio brings its history back.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { toHex } from '../util/bytes.js';
import { ContactType } from '../protocol/constants.js';
import { PayloadType } from '../packet/constants.js';
import { emptyScenario, scenarioIdentity, scenarioKey } from '../emulator/scenarios.js';
import { AppModel, createEmulatorTransportFactory } from './app-model.js';
import { memoryPreferences, type TransportFactory } from './connection.js';

const apps: AppModel[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
});

describe('switching between two radios', () => {
  it('shows only the connected radio’s contacts, conversations and packet log', async () => {
    const radioA = createEmulatorTransportFactory({ defaultAckDelayMs: 0 });
    const idB = scenarioIdentity('radio-b');
    const zed = scenarioKey('zed');
    const emuB = emptyScenario({
      identity: { publicKey: idB.publicKey, privateKey: idB.privateKey },
      name: 'Radio B',
      appTargetVer: 3,
      contacts: [{ pubKey: zed, name: 'Zed', type: ContactType.CHAT }],
    });
    emuB.injectContactMessage(zed, 'hello from B');
    let current: TransportFactory = radioA;
    const app = new AppModel({
      indexedDB: new IDBFactory(),
      keyRange: IDBKeyRange,
      createEmulatorTransport: (req) => current(req),
      preferences: memoryPreferences(),
    });
    apps.push(app);
    const { contacts, conversations, packetLog } = app;

    /** Connects with the current factory and waits for capture and every model to settle. */
    const connect = async () => {
      expect(await app.connection.connect('emulator')).toBe(true);
      await app.connection.capture!.idle();
      await Promise.all([contacts.settled(), conversations.settled(), packetLog.settled()]);
    };
    const contactNames = () => contacts.views.value.map((v) => v.name).sort();
    const convKeys = () => conversations.items.value.map((c) => c.key);

    // ---- radio A: scenario contacts + a live message + a logged packet
    await connect();
    const s = radioA.scenario();
    const pubA = toHex(s.keys.self);
    const alice = toHex(s.keys.alice);
    expect(app.connection.pubKey.value).toBe(pubA);
    s.emulator.injectContactMessage(s.keys.alice, 'only on A');
    s.nodes.bob.advertise({ flood: false });
    const storeA = app.connection.store.value!;
    await vi.waitFor(async () => {
      await app.connection.capture!.idle();
      expect((await storeA.messages.list(alice)).items.map((m) => m.text)).toContain('only on A');
      expect(await storeA.packets.count({ payloadType: PayloadType.ADVERT })).toBeGreaterThan(0);
    });
    await vi.waitFor(() => expect(contacts.views.value).toHaveLength(6));
    await vi.waitFor(() => expect(convKeys()).toContain(alice));
    await vi.waitFor(async () => expect(packetLog.packets.total.value).toBe(await storeA.packets.count()));
    const packetsA = packetLog.packets.total.value;
    expect(packetsA).toBeGreaterThan(0);
    await app.connection.disconnect();
    expect(contacts.views.value).toEqual([]);
    expect(conversations.items.value).toEqual([]);
    expect(packetLog.packets.total.value).toBe(0);

    // ---- radio B: a different identity with one contact and nothing on the air
    current = () => emuB.createLoopbackTransport();
    await connect();
    const pubB = toHex(idB.publicKey);
    expect(app.connection.pubKey.value).toBe(pubB);
    const storeB = app.connection.store.value!;
    await vi.waitFor(async () => {
      await app.connection.capture!.idle();
      expect((await storeB.messages.list(toHex(zed))).items.map((m) => m.text)).toEqual(['hello from B']);
    });
    await vi.waitFor(() => expect(contactNames()).toEqual(['Zed']));
    await vi.waitFor(() => expect(convKeys()).toContain(toHex(zed)));
    expect(conversations.items.value.filter((c) => c.convType === 'contact').map((c) => c.name)).toEqual(['Zed']);
    expect(convKeys()).not.toContain(alice);
    expect(conversations.items.value.filter((c) => c.convType === 'channel').map((c) => c.name)).toEqual(['Public']);
    await packetLog.settled();
    expect(packetLog.packets.total.value).toBe(0);
    expect(packetLog.packets.rows.value).toEqual([]);
    expect(packetLog.frames.total.value).toBe(await storeB.frames.count());
    expect(packetLog.context.value.nodes.map((n) => n.key).sort()).toEqual([pubB, toHex(zed)].sort());
    expect(await storeB.messages.list(alice)).toMatchObject({ items: [] });
    await app.connection.disconnect();

    // ---- back to radio A: its history is still there, B's is not
    current = radioA;
    await connect();
    expect(app.connection.pubKey.value).toBe(pubA);
    await vi.waitFor(() => expect(contacts.views.value).toHaveLength(6));
    expect(contactNames()).not.toContain('Zed');
    await vi.waitFor(() => expect(convKeys()).toContain(alice));
    expect(convKeys()).not.toContain(toHex(zed));
    const chat = app.chat('contact', alice);
    await chat.settled();
    expect(chat.messages.value.map((m) => m.text)).toEqual(['Hi! Are you on the mesh today?', 'only on A']);
    await packetLog.settled();
    expect(packetLog.packets.total.value).toBeGreaterThanOrEqual(packetsA);
    expect(packetLog.context.value.nodes.map((n) => n.key)).not.toContain(toHex(zed));
  });
});
