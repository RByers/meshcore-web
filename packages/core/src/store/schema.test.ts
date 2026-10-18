import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { openDatabase, promisifyRequest } from './idb.js';
import { DEFAULT_CONTACT_LOCAL, INDEX, RADIO_DB_MIGRATIONS, RADIO_DB_VERSION, STORE, pubKeyHex, radioDbName, type ContactRecord, type MessageRecord } from './schema.js';
import { RadioStore } from './radio-store.js';
import { freshFactory, grpTxtPacket, hexKey, key32, makeContact } from './test-helpers.js';

function indexNames(db: IDBDatabase, store: string): string[] {
  return Array.from(db.transaction(store).objectStore(store).indexNames).sort();
}

/** Writes a database the way schema v1 shipped it, with v1-shaped records. */
async function writeV1(factory: IDBFactory, name: string): Promise<void> {
  const req = factory.open(name, 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    const frames = db.createObjectStore('frames', { keyPath: 'id', autoIncrement: true });
    frames.createIndex('ts', 'ts');
    frames.createIndex('code', 'code');
    const packets = db.createObjectStore('packets', { keyPath: 'id', autoIncrement: true });
    packets.createIndex('ts', 'ts');
    packets.createIndex('payloadType', 'payloadType');
    packets.createIndex('hash', 'hash');
    db.createObjectStore('contacts', { keyPath: 'key' });
    const messages = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
    messages.createIndex('conv_ts', ['convKey', 'timestamp']);
    messages.createIndex('status', 'status');
    messages.createIndex('ackCode', 'ackCode');
    const channels = db.createObjectStore('channels', { keyPath: 'key' });
    channels.createIndex('deviceIndex', 'deviceIndex');
    db.createObjectStore('settings', { keyPath: 'key' });
  };
  const db = await promisifyRequest(req);
  const tx = db.transaction(['contacts', 'messages', 'frames'], 'readwrite');
  // v1 contacts had no local fields.
  const c = makeContact(7);
  tx.objectStore('contacts').put({ ...c, key: hexKey(7) });
  const msg: Omit<MessageRecord, 'id'> = {
    convKey: hexKey(7),
    convType: 'contact',
    direction: 'in',
    text: 'old',
    timestamp: 1000,
    receivedAt: 5000,
    txtType: 0,
    status: 'delivered',
    pathLen: 0,
  };
  tx.objectStore('messages').add(msg);
  tx.objectStore('frames').add({ ts: 1, direction: 'in', bytes: Uint8Array.of(0), code: 0, kind: 'ok', size: 1 });
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}

describe('schema', () => {
  it('names one database per radio', () => {
    expect(radioDbName(key32(0xab))).toBe(`meshcore-web:${'ab'.repeat(32)}`);
    expect(radioDbName('ABCD')).toBe('meshcore-web:abcd');
    expect(() => pubKeyHex('xyz')).toThrow();
    expect(() => pubKeyHex('')).toThrow();
  });

  it('a fresh open creates every store and index at the current version', async () => {
    const store = await RadioStore.open(key32(1), { factory: freshFactory() });
    expect(store.db.version).toBe(RADIO_DB_VERSION);
    expect(RADIO_DB_VERSION).toBe(4);
    expect(store.db.storeNames.sort()).toEqual(Object.values(STORE).sort());
    const raw = store.db.raw;
    expect(indexNames(raw, STORE.frames)).toEqual(Object.values(INDEX.frames).sort());
    expect(indexNames(raw, STORE.packets)).toEqual(Object.values(INDEX.packets).sort());
    expect(indexNames(raw, STORE.messages)).toEqual(Object.values(INDEX.messages).sort());
    expect(indexNames(raw, STORE.channels)).toEqual(Object.values(INDEX.channels).sort());
    store.close();
  });

  it('migrates a v1 database to v2 preserving data, adding indexes and back-filling contacts', async () => {
    const factory = freshFactory();
    await writeV1(factory, radioDbName(key32(1)));
    const store = await RadioStore.open(key32(1), { factory });
    expect(store.db.version).toBe(4);
    expect(indexNames(store.db.raw, STORE.messages)).toContain('conv_received');
    expect(indexNames(store.db.raw, STORE.packets)).toContain('payloadType_ts');

    const c = (await store.contacts.get(hexKey(7))) as ContactRecord;
    expect(c.name).toBe('node-7');
    expect(c.unreadCount).toBe(DEFAULT_CONTACT_LOCAL.unreadCount);
    expect(c.notes).toBe('');
    expect(c.favourite).toBe(false);
    expect(c.onDevice).toBe(true);

    // The new arrival-order index covers the old message.
    const page = await store.messages.list(hexKey(7));
    expect(page.items.map((m) => m.text)).toEqual(['old']);
    // The new compound frame index covers the old frame.
    expect((await store.frames.query({ direction: 'in' })).items).toHaveLength(1);
    store.close();
  });

  it('migrates a v3 database to v4 preserving data and adding the noiseFloor store', async () => {
    const factory = freshFactory();
    const name = radioDbName(key32(3));
    const v3 = await openDatabase({ name, version: 3, migrations: RADIO_DB_MIGRATIONS.slice(0, 3), factory });
    await v3.put(STORE.contacts, { ...DEFAULT_CONTACT_LOCAL, ...makeContact(9), key: hexKey(9), onDevice: true, updatedAt: 0 });
    await v3.add(STORE.packets, { ts: 10, direction: 'rx', bytes: grpTxtPacket(), format: 'packet', source: 'logRxData', routeType: 1, payloadType: 5, pathLen: 0, hash: 'aa' });
    expect(v3.storeNames).not.toContain(STORE.noiseFloor);
    v3.close();

    const store = await RadioStore.open(key32(3), { factory });
    expect(store.db.version).toBe(4);
    expect(store.db.storeNames).toContain(STORE.noiseFloor);
    expect((await store.contacts.get(hexKey(9)))?.name).toBe('node-9');
    expect((await store.packets.all()).map((p) => p.ts)).toEqual([10]);
    expect(await store.noiseFloor.count()).toBe(0);
    await store.noiseFloor.add({ t: 20, noiseFloorDbm: -110 });
    expect(await store.noiseFloor.range()).toEqual([{ t: 20, noiseFloorDbm: -110 }]);
    store.close();
  });
});
