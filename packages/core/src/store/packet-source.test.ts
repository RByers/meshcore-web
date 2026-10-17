import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { PayloadType, RouteType } from '../packet/constants.js';
import { buildPacket } from '../packet/packet.js';
import { concatBytes, fromHex } from '../util/bytes.js';
import { packetSourceOf, sourceMatches } from './packet-source.js';
import { RadioStore } from './radio-store.js';
import { openDatabase, transactionDone } from './idb.js';
import { INDEX, RADIO_DB_MIGRATIONS, STORE, radioDbName, type PacketRecord } from './schema.js';
import { advertPacket, freshFactory, grpTxtPacket, key32, openStore } from './test-helpers.js';

/** mesh-packet-format.md §3.0: dest_hash(1) ‖ src_hash(1) ‖ MAC(2) ‖ ciphertext(16·k). */
function peerPayload(dest: number, src: number): Uint8Array {
  return concatBytes(Uint8Array.of(dest, src), Uint8Array.of(0xee, 0xff), new Uint8Array(16).fill(0x99));
}

function txtPacket(dest: number, src: number, hops = 0): Uint8Array {
  return buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.TXT_MSG, path: new Uint8Array(hops).fill(0x22), payload: peerPayload(dest, src) });
}

/** §3.8: dest_hash(1) ‖ sender pubkey(32) ‖ MAC(2) ‖ ciphertext. */
function anonReqPayload(dest: number, sender: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(dest), sender, Uint8Array.of(1, 2), new Uint8Array(16));
}

describe('packetSourceOf', () => {
  it('reads src_hash at offset 1 of REQ / RESPONSE / TXT_MSG / PATH (§3.0)', () => {
    for (const pt of [PayloadType.REQ, PayloadType.RESPONSE, PayloadType.TXT_MSG, PayloadType.PATH]) {
      const bytes = buildPacket({ routeType: RouteType.DIRECT, payloadType: pt, payload: peerPayload(0x10, 0xa7) });
      expect(packetSourceOf({ format: 'packet', bytes, payloadType: pt })).toEqual({ srcHash: 'a7' });
    }
  });

  it('reads the full key at offset 0 of an ADVERT (§3.5)', () => {
    const bytes = advertPacket(0x5c);
    expect(packetSourceOf({ format: 'packet', bytes, payloadType: PayloadType.ADVERT })).toEqual({ srcHash: '5c', srcKey: '5c'.repeat(32) });
  });

  it('reads the sender key at offset 1 of an ANON_REQ payload (§3.8)', () => {
    const sender = fromHex(`c3${'01'.repeat(31)}`);
    const src = packetSourceOf({ format: 'payload', bytes: anonReqPayload(0x10, sender), payloadType: PayloadType.ANON_REQ });
    expect(src).toEqual({ srcHash: 'c3', srcKey: `c3${'01'.repeat(31)}` });
  });

  it('has no source for group, trace, requested and unparsable packets', () => {
    expect(packetSourceOf({ format: 'packet', bytes: grpTxtPacket(1), payloadType: PayloadType.GRP_TXT })).toBeNull();
    expect(packetSourceOf({ format: 'none', bytes: new Uint8Array(0), payloadType: PayloadType.TXT_MSG })).toBeNull();
    expect(packetSourceOf({ format: 'packet', bytes: Uint8Array.of(0x09), payloadType: -1 })).toBeNull();
    // TXT_MSG payload shorter than the envelope
    expect(packetSourceOf({ format: 'payload', bytes: Uint8Array.of(1, 2), payloadType: PayloadType.TXT_MSG })).toBeNull();
  });
});

describe('sourceMatches', () => {
  const key = `a7${'33'.repeat(31)}`;
  it('matches the hash byte and, when known, the full key', () => {
    expect(sourceMatches({ srcHash: 'a7' }, key)).toBe(true);
    expect(sourceMatches({ srcHash: 'a7', srcKey: key }, key)).toBe(true);
    expect(sourceMatches({ srcHash: 'a7', srcKey: `a7${'44'.repeat(31)}` }, key)).toBe(false);
    expect(sourceMatches({ srcHash: 'a8' }, key)).toBe(false);
    expect(sourceMatches({}, key)).toBe(false);
    // a 1-byte prefix query matches every node with that hash
    expect(sourceMatches({ srcHash: 'a7', srcKey: `a7${'44'.repeat(31)}` }, 'a7')).toBe(true);
  });
});

describe('PacketLog by source', () => {
  it('stores srcHash / srcKey and queries them through the srcHash_ts index', async () => {
    const s = await openStore();
    const keyA = 'a7'.repeat(32);
    await s.packets.append({ direction: 'rx', bytes: advertPacket(0xa7), ts: 10 });
    await s.packets.append({ direction: 'rx', bytes: txtPacket(0x01, 0xa7, 2), ts: 20 });
    await s.packets.append({ direction: 'rx', bytes: txtPacket(0x01, 0xb2), ts: 30 });
    await s.packets.append({ direction: 'rx', bytes: grpTxtPacket(1), ts: 40 });
    // another node sharing the a7 hash byte: its advert is excluded, its hash-only packets are not
    const other = await s.packets.append({ direction: 'rx', bytes: buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, payload: concatBytes(fromHex(`a7${'00'.repeat(31)}`), new Uint8Array(69)) }), ts: 50 });
    expect(other.srcKey).toBe(`a7${'00'.repeat(31)}`);

    const page = await s.packets.query({ src: keyA });
    expect(page.items.map((r) => r.ts)).toEqual([20, 10]);
    expect(page.items[1]).toMatchObject({ srcHash: 'a7', srcKey: keyA });
    expect(page.items[0]!.srcKey).toBeUndefined();
    expect(await s.packets.count({ src: keyA })).toBe(2);
    expect(await s.packets.count({ src: keyA, from: 15 })).toBe(1);
    expect(await s.packets.count({ src: 'a7' })).toBe(3);
    expect(await s.packets.count({ src: 'not hex' })).toBe(0);

    const seen = await s.packets.sourceActivity(keyA);
    expect(seen.map((x) => [x.ts, x.keyed])).toEqual([
      [10, true],
      [20, false],
    ]);
    expect(await s.packets.sourceActivity(keyA, { from: 11, to: 25 })).toHaveLength(1);
    s.close();
  });

  it('derives the source on import instead of trusting the file', async () => {
    const s = await openStore();
    await s.packets.append({ direction: 'rx', bytes: txtPacket(0x01, 0xa7), ts: 5 });
    const exp = await s.packets.export();
    const forged = { ...exp, items: exp.items.map((i) => ({ ...i, srcHash: 'ff', srcKey: 'ff'.repeat(32) })) };
    await s.packets.import(forged);
    const all = (await s.packets.query({})).items;
    expect(all).toHaveLength(2);
    for (const r of all) {
      expect(r.srcHash).toBe('a7');
      expect(r.srcKey).toBeUndefined();
    }
    s.close();
  });

  it('the v3 migration indexes and back-fills packets logged before it', async () => {
    const factory = freshFactory();
    const name = radioDbName(key32(1));
    // a v2 database (the first two migrations) holding packets without source fields
    const db2 = await openDatabase({ name, version: 2, migrations: RADIO_DB_MIGRATIONS, factory });
    const tx = db2.raw.transaction(STORE.packets, 'readwrite');
    const base = { direction: 'rx', format: 'packet', source: 'logRxData', routeType: 1, pathLen: 0, hash: '' } as const;
    tx.objectStore(STORE.packets).add({ ...base, ts: 1, bytes: txtPacket(0x01, 0xa7), payloadType: PayloadType.TXT_MSG });
    tx.objectStore(STORE.packets).add({ ...base, ts: 2, bytes: grpTxtPacket(0), payloadType: PayloadType.GRP_TXT });
    await transactionDone(tx);
    expect(Array.from(db2.raw.transaction(STORE.packets).objectStore(STORE.packets).indexNames)).not.toContain(INDEX.packets.srcHashTs);
    db2.close();

    const store = await RadioStore.open(key32(1), { factory });
    expect(store.db.version).toBe(3);
    const all = (await store.packets.query({ order: 'asc' })).items as PacketRecord[];
    expect(all.map((r) => r.srcHash)).toEqual(['a7', undefined]);
    expect((await store.packets.query({ src: 'a7' })).items.map((r) => r.ts)).toEqual([1]);
    store.close();
  });
});
