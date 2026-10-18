import { describe, expect, it, vi } from 'vitest';
import { toHex } from '../util/bytes.js';
import { channelKeyForPsk } from '../store/channels.js';
import { publicChannelSecret, type BasicScenario } from '../emulator/scenarios.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import type { AnnotationNode } from '../packet/annotate.js';
import type { AppModel } from './app-model.js';
import { effect } from './signal.js';
import { testApp, connectedApp } from './testing.js';
import { packetFilterChips, withoutChip, type PacketFilter, type PacketLogModel } from './packet-log-model.js';
import { SEND_BACKFILL_SETTING } from '../store/send-backfill.js';

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

async function connected(): Promise<{ app: AppModel; log: PacketLogModel; scenario: BasicScenario }> {
  const { app, scenario } = await connectedApp();
  const log = app.packetLog;
  await log.settled();
  return { app, log, scenario };
}

/**
 * Alice adverts, Bob posts on Public, Alice DMs the radio (which ACKs); waits until every packet
 * the radio hears is logged: each original plus the repeater's forwarded copy, and the
 * repeater's forward of our ACK.
 */
async function traffic(app: AppModel, log: PacketLogModel, scenario: BasicScenario): Promise<void> {
  scenario.nodes.alice.advertise();
  scenario.nodes.bob.sendChannelMessage('Public', 'hello mesh');
  scenario.nodes.alice.sendText(scenario.keys.self, 'hi there');
  const expected = [
    // advert and channel message: heard from the sender (path 0) and re-flooded by the repeater (path 1)
    `${PayloadType.ADVERT}/0`,
    `${PayloadType.ADVERT}/1`,
    `${PayloadType.GRP_TXT}/0`,
    `${PayloadType.GRP_TXT}/1`,
    // Alice's DM is routed via the repeater: overheard with 1 hop left, then forwarded to us
    `${PayloadType.TXT_MSG}/1`,
    `${PayloadType.TXT_MSG}/0`,
    // our ACK, forwarded back by the repeater
    `${PayloadType.ACK}/0`,
  ];
  await vi.waitFor(
    async () => {
      await app.connection.capture!.idle();
      const items = (await app.connection.store.value!.packets.query({ limit: 1000 })).items;
      const seen = new Set(items.filter((r) => r.direction === 'rx').map((r) => `${r.payloadType}/${r.pathLen}`));
      expect(expected.filter((k) => !seen.has(k))).toEqual([]);
    },
    { timeout: 3000 },
  );
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
    expect(txt.summary).toBe('TXT_MSG Alice → Emulator (encrypted)');
    // the path column's ends: src_hash / dest_hash (§3.0), kept apart from the relay hops
    expect(txt.endpoints).toEqual({ src: toHex(scenario.keys.alice.subarray(0, 1)), dst: toHex(scenario.keys.self.subarray(0, 1)) });
    expect(advert.endpoints).toEqual({ src: null, dst: null });
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

    // src: only packets Alice originated (her advert copies and her DM), via the source index
    const alice = toHex(scenario.keys.alice);
    await log.packets.setFilter({ src: alice }, { replace: true });
    const fromAlice = log.packets.rows.value;
    expect(new Set(fromAlice.map((r) => r.typeName))).toEqual(new Set(['ADVERT', 'TXT_MSG']));
    expect(fromAlice.every((r) => r.record.srcHash === alice.slice(0, 2))).toBe(true);
    expect(log.packets.matching.value).toBe(fromAlice.length);
    expect(fromAlice.every((r) => log.packetMatches(r.record, { src: alice }))).toBe(true);
    await log.packets.setFilter({ src: toHex(scenario.keys.bob) }, { replace: true });
    expect(log.packets.rows.value.map((r) => r.typeName)).not.toContain('TXT_MSG');

    // packets are stamped with the app clock, so "now" bounds them exactly
    const now = app.clock.now();
    await log.packets.setFilter({ from: now + 1 }, { replace: true });
    expect(log.packets.rows.value).toEqual([]);
    await log.packets.setFilter({ to: now }, { replace: true });
    expect(log.packets.matching.value).toBeGreaterThanOrEqual(all);

    await log.packets.clearFilter();
    expect(log.packets.rows.value.length).toBe(all);
  });

  it('loads more rows on demand and counts; live tail off counts missed packets', async () => {
    const { app, emulator } = testApp();
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
    // infinite scroll: each loadMore appends the next older page until the log is exhausted
    const first = log.packets.rows.value.map((r) => r.id);
    await log.packets.loadMore();
    const two = log.packets.rows.value.map((r) => r.id);
    expect(two.slice(0, 2)).toEqual(first);
    expect(two.length).toBe(Math.min(4, total));
    expect(new Set(two).size).toBe(two.length);
    expect([...two].sort((x, y) => y - x)).toEqual(two);
    while (log.packets.hasMore.value) await log.packets.loadMore();
    expect(log.packets.rows.value.length).toBe(total);
    // a reload (e.g. after a contact change) keeps everything loaded
    await log.packets.reload();
    expect(log.packets.rows.value.length).toBe(total);
    // once older rows are loaded, live tail grows the list rather than dropping its oldest row
    emulator.scenario().nodes.alice.advertise();
    await vi.waitFor(async () => {
      await app.connection.capture!.idle();
      await log.settled();
      expect(log.packets.total.value).toBeGreaterThan(total);
      expect(log.packets.rows.value.length).toBe(log.packets.total.value);
    });
    expect(log.packets.hasMore.value).toBe(false);
    await log.packets.setLive(false);
    // Bob's advert also updates his contact, and the resulting context reload re-queries the page and
    // zeroes `missed` again; whether that lands before or after the repeater's copy is a race, so
    // assert on the highest count seen rather than the current one
    let maxMissed = 0;
    const off = effect(() => {
      maxMissed = Math.max(maxMissed, log.packets.missed.value);
    });
    emulator.scenario().nodes.bob.advertise();
    await vi.waitFor(async () => {
      await app.connection.capture!.idle();
      expect(maxMissed).toBeGreaterThan(0);
    });
    off();
    await log.packets.setLive(true);
    // back to the newest page only
    expect(log.packets.rows.value.length).toBe(2);
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

describe('PacketLogModel — packets from other nodes (#10)', () => {
  it('logs DMs and channel messages others send to this radio, with DM text once decryptable', async () => {
    const { app, log, scenario } = await connected();
    await log.packets.setFilter({ direction: 'rx' });
    scenario.nodes.alice.sendText(scenario.keys.self, 'dm for you');
    scenario.nodes.bob.sendChannelMessage('Public', 'channel hello');
    await vi.waitFor(
      async () => {
        await app.connection.capture!.idle();
        await log.settled();
        const s = log.packets.rows.value.map((r) => r.summary);
        expect(s).toContain('TXT_MSG Alice → Emulator (encrypted)');
        expect(s).toContain('GRP_TXT Public: "Bob: channel hello"');
      },
      { timeout: 3000 },
    );
    const dm = log.packets.rows.value.find((r) => r.typeName === 'TXT_MSG')!;
    expect(dm.record).toMatchObject({ direction: 'rx', source: 'logRxData', format: 'packet' });
    const store = app.connection.store.value!;
    await vi.waitFor(async () => expect((await store.messages.list(toHex(scenario.keys.alice))).items.map((m) => m.text)).toContain('dm for you'));

    // with the radio key stored (opt-in), the DM row shows its text and search finds it
    await log.storeSelfKeyFromDevice();
    await vi.waitFor(async () => {
      await log.settled();
      expect(log.packets.rows.value.map((r) => r.summary)).toContain('TXT_MSG Alice → Emulator: "dm for you"');
    });
    await log.packets.setFilter({ text: 'dm for you' });
    expect(new Set(log.packets.rows.value.map((r) => r.typeName))).toEqual(new Set(['TXT_MSG'])); // original + the repeater's copy
    await log.setSelfPrivateKey(null);
    await log.packets.clearFilter();
    await vi.waitFor(async () => {
      await log.settled();
      expect(log.packets.rows.value.map((r) => r.summary)).toContain('TXT_MSG Alice → Emulator (encrypted)');
    });
  });
});

describe('PacketLogModel — sent packets (#9)', () => {
  it('rebuilds sent rows from frames once per radio, in the background on connect', async () => {
    const { app } = await connected();
    expect(await app.connection.capture!.sendBackfill).toEqual({ framesScanned: 0, added: 0, updated: 0 }); // fresh radio
    const client = app.connection.client.value!;
    await client.sendSelfAdvert('flood');
    await app.connection.capture!.idle();
    const store = app.connection.store.value!;
    expect(await store.packets.count({ direction: 'tx' })).toBe(1);
    // simulate history from before sends were logged: tx rows gone, backfill flag cleared
    await store.packets.clear();
    await store.settings.delete(SEND_BACKFILL_SETTING);
    await app.connection.disconnect();

    expect(await app.connection.connect('emulator')).toBe(true);
    const r = await app.connection.capture!.sendBackfill;
    expect(r).toMatchObject({ added: 1, updated: 0 });
    const s2 = app.connection.store.value!;
    const [row] = (await s2.packets.query({ direction: 'tx' })).items;
    expect(row).toMatchObject({ decodedSummary: 'ADVERT self (flood)', send: { status: 'sent' } });
    expect((await s2.frames.get(row!.sourceFrameId!))?.kind).toBe('sendSelfAdvert');
    expect(await s2.settings.get(SEND_BACKFILL_SETTING)).toMatchObject({ added: 1 });
    await app.connection.capture!.idle();
    await app.connection.disconnect();

    // the flag prevents another run
    expect(await app.connection.connect('emulator')).toBe(true);
    expect(await app.connection.capture!.sendBackfill).toBeNull();
    await app.connection.capture!.idle();
    expect(await app.connection.store.value!.packets.count({ direction: 'tx' })).toBe(1);
  });

  it('logs DMs, channel messages, adverts and traces the app asked the radio to send as tx', async () => {
    const { app, log, scenario } = await connected();
    const alice = toHex(scenario.keys.alice);
    const dm = app.chat('contact', alice);
    await dm.settled();
    expect((await (await dm.send('ping from me')).done).status).toBe('delivered');
    const ch = app.chat('channel', await channelKeyForPsk(publicChannelSecret()));
    await ch.settled();
    await vi.waitFor(() => expect(ch.channel.value?.name).toBe('Public'));
    await (await ch.send('hello all')).done;
    const client = app.connection.client.value!;
    await client.sendSelfAdvert('flood');
    await client.tracePath(scenario.keys.repeater.subarray(0, 1)).catch(() => undefined);
    await app.connection.capture!.idle();
    await log.settled();

    await log.packets.setFilter({ direction: 'tx' });
    const rows = log.packets.rows.value;
    expect(rows.every((r) => r.record.direction === 'tx' && r.record.source === 'sent')).toBe(true);
    const by = (t: string) => rows.find((r) => r.typeName === t)!;
    expect(by('TXT_MSG').summary).toBe('TXT_MSG → Alice: "ping from me"');
    // the route comes from RESP_SENT's flood flag (Alice has a direct path); the ACK confirmed it
    expect(by('TXT_MSG').record).toMatchObject({ format: 'none', hash: '', routeType: RouteType.DIRECT });
    expect(by('TXT_MSG').record.send).toMatchObject({ status: 'confirmed', flood: false, peer: alice.slice(0, 12) });
    expect(by('TXT_MSG').record.send!.rttMs).toBeGreaterThanOrEqual(0);
    expect(by('TXT_MSG').record.bytes.length).toBe(0);
    expect(by('TXT_MSG').routeName).toBe('DIRECT');
    expect(by('GRP_TXT').summary).toBe('GRP_TXT Public: "hello all"');
    expect(by('GRP_TXT').routeName).toBe('FLOOD');
    expect(by('GRP_TXT').record.send).toMatchObject({ status: 'sent' }); // channel text answers OK
    expect(by('ADVERT').summary).toBe('ADVERT self (flood)');
    const trace = by('TRACE');
    expect(trace.record.send).toMatchObject({ status: 'sent', flood: false });
    expect(trace.record.format).toBe('payload');
    expect(trace.record.bytes.length).toBe(10); // tag(4) auth(4) flags(1) + one 1-byte hop hash
    expect(trace.record.bytes[9]).toBe(scenario.keys.repeater[0]);

    // the rx view excludes them; no direction filter shows both
    await log.packets.setFilter({ direction: 'rx' });
    expect(log.packets.rows.value.length).toBeGreaterThan(0);
    expect(log.packets.rows.value.some((r) => r.record.direction === 'tx')).toBe(false);
    await log.packets.setFilter({ direction: undefined });
    expect(new Set(log.packets.rows.value.map((r) => r.record.direction))).toEqual(new Set(['rx', 'tx']));

    // inspector: no bytes, linked to the command frame; the frame links back
    const txt = (await log.inspect(by('TXT_MSG').id))!;
    expect(txt.annotation).toMatchObject({ length: 0, name: 'requested transmission', errors: [] });
    expect(txt.sourceFrame?.direction).toBe('out');
    expect(txt.summary).toBe('TXT_MSG → Alice: "ping from me"');
    const frame = (await log.inspectFrame(txt.sourceFrame!.id))!;
    expect(frame.decoded).toMatchObject({ kind: 'sendTxtMsg', text: 'ping from me' });
    expect(frame.packetId).toBe(txt.record.id);
    const tr = (await log.inspect(trace.id))!;
    expect(tr.annotation.errors).toEqual([]);
    expect(tr.annotation.length).toBe(10);

    // live tail picks up new tx entries
    await log.packets.setFilter({ direction: 'tx' });
    await client.sendSelfAdvert('zeroHop');
    await app.connection.capture!.idle();
    await log.settled();
    expect(log.packets.rows.value[0]!.summary).toBe('ADVERT self (zero-hop)');
    expect(log.packets.rows.value[0]!.routeName).toBe('DIRECT');
    // the device's OK updated the shown row in place (packetUpdated), without counting it twice
    expect(log.packets.rows.value[0]!.record.send?.status).toBe('sent');
    expect(log.packets.matching.value).toBe(await app.connection.store.value!.packets.count({ direction: 'tx' }));
    expect(new Set(log.packets.rows.value.map((r) => r.id)).size).toBe(log.packets.rows.value.length);

    // export / import keep tx entries
    const exp = await log.exportPackets({ filtered: true });
    expect(exp.items.length).toBe(log.packets.matching.value);
    expect(exp.items.every((i) => i.direction === 'tx')).toBe(true);
    const json = JSON.stringify(exp);
    await log.clearPackets();
    await vi.waitFor(() => expect(log.packets.total.value).toBe(0));
    expect(await log.importJson(json)).toEqual({ packets: exp.items.length, frames: 0 });
    await vi.waitFor(async () => {
      await log.settled();
      expect(log.packets.rows.value.map((r) => r.summary)).toContain('TXT_MSG → Alice: "ping from me"');
    });
    const back = log.packets.rows.value.find((r) => r.typeName === 'TXT_MSG')!.record;
    expect(back).toMatchObject({ direction: 'tx', format: 'none', source: 'sent', hash: '' });
  });
});

describe('PacketLogModel — filter shared with the packet statistics', () => {
  it('app.packetStats drill-downs filter the packet log, live included', async () => {
    const { app, log, scenario } = await connected();
    const stats = app.packetStats;
    await traffic(app, log, scenario);
    await stats.settled();
    const alice = toHex(scenario.keys.alice);
    await stats.addFilter({ field: 'source', value: alice, label: 'Alice' });
    expect(log.packets.filter.value.drill).toEqual([{ field: 'source', value: alice, label: 'Alice' }]);
    const ids = stats.points.value.map((p) => p.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(log.packets.rows.value.map((r) => r.id).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
    expect(log.packets.matching.value).toBe(ids.length);

    // a new advert from Alice shows up once its stats point is derived; Bob's does not
    scenario.nodes.alice.advertise();
    scenario.nodes.bob.advertise();
    await vi.waitFor(async () => {
      await app.connection.capture!.idle();
      await stats.settled();
      await log.settled();
      expect(stats.points.value.length).toBeGreaterThan(ids.length);
    });
    const shown = log.packets.rows.value.map((r) => r.id);
    expect(new Set(shown).size).toBe(shown.length);
    expect([...shown].sort((a, b) => a - b)).toEqual(stats.points.value.map((p) => p.id).sort((a, b) => a - b));
    expect(log.packets.matching.value).toBe(shown.length);

    await stats.clearFilters();
    expect(log.packets.filter.value).toEqual({});
  });

  it('packetFilterChips / withoutChip cover every criterion but the date range', () => {
    const f: PacketFilter = {
      direction: 'rx',
      payloadTypes: [PayloadType.ADVERT, PayloadType.TXT_MSG],
      routeTypes: [RouteType.FLOOD],
      from: 1,
      to: 2,
      text: 'foo',
      node: 'a3',
      src: 'a1b2c3d4e5f6',
      drill: [
        { field: 'source', value: 'k', label: 'Alice' },
        { field: 'hops', value: '2', label: '2 hops' },
      ],
    };
    expect(packetFilterChips(f).map((c) => [c.key, c.label])).toEqual([
      ['direction', 'Direction: Received'],
      ['types', 'Types: ADVERT, TXT_MSG'],
      ['routes', 'Route: FLOOD'],
      ['src', 'From: a1b2c3d4…'],
      ['node', 'Node: a3'],
      ['text', 'Text: foo'],
      ['drill-source', 'Source: Alice'],
      ['drill-hops', 'Hops: 2 hops'],
    ]);
    expect(packetFilterChips({ direction: 'tx', payloadTypes: [PayloadType.ACK] }, {}).map((c) => [c.name, c.value])).toEqual([
      ['Direction', 'Sent'],
      ['Type', 'ACK'],
    ]);
    expect(packetFilterChips({ src: 'abc' }, { srcLabel: (k) => `node ${k}` })[0]!.label).toBe('From: node abc');
    expect(packetFilterChips({ from: 1, to: 2, payloadTypes: [] })).toEqual([]);

    expect(withoutChip(f, 'types').payloadTypes).toBeUndefined();
    expect(withoutChip(f, 'direction').direction).toBeUndefined();
    expect(withoutChip(f, 'drill-source').drill).toEqual([{ field: 'hops', value: '2', label: '2 hops' }]);
    expect('drill' in withoutChip(withoutChip(f, 'drill-source'), 'drill-hops')).toBe(false);
    expect(withoutChip(f, 'nope')).toBe(f);
    let g: PacketFilter = f;
    for (const c of packetFilterChips(f)) g = withoutChip(g, c.key);
    expect(g).toEqual({ from: 1, to: 2 });
  });
});
