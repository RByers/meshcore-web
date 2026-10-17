import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { ContactType, encodePathLen } from '../protocol/constants.js';
import type { SelfInfo } from '../protocol/types.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import { buildPacket } from '../packet/packet.js';
import { channelHash, encodeAdvertAppData } from '../packet/payloads.js';
import { channelKeyForPsk } from '../store/channels.js';
import type { RadioStore } from '../store/radio-store.js';
import type { ContactRecord, MessageRecord, PacketRecord } from '../store/schema.js';
import { hexKey, key32, openStore } from '../store/test-helpers.js';
import { concatBytes, fromHex } from '../util/bytes.js';
import type { ContactView } from './contacts-model.js';
import { contactTypeName, pathDisplay } from './messaging.js';
import {
  PathModel,
  contactPathSpec,
  findMessagePacket,
  hopsOfPathLen,
  messagePathSpec,
  packetPathSpec,
  pathNodesFromContacts,
  selfPathNode,
} from './path-model.js';
import { signal } from './signal.js';

const T = 1_800_000_000_000;

function view(fill: number, name: string, type: number, over: Partial<ContactRecord> = {}): ContactView {
  const key = hexKey(fill);
  const record = { key, pubKey: key32(fill), name, type, lat: 0, lon: 0, outPathLen: 0xff, outPath: new Uint8Array(0), lastSeen: 0, ...over } as unknown as ContactRecord;
  return {
    key,
    record,
    name,
    typeName: contactTypeName(type),
    lastSeen: 0,
    lastMessage: undefined,
    lastActivity: 0,
    unread: 0,
    path: pathDisplay(record.outPathLen),
    lastSnr: undefined,
    favourite: false,
    onDevice: true,
  };
}

const ALICE = view(0xa1, 'Alice', ContactType.CHAT, { lat: 47.61, lon: -122.33, outPathLen: encodePathLen(2), outPath: Uint8Array.of(0x7e, 0x22) });
const HILL = view(0x7e, 'Hilltop', ContactType.REPEATER, { lat: 47.62, lon: -122.35 });
const SELF_INFO = { pubKey: key32(0x01), name: 'Me', lat: 47.6, lon: -122.33 } as unknown as SelfInfo;

function msg(over: Partial<MessageRecord>): MessageRecord {
  return {
    id: 1,
    convKey: ALICE.key,
    convType: 'contact',
    direction: 'in',
    text: 'hi',
    timestamp: 0,
    receivedAt: T,
    txtType: 0,
    status: 'delivered',
    pathLen: encodePathLen(2),
    ...over,
  };
}

/** A flood TXT_MSG / GRP_TXT packet (§3.0 / §3.6 envelopes, ciphertext zeros). */
function txtPacket(srcHash: number, destHash: number, path: number[], routeType: number = RouteType.FLOOD): Uint8Array {
  return buildPacket({ routeType: routeType as 1, payloadType: PayloadType.TXT_MSG, path: Uint8Array.from(path), payload: concatBytes(Uint8Array.of(destHash, srcHash), new Uint8Array(18)) });
}
function grpPacket(chHash: number, path: number[]): Uint8Array {
  return buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.GRP_TXT, path: Uint8Array.from(path), payload: concatBytes(Uint8Array.of(chHash), new Uint8Array(19)) });
}

let nextId = 1;
function rec(bytes: Uint8Array, ts: number, over: Partial<PacketRecord> = {}): PacketRecord {
  const routeType = bytes[0]! & 0x03;
  const payloadType = (bytes[0]! >> 2) & 0x0f;
  return { id: nextId++, ts, direction: 'rx', bytes, format: 'packet', source: 'logRxData', routeType, payloadType, pathLen: bytes[1]!, hash: `h${nextId}`, ...over };
}

describe('path nodes', () => {
  it('maps contacts and self, with locations only when set', () => {
    const nodes = pathNodesFromContacts([ALICE, view(0x33, 'Nowhere', ContactType.CHAT)]);
    expect(nodes[0]).toEqual({ key: ALICE.key, name: 'Alice', kind: 'chat', lat: 47.61, lon: -122.33 });
    expect(nodes[1]).toEqual({ key: hexKey(0x33), name: 'Nowhere', kind: 'chat' });
    expect(selfPathNode(SELF_INFO)).toEqual({ key: hexKey(0x01), name: 'Me', kind: 'self', lat: 47.6, lon: -122.33 });
    expect(selfPathNode({ ...SELF_INFO, lat: 0, lon: 0 })).toEqual({ key: hexKey(0x01), name: 'Me', kind: 'self' });
    expect(selfPathNode(null)).toBeNull();
  });

  it('hopsOfPathLen decodes path_len (0xFF = none)', () => {
    expect(hopsOfPathLen(0xff)).toBeNull();
    expect(hopsOfPathLen(0)).toBe(0);
    expect(hopsOfPathLen(encodePathLen(3, 2))).toBe(3);
  });
});

describe('contactPathSpec', () => {
  it('splits out_path into hop hashes: self → hops → contact', () => {
    expect(contactPathSpec(ALICE)).toEqual({ title: 'Path to Alice', hashes: ['7e', '22'], from: { kind: 'self' }, to: { kind: 'contact', key: ALICE.key } });
    const two = view(0x44, 'Two', ContactType.CHAT, { outPathLen: encodePathLen(2, 2), outPath: Uint8Array.of(1, 2, 3, 4, 0, 0) });
    expect(contactPathSpec(two).hashes).toEqual(['0102', '0304']);
  });

  it('notes a flood (unknown) path and an empty direct path', () => {
    expect(contactPathSpec(HILL)).toMatchObject({ hashes: [], note: expect.stringContaining('flood') });
    expect(contactPathSpec(view(0x45, 'Direct', ContactType.CHAT, { outPathLen: 0 })).hashes).toEqual([]);
  });
});

describe('findMessagePacket', () => {
  it('finds the TXT_MSG from the contact to this radio with the same path_len, nearest the arrival', () => {
    const far = rec(txtPacket(0xa1, 0x01, [0x7e, 0x22]), T - 90_000);
    const near = rec(txtPacket(0xa1, 0x01, [0x7e, 0x33]), T - 400);
    const otherSrc = rec(txtPacket(0xb2, 0x01, [0x7e, 0x44]), T - 100);
    const otherDest = rec(txtPacket(0xa1, 0x09, [0x7e, 0x55]), T - 100);
    const otherLen = rec(txtPacket(0xa1, 0x01, [0x7e]), T - 100);
    const tooOld = rec(txtPacket(0xa1, 0x01, [0x7e, 0x66]), T - 200_000);
    const tx = rec(txtPacket(0xa1, 0x01, [0x7e, 0x77]), T - 50, { direction: 'tx' });
    const all = [far, near, otherSrc, otherDest, otherLen, tooOld, tx];
    expect(findMessagePacket(msg({}), all, { selfKey: hexKey(0x01) })).toBe(near);
    // without the self key any destination matches
    expect(findMessagePacket(msg({}), all)).toBe(otherDest);
    expect(findMessagePacket(msg({}), [far, tooOld], { selfKey: hexKey(0x01) })).toBe(far);
  });

  it('prefers packets heard before the message, and the first copy of a re-heard packet', () => {
    const after = rec(txtPacket(0xa1, 0x01, [0x7e, 0x22]), T + 100);
    const before = rec(txtPacket(0xa1, 0x01, [0x7e, 0x22]), T - 5_000);
    expect(findMessagePacket(msg({}), [after, before])).toBe(before);
    const first = rec(txtPacket(0xa1, 0x01, [0x7e, 0x22]), T - 3_000, { hash: 'same' });
    const second = rec(txtPacket(0xa1, 0x01, [0x7e, 0x99]), T - 200, { hash: 'same' });
    expect(findMessagePacket(msg({}), [second, first])).toBe(first);
  });

  it('matches channel messages by channel hash', () => {
    const chKey = 'c4'.padEnd(64, '0');
    const m = msg({ convType: 'channel', convKey: chKey, senderName: 'Dave' });
    const right = rec(grpPacket(0xc4, [1, 2]), T - 100);
    const wrong = rec(grpPacket(0xc5, [1, 2]), T - 50);
    const dm = rec(txtPacket(0xc4, 0x01, [1, 2]), T - 10);
    expect(findMessagePacket(m, [right, wrong, dm])).toBe(right);
    expect(findMessagePacket(m, [right, wrong, dm], { channelHash: 0xc5 })).toBe(wrong);
  });

  it('finds nothing for outgoing or direct (0xFF) messages', () => {
    const p = rec(txtPacket(0xa1, 0x01, [0x7e, 0x22]), T - 100);
    expect(findMessagePacket(msg({ direction: 'out' }), [p])).toBeUndefined();
    expect(findMessagePacket(msg({ pathLen: 0xff }), [p])).toBeUndefined();
  });
});

describe('messagePathSpec', () => {
  it('uses the packet path when found: sender → hops → self', () => {
    const p = rec(txtPacket(0xa1, 0x01, [0x7e, 0x22]), T - 100);
    expect(messagePathSpec(msg({}), p)).toMatchObject({ hashes: ['7e', '22'], from: { kind: 'contact', key: ALICE.key }, to: { kind: 'self' } });
  });

  it('falls back to the hop count, and names channel senders', () => {
    const s = messagePathSpec(msg({ convType: 'channel', convKey: 'c4'.padEnd(64, '0'), senderName: 'Dave' }), undefined);
    expect(s).toMatchObject({ hashes: [], hopCount: 2, from: { kind: 'name', name: 'Dave' } });
    expect(s.note).toContain('only the hop count');
    expect(messagePathSpec(msg({ pathLen: 0xff }), undefined).hopCount).toBeUndefined();
  });
});

describe('packetPathSpec', () => {
  it('flood rx: src hash → hops → self; direct: self → hops → dest', () => {
    expect(packetPathSpec(rec(txtPacket(0xa1, 0x01, [0x7e, 0x22]), T))).toMatchObject({
      hashes: ['7e', '22'],
      from: { kind: 'hash', hash: 'a1' },
      to: { kind: 'self' },
    });
    expect(packetPathSpec(rec(txtPacket(0xa1, 0x09, [0x7e], RouteType.DIRECT), T, { direction: 'tx' }))).toMatchObject({
      hashes: ['7e'],
      from: { kind: 'self' },
      to: { kind: 'hash', hash: '09' },
    });
  });

  it('an advert with a location starts at the advertised point', () => {
    const app = encodeAdvertAppData({ nodeType: 2, latitude: 47.5, longitude: -122.1, name: 'Ridge' });
    const payload = concatBytes(key32(0x5a), new Uint8Array(4), new Uint8Array(64), app);
    const r = rec(buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, path: Uint8Array.of(0x7e), payload }), T);
    expect(packetPathSpec(r)).toMatchObject({ hashes: ['7e'], from: { kind: 'point', name: 'Ridge', lat: 47.5, lon: -122.1, key: hexKey(0x5a) }, to: { kind: 'self' } });
  });
});

describe('PathModel', () => {
  async function setup(): Promise<{ store: RadioStore; model: PathModel }> {
    const store = await openStore(0x01);
    const model = new PathModel({
      contacts: signal<readonly ContactView[]>([ALICE, HILL]).readonly,
      selfInfo: signal<SelfInfo | null>(SELF_INFO).readonly,
      store: signal<RadioStore | null>(store).readonly,
    });
    return { store, model };
  }

  it('resolves a contact path and lays it out with an interpolated unknown hop', async () => {
    const { store, model } = await setup();
    const spec = (await model.resolve({ kind: 'contact', key: ALICE.key.toUpperCase() }))!;
    const g = model.geometry(spec);
    expect(g.stops.map((s) => [s.label, s.position])).toEqual([
      ['Me (you)', 'known'],
      ['Hilltop', 'known'],
      ['22', 'interpolated'],
      ['Alice', 'known'],
    ]);
    expect(await model.resolve({ kind: 'contact', key: 'ff' })).toBeNull();
    store.close();
  });

  it('recovers a message path from the packet log', async () => {
    const { store, model } = await setup();
    await store.packets.append({ direction: 'rx', bytes: txtPacket(0xa1, 0x01, [0x7e, 0x22]), ts: T - 1_000, source: 'logRxData' });
    const spec = await model.messageSpec(msg({}));
    expect(spec.hashes).toEqual(['7e', '22']);
    expect(spec.note).toMatch(/packet #\d+/);
    // a message with no logged packet only has its hop count
    expect((await model.messageSpec(msg({ receivedAt: T + 3_600_000 }))).hopCount).toBe(2);
    store.close();
  });

  it('uses the stored channel PSK hash for channel messages', async () => {
    const { store, model } = await setup();
    const psk = fromHex('8b3387e9c5cdea6ac9e5edbaa115cd72');
    const ch = await store.channels.put({ name: 'Public', psk, deviceIndex: 0 });
    expect(ch.key).toBe(await channelKeyForPsk(psk));
    const h = await channelHash(psk);
    await store.packets.append({ direction: 'rx', bytes: grpPacket(h, [0x7e, 0x22]), ts: T - 500, source: 'logRxData' });
    const spec = await model.messageSpec(msg({ convType: 'channel', convKey: ch.key, senderName: 'Alice' }));
    expect(spec.hashes).toEqual(['7e', '22']);
    expect(model.geometry(spec).stops[0]!.node?.key).toBe(ALICE.key);
    store.close();
  });

  it('resolves a logged packet by id', async () => {
    const { store, model } = await setup();
    const r = await store.packets.append({ direction: 'rx', bytes: txtPacket(0xa1, 0x01, [0x7e]), ts: T, source: 'logRxData' });
    expect((await model.resolve({ kind: 'packet', id: r.id }))?.hashes).toEqual(['7e']);
    expect(await model.resolve({ kind: 'packet', id: 999 })).toBeNull();
    store.close();
  });
});
