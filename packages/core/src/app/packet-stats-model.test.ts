import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { ContactType } from '../protocol/constants.js';
import type { SelfInfo } from '../protocol/types.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import { buildPacket } from '../packet/packet.js';
import {
  buildGroupDatagramPayload,
  buildGrpTxtPlaintext,
  buildTracePayload,
  channelHash,
  encodeAdvertAppData,
} from '../packet/payloads.js';
import { publicChannelSecret } from '../emulator/scenarios.js';
import type { PacketInput } from '../store/packet-log.js';
import type { RadioStore } from '../store/radio-store.js';
import { DEFAULT_CONTACT_LOCAL, type ContactRecord } from '../store/schema.js';
import { hexKey, key32, makeContact, openStore } from '../store/test-helpers.js';
import { concatBytes, toHex } from '../util/bytes.js';
import { loraAirtimeMs } from './airtime.js';
import { AppModel, createEmulatorTransportFactory } from './app-model.js';
import { memoryPreferences, type ConnectionModel } from './connection.js';
import { haversineMeters } from './geo.js';
import {
  BIN_STEPS,
  PacketStatsModel,
  SERIES_ADVERTS,
  SERIES_DMS,
  SERIES_OTHER,
  autoBinMs,
  nodeId,
  type StatPacket,
} from './packet-stats-model.js';
import type { SummaryContext } from './packet-summary.js';
import { signal } from './signal.js';

const T = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function contact(pubKey: Uint8Array, name: string, type: number, lat = 0, lon = 0): ContactRecord {
  return { ...makeContact(0, { pubKey, name, type, lat, lon }), ...DEFAULT_CONTACT_LOCAL, key: toHex(pubKey), onDevice: true, updatedAt: 0 };
}

const SELF_POS = { lat: 47.6, lon: -122.33 };
const SELF = {
  pubKey: key32(0x01),
  name: 'Me',
  ...SELF_POS,
  radioSf: 10,
  radioBwHz: 250_000,
  radioCr: 5,
} as unknown as SelfInfo;
const RADIO = { sf: 10, bwKhz: 250, cr: 5 };

const ALICE = contact(key32(0xa1), 'Alice', ContactType.CHAT, 47.61, -122.33);
const BOB = contact(key32(0xb2), 'Bob', ContactType.CHAT); // no location
const HILL = contact(key32(0x7e), 'Hilltop', ContactType.REPEATER, 47.62, -122.35);
const RIDGE = contact(key32(0x22), 'Ridge', ContactType.REPEATER); // no location
const FAR = contact(key32(0xe5), 'Faraway', ContactType.REPEATER, 48.5, -121.0);
const AMB1 = contact(concatBytes(Uint8Array.of(0xc3), new Uint8Array(31).fill(0x10)), 'Cee One', ContactType.CHAT);
const AMB2 = contact(concatBytes(Uint8Array.of(0xc3), new Uint8Array(31).fill(0x20)), 'Cee Two', ContactType.CHAT);
const CAROL = contact(key32(0xd4), 'Carol', ContactType.CHAT, 47.5, -122.2);
const CONTACTS = [ALICE, BOB, HILL, RIDGE, FAR, AMB1, AMB2, CAROL];

const PSK = new Uint8Array(16).fill(7);

// ---- packet builders (mesh-packet-format.md §1 envelope, §3 payloads; ciphertext zeros where not decrypted) ----

function advert(key: Uint8Array, app: Parameters<typeof encodeAdvertAppData>[0], path: number[] = []): Uint8Array {
  const payload = concatBytes(key, new Uint8Array(4), new Uint8Array(64), encodeAdvertAppData(app));
  return buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, path: Uint8Array.from(path), payload });
}
function datagram(type: number, src: number, dest: number, path: number[] = [], routeType: number = RouteType.FLOOD): Uint8Array {
  return buildPacket({ routeType: routeType as 1, payloadType: type, path: Uint8Array.from(path), payload: concatBytes(Uint8Array.of(dest, src), new Uint8Array(18)) });
}
function anonReq(sender: Uint8Array, dest = 0x01): Uint8Array {
  return buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ANON_REQ, payload: concatBytes(Uint8Array.of(dest), sender, new Uint8Array(18)) });
}
async function grpTxt(psk: Uint8Array, sender: string, text: string, path: number[] = []): Promise<Uint8Array> {
  const payload = await buildGroupDatagramPayload({
    channelHash: await channelHash(psk),
    secret: psk,
    plaintext: buildGrpTxtPlaintext({ timestamp: 1, senderName: sender, text }),
  });
  return buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.GRP_TXT, path: Uint8Array.from(path), payload });
}
function grpUnknown(hash: number): Uint8Array {
  return buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.GRP_TXT, payload: concatBytes(Uint8Array.of(hash), new Uint8Array(19)) });
}
function ack(path: number[] = []): Uint8Array {
  return buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ACK, path: Uint8Array.from(path), payload: new Uint8Array(4).fill(9) });
}

// ---- harness ----

interface Harness {
  store: RadioStore;
  model: PacketStatsModel;
  context: ReturnType<typeof signal<SummaryContext>>;
  contacts: ReturnType<typeof signal<readonly ContactRecord[]>>;
  selfInfo: ReturnType<typeof signal<SelfInfo | null>>;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function harness(inputs: PacketInput[], opts: { contacts?: readonly ContactRecord[]; self?: SelfInfo | null; channels?: SummaryContext['channels'] } = {}): Promise<Harness> {
  const store = await openStore(0x01);
  if (inputs.length) await store.packets.appendMany(inputs);
  const storeSig = signal<RadioStore | null>(null);
  const selfInfo = signal<SelfInfo | null>(opts.self === undefined ? SELF : opts.self);
  const connection = { store: storeSig.readonly, selfInfo: selfInfo.readonly } as unknown as ConnectionModel;
  const channels = opts.channels ?? [{ name: 'Test', psk: PSK, hash: await channelHash(PSK) }];
  const context = signal<SummaryContext>({ nodes: [], channels });
  const contacts = signal<readonly ContactRecord[]>(opts.contacts ?? CONTACTS);
  const model = new PacketStatsModel(connection, { context: context.readonly, contacts: contacts.readonly }).start();
  storeSig.value = store;
  await model.settled();
  cleanups.push(() => {
    model.dispose();
    store.close();
  });
  return { store, model, context, contacts, selfInfo };
}

function rx(bytes: Uint8Array, ts: number, over: Partial<PacketInput> = {}): PacketInput {
  return { direction: 'rx', bytes, ts, source: 'logRxData', snr: 5, rssi: -90, ...over };
}

function byTs(points: readonly StatPacket[], ts: number): StatPacket {
  const p = points.find((x) => x.ts === ts);
  if (!p) throw new Error(`no point at ${ts}`);
  return p;
}

describe('PacketStatsModel — per-packet attribution (§1.3)', () => {
  it('attributes sources, last hops and distance for each payload kind', async () => {
    const aliceAdvert = advert(key32(0xa1), { nodeType: 1, latitude: 47.61, longitude: -122.33, name: 'Alice' }, [0x7e]);
    const { model } = await harness([
      rx(aliceAdvert, T + 1),
      rx(advert(key32(0x5a), { nodeType: 1, name: 'Stranger' }), T + 2),
      rx(datagram(PayloadType.TXT_MSG, 0xb2, 0x01, [0x22, 0x7e, 0xe5]), T + 3),
      rx(datagram(PayloadType.TXT_MSG, 0xc3, 0x01), T + 4),
      rx(datagram(PayloadType.REQ, 0x99, 0x01, [0x7e]), T + 5),
      rx(anonReq(key32(0xd4)), T + 6),
      rx(await grpTxt(PSK, 'Carol', 'hi'), T + 7),
      rx(await grpTxt(PSK, 'Zed', 'yo', [0x7e]), T + 8),
      rx(grpUnknown(0x00), T + 9),
      rx(ack([0x7e]), T + 10),
      rx(buildTracePayload({ tag: 1, authCode: 2, hashes: Uint8Array.of(0x7e) }), T + 11, { format: 'payload', source: 'traceData', payloadType: PayloadType.TRACE, routeType: RouteType.DIRECT, pathLen: 1 }),
      { direction: 'tx', bytes: new Uint8Array(0), format: 'none', source: 'sent', payloadType: PayloadType.TXT_MSG, ts: T + 12 },
      rx(datagram(PayloadType.PATH, 0xa1, 0x01, [], RouteType.DIRECT), T + 13),
      rx(await grpTxt(PSK, 'Me', 'echo', [0x7e]), T + 14),
    ]);
    const pts = model.points.value;
    expect(pts.map((p) => p.ts)).toEqual(Array.from({ length: 14 }, (_, i) => T + i + 1));

    // ADVERT → advertised key; distance to the advertised position; last hop = the repeater
    const a = byTs(pts, T + 1);
    expect(a).toMatchObject({ direction: 'in', typeName: 'ADVERT', category: 'advert', routeName: 'FLOOD', hops: 1, snr: 5, rssi: -90, direct: false, channel: null });
    expect(a.source).toEqual({ hash: ALICE.key, key: ALICE.key, label: 'Alice', resolved: true });
    expect(a.lastHop).toEqual({ hash: '7e', key: HILL.key, label: 'Hilltop', resolved: true });
    expect(a.distanceM).toBeCloseTo(haversineMeters(SELF_POS, { lat: 47.61, lon: -122.33 }), 3);
    expect(a.bytes).toBe(aliceAdvert.length);
    expect(a.airtimeMs).toBeCloseTo(loraAirtimeMs(aliceAdvert.length, RADIO), 9);

    // unknown advertiser: its name, not resolved; heard directly → lastHop = source; no location → no distance
    const s = byTs(pts, T + 2);
    expect(s.source).toEqual({ hash: hexKey(0x5a), label: 'Stranger', resolved: false });
    expect(s.direct).toBe(true);
    expect(s.lastHop).toEqual(s.source);
    expect(s.distanceM).toBeNull();

    // TXT_MSG src hash → Bob (no location): distance falls back to the earliest located hop (Hilltop, not Faraway)
    const t = byTs(pts, T + 3);
    expect(t.source).toEqual({ hash: 'b2', key: BOB.key, label: 'Bob', resolved: true });
    expect(t.lastHop).toMatchObject({ hash: 'e5', label: 'Faraway', resolved: true });
    expect(t.hops).toBe(3);
    expect(t.category).toBe('dm');
    expect(t.distanceM).toBeCloseTo(haversineMeters(SELF_POS, HILL), 3);

    // ambiguous src hash
    const amb = byTs(pts, T + 4);
    expect(amb.source).toEqual({ hash: 'c3', label: 'c3?', resolved: false });
    expect(amb.direct).toBe(true);
    expect(amb.lastHop).toEqual(amb.source);
    expect(amb.distanceM).toBeNull();

    // unknown src hash; distance from the located hop
    const req = byTs(pts, T + 5);
    expect(req.source).toEqual({ hash: '99', label: '99', resolved: false });
    expect(req.category).toBe('other');
    expect(req.distanceM).toBeCloseTo(haversineMeters(SELF_POS, HILL), 3);

    // ANON_REQ: sender public key
    const anon = byTs(pts, T + 6);
    expect(anon.source).toEqual({ hash: CAROL.key, key: CAROL.key, label: 'Carol', resolved: true });
    expect(anon.distanceM).toBeCloseTo(haversineMeters(SELF_POS, CAROL), 3);

    // GRP_TXT with a known PSK: "sender: text" → a contact by exact name
    const g1 = byTs(pts, T + 7);
    expect(g1).toMatchObject({ channel: 'Test', category: 'channel' });
    expect(g1.source).toEqual({ hash: 'd4', key: CAROL.key, label: 'Carol', resolved: true });
    expect(g1.distanceM).toBeCloseTo(haversineMeters(SELF_POS, CAROL), 3);
    const g2 = byTs(pts, T + 8);
    expect(g2.source).toEqual({ hash: '', label: 'Zed', resolved: false });
    expect(g2.lastHop?.label).toBe('Hilltop');

    // GRP_TXT without a key, ACK, TRACE: unattributable
    const g3 = byTs(pts, T + 9);
    expect(g3.channel).toBe('channel 00');
    expect(g3.source).toBeNull();
    expect(byTs(pts, T + 10).source).toBeNull();
    const tr = byTs(pts, T + 11);
    expect(tr).toMatchObject({ typeName: 'TRACE', category: 'trace', source: null, lastHop: null, direct: false, hops: 1 });
    // payload-only record: header + path_len + 1 path (SNR) byte + payload
    expect(tr.bytes).toBe(2 + 1 + 9 + 1);

    // outgoing: this radio; requested transmissions have no known size / airtime
    const out = byTs(pts, T + 12);
    expect(out).toMatchObject({ direction: 'out', bytes: 0, airtimeMs: null, distanceM: null, snr: null, rssi: null });
    expect(out.source).toEqual({ hash: '01', key: hexKey(0x01), label: 'Me', resolved: true, self: true });

    // PATH src hash
    expect(byTs(pts, T + 13).source?.label).toBe('Alice');
    // a channel message named after this radio
    expect(byTs(pts, T + 14).source).toMatchObject({ key: hexKey(0x01), self: true });
  });

  it('re-attributes when contacts, SELF_INFO or the channel list change', async () => {
    const h = await harness([rx(datagram(PayloadType.TXT_MSG, 0xb2, 0x01), T), rx(await grpTxt(PSK, 'Bob', 'hey'), T + 1)], { channels: [] });
    expect(h.model.points.value[0]!.source?.resolved).toBe(true);
    expect(h.model.points.value[1]!.source).toBeNull();
    expect(h.model.points.value[1]!.channel).toMatch(/^channel [0-9a-f]{2}$/);

    h.contacts.value = [ALICE];
    expect(h.model.points.value[0]!.source).toEqual({ hash: 'b2', label: 'b2', resolved: false });

    // a new channel PSK: GRP_TXT packets are decrypted again (reload)
    h.context.value = { nodes: [], channels: [{ name: 'Test', psk: PSK, hash: await channelHash(PSK) }] };
    await h.model.settled();
    expect(h.model.points.value[1]!.channel).toBe('Test');
    expect(h.model.points.value[1]!.source).toEqual({ hash: '', label: 'Bob', resolved: false });

    // no radio params → no airtime
    expect(h.model.points.value[0]!.airtimeMs).not.toBeNull();
    h.selfInfo.value = null;
    expect(h.model.points.value[0]!.airtimeMs).toBeNull();
    expect(h.model.summary.value.airtimeMs).toBeNull();
    expect(h.model.radio.value).toBeNull();
  });

  it('no distance without an own position', async () => {
    const { model } = await harness([rx(anonReq(key32(0xd4)), T)], { self: { ...SELF, lat: 0, lon: 0 } });
    expect(model.points.value[0]!.distanceM).toBeNull();
  });
});

describe('PacketStatsModel — range, live tail, aggregations', () => {
  it('filters by date range, keeps the whole-log bounds, and appends live packets in range', async () => {
    const { store, model } = await harness([
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01), T),
      rx(datagram(PayloadType.TXT_MSG, 0xb2, 0x01), T + HOUR),
      rx(datagram(PayloadType.TXT_MSG, 0xd4, 0x01), T + 2 * HOUR),
    ]);
    expect(model.points.value).toHaveLength(3);
    expect(model.bounds.value).toEqual({ first: T, last: T + 2 * HOUR });
    expect(model.range.value).toEqual({ from: null, to: null });

    await model.setRange({ from: T + HOUR, to: T + 2 * HOUR });
    expect(model.points.value.map((p) => p.source?.label)).toEqual(['Bob', 'Carol']);
    expect(model.bounds.value).toEqual({ first: T, last: T + 2 * HOUR });
    expect(model.summary.value).toMatchObject({ packets: 2, sources: 2, spanMs: HOUR });

    // live: inside the range → appended in ts order; outside → only the bounds move
    await store.packets.append(rx(ack(), T + 90 * MIN));
    await store.packets.append(rx(ack(), T + 3 * HOUR));
    await model.settled();
    expect(model.points.value.map((p) => p.ts)).toEqual([T + HOUR, T + 90 * MIN, T + 2 * HOUR]);
    expect(model.bounds.value).toEqual({ first: T, last: T + 3 * HOUR });

    await model.setRange({ from: T + 2 * HOUR, to: null });
    expect(model.points.value.map((p) => p.ts)).toEqual([T + 2 * HOUR, T + 3 * HOUR]);
    await store.packets.append(rx(ack(), T + 4 * HOUR));
    await model.settled();
    expect(model.points.value.map((p) => p.ts)).toEqual([T + 2 * HOUR, T + 3 * HOUR, T + 4 * HOUR]);

    // clearing the log reloads
    await store.packets.clear();
    await model.settled();
    expect(model.points.value).toEqual([]);
    expect(model.bounds.value).toBeNull();
    // a range with an open end and no points: the window collapses to the fixed end
    expect(model.window.value).toEqual({ from: T + 2 * HOUR, to: T + 2 * HOUR });
    await model.setRange({ from: null, to: null });
    expect(model.window.value).toBeNull();
    expect(model.timeline.value.bins).toEqual([]);
  });

  it('summary, breakdowns and hop counts', async () => {
    const { model } = await harness([
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01, [0x7e]), T),
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01), T + 10_000),
      rx(await grpTxt(PSK, 'Carol', 'hi', [0x7e, 0x22]), T + 20_000),
      rx(ack(), T + 30_000),
      { direction: 'tx', bytes: new Uint8Array(0), format: 'none', source: 'sent', payloadType: PayloadType.GRP_TXT, routeType: RouteType.FLOOD, pathLen: 0, ts: T + 40_000 },
    ]);
    const pts = model.points.value;
    const air = pts.reduce((n, p) => n + (p.airtimeMs ?? 0), 0);
    const s = model.summary.value;
    expect(s).toMatchObject({ packets: 5, bytes: pts.reduce((n, p) => n + p.bytes, 0), sources: 3, spanMs: 40_000 });
    expect(s.airtimeMs).toBeCloseTo(air, 9);
    expect(s.airtimeFraction).toBeCloseTo(air / 40_000, 12);

    const u = model.utilization.value;
    expect(u.byType.map((b) => [b.name, b.count])).toEqual(expect.arrayContaining([['TXT_MSG', 2], ['GRP_TXT', 2], ['ACK', 1]]));
    expect(u.byType[0]!.airtimeMs).toBeGreaterThanOrEqual(u.byType[1]!.airtimeMs);
    expect(u.byDirection.map((b) => [b.name, b.count])).toEqual([['in', 4], ['out', 1]]);
    expect(u.byRoute.map((b) => b.name).sort()).toEqual(['FLOOD']);
    expect(u.byCategory.map((b) => [b.name, b.count]).sort()).toEqual([['ack', 1], ['channel', 2], ['dm', 2]]);
    // the requested (tx, 'none') GRP_TXT has no channel; the received one decrypted with the Test PSK
    expect(u.byChannel.map((b) => [b.name, b.count])).toEqual([['Test', 1]]);

    expect(model.hops.value).toEqual([
      { hops: 0, count: 3 },
      { hops: 1, count: 1 },
      { hops: 2, count: 1 },
    ]);

    const src = model.bySource.value;
    expect(src.unattributed).toBe(1);
    expect(src.top.map((x) => [x.node.label, x.count])).toEqual([['Alice', 2], ['Carol', 1], ['Me', 1]]);
    expect(src.others).toBe(0);
  });

  it('cuts the source list at the top 50', async () => {
    const inputs: PacketInput[] = [];
    // 55 unknown sources 0x10..0x46; source i sends (i < 5 ? 3 : 1) packets
    for (let i = 0; i < 55; i++) for (let k = 0; k < (i < 5 ? 3 : 1); k++) inputs.push(rx(datagram(PayloadType.TXT_MSG, 0x10 + i, 0x01), T + i * 1000 + k));
    inputs.push(rx(ack(), T + 100_000));
    const { model } = await harness(inputs, { contacts: [] });
    const src = model.bySource.value;
    expect(src.top).toHaveLength(50);
    expect(src.top.slice(0, 5).map((x) => x.count)).toEqual([3, 3, 3, 3, 3]);
    expect(src.others).toBe(5);
    expect(src.othersPackets).toBe(5);
    expect(src.unattributed).toBe(1);
    expect(model.summary.value.sources).toBe(55);
    expect(new Set(src.top.map((x) => nodeId(x.node))).size).toBe(50);
  });

  it('picks round bin sizes for 60–150 bins, and honours a manual bin', async () => {
    expect(autoBinMs(0)).toBe(MIN);
    expect(autoBinMs(HOUR)).toBe(MIN); // 61 bins
    expect(autoBinMs(3 * HOUR)).toBe(2 * MIN); // 91
    expect(autoBinMs(DAY)).toBe(10 * MIN); // 145
    expect(autoBinMs(7 * DAY)).toBe(2 * HOUR); // 85
    expect(autoBinMs(90 * DAY)).toBe(DAY);
    expect(autoBinMs(400 * DAY)).toBe(DAY);
    for (const span of [HOUR, 5 * HOUR, DAY, 3 * DAY, 30 * DAY]) {
      const n = Math.floor(span / autoBinMs(span)) + 1;
      expect(n).toBeGreaterThanOrEqual(60);
      expect(n).toBeLessThanOrEqual(150);
      expect(BIN_STEPS).toContain(autoBinMs(span));
    }

    const { model } = await harness([
      rx(advert(key32(0xa1), { nodeType: 1, name: 'Alice' }), T),
      rx(await grpTxt(PSK, 'Carol', 'hi'), T + 30 * MIN),
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01), T + 30 * MIN + 1),
      rx(ack(), T + 3 * HOUR),
      rx(grpUnknown(0x00), T + 3 * HOUR),
    ]);
    const tl = model.timeline.value;
    expect(tl.binMs).toBe(2 * MIN);
    expect(tl.series).toEqual(['Test', SERIES_DMS, SERIES_ADVERTS, SERIES_OTHER]);
    expect(tl.bins[0]!.t).toBe(Math.floor(T / (2 * MIN)) * 2 * MIN);
    const total = (k: string): number => tl.bins.reduce((n, b) => n + (b.series[k] ?? 0), 0);
    expect([total('Test'), total(SERIES_DMS), total(SERIES_ADVERTS), total(SERIES_OTHER)]).toEqual([1, 1, 1, 2]);
    expect(model.utilization.value.overTime).toHaveLength(tl.bins.length);
    const ot = model.utilization.value.overTime;
    expect(ot.reduce((n, o) => n + o.airtimeMs, 0)).toBeCloseTo(model.summary.value.airtimeMs!, 9);
    expect(ot[0]!.fraction).toBeCloseTo(ot[0]!.airtimeMs / (2 * MIN), 12);

    model.setBin(HOUR);
    expect(model.bin.value).toBe(HOUR);
    expect(model.timeline.value.binMs).toBe(HOUR);
    expect(model.timeline.value.bins).toHaveLength(4);
    expect(model.timeline.value.bins.map((b) => b.series['Test'])).toEqual([1, 0, 0, 0]);

    model.setBin('auto');
    expect(model.timeline.value.binMs).toBe(2 * MIN);
  });

  it('falls back to the automatic bin when a manual one gives too many bins', async () => {
    const { model } = await harness([rx(ack(), T), rx(ack(), T + 90 * DAY)]);
    model.setBin(MIN);
    expect(model.timeline.value.binMs).toBe(DAY);
  });
});

describe('PacketStatsModel — per contact (§5)', () => {
  it('splits packets from the contact by path, and counts packets it forwarded as via', async () => {
    const { model } = await harness([
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01), T, { snr: 10 }),
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01, [0x7e, 0x22]), T + 1000, { snr: 2 }),
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01, [0x7e, 0x22]), T + 2000, { snr: 4 }),
      rx(advert(key32(0xa1), { nodeType: 1, name: 'Alice' }, [0x7e, 0x22]), T + 3000, { snr: 6 }),
      // Bob's packet forwarded by Hilltop: via Hilltop, not from Alice
      rx(datagram(PayloadType.TXT_MSG, 0xb2, 0x01, [0x7e]), T + 4000),
      rx(advert(key32(0x7e), { nodeType: 2, name: 'Hilltop' }), T + 5000),
    ]);
    const p = model.points.value[1]!;
    expect(p.pathKey).toBe('7e>22');
    expect(p.path.map((n) => n.label)).toEqual(['Hilltop', 'Ridge']);
    expect(model.points.value[0]!).toMatchObject({ pathKey: '', path: [] });

    const alice = model.forContact(ALICE.key).value;
    expect(model.forContact(ALICE.key.toUpperCase())).toBe(model.forContact(ALICE.key));
    expect(alice.from.map((x) => x.ts)).toEqual([T, T + 1000, T + 2000, T + 3000]);
    expect(alice.via).toEqual([]);
    expect(alice.paths).toHaveLength(2);
    expect(alice.paths[0]).toMatchObject({ pathKey: '7e>22', count: 3, lastTs: T + 3000, meanSnr: 4, share: 0.75 });
    expect(alice.paths[0]!.hops.map((n) => n.label)).toEqual(['Hilltop', 'Ridge']);
    expect(alice.paths[1]).toMatchObject({ pathKey: '', hops: [], count: 1, lastTs: T, meanSnr: 10, share: 0.25 });
    expect(alice.signal.map((x) => [x.id, x.snr, x.pathKey])).toEqual(alice.from.map((x) => [x.id, x.snr, x.pathKey]));
    expect(alice.hops).toEqual([{ hops: 0, count: 1 }, { hops: 2, count: 3 }]);
    expect(alice.timeline.binMs).toBe(model.timeline.value.binMs);
    const total = (k: string): number => alice.timeline.bins.reduce((n, b) => n + (b.series[k] ?? 0), 0);
    expect([total(SERIES_DMS), total(SERIES_ADVERTS)]).toEqual([3, 1]);

    const hill = model.forContact(HILL.key).value;
    expect(hill.from.map((x) => x.ts)).toEqual([T + 5000]);
    expect(hill.via.map((x) => x.ts)).toEqual([T + 1000, T + 2000, T + 3000, T + 4000]);
    expect(hill.paths).toEqual([expect.objectContaining({ pathKey: '', count: 1, share: 1 })]);
  });
});

describe('PacketStatsModel — app wiring', () => {
  const apps: AppModel[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.dispose();
  });

  it('app.packetStats uses the packet log context (channel names) and stored contacts', async () => {
    const app = new AppModel({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, createEmulatorTransport: createEmulatorTransportFactory(), preferences: memoryPreferences() });
    apps.push(app);
    const stats = app.packetStats;
    expect(await app.connection.connect('emulator')).toBe(true);
    await app.connection.capture!.idle();
    await stats.settled();
    const store = app.connection.store.value!;
    const before = stats.points.value.length;
    await store.packets.append(rx(await grpTxt(publicChannelSecret(), 'Somebody', 'hello'), Date.now()));
    await stats.settled();
    const p = stats.points.value[stats.points.value.length - 1]!;
    expect(stats.points.value).toHaveLength(before + 1);
    expect(p.channel).toBe('Public');
    expect(p.source).toMatchObject({ label: 'Somebody', resolved: false });
    expect(stats.radio.value).not.toBeNull();
    expect(p.airtimeMs).toBeGreaterThan(0);
  });
});
