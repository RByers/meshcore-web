import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { toHex } from '../util/bytes.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import type { AnnotationNode } from '../packet/annotate.js';
import { AppModel, createEmulatorTransportFactory } from './app-model.js';
import { memoryPreferences } from './connection.js';
import type { PacketLogModel } from './packet-log-model.js';

const apps: AppModel[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
});

/** Leaves (ignoring bit fields and decrypted overlays) must tile the node exactly. */
function checkTiling(n: AnnotationNode): void {
  const kids = (n.children ?? []).filter((c) => !c.bits && !c.decrypted);
  if (kids.length === 0) return;
  let pos = n.offset;
  for (const c of kids) {
    expect(c.offset).toBe(pos);
    pos += c.length;
    checkTiling(c);
  }
  expect(pos).toBe(n.offset + n.length);
}

function find(n: AnnotationNode, pred: (n: AnnotationNode) => boolean): AnnotationNode | undefined {
  if (pred(n)) return n;
  for (const c of n.children ?? []) {
    const f = find(c, pred);
    if (f) return f;
  }
  return undefined;
}

async function connected(): Promise<{ app: AppModel; log: PacketLogModel; scenario: ReturnType<ReturnType<typeof createEmulatorTransportFactory>['scenario']> }> {
  const emulator = createEmulatorTransportFactory();
  const app = new AppModel({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, createEmulatorTransport: emulator, preferences: memoryPreferences() });
  apps.push(app);
  const log = app.packetLog;
  expect(await app.connection.connect('emulator')).toBe(true);
  await app.connection.capture!.idle();
  await log.settled();
  return { app, log, scenario: emulator.scenario() };
}

/** Alice adverts, Bob posts on Public, Alice DMs the radio; waits until all are logged. */
async function traffic(app: AppModel, log: PacketLogModel, scenario: Awaited<ReturnType<typeof connected>>['scenario']): Promise<void> {
  scenario.nodes.alice.advertise();
  scenario.nodes.bob.sendChannelMessage('Public', 'hello mesh');
  scenario.nodes.alice.sendText(scenario.keys.self, 'hi there');
  await vi.waitFor(
    async () => {
      await app.connection.capture!.idle();
      const items = (await app.connection.store.value!.packets.query({ limit: 1000 })).items;
      const types = new Set(items.map((r) => r.payloadType));
      expect(types.has(PayloadType.ADVERT) && types.has(PayloadType.GRP_TXT) && types.has(PayloadType.TXT_MSG)).toBe(true);
      // the repeater's re-flooded copies (forwarded after a short delay)
      expect(items.filter((r) => r.payloadType === PayloadType.ADVERT && r.pathLen === 1).length).toBeGreaterThan(0);
    },
    { timeout: 3000 },
  );
  await new Promise((r) => setTimeout(r, 200));
  await app.connection.capture!.idle();
  await log.settled();
}

describe('PacketLogModel — packets', () => {
  it('live-tails LOG_RX_DATA packets with decoded summaries', async () => {
    const { app, log, scenario } = await connected();
    expect(log.packets.live.value).toBe(true);
    await traffic(app, log, scenario);
    const rows = log.packets.rows.value;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // newest first
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.record.ts).toBeGreaterThanOrEqual(rows[i]!.record.ts);
    const advert = rows.find((r) => r.record.payloadType === PayloadType.ADVERT)!;
    expect(advert.summary).toBe('ADVERT "Alice" (chat) 47.6100,-122.3300');
    expect(advert.typeName).toBe('ADVERT');
    expect(advert.routeName).toBe('FLOOD');
    expect(advert.record.source).toBe('logRxData');
    expect(advert.record.snr).toBe(8);
    const grp = rows.find((r) => r.record.payloadType === PayloadType.GRP_TXT)!;
    expect(grp.summary).toBe('GRP_TXT Public: "Bob: hello mesh"');
    const txt = rows.find((r) => r.record.payloadType === PayloadType.TXT_MSG)!;
    expect(txt.summary).toBe('TXT_MSG Alice → Emulator');
    expect(log.packets.total.value).toBe(rows.length);
    expect(log.packets.matching.value).toBe(rows.length);
    // the repeater re-floods Alice's advert: a 1-hop copy via the repeater
    const relayed = rows.find((r) => r.record.payloadType === PayloadType.ADVERT && r.hops === 1);
    expect(relayed?.path).toEqual([toHex(scenario.keys.repeater.subarray(0, 1))]);
  });

  it('filters by type, route, direction, text, node and time', async () => {
    const { app, log, scenario } = await connected();
    await traffic(app, log, scenario);
    const all = log.packets.total.value;

    await log.packets.setFilter({ payloadTypes: [PayloadType.ADVERT] });
    expect(log.packets.rows.value.length).toBeGreaterThan(0);
    expect(log.packets.rows.value.every((r) => r.record.payloadType === PayloadType.ADVERT)).toBe(true);
    expect(log.packets.matching.value).toBe(log.packets.rows.value.length);
    expect(log.packets.total.value).toBe(all);

    await log.packets.setFilter({ payloadTypes: [PayloadType.ADVERT, PayloadType.GRP_TXT] });
    expect(new Set(log.packets.rows.value.map((r) => r.typeName))).toEqual(new Set(['ADVERT', 'GRP_TXT']));

    await log.packets.setFilter({ payloadTypes: [], routeTypes: [RouteType.DIRECT] });
    expect(log.packets.rows.value.every((r) => r.routeName === 'DIRECT')).toBe(true);

    await log.packets.setFilter({ routeTypes: undefined, direction: 'tx' });
    expect(log.packets.rows.value).toEqual([]);

    await log.packets.setFilter({ text: 'hello mesh' }, { replace: true });
    expect(log.packets.rows.value.map((r) => r.typeName)).toEqual(expect.arrayContaining(['GRP_TXT']));
    expect(log.packets.rows.value.every((r) => r.typeName === 'GRP_TXT')).toBe(true);

    // hex search
    const someHex = toHex(log.packets.rows.value[0]!.record.bytes.subarray(3, 9));
    await log.packets.setFilter({ text: someHex }, { replace: true });
    expect(log.packets.rows.value.length).toBeGreaterThan(0);

    // node: Bob's key prefix → his channel post carries no node hash, but his key appears nowhere; Alice's does
    await log.packets.setFilter({ node: toHex(scenario.keys.alice.subarray(0, 4)) }, { replace: true });
    const types = new Set(log.packets.rows.value.map((r) => r.typeName));
    expect(types.has('ADVERT') && types.has('TXT_MSG')).toBe(true);
    expect(types.has('GRP_TXT')).toBe(false);

    await log.packets.setFilter({ from: Date.now() + 60_000 }, { replace: true });
    expect(log.packets.rows.value).toEqual([]);

    await log.packets.clearFilter();
    expect(log.packets.rows.value.length).toBe(all);
  });

  it('pages and counts; live tail off counts missed packets', async () => {
    const emulator = createEmulatorTransportFactory();
    const app = new AppModel({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, createEmulatorTransport: emulator });
    apps.push(app);
    // a small page size to exercise paging (the AppModel getter uses the default of 100)
    const { PacketLogModel } = await import('./packet-log-model.js');
    const log = new PacketLogModel(app.connection, { pageSize: 2 }).start();
    await app.connection.connect('emulator');
    await app.connection.capture!.idle();
    await log.settled();
    await traffic(app, log, emulator.scenario());
    const total = log.packets.total.value;
    expect(total).toBeGreaterThan(2);
    expect(log.packets.rows.value.length).toBe(2);
    expect(log.packets.hasMore.value).toBe(true);
    expect(log.packets.pageCount.value).toBe(Math.ceil(total / 2));
    const first = log.packets.rows.value.map((r) => r.id);
    await log.packets.next();
    expect(log.packets.page.value).toBe(1);
    expect(log.packets.rows.value.map((r) => r.id)).not.toEqual(first);
    await log.packets.setLive(false);
    emulator.scenario().nodes.bob.advertise();
    await vi.waitFor(async () => {
      await app.connection.capture!.idle();
      expect(log.packets.missed.value).toBeGreaterThan(0);
    });
    await log.packets.setLive(true);
    expect(log.packets.page.value).toBe(0);
    expect(log.packets.missed.value).toBe(0);
    expect(log.packets.rows.value[0]!.summary).toContain('"Bob"');
    log.dispose();
  });

  it('inspect: annotation tiles every byte and decrypts channel traffic', async () => {
    const { app, log, scenario } = await connected();
    await traffic(app, log, scenario);
    const grp = log.packets.rows.value.find((r) => r.typeName === 'GRP_TXT')!;
    const ins = (await log.inspect(grp.id))!;
    expect(ins.record.id).toBe(grp.id);
    expect(ins.annotation.length).toBe(ins.record.bytes.length);
    checkTiling(ins.annotation);
    expect(ins.annotation.errors).toEqual([]);
    expect(ins.annotation.meaning).toBe(`packet hash ${ins.record.hash}`);
    const text = find(ins.annotation, (n) => n.decrypted === true && n.name === 'text');
    expect(text?.value).toBe('"Bob: hello mesh"');
    expect(ins.sourceFrame?.kind).toBe('logRxData');
    expect(ins.summary).toBe(grp.summary);
    expect(await log.inspect(999_999)).toBeNull();
  });

  it('inspect: DMs decrypt only after opting in to store the radio key', async () => {
    const { app, log, scenario } = await connected();
    await traffic(app, log, scenario);
    const txt = log.packets.rows.value.find((r) => r.typeName === 'TXT_MSG')!;
    let ins = (await log.inspect(txt.id))!;
    expect(log.selfKeyStored.value).toBe(false);
    expect(find(ins.annotation, (n) => n.decrypted === true)).toBeUndefined();
    await log.storeSelfKeyFromDevice();
    await vi.waitFor(() => expect(log.selfKeyStored.value).toBe(true));
    ins = (await log.inspect(txt.id))!;
    expect(find(ins.annotation, (n) => n.decrypted === true && n.name === 'text')?.value).toBe('"hi there"');
    checkTiling(ins.annotation);
    await log.setSelfPrivateKey(null);
    await vi.waitFor(() => expect(log.selfKeyStored.value).toBe(false));
  });
});

describe('PacketLogModel — frames', () => {
  it('lists the handshake frames with names and decodes them', async () => {
    const { log } = await connected();
    const names = log.frames.rows.value.map((r) => `${r.record.direction}:${r.name}`);
    expect(names).toEqual(expect.arrayContaining(['out:DEVICE_QUERY', 'in:DEVICE_INFO', 'out:APP_START', 'in:SELF_INFO']));
    const si = log.frames.rows.value.find((r) => r.name === 'SELF_INFO')!;
    expect(si.summary).toContain('"Emulator"');
    const ins = (await log.inspectFrame(si.id))!;
    expect(ins.decoded).toMatchObject({ kind: 'selfInfo' });
    expect(ins.annotation.value).toBe('SELF_INFO');
    checkTiling(ins.annotation);
    expect(ins.annotation.errors).toEqual([]);
    const dq = log.frames.rows.value.find((r) => r.name === 'DEVICE_QUERY')!;
    expect((await log.inspectFrame(dq.id))!.decoded).toMatchObject({ kind: 'deviceQuery', appTargetVer: 3 });

    await log.frames.setFilter({ direction: 'out' });
    expect(log.frames.rows.value.every((r) => r.record.direction === 'out')).toBe(true);
    await log.frames.setFilter({ codes: [0x16] }, { replace: true });
    expect(log.frames.rows.value.map((r) => r.name)).toEqual(['DEVICE_QUERY']);
    await log.frames.setFilter({ codes: [0x16, 0x01], direction: 'out' }, { replace: true });
    expect(new Set(log.frames.rows.value.map((r) => r.name))).toEqual(new Set(['DEVICE_QUERY', 'APP_START']));
    await log.frames.setFilter({ text: 'self_info' }, { replace: true });
    expect(log.frames.rows.value.map((r) => r.name)).toEqual(['SELF_INFO']);
  });

  it('LOG_RX_DATA frames link to their packet', async () => {
    const { app, log, scenario } = await connected();
    await traffic(app, log, scenario);
    await log.frames.setFilter({ codes: [0x88] });
    const f = log.frames.rows.value[0]!;
    expect(f.name).toBe('LOG_RX_DATA');
    const ins = (await log.inspectFrame(f.id))!;
    expect(ins.packetId).toBeDefined();
    const pkt = (await log.inspect(ins.packetId!))!;
    expect(pkt.record.sourceFrameId).toBe(f.id);
    expect(find(ins.annotation, (n) => n.name === 'packet')?.offset).toBe(3);
  });
});

describe('PacketLogModel — export / import / clear', () => {
  it('round-trips both logs through JSON', async () => {
    const { app, log, scenario } = await connected();
    await traffic(app, log, scenario);
    const packets = log.packets.total.value;
    const frames = (await app.connection.store.value!.frames.count());
    const bundle = JSON.stringify(await log.exportAll());
    const onlyAdverts = await (async () => {
      await log.packets.setFilter({ payloadTypes: [PayloadType.ADVERT] });
      return log.exportPackets({ filtered: true });
    })();
    expect(onlyAdverts.items.every((i) => i.payloadType === PayloadType.ADVERT)).toBe(true);
    expect(onlyAdverts.items[0]!.bytes).toMatch(/^[0-9a-f]+$/);
    await log.packets.clearFilter();

    // stop live traffic from adding frames while we count
    await app.connection.disconnect();
    expect(await app.connection.connect('emulator')).toBe(true);
    await app.connection.capture!.idle();
    await log.settled();
    await log.clearPackets();
    await log.clearFrames();
    await log.settled();
    await vi.waitFor(() => expect(log.packets.total.value).toBe(0));

    const res = await log.importJson(bundle);
    expect(res.packets).toBe(packets);
    expect(res.frames).toBeGreaterThanOrEqual(frames);
    await vi.waitFor(() => expect(log.packets.total.value).toBe(packets));
    expect(log.packets.rows.value.some((r) => r.summary === 'GRP_TXT Public: "Bob: hello mesh"')).toBe(true);

    await expect(log.importJson('{"format":"nope"}')).rejects.toThrow(/unknown export format/);
    await expect(log.importJson('not json')).rejects.toThrow(/invalid JSON/);
    const one = await log.importJson(await log.exportPackets());
    expect(one).toEqual({ packets, frames: 0 });
    expect(await log.prune()).toEqual({ frames: 0, packets: 0 });
  });
});
