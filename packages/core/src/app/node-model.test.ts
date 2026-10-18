/** NodeModel (the /node/:key page): reference resolution, tabs, add / remove contact. */

import { describe, expect, it } from 'vitest';
import { PayloadType, RouteType } from '../packet/constants.js';
import { buildPacket } from '../packet/packet.js';
import { encodeAdvertAppData } from '../packet/payloads.js';
import { ContactType } from '../protocol/constants.js';
import { concatBytes, fromHex, toHex } from '../util/bytes.js';
import { scenarioKey } from '../emulator/scenarios.js';
import { connectedApp, type ConnectedApp } from './testing.js';
import { entryTab, nodeCandidates, nodeTabFor, nodeTabs, normalizeNodeRef, resolveContactRef, NODE_TAB_ORDER, type NodeIdentity } from './node-model.js';
import { effect, when } from './signal.js';
import { NODE_CACHE_SIZE } from './app-model.js';

interface AdvertInit {
  name: string;
  type?: number;
  lat?: number;
  lon?: number;
  ts?: number;
  hops?: number;
}

/** A logged ADVERT (§3.5: pubkey ‖ timestamp ‖ signature ‖ app data; signature not checked). */
async function hearAdvert(t: ConnectedApp, key: string, a: AdvertInit, snr = 6) {
  const stamp = new Uint8Array(4);
  new DataView(stamp.buffer).setUint32(0, a.ts ?? 1_700_000_000, true);
  const app = encodeAdvertAppData({
    nodeType: a.type ?? ContactType.CHAT,
    name: a.name,
    ...(a.lat !== undefined && a.lon !== undefined ? { latitude: a.lat, longitude: a.lon } : {}),
  });
  const payload = concatBytes(fromHex(key), stamp, new Uint8Array(64), app);
  const bytes = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, path: new Uint8Array(a.hops ?? 0).fill(0x42), payload });
  return t.store.packets.append({ direction: 'rx', source: 'logRxData', bytes, ts: t.clock.now(), snr });
}

/** The identity kinds seen, consecutive repeats collapsed (null kept as null). */
function kindRuns(seen: ReadonlyArray<NodeIdentity | null>): Array<string | null> {
  return seen.map((v) => v?.kind ?? null).filter((k, i, a) => i === 0 || k !== a[i - 1]);
}

async function resolved(t: ConnectedApp, ref: string): Promise<NodeIdentity> {
  const node = t.app.node(ref);
  await node.settled();
  const id = await when(node.identity, (v) => v !== null);
  return id!;
}

describe('node reference helpers', () => {
  it('normalizeNodeRef accepts 1..32 bytes of hex, case-insensitively', () => {
    expect(normalizeNodeRef(' A7 ')).toBe('a7');
    expect(normalizeNodeRef('ab'.repeat(32))).toBe('ab'.repeat(32));
    for (const bad of ['', 'a', 'abc', 'zz', 'ab'.repeat(33), 'a7:'] as const) expect(normalizeNodeRef(bad)).toBeNull();
  });

  it('tabs per identity kind, nodeTabFor falls back to info, entryTab', () => {
    const view = (typeName: 'chat' | 'room' | 'repeater' | 'sensor') => ({ kind: 'contact', key: 'aa', contact: { typeName } }) as unknown as NodeIdentity;
    expect(nodeTabs(view('chat'))).toEqual(['info', 'messages', 'path', 'stats']);
    expect(nodeTabs(view('room'))).toEqual(['info', 'messages', 'path', 'overview', 'telemetry', 'cli', 'tools', 'stats']);
    expect(nodeTabs(view('repeater'))).toEqual(['info', 'messages', 'path', 'overview', 'telemetry', 'cli', 'tools', 'stats']);
    expect(nodeTabs(view('sensor'))).toEqual(['info', 'messages', 'path', 'overview', 'telemetry', 'cli', 'tools', 'stats']);
    const heard = { kind: 'heard', key: 'aa', heard: {} } as unknown as NodeIdentity;
    expect(nodeTabs(heard)).toEqual(['info', 'stats']);
    expect(nodeTabs({ kind: 'unknown', ref: 'aa', valid: true })).toEqual(['info']);
    expect(nodeTabs({ kind: 'ambiguous', ref: 'aa', contacts: [], heard: [] })).toEqual(['info']);
    expect(nodeTabs(null)).toEqual(['info']);
    for (const kind of ['chat', 'room', 'repeater', 'sensor'] as const) {
      expect(nodeTabs(view(kind)).every((t, i, a) => i === 0 || NODE_TAB_ORDER.indexOf(a[i - 1]!) < NODE_TAB_ORDER.indexOf(t))).toBe(true);
    }

    expect(nodeTabFor(view('repeater'), 'cli')).toBe('cli');
    expect(nodeTabFor(view('repeater'), 'messages')).toBe('messages'); // its DM conversation (CLI replies)
    expect(nodeTabFor(view('chat'), 'cli')).toBe('info'); // hidden for chat nodes
    expect(nodeTabFor(view('chat'), 'bogus')).toBe('info');
    expect(nodeTabFor(view('chat'))).toBe('info');
    expect(nodeTabFor(view('chat'), 'path')).toBe('path');
    expect(nodeTabFor(heard, 'path')).toBe('info'); // only contacts have a stored path
    expect(nodeTabFor(heard, 'stats')).toBe('stats');
    expect(nodeTabFor(null, 'stats')).toBe('info');

    expect(entryTab('chat')).toBe('messages');
    expect(entryTab('room')).toBe('messages');
    expect(entryTab('repeater')).toBe('info');
    expect(entryTab('sensor')).toBe('info');
  });
});

describe('NodeModel', () => {
  it('resolves a contact by full key or prefix, with tabs for its kind', async () => {
    const t = await connectedApp();
    const views = t.app.contacts.views.value;
    expect(resolveContactRef(t.keys.alice.toUpperCase(), views).map((v) => v.name)).toEqual(['Alice']);

    const full = await resolved(t, t.keys.alice);
    expect(full).toMatchObject({ kind: 'contact', key: t.keys.alice });
    expect(full.kind === 'contact' && full.contact.name).toBe('Alice');
    expect(t.app.node(t.keys.alice).tabs.value).toEqual(['info', 'messages', 'path', 'stats']);
    expect(t.app.node(t.keys.alice).canAddContact.value).toBe(false);

    const prefix = await resolved(t, t.keys.alice.slice(0, 8).toUpperCase());
    expect(prefix).toMatchObject({ kind: 'contact', key: t.keys.alice });
    expect(t.app.node(t.keys.alice.slice(0, 8))).toBe(t.app.node(` ${t.keys.alice.slice(0, 8).toUpperCase()} `)); // cached per normalised ref

    expect(await resolved(t, t.keys.repeater)).toMatchObject({ kind: 'contact', key: t.keys.repeater });
    expect(t.app.node(t.keys.repeater).tabs.value).toEqual(['info', 'messages', 'path', 'overview', 'telemetry', 'cli', 'tools', 'stats']);
    expect(await resolved(t, t.keys.room)).toMatchObject({ kind: 'contact' });
    expect(t.app.node(t.keys.room).tabs.value).toEqual(['info', 'messages', 'path', 'overview', 'telemetry', 'cli', 'tools', 'stats']);
  });

  it('keeps the most recently requested models and disposes evicted ones', async () => {
    const t = await connectedApp();
    const refs = Array.from({ length: NODE_CACHE_SIZE + 1 }, (_, i) => (i + 0x10).toString(16).padStart(2, '0'));
    const first = t.app.node(refs[0]!);
    const second = t.app.node(refs[1]!);
    let runs = 0;
    const off = effect(() => {
      void second.disposed.value;
      runs++;
    });
    for (const r of refs.slice(2, NODE_CACHE_SIZE)) t.app.node(r);
    expect(t.app.node(refs[0]!)).toBe(first); // re-requested: now the most recent
    const before = runs;
    t.app.node(refs[NODE_CACHE_SIZE]!); // one over: evicts the least recently requested (refs[1])
    expect(second.disposed.value).toBe(true);
    expect(runs).toBeGreaterThan(before); // a view of the evicted model re-renders…
    const fresh = t.app.node(refs[1]!); // …and re-requests a new one
    expect(fresh).not.toBe(second);
    expect(fresh.disposed.value).toBe(false);
    expect(first.disposed.value).toBe(false);
    off();
    await fresh.settled();
    expect(fresh.identity.value?.kind).toBeDefined();
  });

  it('is unknown for an unheard hash and invalid for non-hex', async () => {
    const t = await connectedApp();
    const used = new Set(t.app.contacts.views.value.map((v) => v.key.slice(0, 2)));
    const free = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')).find((h) => !used.has(h))!;
    expect(await resolved(t, free)).toEqual({ kind: 'unknown', ref: free, valid: true });
    expect(t.app.node(free).tabs.value).toEqual(['info']);
    expect(t.app.node('xyz').identity.value).toEqual({ kind: 'unknown', ref: 'xyz', valid: false });
  });

  it('resolves a node heard advertising, follows new adverts, and adds it as a contact', async () => {
    const t = await connectedApp();
    const dave = toHex(scenarioKey('dave'));
    const node = t.app.node(dave);
    expect(await resolved(t, dave)).toEqual({ kind: 'unknown', ref: dave, valid: true });

    // the packet log grows → the lookup re-runs
    const logged = await hearAdvert(t, dave, { name: 'Dave', type: ContactType.REPEATER, lat: 47.6, lon: -122.3, ts: 1_700_000_500, hops: 2 }, 7.5);
    const id = await when(node.identity, (v) => v?.kind === 'heard');
    if (id?.kind !== 'heard') throw new Error('not heard');
    expect(id.key).toBe(dave);
    expect(id.heard).toMatchObject({ key: dave, name: 'Dave', type: ContactType.REPEATER, typeName: 'repeater', advertTimestamp: 1_700_000_500, hops: 2, snr: 7.5, heardAt: logged.ts, packetId: logged.id });
    expect(id.heard.lat).toBeCloseTo(47.6, 5);
    expect(id.heard.lon).toBeCloseTo(-122.3, 5);
    expect(node.tabs.value).toEqual(['info', 'stats']);
    expect(node.canAddContact.value).toBe(true);
    // a hash prefix resolves to it too
    expect(await resolved(t, dave.slice(0, 2))).toMatchObject({ kind: 'heard', key: dave });

    const rec = await node.addContact();
    expect(rec).toMatchObject({ key: dave, name: 'Dave', type: ContactType.REPEATER, lastAdvert: 1_700_000_500 });
    const now = node.identity.value;
    expect(now).toMatchObject({ kind: 'contact', key: dave });
    expect(node.tabs.value).toEqual(['info', 'messages', 'path', 'overview', 'telemetry', 'cli', 'tools', 'stats']);
    expect(node.canAddContact.value).toBe(false);
  });

  it('removeContact turns a contact into a heard node (or unknown)', async () => {
    const t = await connectedApp();
    const node = t.app.node(t.keys.alice);
    expect(await resolved(t, t.keys.alice)).toMatchObject({ kind: 'contact' });
    await hearAdvert(t, t.keys.alice, { name: 'Alice' });

    // contact → heard directly: never null ("Loading…") while the heard lookup runs
    const seen: Array<NodeIdentity | null> = [];
    const off = node.identity.subscribe((v) => seen.push(v));
    await node.removeContact();
    off();
    expect(seen).not.toContain(null);
    expect(kindRuns(seen)).toEqual(['contact', 'heard']);
    expect(t.app.contacts.view(t.keys.alice)).toBeUndefined();
    expect(node.identity.value).toMatchObject({ kind: 'heard', key: t.keys.alice, heard: { name: 'Alice' } });
    expect(node.canAddContact.value).toBe(true);

    const bob = t.app.node(t.keys.bob);
    expect(await resolved(t, t.keys.bob)).toMatchObject({ kind: 'contact' });
    const bobSeen: Array<NodeIdentity | null> = [];
    const offBob = bob.identity.subscribe((v) => bobSeen.push(v));
    await bob.removeContact();
    offBob();
    expect(bobSeen).not.toContain(null);
    expect(kindRuns(bobSeen)).toEqual(['contact', 'unknown']);
    expect(bob.identity.value).toEqual({ kind: 'unknown', ref: t.keys.bob, valid: true });
    await expect(bob.removeContact()).rejects.toThrow('Not a contact');
    await expect(bob.addContact()).rejects.toThrow('Not a heard node');
  });

  it('is ambiguous when several heard nodes or contacts share a prefix', async () => {
    const t = await connectedApp();
    const used = new Set(t.app.contacts.views.value.map((v) => v.key.slice(0, 2)));
    const free = Array.from({ length: 254 }, (_, i) => (i + 1).toString(16).padStart(2, '0')).filter((h) => !used.has(h));
    const [h1, h2] = free as [string, string];

    const x = `${h1}${'01'.repeat(31)}`;
    const y = `${h1}${'02'.repeat(31)}`;
    await hearAdvert(t, x, { name: 'X' });
    await hearAdvert(t, y, { name: 'Y' });
    const amb = await resolved(t, h1);
    if (amb.kind !== 'ambiguous') throw new Error(amb.kind);
    expect(amb.contacts).toEqual([]);
    expect(amb.heard.map((n) => n.name)).toEqual(['Y', 'X']); // newest first
    expect(t.app.node(h1).tabs.value).toEqual(['info']);
    expect(await resolved(t, x)).toMatchObject({ kind: 'heard', key: x });

    const p = `${h2}${'01'.repeat(31)}`;
    const q = `${h2}${'02'.repeat(31)}`;
    await t.app.contacts.addFromAdvert({ key: p, name: 'P', type: ContactType.CHAT, advertTimestamp: 1 });
    await t.app.contacts.addFromAdvert({ key: q, name: 'Q', type: ContactType.CHAT, advertTimestamp: 1 });
    const both = await resolved(t, h2);
    if (both.kind !== 'ambiguous') throw new Error(both.kind);
    expect(both.contacts.map((c) => c.name).sort()).toEqual(['P', 'Q']);
    expect(await resolved(t, q.slice(0, 4))).toMatchObject({ kind: 'contact', key: q });
  });

  it('listing mode lists every contact and heard node with the prefix, even when one contact matches', async () => {
    const t = await connectedApp();
    const hash = t.keys.alice.slice(0, 2);
    const others = t.app.contacts.views.value.filter((v) => v.key.startsWith(hash) && v.key !== t.keys.alice);
    expect(others).toEqual([]); // the scenario's Alice is the only contact with her hash
    const stranger = `${hash}${'07'.repeat(31)}`;
    await hearAdvert(t, stranger, { name: 'Stranger', type: ContactType.REPEATER });
    await hearAdvert(t, t.keys.alice, { name: 'Alice' }); // a contact heard advertising stays listed once

    // the node page goes straight to the one contact…
    expect(await resolved(t, hash)).toMatchObject({ kind: 'contact', key: t.keys.alice });
    // …the listing shows both
    const list = t.app.node(hash, { list: true });
    expect(list).not.toBe(t.app.node(hash));
    expect(t.app.node(` ${hash.toUpperCase()}`, { list: true })).toBe(list); // cached per normalised ref
    await list.settled();
    const c = await when(list.candidates, (v) => v !== null);
    expect(c).toEqual([
      { key: t.keys.alice, name: 'Alice', typeName: 'chat', heard: false, note: '' },
      { key: stranger, name: 'Stranger', typeName: 'repeater', heard: true, note: '' },
    ]);

    expect(t.app.node('zz', { list: true }).candidates.value).toEqual([]); // invalid: nothing
  });

  it('nodeCandidates puts contacts first, then heard nodes not already listed', () => {
    const contact = { key: 'aa01', name: 'C', typeName: 'chat', note: 'n' } as never;
    const heard = [
      { key: 'aa01', name: 'C', typeName: 'chat' },
      { key: 'aa02', name: '', typeName: 'sensor' },
    ] as never;
    expect(nodeCandidates([contact], heard)).toEqual([
      { key: 'aa01', name: 'C', typeName: 'chat', heard: false, note: 'n' },
      { key: 'aa02', name: '', typeName: 'sensor', heard: true, note: '' },
    ]);
  });
});
