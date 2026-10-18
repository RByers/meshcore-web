import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { ContactType, TxtType } from '../protocol/constants.js';
import type { Command, SelfInfo } from '../protocol/types.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import { buildPacket } from '../packet/packet.js';
import {
  buildGroupDatagramPayload,
  buildGrpTxtPlaintext,
  buildPeerDatagramPayload,
  buildTracePayload,
  buildTxtMsgPlaintext,
  channelHash,
  encodeAdvertAppData,
} from '../packet/payloads.js';
import { publicChannelSecret } from '../emulator/scenarios.js';
import { packetInputFromCommand, type PacketInput } from '../store/packet-log.js';
import type { RadioStore } from '../store/radio-store.js';
import { DEFAULT_CONTACT_LOCAL, type ContactRecord } from '../store/schema.js';
import { hexKey, key32, makeContact, openStore } from '../store/test-helpers.js';
import { concatBytes, toHex, utf8Encode } from '../util/bytes.js';
import { smazEncodeIfSmaller } from '../util/smaz.js';
import { loraAirtimeMs } from './airtime.js';
import { AppModel, createEmulatorTransportFactory } from './app-model.js';
import { memoryPreferences, type ConnectionModel } from './connection.js';
import { haversineMeters } from './geo.js';
import {
  BIN_STEPS,
  PacketStatsModel,
  SERIES_ADVERTS,
  SERIES_DMS,
  SERIES_ACKS,
  SERIES_REQUESTS,
  SERIES_UNKNOWN_CHANNELS,
  SERIES_OTHER,
  SERIES_PATHS,
  SERIES_TRACES,
  SERIES_CONTROL,
  timelineSeriesDescription,
  autoBinMs,
  channelMessageCounts,
  matchesFilter,
  nodeEndpoint,
  nodeId,
  nodeStats,
  placeNodeCounts,
  filterKey,
  filterPoints,
  lastHopSignalStats,
  snrSummary,
  TOP_SOURCES,
  type NodeRef,
  MAP_PACKET_LIMIT,
  packetRoutes,
  recentPacketRoutes,
  statPacketRoute,
  type StatPacket,
  type StatsFilter,
} from './packet-stats-model.js';
import { PacketLogModel } from './packet-log-model.js';
import type { PathUsageMap, PathUsageStop } from './path-usage.js';
import type { DmKeys, SummaryContext } from './packet-summary.js';
import { signal, type ReadonlySignal } from './signal.js';

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
  /** The packet log owning the shared filter (wired as AppModel does). */
  log: PacketLogModel;
  context: ReturnType<typeof signal<SummaryContext>>;
  contacts: ReturnType<typeof signal<readonly ContactRecord[]>>;
  selfInfo: ReturnType<typeof signal<SelfInfo | null>>;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function harness(inputs: PacketInput[], opts: { contacts?: readonly ContactRecord[]; self?: SelfInfo | null; channels?: SummaryContext['channels']; dmKeys?: ReadonlySignal<DmKeys | null> } = {}): Promise<Harness> {
  const store = await openStore(0x01);
  if (inputs.length) await store.packets.appendMany(inputs);
  const storeSig = signal<RadioStore | null>(null);
  const selfInfo = signal<SelfInfo | null>(opts.self === undefined ? SELF : opts.self);
  const connection = { store: storeSig.readonly, selfInfo: selfInfo.readonly } as unknown as ConnectionModel;
  const channels = opts.channels ?? [{ name: 'Test', psk: PSK, hash: await channelHash(PSK) }];
  const context = signal<SummaryContext>({ nodes: [], channels });
  const contacts = signal<readonly ContactRecord[]>(opts.contacts ?? CONTACTS);
  const log = new PacketLogModel(connection).start();
  const model = new PacketStatsModel(connection, {
    filter: log.sharedFilter,
    context: context.readonly,
    contacts: contacts.readonly,
    ready: () => log.settled(),
    ...(opts.dmKeys ? { dmKeys: opts.dmKeys } : {}),
  }).start();
  log.attachStats(model);
  storeSig.value = store;
  await model.settled();
  cleanups.push(() => {
    model.dispose();
    log.dispose();
    store.close();
  });
  return { store, model, log, context, contacts, selfInfo };
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

  it('counts group messages per channel, by name or hash', async () => {
    const other = new Uint8Array(16).fill(9);
    const { model } = await harness([
      rx(await grpTxt(PSK, 'Carol', 'one'), T),
      rx(await grpTxt(PSK, 'Zed', 'two'), T + 1),
      { direction: 'tx', bytes: await grpTxt(PSK, 'Me', 'three'), ts: T + 2 },
      rx(await grpTxt(other, 'Bob', 'secret'), T + 3),
      // not group text, or no channel: left out
      rx(datagram(PayloadType.GRP_DATA, 0, await channelHash(PSK)), T + 4),
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01), T + 5),
      { direction: 'tx', bytes: new Uint8Array(0), format: 'none', source: 'sent', payloadType: PayloadType.GRP_TXT, routeType: RouteType.FLOOD, pathLen: 0, ts: T + 6 },
    ]);
    const pts = model.points.value;
    const unknown = `channel ${toHex(Uint8Array.of(await channelHash(other)))}`;
    expect(model.channelMessages.value).toEqual([
      { channel: 'Test', count: 3, sent: 1, bytes: byTs(pts, T).bytes + byTs(pts, T + 1).bytes + byTs(pts, T + 2).bytes },
      { channel: unknown, count: 1, sent: 0, bytes: byTs(pts, T + 3).bytes },
    ]);
    expect(channelMessageCounts([])).toEqual([]);

    // follows the drill-down filters
    await model.addFilter({ field: 'direction', value: 'out', label: 'Sent' });
    expect(model.channelMessages.value.map((c) => [c.channel, c.count, c.sent])).toEqual([['Test', 1, 1]]);
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
      rx(ack(), T + 3 * HOUR + 1),
      rx(datagram(PayloadType.REQ, 0xa1, 0x01), T + 3 * HOUR + 2),
      rx(datagram(PayloadType.RESPONSE, 0xa1, 0x01), T + 3 * HOUR + 3),
      rx(grpUnknown(0x00), T + 3 * HOUR),
    ]);
    const tl = model.timeline.value;
    expect(tl.binMs).toBe(2 * MIN);
    // Non-empty series by count desc (ties by name); no Other since every type has its own series.
    expect(tl.series).toEqual([SERIES_ACKS, SERIES_REQUESTS, SERIES_ADVERTS, SERIES_DMS, 'Test', SERIES_UNKNOWN_CHANNELS]);
    expect(tl.bins[0]!.t).toBe(Math.floor(T / (2 * MIN)) * 2 * MIN);
    const total = (k: string): number => tl.bins.reduce((n, b) => n + (b.series[k] ?? 0), 0);
    expect(tl.series.map(total)).toEqual([2, 2, 1, 1, 1, 1]);
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

describe('PacketStatsModel — drill-down filters (§6)', () => {
  async function filtered(): Promise<Harness> {
    return harness([
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01, [0x7e]), T),
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01), T + 10_000),
      rx(await grpTxt(PSK, 'Carol', 'hi', [0x7e, 0x22]), T + 20_000),
      rx(ack(), T + 30_000),
      { direction: 'tx', bytes: new Uint8Array(0), format: 'none', source: 'sent', payloadType: PayloadType.GRP_TXT, routeType: RouteType.FLOOD, pathLen: 0, ts: T + 40_000 },
    ]);
  }
  const f = (field: StatsFilter['field'], value: string): StatsFilter => ({ field, value, label: value });
  const tss = (pts: readonly StatPacket[]): number[] => pts.map((p) => p.ts - T);

  it('matchesFilter keys each field like the aggregations do', async () => {
    const { model } = await filtered();
    const pts = model.allPoints.value;
    const alice = byTs(pts, T);
    const chan = byTs(pts, T + 20_000);
    const ackP = byTs(pts, T + 30_000);
    expect(matchesFilter(alice, f('source', ALICE.key))).toBe(true);
    expect(matchesFilter(ackP, f('source', ''))).toBe(true);
    expect(matchesFilter(alice, f('source', ''))).toBe(false);
    expect(matchesFilter(alice, f('type', 'TXT_MSG'))).toBe(true);
    expect(matchesFilter(alice, f('route', 'FLOOD'))).toBe(true);
    expect(matchesFilter(alice, f('direction', 'in'))).toBe(true);
    expect(matchesFilter(alice, f('category', 'dm'))).toBe(true);
    expect(matchesFilter(chan, f('channel', 'Test'))).toBe(true);
    expect(matchesFilter(alice, f('channel', 'Test'))).toBe(false);
    expect(matchesFilter(alice, f('hops', '1'))).toBe(true);
    expect(matchesFilter(chan, f('hops', '1'))).toBe(false);
  });

  it('narrows every aggregation, keeps the window, and leaves forContact alone', async () => {
    const { model } = await filtered();
    const window = model.window.value;
    const binMs = model.timeline.value.binMs;
    const aliceBefore = model.forContact(ALICE.key).value;

    await model.addFilter({ field: 'source', value: ALICE.key, label: 'Alice' });
    expect(model.filters.value).toEqual([{ field: 'source', value: ALICE.key, label: 'Alice' }]);
    expect(tss(model.points.value)).toEqual([0, 10_000]);
    expect(model.unfilteredCount.value).toBe(5);
    const air = model.points.value.reduce((n, p) => n + (p.airtimeMs ?? 0), 0);
    expect(model.summary.value).toMatchObject({ packets: 2, sources: 1, spanMs: 40_000 });
    expect(model.summary.value.airtimeMs).toBeCloseTo(air, 9);
    expect(model.bySource.value.top.map((x) => [x.node.label, x.count])).toEqual([['Alice', 2]]);
    expect(model.bySource.value.unattributed).toBe(0);
    expect(model.hops.value).toEqual([{ hops: 0, count: 1 }, { hops: 1, count: 1 }]);
    expect(model.utilization.value.byType.map((b) => [b.name, b.count])).toEqual([['TXT_MSG', 2]]);
    expect(model.utilization.value.overTime.reduce((n, o) => n + o.airtimeMs, 0)).toBeCloseTo(air, 9);
    const total = (k: string): number => model.timeline.value.bins.reduce((n, b) => n + (b.series[k] ?? 0), 0);
    expect(total(SERIES_DMS)).toBe(2);
    expect(total('Test')).toBe(0);
    // axes don't move
    expect(model.window.value).toEqual(window);
    expect(model.timeline.value.binMs).toBe(binMs);
    // the contact page ignores the packets page's filters
    await model.addFilter(f('type', 'ACK'));
    expect(model.points.value).toEqual([]);
    expect(model.forContact(ALICE.key).value.from).toEqual(aliceBefore.from);
    expect(model.forContact(ALICE.key).value.from).toHaveLength(2);
  });

  it('filters by channel, direction, category and hops; unknown hops never match', async () => {
    const { model } = await filtered();
    await model.addFilter(f('channel', 'Test'));
    expect(tss(model.points.value)).toEqual([20_000]);
    expect(model.utilization.value.byChannel.map((b) => [b.name, b.count])).toEqual([['Test', 1]]);
    await model.clearFilters();
    await model.addFilter(f('direction', 'out'));
    expect(tss(model.points.value)).toEqual([40_000]);
    expect(model.bySource.value.top.map((x) => x.node.label)).toEqual(['Me']);
    await model.clearFilters();
    await model.addFilter(f('category', 'channel'));
    expect(tss(model.points.value)).toEqual([20_000, 40_000]);
    await model.clearFilters();
    await model.addFilter(f('hops', '2'));
    expect(tss(model.points.value)).toEqual([20_000]);
    expect(model.hops.value).toEqual([{ hops: 2, count: 1 }]);
  });

  it('ANDs fields, replaces a field, removes and clears; survives range changes', async () => {
    const { model } = await filtered();
    await model.addFilter(f('route', 'FLOOD'));
    await model.addFilter(f('hops', '0'));
    expect(tss(model.points.value)).toEqual([10_000, 30_000, 40_000]);
    await model.addFilter(f('type', 'TXT_MSG'));
    expect(tss(model.points.value)).toEqual([10_000]);
    // same field: replaces (direction, type and route come first: native packet log fields)
    await model.addFilter(f('type', 'ACK'));
    expect(model.filters.value.map((x) => [x.field, x.value])).toEqual([['type', 'ACK'], ['route', 'FLOOD'], ['hops', '0']]);
    expect(tss(model.points.value)).toEqual([30_000]);
    await model.removeFilter('type');
    expect(model.filters.value.map((x) => x.field)).toEqual(['route', 'hops']);
    expect(tss(model.points.value)).toEqual([10_000, 30_000, 40_000]);
    await model.removeFilter('channel'); // absent: no-op
    expect(model.filters.value).toHaveLength(2);

    await model.setRange({ from: T + 20_000, to: null });
    expect(model.filters.value).toHaveLength(2);
    expect(tss(model.points.value)).toEqual([30_000, 40_000]);
    expect(model.unfilteredCount.value).toBe(3);

    await model.clearFilters();
    expect(model.filters.value).toEqual([]);
    expect(model.points.value).toEqual(model.allPoints.value);
  });
});

describe('PacketStatsModel — filter shared with the packet log', () => {
  async function shared(): Promise<Harness> {
    return harness([
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01, [0x7e]), T),
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01), T + 10_000),
      rx(await grpTxt(PSK, 'Carol', 'hi', [0x7e, 0x22]), T + 20_000),
      rx(ack(), T + 30_000),
      { direction: 'tx', bytes: new Uint8Array(0), format: 'none', source: 'sent', payloadType: PayloadType.GRP_TXT, routeType: RouteType.FLOOD, pathLen: 0, ts: T + 40_000 },
    ]);
  }
  const tss = (pts: readonly StatPacket[]): number[] => pts.map((p) => p.ts - T);
  const rowTs = (h: Harness): number[] => h.log.packets.rows.value.map((r) => r.record.ts - T);

  it('drill-downs land in the log filter: direction / type / route natively, the rest in drill', async () => {
    const { model, log } = await shared();
    await model.addFilter({ field: 'direction', value: 'in', label: 'Received' });
    await model.addFilter({ field: 'type', value: 'TXT_MSG', label: 'TXT_MSG' });
    await model.addFilter({ field: 'route', value: 'FLOOD', label: 'FLOOD' });
    await model.addFilter({ field: 'source', value: ALICE.key, label: 'Alice' });
    expect(log.packets.filter.value).toEqual({
      direction: 'rx',
      payloadTypes: [PayloadType.TXT_MSG],
      routeTypes: [RouteType.FLOOD],
      drill: [{ field: 'source', value: ALICE.key, label: 'Alice' }],
    });
    expect(model.filters.value.map((x) => [x.field, x.value, x.label])).toEqual([
      ['direction', 'in', 'Received'],
      ['type', 'TXT_MSG', 'TXT_MSG'],
      ['route', 'FLOOD', 'FLOOD'],
      ['source', ALICE.key, 'Alice'],
    ]);
    expect(tss(model.points.value)).toEqual([0, 10_000]);
    expect(rowTs({ model, log } as Harness)).toEqual([10_000, 0]);

    // 'out' ⇄ 'tx'; a type with no number ('UNKNOWN') stays a drill entry and drops the native one
    await model.addFilter({ field: 'direction', value: 'out', label: 'Sent' });
    expect(log.packets.filter.value.direction).toBe('tx');
    await model.addFilter({ field: 'type', value: 'UNKNOWN', label: 'UNKNOWN' });
    expect(log.packets.filter.value.payloadTypes).toBeUndefined();
    expect(log.packets.filter.value.drill?.map((d) => d.field)).toEqual(['source', 'type']);
    expect(model.filters.value.map((x) => x.field)).toEqual(['direction', 'route', 'source', 'type']);
    // and a numbered type replaces it again
    await model.addFilter({ field: 'type', value: 'ACK', label: 'ACK' });
    expect(log.packets.filter.value.payloadTypes).toEqual([PayloadType.ACK]);
    expect(log.packets.filter.value.drill?.map((d) => d.field)).toEqual(['source']);

    await model.removeFilter('source');
    expect('drill' in log.packets.filter.value).toBe(false);
    await model.removeFilter('direction');
    expect(log.packets.filter.value).toEqual({ payloadTypes: [PayloadType.ACK], routeTypes: [RouteType.FLOOD] });
  });

  it('the log lists the drilled-down packets, waits for the stats load, and live-tails them once', async () => {
    const h = await shared();
    const { store, model, log } = h;
    await model.addFilter({ field: 'hops', value: '1', label: '1 hop' });
    expect(rowTs(h)).toEqual([0]);
    expect(log.packets.matching.value).toBe(1);
    // a range change reloads both; the log's query waits for the stats points of the new range
    await model.setRange({ from: T + 5_000, to: null });
    expect(rowTs(h)).toEqual([]);
    await model.setRange({ from: null, to: null });
    expect(rowTs(h)).toEqual([0]);
    await log.packets.reload();
    expect(rowTs(h)).toEqual([0]);

    // live, while the drill-down is active: shown once its point is derived; non-matching ones only counted
    const total = log.packets.total.value;
    const { id } = await store.packets.append(rx(datagram(PayloadType.TXT_MSG, 0xb2, 0x01, [0x22]), T + 50_000));
    await store.packets.append(rx(ack(), T + 60_000));
    await model.settled();
    await log.settled();
    expect(log.packets.rows.value.filter((r) => r.id === id)).toHaveLength(1);
    expect(rowTs(h)).toEqual([50_000, 0]);
    expect(log.packets.matching.value).toBe(2);
    expect(log.packets.total.value).toBe(total + 2);
    expect(tss(model.points.value)).toEqual([0, 50_000]);

    await model.clearFilters();
    expect(log.packets.rows.value).toHaveLength(7);
  });

  it('a log text / node / types filter narrows the stats points', async () => {
    const { model, log } = await shared();
    await log.packets.setFilter({ node: '7e' });
    expect(tss(model.points.value)).toEqual([0, 20_000]);
    expect(model.unfilteredCount.value).toBe(5);
    // several types (List tab only): no single-type drill-down to show
    await log.packets.setFilter({ node: undefined, payloadTypes: [PayloadType.TXT_MSG, PayloadType.ACK] });
    expect(tss(model.points.value)).toEqual([0, 10_000, 30_000]);
    expect(model.filters.value).toEqual([]);
    await log.packets.setFilter({ payloadTypes: undefined, text: 'grp_txt' });
    expect(tss(model.points.value)).toEqual([20_000, 40_000]);
    expect(model.summary.value.packets).toBe(2);
  });

  it('the stats range is the log filter from / to, both ways; clearFilters keeps it', async () => {
    const { model, log } = await shared();
    await model.setRange({ from: T + 10_000, to: T + 30_000 });
    expect(log.packets.filter.value).toEqual({ from: T + 10_000, to: T + 30_000 });
    expect(log.packets.rows.value).toHaveLength(3);
    await model.setRange({ from: null, to: T + 30_000 });
    expect(log.packets.filter.value).toEqual({ to: T + 30_000 });

    // the log's date inputs move the stats range (and reload it)
    await log.packets.setFilter({ from: T + 20_000, to: undefined });
    await model.settled();
    expect(model.range.value).toEqual({ from: T + 20_000, to: null });
    expect(tss(model.allPoints.value)).toEqual([20_000, 30_000, 40_000]);

    await log.packets.setFilter({ text: 'ack', direction: 'rx' });
    await model.addFilter({ field: 'hops', value: '0', label: '0' });
    await model.clearFilters();
    expect(log.packets.filter.value).toEqual({ from: T + 20_000 });
    expect(model.range.value).toEqual({ from: T + 20_000, to: null });
    expect(model.points.value).toEqual(model.allPoints.value);
  });
});

describe('PacketStatsModel — SMAZ compression (§1.2, §1.6)', () => {
  const SECRET = new Uint8Array(32).fill(5);
  const DM_KEYS: DmKeys = { selfPublicKey: SELF.pubKey, contacts: [ALICE.pubKey, BOB.pubKey], sharedSecret: () => Promise.resolve(SECRET) };
  const CH_TEXT = 'this is the message that should compress well';
  const DM_TEXT = 'there is another message in the mail for you';
  const OUT_TEXT = 'the one that I send';
  const LONG_TEXT = 'this is a rather long message that I send to the channel, and it is long enough that the logged copy of the envelope is cut';
  const utf8 = (s: string): number => utf8Encode(s).length;
  const env = (s: string): string => {
    const e = smazEncodeIfSmaller(s);
    expect(e.startsWith('s:')).toBe(true);
    return e;
  };
  async function dm(src: number, dest: number, text: string, txtType: number = TxtType.PLAIN): Promise<Uint8Array> {
    const payload = await buildPeerDatagramPayload({ destHash: dest, srcHash: src, secret: SECRET, plaintext: buildTxtMsgPlaintext({ timestamp: 1, text, txtType }) });
    return buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.TXT_MSG, payload });
  }
  function sent(cmd: Command, ts: number): PacketInput {
    const p = packetInputFromCommand(cmd, { ts });
    if (!p) throw new Error('not a transmission');
    return p;
  }

  async function compressed(dmKeys: ReadonlySignal<DmKeys | null> = signal<DmKeys | null>(DM_KEYS).readonly): Promise<Harness> {
    expect(env(OUT_TEXT).length).toBeLessThan(60); // logged in full
    expect(env(LONG_TEXT).length).toBeGreaterThan(60); // logged cut
    return harness(
      [
        rx(await grpTxt(PSK, 'Alice', env(CH_TEXT)), T),
        rx(await grpTxt(PSK, 'Bob', 'hi'), T + 1),
        rx(grpUnknown(0x99), T + 2),
        rx(await dm(0xa1, 0x01, env(DM_TEXT)), T + 3),
        rx(await dm(0xb2, 0x01, 'clock', TxtType.CLI_DATA), T + 4),
        sent({ kind: 'sendTxtMsg', recipient: ALICE.pubKey, text: env(OUT_TEXT), timestamp: 1 }, T + 5),
        sent({ kind: 'sendChannelTxtMsg', channelIdx: 0, text: env(LONG_TEXT), timestamp: 1 }, T + 6),
        rx(ack(), T + 7),
        rx(datagram(PayloadType.TXT_MSG, 0xb2, 0x01), T + 8), // MAC fails: not decrypted
        rx(advert(ALICE.pubKey, { nodeType: ContactType.CHAT, name: 'Alice' }), T + 9),
        sent({ kind: 'sendTxtMsg', recipient: BOB.pubKey, text: 'get clock', timestamp: 1, txtType: TxtType.CLI_DATA }, T + 10),
      ],
      { dmKeys },
    );
  }

  it('classifies text messages, with sizes, and never non-text packets', async () => {
    const { model } = await compressed();
    const at = (dt: number): Pick<StatPacket, 'compression' | 'textBytes'> => {
      const p = byTs(model.allPoints.value, T + dt);
      return { compression: p.compression, textBytes: p.textBytes };
    };
    expect(at(0)).toEqual({ compression: 'smaz', textBytes: { plain: utf8(CH_TEXT), sent: utf8(env(CH_TEXT)) } });
    expect(at(1)).toEqual({ compression: 'plain', textBytes: { plain: 2, sent: 2 } });
    expect(at(2)).toEqual({ compression: 'unknown', textBytes: null });
    expect(at(3)).toEqual({ compression: 'smaz', textBytes: { plain: utf8(DM_TEXT), sent: utf8(env(DM_TEXT)) } });
    expect(at(4)).toEqual({ compression: null, textBytes: null }); // CLI data is not text
    expect(at(5)).toEqual({ compression: 'smaz', textBytes: { plain: utf8(OUT_TEXT), sent: utf8(env(OUT_TEXT)) } });
    expect(at(6)).toEqual({ compression: 'smaz', textBytes: null }); // logged copy cut: no sizes
    expect(at(7)).toEqual({ compression: null, textBytes: null });
    expect(at(8)).toEqual({ compression: 'unknown', textBytes: null });
    expect(at(9)).toEqual({ compression: null, textBytes: null });
    expect(at(10)).toEqual({ compression: null, textBytes: null });
  });

  it('aggregates counts, bytes saved and compressed sources over the filtered points', async () => {
    const { model } = await compressed();
    const plain = utf8(CH_TEXT) + utf8(DM_TEXT) + utf8(OUT_TEXT);
    const sentB = utf8(env(CH_TEXT)) + utf8(env(DM_TEXT)) + utf8(env(OUT_TEXT));
    expect(model.compression.value).toEqual({
      text: 7,
      smaz: 4,
      plain: 1,
      unknown: 2,
      compressedShare: 4 / 5,
      smazPlainBytes: plain,
      smazSentBytes: sentB,
      bytesSaved: plain - sentB,
      savingsRatio: (plain - sentB) / plain,
      byCategory: { dm: { text: 3, smaz: 2, plain: 0, unknown: 1 }, channel: { text: 4, smaz: 2, plain: 1, unknown: 1 } },
      byDirection: { in: { text: 5, smaz: 2, plain: 1, unknown: 2 }, out: { text: 2, smaz: 2, plain: 0, unknown: 0 } },
      compressedSources: 2, // Alice (channel + DM) and this radio
    });
    await model.addFilter({ field: 'direction', value: 'in', label: 'in' });
    expect(model.compression.value).toMatchObject({ text: 5, smaz: 2, compressedSources: 1 });
    await model.addFilter({ field: 'category', value: 'advert', label: 'advert' });
    expect(model.compression.value).toMatchObject({ text: 0, compressedShare: null, savingsRatio: null, bytesSaved: 0, compressedSources: 0 });
  });

  it('drills down by compression; non-text packets never match', async () => {
    const { model } = await compressed();
    const tss = (): number[] => model.points.value.map((p) => p.ts - T);
    await model.addFilter({ field: 'compression', value: 'smaz', label: 'Compressed' });
    expect(tss()).toEqual([0, 3, 5, 6]);
    await model.addFilter({ field: 'compression', value: 'unknown', label: 'Not decrypted' });
    expect(tss()).toEqual([2, 8]);
    await model.addFilter({ field: 'compression', value: 'plain', label: 'Plain' });
    expect(tss()).toEqual([1]);
    expect(matchesFilter(byTs(model.allPoints.value, T + 7), { field: 'compression', value: '', label: '' })).toBe(false);
  });

  it('DMs are not decrypted without the DM keys, and are re-derived when the keys arrive', async () => {
    const keys = signal<DmKeys | null>(null);
    const { model } = await compressed(keys.readonly);
    expect(byTs(model.allPoints.value, T + 3).compression).toBe('unknown');
    expect(byTs(model.allPoints.value, T + 4).compression).toBe('unknown');
    keys.value = DM_KEYS;
    await model.settled();
    expect(byTs(model.allPoints.value, T + 3).compression).toBe('smaz');
    expect(byTs(model.allPoints.value, T + 4).compression).toBeNull();
    expect(byTs(model.allPoints.value, T).compression).toBe('smaz');
  });
});

describe('PacketStatsModel — paths map routes (§1.7)', () => {
  const SELF_EP = { kind: 'self' } as const;
  const ORIGIN = { kind: 'unknown', label: 'Origin' } as const;

  it('derives a route per packet from its route type, path and ends', async () => {
    const { model } = await harness([
      rx(advert(key32(0xa1), { nodeType: 1, name: 'Alice' }, [0x7e]), T + 1), // flood: Alice → Hilltop → me
      rx(ack([0x7e, 0x22]), T + 2), // unattributed flood with hops: unknown origin
      rx(grpUnknown(0x00), T + 3), // unattributed, heard directly: nothing to draw
      rx(datagram(PayloadType.PATH, 0xa1, 0x01, [], RouteType.DIRECT), T + 4), // direct, delivered to us
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x22, [0x7e], RouteType.DIRECT), T + 5), // direct, still to travel
      rx(buildTracePayload({ tag: 1, authCode: 2, hashes: Uint8Array.of(0x7e) }), T + 6, { format: 'payload', source: 'traceData', payloadType: PayloadType.TRACE, routeType: RouteType.DIRECT, pathLen: 1 }),
      { direction: 'tx', bytes: datagram(PayloadType.TXT_MSG, 0x01, 0xd4, [0x7e, 0x22], RouteType.DIRECT), ts: T + 7 }, // tx direct
      { direction: 'tx', bytes: datagram(PayloadType.TXT_MSG, 0x01, 0xd4), ts: T + 8 }, // tx flood: no path yet
      rx(await grpTxt(PSK, 'Zed', 'yo'), T + 9), // channel sender known only by name, heard directly
      rx(datagram(PayloadType.REQ, 0x99, 0x01), T + 10), // unknown src hash
    ]);
    const pts = model.points.value;
    const route = (ts: number) => statPacketRoute(byTs(pts, ts));

    expect(byTs(pts, T + 1).destHash).toBeNull();
    expect(route(T + 1)).toEqual({ hashes: ['7e'], from: { kind: 'contact', key: ALICE.key }, to: SELF_EP });
    expect(route(T + 2)).toEqual({ hashes: ['7e', '22'], from: ORIGIN, to: SELF_EP });
    expect(route(T + 3)).toBeNull();
    expect(byTs(pts, T + 4).destHash).toBe('01');
    expect(route(T + 4)).toBeNull();
    expect(byTs(pts, T + 5).destHash).toBe('22');
    expect(route(T + 5)).toEqual({ hashes: ['7e'], from: ORIGIN, to: { kind: 'hash', hash: '22' } });
    expect(route(T + 6)).toBeNull();
    expect(route(T + 7)).toEqual({ hashes: ['7e', '22'], from: SELF_EP, to: { kind: 'hash', hash: 'd4' } });
    expect(route(T + 8)).toBeNull();
    expect(route(T + 9)).toEqual({ hashes: [], from: { kind: 'name', name: 'Zed' }, to: SELF_EP });
    expect(route(T + 10)).toEqual({ hashes: [], from: { kind: 'hash', hash: '99' }, to: SELF_EP });
  });

  it('nodeEndpoint maps each kind of node reference', () => {
    expect(nodeEndpoint(null)).toEqual(ORIGIN);
    expect(nodeEndpoint({ hash: '01', key: hexKey(0x01), label: 'Me', resolved: true, self: true })).toEqual(SELF_EP);
    expect(nodeEndpoint({ hash: 'a1', key: ALICE.key, label: 'Alice', resolved: true })).toEqual({ kind: 'contact', key: ALICE.key });
    expect(nodeEndpoint({ hash: 'c3', label: 'c3?', resolved: false })).toEqual({ kind: 'hash', hash: 'c3' });
    expect(nodeEndpoint({ hash: '', label: 'Zed', resolved: false })).toEqual({ kind: 'name', name: 'Zed' });
  });

  it('statPacketRoute: unknown route types count as floods only with hops', () => {
    const base = { direction: 'in', payloadType: PayloadType.TXT_MSG, routeType: -1, hops: 0, pathKey: '', source: null, destHash: null } as const;
    expect(statPacketRoute(base)).toBeNull();
    expect(statPacketRoute({ ...base, hops: 1, pathKey: '7e' })).toEqual({ hashes: ['7e'], from: ORIGIN, to: SELF_EP });
    expect(statPacketRoute({ ...base, routeType: RouteType.FLOOD, hops: null })).toBeNull();
    // a sent direct packet with neither hops nor a destination says nothing
    expect(statPacketRoute({ ...base, direction: 'out', routeType: RouteType.DIRECT })).toBeNull();
  });

  it('packetRoutes groups identical routes, busiest first; model.routes follows the filters', async () => {
    const { model } = await harness([
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01, [0x7e]), T),
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01, [0x7e]), T + 1),
      rx(datagram(PayloadType.REQ, 0xa1, 0x01, [0x7e]), T + 2),
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01, [0x22, 0x7e]), T + 3),
      rx(datagram(PayloadType.TXT_MSG, 0xd4, 0x01, [0x7e]), T + 4),
      rx(buildTracePayload({ tag: 1, authCode: 2, hashes: Uint8Array.of(0x7e) }), T + 5, { format: 'payload', source: 'traceData', payloadType: PayloadType.TRACE, routeType: RouteType.DIRECT, pathLen: 1 }),
    ]);
    const alice = { kind: 'contact', key: ALICE.key } as const;
    const carol = { kind: 'contact', key: CAROL.key } as const;
    expect(packetRoutes(model.points.value)).toEqual([
      { hashes: ['7e'], from: alice, to: SELF_EP, count: 3 },
      { hashes: ['22', '7e'], from: alice, to: SELF_EP, count: 1 },
      { hashes: ['7e'], from: carol, to: SELF_EP, count: 1 },
    ]);
    expect(model.routes.value).toEqual(packetRoutes(model.points.value));
    model.addFilter({ field: 'category', value: 'dm', label: 'dm' });
    expect(model.routes.value).toEqual([
      { hashes: ['7e'], from: alice, to: SELF_EP, count: 2 },
      { hashes: ['22', '7e'], from: alice, to: SELF_EP, count: 1 },
      { hashes: ['7e'], from: carol, to: SELF_EP, count: 1 },
    ]);
  });
});

describe('PacketStatsModel — Packets list map (recentRoutes)', () => {
  it('maps only the newest MAP_PACKET_LIMIT packets of points, counting those with a route', async () => {
    const SELF_EP = { kind: 'self' } as const;
    const inputs: PacketInput[] = [
      // the 3 oldest (from Carol) fall outside the newest 500
      ...[0, 1, 2].map((i) => rx(datagram(PayloadType.TXT_MSG, 0xd4, 0x01, [0x7e]), T + i)),
      ...Array.from({ length: MAP_PACKET_LIMIT - 1 }, (_, i) => rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01, [0x7e]), T + 3 + i)),
      // the newest packet has no route
      rx(buildTracePayload({ tag: 1, authCode: 2, hashes: Uint8Array.of(0x7e) }), T + 3 + MAP_PACKET_LIMIT, { format: 'payload', source: 'traceData', payloadType: PayloadType.TRACE, routeType: RouteType.DIRECT, pathLen: 1 }),
    ];
    const { model } = await harness(inputs);
    expect(model.points.value).toHaveLength(MAP_PACKET_LIMIT + 3);
    expect(model.recentRoutes.value).toEqual({
      routes: [{ hashes: ['7e'], from: { kind: 'contact', key: ALICE.key }, to: SELF_EP, count: MAP_PACKET_LIMIT - 1 }],
      packets: MAP_PACKET_LIMIT,
      mapped: MAP_PACKET_LIMIT - 1,
    });
    expect(recentPacketRoutes(model.points.value, 2)).toEqual({
      routes: [{ hashes: ['7e'], from: { kind: 'contact', key: ALICE.key }, to: SELF_EP, count: 1 }],
      packets: 2,
      mapped: 1,
    });
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

describe('timelineSeriesDescription', () => {
  it('names the payload types each series counts', () => {
    const fixed: [string, string[]][] = [
      [SERIES_DMS, ['TXT_MSG']],
      [SERIES_ADVERTS, ['ADVERT']],
      [SERIES_ACKS, ['ACK']],
      [SERIES_PATHS, ['PATH']],
      [SERIES_TRACES, ['TRACE']],
      [SERIES_REQUESTS, ['REQ', 'RESPONSE', 'ANON_REQ']],
      [SERIES_CONTROL, ['CONTROL']],
      [SERIES_UNKNOWN_CHANNELS, ['GRP_TXT', 'GRP_DATA']],
      [SERIES_OTHER, ['MULTIPART', 'RAW_CUSTOM']],
    ];
    for (const [key, types] of fixed) for (const t of types) expect(timelineSeriesDescription(key), key).toContain(t);
    expect(timelineSeriesDescription('Public')).toBe('GRP_TXT and GRP_DATA: channel messages and data on Public.');
  });
});

describe('path start / end nodes', () => {
  const node = (hash: string, key?: string): NodeRef => ({ hash, label: key ? `N${hash}` : hash, resolved: !!key, ...(key ? { key } : {}) });
  const hill = node('aa', 'aa'.repeat(32));
  const relay = node('55');
  const base: StatPacket = {
    id: 0,
    ts: 0,
    direction: 'in',
    bytes: 10,
    payloadType: PayloadType.ADVERT,
    typeName: 'ADVERT',
    routeType: RouteType.FLOOD,
    routeName: 'FLOOD',
    hops: 0,
    snr: null,
    rssi: null,
    category: 'advert',
    channel: null,
    source: null,
    lastHop: null,
    direct: true,
    path: [],
    pathKey: '',
    destHash: null,
    distanceM: null,
    airtimeMs: null,
    compression: null,
    textBytes: null,
  };
  const pts: StatPacket[] = [base, { ...base, id: 1, path: [hill] }, { ...base, id: 2, path: [hill] }, { ...base, id: 3, path: [relay, hill], bytes: 20 }];

  it('counts packets per first and last path entry; packets without a path are unattributed', () => {
    const first = nodeStats(pts, (p) => p.path[0]);
    expect(first.top.map((s) => [s.node.label, s.count])).toEqual([
      ['Naa', 2],
      ['55', 1],
    ]);
    expect(first.unattributed).toBe(1);
    const last = nodeStats(pts, (p) => p.path[p.path.length - 1]);
    expect(last.top.map((s) => [s.node.label, s.count, s.bytes])).toEqual([['Naa', 3, 40]]);
    expect(last.unattributed).toBe(1);
  });

  it('filters by the first / last path entry', () => {
    expect(pts.map((p) => filterKey(p, 'pathStart'))).toEqual([null, hill.key, hill.key, '#55']);
    expect(pts.map((p) => filterKey(p, 'pathEnd'))).toEqual([null, hill.key, hill.key, hill.key]);
    expect(filterPoints(pts, [{ field: 'pathStart', value: '#55', label: '55' }]).map((p) => p.id)).toEqual([3]);
  });

  it('places counted nodes where the paths map put them: by key, else the busiest stop of the hash', () => {
    const stop = (id: string, lat: number, count: number, extra: Partial<PathUsageStop> = {}): PathUsageStop => ({ id, role: 'hop', label: id, lat, lon: 0, approximate: false, count, ...extra });
    const usage: PathUsageMap = {
      stops: [
        stop('hill', 1, 4, { node: { key: hill.key!, name: 'Hill', kind: 'repeater', lat: 1, lon: 0 }, hash: 'aa' }),
        stop('55@a', 2, 1, { hash: '55', approximate: true }),
        stop('55@b', 3, 2, { hash: '55', approximate: true }),
      ],
      edges: [],
      maxCount: 0,
      total: 4,
      incomplete: 0,
      bounds: null,
    };
    const lost = node('77');
    const placed = placeNodeCounts(nodeStats([...pts, { ...base, id: 4, path: [lost] }], (p) => p.path[0]), usage);
    expect(placed.markers.map((m) => [m.id, m.lat, m.count, m.kind, m.approximate])).toEqual([
      [hill.key, 1, 2, 'repeater', false],
      ['#55', 3, 1, undefined, true],
    ]);
    expect(placed.maxCount).toBe(2);
    expect([placed.unplaced, placed.unplacedPackets]).toEqual([1, 1]);
    expect(placed.bounds).toEqual({ south: 1, west: 0, north: 3, east: 0 });
  });
});

describe('PacketStatsModel — signal by last hop (§1.6, §5)', () => {
  function noSignal(bytes: Uint8Array, ts: number): PacketInput {
    return { direction: 'rx', bytes, ts, source: 'logRxData' };
  }
  async function lastHopHarness(): Promise<Harness> {
    return harness([
      // Hilltop heard zero-hop (its own advert), then relaying twice (once without SNR / RSSI)
      rx(advert(key32(0x7e), { nodeType: 2, name: 'Hilltop' }), T, { snr: 10, rssi: -80 }),
      rx(datagram(PayloadType.TXT_MSG, 0xb2, 0x01, [0x7e]), T + 1000, { snr: 4, rssi: -100 }),
      noSignal(ack([0x22, 0x7e]), T + 2000),
      // ambiguous c3: heard zero-hop as the source, and as the last forwarder → one 'c3?' row
      rx(datagram(PayloadType.TXT_MSG, 0xc3, 0x01), T + 3000, { snr: -2 }),
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01, [0xc3]), T + 4000, { snr: -6 }),
      // no last hop: unattributed zero-hop ACK, TRACE, DIRECT routes (forwarders remove themselves)
      rx(ack(), T + 5000),
      rx(buildTracePayload({ tag: 1, authCode: 2, hashes: Uint8Array.of(0x7e) }), T + 6000, { format: 'payload', source: 'traceData', payloadType: PayloadType.TRACE, routeType: RouteType.DIRECT, pathLen: 1 }),
      rx(datagram(PayloadType.TXT_MSG, 0xa1, 0x01, [0x7e], RouteType.DIRECT), T + 7000),
      rx(datagram(PayloadType.PATH, 0x7e, 0x01, [], RouteType.DIRECT), T + 7500),
      // sent (zero-hop flood → last hop = this radio): not counted
      { direction: 'tx', bytes: await grpTxt(PSK, 'Me', 'out'), ts: T + 8000 },
    ]);
  }

  it('summarises SNR / RSSI per last hop of the received packets', async () => {
    const { model } = await lastHopHarness();
    const pts = model.points.value;
    expect(byTs(pts, T + 7000)).toMatchObject({ lastHop: null, direct: false });
    expect(byTs(pts, T + 7500)).toMatchObject({ lastHop: null, direct: false });
    expect(byTs(pts, T + 7500).source?.label).toBe('Hilltop');
    expect(byTs(pts, T + 8000).lastHop?.self).toBe(true);

    const s = model.lastHops.value;
    expect(s.top.map((r) => r.node.label)).toEqual(['Hilltop', 'c3?']);
    expect(s.top[0]).toEqual({
      node: expect.objectContaining({ key: HILL.key, label: 'Hilltop', resolved: true }),
      count: 3,
      snrCount: 2,
      meanSnr: 7,
      minSnr: 4,
      maxSnr: 10,
      meanRssi: -90,
      lastTs: T + 2000,
      direct: 1,
      relayed: 2,
    });
    expect(s.top[1]).toMatchObject({ node: { hash: 'c3', label: 'c3?', resolved: false }, count: 2, snrCount: 2, meanSnr: -4, minSnr: -6, maxSnr: -2, direct: 1, relayed: 1, lastTs: T + 4000 });
    expect(s).toMatchObject({ unattributed: 4, others: 0, othersPackets: 0 });
  });

  it('drills down by last hop (received packets only)', async () => {
    const { model } = await lastHopHarness();
    const pts = model.allPoints.value;
    expect(filterKey(byTs(pts, T + 8000), 'lastHop')).toBeNull();
    expect(filterKey(byTs(pts, T + 3000), 'lastHop')).toBe('#c3');
    await model.addFilter({ field: 'lastHop', value: HILL.key, label: 'Hilltop' });
    expect(model.filters.value).toEqual([{ field: 'lastHop', value: HILL.key, label: 'Hilltop' }]);
    expect(model.points.value.map((p) => p.ts)).toEqual([T, T + 1000, T + 2000]);
    expect(model.lastHops.value.top.map((r) => [r.node.label, r.count])).toEqual([['Hilltop', 3]]);
    await model.removeFilter('lastHop');
    expect(model.points.value).toHaveLength(10);
  });

  it('forContact: the packets heard with the contact as last hop', async () => {
    const { model } = await lastHopHarness();
    const hill = model.forContact(HILL.key).value;
    expect(hill.lastHopOf.map((p) => p.ts)).toEqual([T, T + 1000, T + 2000]);
    expect(hill.lastHopSignal).toEqual([
      { ts: T, snr: 10, rssi: -80, direct: true, id: hill.lastHopOf[0]!.id },
      { ts: T + 1000, snr: 4, rssi: -100, direct: false, id: hill.lastHopOf[1]!.id },
      { ts: T + 2000, snr: null, rssi: null, direct: false, id: hill.lastHopOf[2]!.id },
    ]);
    expect(hill.lastHopSummary).toEqual({ count: 3, snrCount: 2, meanSnr: 7, minSnr: 4, maxSnr: 10, meanRssi: -90 });
    // Alice is never the last hop (her DIRECT-routed DM has none)
    const alice = model.forContact(ALICE.key).value;
    expect(alice.lastHopOf).toEqual([]);
    expect(alice.lastHopSummary).toEqual({ count: 0, snrCount: 0, meanSnr: null, minSnr: null, maxSnr: null, meanRssi: null });
  });

  it('keeps the top last hops and counts the rest', () => {
    const base: StatPacket = {
      id: 0,
      ts: 0,
      direction: 'in',
      bytes: 10,
      payloadType: PayloadType.ACK,
      typeName: 'ACK',
      routeType: RouteType.FLOOD,
      routeName: 'FLOOD',
      hops: 1,
      snr: 1,
      rssi: null,
      category: 'ack',
      channel: null,
      source: null,
      lastHop: null,
      direct: false,
      path: [],
      pathKey: '',
      destHash: null,
      distanceM: null,
      airtimeMs: null,
      compression: null,
      textBytes: null,
    };
    const pts: StatPacket[] = Array.from({ length: TOP_SOURCES + 2 }, (_, i) => {
      const hash = i.toString(16).padStart(2, '0');
      return { ...base, id: i, lastHop: { hash, label: hash, resolved: false } };
    });
    pts.push({ ...pts[0]!, id: 99, snr: null });
    const s = lastHopSignalStats(pts);
    expect(s.top).toHaveLength(TOP_SOURCES);
    expect(s.top[0]).toMatchObject({ node: { hash: '00' }, count: 2, snrCount: 1, meanSnr: 1, meanRssi: null, relayed: 2, direct: 0 });
    expect(s).toMatchObject({ unattributed: 0, others: 2, othersPackets: 2 });
    expect(snrSummary([])).toEqual({ count: 0, snrCount: 0, meanSnr: null, minSnr: null, maxSnr: null, meanRssi: null });
  });
});
