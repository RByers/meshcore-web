import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { ContactType, encodePathLen } from '../protocol/constants.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import { buildPacket } from '../packet/packet.js';
import { buildAdvertPayload } from '../packet/payloads.js';
import { scenarioIdentity } from '../emulator/scenarios.js';
import type { ContactRecord, MessageRecord, PacketRecord } from '../store/schema.js';
import { fromHex, toHex } from '../util/bytes.js';
import { AppModel, createEmulatorTransportFactory } from './app-model.js';
import { memoryPreferences } from './connection.js';
import { haversineMeters } from './geo.js';
import {
  ESTIMATE_DISTANCE_M,
  estimatePositions,
  messageEvidence,
  outPathEvidence,
  packetEvidence,
  type AdjacencyEvidence,
  type EstimatorContact,
} from './position-estimator.js';

const NOW = 1_800_000_000_000;

function contact(prefix: string, name: string, type: number, lat = 0, lon = 0): EstimatorContact {
  const key = prefix.padEnd(64, '0');
  return { key, pubKey: fromHex(key), name, type, lat, lon };
}

const R1 = contact('a1', 'Hilltop', ContactType.REPEATER, 47.62, -122.35);
const R2 = contact('b2', 'Harbour', ContactType.REPEATER, 47.7, -122.4);
const C3a = contact('c3aa', 'Ridge A', ContactType.REPEATER, 47.5, -122.3);
const C3b = contact('c3bb', 'Ridge B', ContactType.REPEATER, 47.55, -122.25);
const CAROL = contact('d4', 'Carol', ContactType.CHAT);
const DAN = contact('e5', 'Dan', ContactType.CHAT);
const F0a = contact('f0aa', 'Twin A', ContactType.CHAT);
const F0b = contact('f0bb', 'Twin B', ContactType.CHAT);
const CONTACTS = [R1, R2, C3a, C3b, CAROL, DAN, F0a, F0b];

function ev(node: AdjacencyEvidence['node'], via: string | 'self', ts: number, id = `x${ts}${JSON.stringify(node)}${via}`): AdjacencyEvidence {
  return { id, ts, source: 'packet', node, via: via === 'self' ? 'self' : fromHex(via) };
}

describe('estimatePositions', () => {
  it('places a node a fixed distance from the most recent located repeater it was heard through', () => {
    const evidence = [ev({ key: CAROL.key }, 'b2', NOW - 1000), ev({ key: CAROL.key }, 'a1', NOW - 5000)];
    for (const list of [evidence, [...evidence].reverse()]) {
      const [e, ...rest] = estimatePositions({ contacts: CONTACTS, evidence: list, now: NOW });
      expect(rest).toEqual([]);
      expect(e).toMatchObject({ key: CAROL.key, viaKey: R2.key, viaName: 'Harbour', observedAt: NOW - 1000, approximate: true });
      expect(haversineMeters(e!, R2)).toBeCloseTo(ESTIMATE_DISTANCE_M, 0);
    }
  });

  it('ignores ambiguous repeater hashes and ambiguous node hashes', () => {
    const r = estimatePositions({
      contacts: CONTACTS,
      evidence: [
        ev({ key: CAROL.key }, 'c3', NOW - 100), // Ridge A or Ridge B
        ev({ key: CAROL.key }, 'a1', NOW - 9000),
        ev({ hash: fromHex('f0') }, 'a1', NOW - 100), // Twin A or Twin B
        ev({ hash: fromHex('e5') }, '99', NOW - 100), // unknown repeater
      ],
      now: NOW,
    });
    expect(r.map((e) => [e.key, e.viaKey])).toEqual([[CAROL.key, R1.key]]);
  });

  it('resolves src hashes and channel sender names, never repositions located nodes', () => {
    const r = estimatePositions({
      contacts: CONTACTS,
      evidence: [ev({ hash: fromHex('e5') }, 'a1', NOW - 100), ev({ name: 'Carol' }, 'b2', NOW - 100), ev({ key: R2.key }, 'a1', NOW - 100)],
      now: NOW,
    });
    expect(r.map((e) => [e.key, e.viaName])).toEqual([
      [CAROL.key, 'Harbour'],
      [DAN.key, 'Hilltop'],
    ]);
  });

  it('fans estimates out around a busy repeater without overlapping each other or other nodes', () => {
    const many = Array.from({ length: 10 }, (_, i) => contact(`7${i}`, `User ${i}`, ContactType.CHAT));
    // a located node right where the first estimate might go
    const near = contact('60', 'Neighbour', ContactType.CHAT, 47.6236, -122.35);
    const contacts = [R1, near, ...many];
    const evidence = many.map((c, i) => ev({ key: c.key }, 'a1', NOW - i));
    const r = estimatePositions({ contacts, evidence, now: NOW });
    expect(r).toHaveLength(10);
    const pts = [R1, near, ...r];
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) expect(haversineMeters(pts[i]!, pts[j]!)).toBeGreaterThanOrEqual(ESTIMATE_DISTANCE_M * 0.6 - 1e-6);
    }
    for (const e of r) expect(haversineMeters(e, R1)).toBeLessThan(ESTIMATE_DISTANCE_M * 3);
    // deterministic
    expect(estimatePositions({ contacts, evidence: [...evidence].reverse(), now: NOW })).toEqual(r);
  });

  it('anchors zero-hop sightings at this radio only when it has a location; drops old sightings', () => {
    const self = { pubKey: fromHex('99'.padEnd(64, '0')), name: 'Me', lat: 47.6, lon: -122.33 };
    const evidence = [ev({ key: CAROL.key }, 'self', NOW - 10)];
    expect(estimatePositions({ contacts: CONTACTS, evidence, self, now: NOW })[0]).toMatchObject({ viaKey: toHex(self.pubKey), viaName: 'Me' });
    expect(estimatePositions({ contacts: CONTACTS, evidence, self: { ...self, lat: 0, lon: 0 }, now: NOW })).toEqual([]);
    expect(estimatePositions({ contacts: CONTACTS, evidence: [ev({ key: CAROL.key }, 'a1', NOW - 8 * 86_400_000)], now: NOW })).toEqual([]);
  });

  it('uses the last hop of a stored out_path (never expires)', () => {
    const rec = {
      key: DAN.key,
      outPathLen: encodePathLen(2),
      outPath: fromHex('b2a1'),
      lastMod: 1000,
      lastSeen: 0,
    } as Pick<ContactRecord, 'key' | 'outPathLen' | 'outPath' | 'lastMod' | 'lastSeen' | 'pathHistory'>;
    const e = outPathEvidence(rec)!;
    expect(e).toMatchObject({ id: `o:${DAN.key}`, ts: 1_000_000, source: 'outPath', node: { key: DAN.key } });
    expect(toHex(e.via as Uint8Array)).toBe('a1');
    const r = estimatePositions({ contacts: CONTACTS, evidence: [e], now: NOW });
    expect(r[0]).toMatchObject({ key: DAN.key, viaKey: R1.key, source: 'outPath' });
    // the path history's lastUsed wins over lastmod
    const hist = { pathLen: rec.outPathLen, path: rec.outPath, attempts: 1, successes: 1, failures: 0, lastUsed: 5_000_000 };
    expect(outPathEvidence({ ...rec, pathHistory: [hist] })!.ts).toBe(5_000_000);
    expect(outPathEvidence({ ...rec, outPathLen: 0, outPath: new Uint8Array(0) })!.via).toBe('self');
    expect(outPathEvidence({ ...rec, outPathLen: 0xff })).toBeNull();
  });
});

describe('packetEvidence / messageEvidence', () => {
  const rec = (bytes: Uint8Array, over: Partial<PacketRecord> = {}): PacketRecord =>
    ({ id: 7, ts: NOW, direction: 'rx', format: 'packet', bytes, ...over }) as PacketRecord;

  it('takes the advertiser key and the first hop of a flood advert (§3.5, §1.2)', async () => {
    const carol = scenarioIdentity('carol');
    const payload = await buildAdvertPayload({ keys: carol, timestamp: 1, appData: { nodeType: 1, name: 'Carol' } });
    const flood = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, path: fromHex('a1b2'), payload });
    const e = packetEvidence(rec(flood))!;
    expect(e).toMatchObject({ id: 'p:7', ts: NOW, source: 'packet', node: { key: toHex(carol.publicKey) } });
    expect(toHex(e.via as Uint8Array)).toBe('a1');
    const zeroHop = buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.ADVERT, payload });
    expect(packetEvidence(rec(zeroHop))!.via).toBe('self');
    expect(packetEvidence(rec(flood, { direction: 'tx' }))).toBeNull();
  });

  it('takes src_hash (payload[1], §3.0) of a flood TXT_MSG; ignores direct-routed and channel packets', () => {
    const payload = Uint8Array.from([0x99, 0xe5, 1, 2, 3, 4]);
    const flood = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.TXT_MSG, path: fromHex('a1'), payload });
    const e = packetEvidence(rec(flood))!;
    expect(toHex((e.node as { hash: Uint8Array }).hash)).toBe('e5');
    expect(packetEvidence(rec(buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.TXT_MSG, path: fromHex('a1'), payload })))).toBeNull();
    expect(packetEvidence(rec(buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.GRP_TXT, path: fromHex('a1'), payload })))).toBeNull();
  });

  it('message: DM → conversation key, channel → sender name; first hop of the stored path', () => {
    const base = { id: 3, receivedAt: NOW, direction: 'in', pathLen: encodePathLen(2), path: fromHex('b2a1') } as const;
    const dm = messageEvidence({ ...base, convType: 'contact', convKey: CAROL.key } as MessageRecord)!;
    expect(dm).toMatchObject({ id: 'm:3', node: { key: CAROL.key }, source: 'message' });
    expect(toHex(dm.via as Uint8Array)).toBe('b2');
    expect(messageEvidence({ ...base, convType: 'channel', convKey: 'ch', senderName: 'Carol' } as MessageRecord)!.node).toEqual({ name: 'Carol' });
    expect(messageEvidence({ ...base, convType: 'contact', convKey: CAROL.key, pathLen: 0xff } as MessageRecord)).toBeNull();
    expect(messageEvidence({ ...base, convType: 'contact', convKey: CAROL.key, path: undefined } as MessageRecord)).toBeNull();
    expect(messageEvidence({ ...base, convType: 'contact', convKey: CAROL.key, direction: 'out' } as MessageRecord)).toBeNull();
  });
});

describe('PositionEstimatorModel (emulator + virtual mesh)', () => {
  const apps: AppModel[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.dispose();
  });

  it('a contact heard only through the repeater gets an estimate near it once the setting is on', async () => {
    const emulator = createEmulatorTransportFactory();
    const app = new AppModel({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, createEmulatorTransport: emulator, preferences: memoryPreferences() });
    apps.push(app);
    expect(await app.connection.connect('emulator')).toBe(true);
    await app.connection.capture!.idle();
    const s = emulator.scenario();
    const carol = toHex(s.keys.carol);
    const sensor = toHex(s.keys.sensor);
    const repeater = { lat: 47.62, lon: -122.35 };
    await app.contacts.settled();
    // Carol only reaches the repeater: her advert arrives with a 1-hop path
    s.nodes.carol.advertise();
    await vi.waitFor(async () => {
      await app.connection.capture!.idle();
      expect((await app.connection.store.value!.packets.query({ payloadType: PayloadType.ADVERT })).items.length).toBeGreaterThan(0);
    });
    expect(app.map.allMarkers.value.some((m) => m.approximate)).toBe(false);

    app.appSettings.setApproximatePositions(true);
    await vi.waitFor(async () => {
      await app.positions.settled();
      expect(app.positions.estimates.value.find((e) => e.key === carol)).toBeDefined();
    });
    const e = app.positions.estimates.value.find((x) => x.key === carol)!;
    expect(e).toMatchObject({ viaKey: toHex(s.keys.repeater), viaName: 'Hilltop Repeater', source: 'packet' });
    expect(haversineMeters(e, repeater)).toBeLessThan(ESTIMATE_DISTANCE_M * 3);
    // the sensor has no location but a stored out_path via the repeater
    expect(app.positions.estimates.value.find((x) => x.key === sensor)).toMatchObject({ viaName: 'Hilltop Repeater', source: 'outPath' });

    const marker = app.map.allMarkers.value.find((m) => m.key === carol)!;
    expect(marker).toMatchObject({ approximate: true, kind: 'chat', lat: e.lat, lon: e.lon });
    expect(app.map.focus(carol)?.key).toBe(carol);

    // new traffic is picked up incrementally (a channel message via the repeater)
    s.nodes.carol.sendChannelMessage('Public', 'hello from the valley');
    await vi.waitFor(async () => {
      await app.connection.capture!.idle();
      expect(app.positions.estimates.value.find((x) => x.key === carol)!.observedAt).toBeGreaterThan(e.observedAt);
    });

    app.appSettings.setApproximatePositions(false);
    expect(app.positions.estimates.value).toEqual([]);
    expect(app.map.allMarkers.value.some((m) => m.approximate)).toBe(false);
  });
});
