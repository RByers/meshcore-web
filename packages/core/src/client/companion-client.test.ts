import { describe, expect, it } from 'vitest';
import { readU32LE, toHex, utf8Encode } from '../util/bytes.js';
import { CMD, ContactType, ERR, ReqType, TxtType, encodePathLen } from '../protocol/constants.js';
import { CompanionEmulator, computeAckCode } from '../emulator/companion-emulator.js';
import type { RemoteNodeConfig } from '../emulator/remote-node.js';
import { basicScenario, scenarioKey, type BasicScenarioOptions } from '../emulator/scenarios.js';
import { LoopbackTransport, type FrameTransport } from '../transport/index.js';
import { CompanionClient } from './companion-client.js';
import { DeviceError, DisconnectedError, LoginFailedError, RemoteTimeoutError, RequestTimeoutError } from './errors.js';
import { SteppingClock, drive, runFor } from './testing.js';
import type { CompanionClientEvents, CompanionClientOptions, ContactsChangedEvent, ContactsSnapshot, FrameLogEntry, SendProgress } from './types.js';
import { encodeCommand } from '../protocol/encode.js';
import type { SelfInfo } from '../protocol/types.js';

const START = Date.UTC(2026, 9, 15, 12, 0, 0);
const START_SECS = START / 1000;

interface Setup {
  clock: SteppingClock;
  emu: CompanionEmulator;
  keys: ReturnType<typeof basicScenario>['keys'];
  transport: FrameTransport;
  client: CompanionClient;
  frames: FrameLogEntry[];
  run<T>(p: Promise<T>): Promise<T>;
  record<K extends keyof CompanionClientEvents>(event: K): Array<CompanionClientEvents[K]>;
  /** Commands sent (by kind) since the start. */
  sent(): string[];
}

function makeSetup(
  opts: {
    emu?: BasicScenarioOptions;
    client?: CompanionClientOptions;
    nodes?: RemoteNodeConfig[];
    transport?: (emu: CompanionEmulator) => FrameTransport;
  } = {},
): Setup {
  const clock = new SteppingClock(START);
  const { emulator: emu, keys } = basicScenario({ clock, ...opts.emu });
  for (const n of opts.nodes ?? []) emu.addRemoteNode(n);
  const transport = opts.transport ? opts.transport(emu) : emu.createLoopbackTransport();
  const client = new CompanionClient({ clock, ...opts.client });
  const frames: FrameLogEntry[] = [];
  client.events.on('frame', (f) => frames.push(f));
  return {
    clock,
    emu,
    keys,
    transport,
    client,
    frames,
    run: (p) => drive(clock, p),
    record(event) {
      const out: Array<CompanionClientEvents[typeof event]> = [];
      client.events.on(event, (e) => out.push(e));
      return out;
    },
    sent: () => frames.filter((f) => f.direction === 'out').map((f) => f.command ?? '?'),
  };
}

async function connected(opts: Parameters<typeof makeSetup>[0] = {}): Promise<Setup> {
  const s = makeSetup(opts);
  await s.run(s.client.connect(s.transport));
  return s;
}

/** A transport that routes host frames through `filter` before the emulator sees them. */
function filtered(filter: (frame: Uint8Array, reply: (f: Uint8Array) => void) => boolean) {
  return (emu: CompanionEmulator): FrameTransport => {
    const t = new LoopbackTransport((frame, device) => {
      if (filter(frame, (f) => device.send(f))) return;
      emu.handleFrame(frame);
    });
    emu.onFrame((f) => t.pushFromDevice(f));
    return t;
  };
}

const DAVE = scenarioKey('dave');
const onePathVia = (k: Uint8Array) => ({ outPathLen: encodePathLen(1), outPath: k.slice(0, 1) });

// ---------------------------------------------------------------------------

describe('CompanionClient handshake', () => {
  it('runs DEVICE_QUERY, APP_START, time check, contacts sync and message drain', async () => {
    const s = makeSetup();
    const connectedEvents = s.record('connected');
    const states = s.record('state');
    const msgs = s.record('contactMessage');
    const ev = await s.run(s.client.connect(s.transport));

    expect(s.client.state).toBe('connected');
    expect(states).toEqual(['connecting', 'connected']);
    expect(connectedEvents).toHaveLength(1);
    expect(ev.protocolVersion).toBe(3);
    expect(s.client.protocolVersion).toBe(3);
    expect(s.client.deviceInfo?.firmwareVerCode).toBe(14);
    expect(s.client.deviceInfo?.maxChannels).toBe(8);
    expect(s.client.selfInfo?.name).toBe('Emulator');
    expect(toHex(s.client.selfInfo!.pubKey)).toBe(toHex(s.keys.self));
    expect(s.client.contacts.map((c) => c.name).sort()).toEqual(['Alice', 'Bob', 'Carol', 'Hilltop Repeater', 'Town Square', 'Weather Station']);
    expect(msgs).toHaveLength(2);
    expect(s.emu.appTargetVer).toBe(3);
    // RTC equals host time: no SET_DEVICE_TIME
    expect(s.sent()).toEqual([
      'deviceQuery',
      'appStart',
      'getDeviceTime',
      'getContacts',
      'syncNextMessage',
      'syncNextMessage',
      'syncNextMessage',
      'syncNextMessage',
    ]);
  });

  it('emits connectProgress per step, per contact (done/total) and per drained message', async () => {
    const s = makeSetup();
    const progress = s.record('connectProgress');
    const msgs = s.record('contactMessage');
    const chans = s.record('channelMessage');
    await s.run(s.client.connect(s.transport));

    const steps = ['deviceQuery', 'appStart', 'timeSync', 'contacts', 'messages'];
    for (const p of progress) expect(p.steps).toEqual(steps);
    const n = s.client.contacts.length;
    const drained = msgs.length + chans.length;
    expect(progress.map(({ step, done, total }) => ({ step, done, total }))).toEqual([
      { step: 'deviceQuery', done: undefined, total: undefined },
      { step: 'appStart', done: undefined, total: undefined },
      { step: 'timeSync', done: undefined, total: undefined },
      { step: 'contacts', done: undefined, total: undefined },
      ...Array.from({ length: n + 1 }, (_, i) => ({ step: 'contacts', done: i, total: n })),
      ...Array.from({ length: drained + 1 }, (_, i) => ({ step: 'messages', done: i, total: undefined })),
    ]);
    expect(n).toBe(6);
    expect(drained).toBeGreaterThan(0);

    // nothing after the handshake (a later sync is not part of connect)
    const before = progress.length;
    await s.run(s.client.syncContacts({ full: true }));
    await s.run(s.client.syncMessages());
    expect(progress).toHaveLength(before);
  });

  it('leaves disabled steps out of connectProgress', async () => {
    const s = makeSetup({ client: { timeSync: 'never', syncContactsOnConnect: false } });
    const progress = s.record('connectProgress');
    await s.run(s.client.connect(s.transport));
    expect(progress[0]?.steps).toEqual(['deviceQuery', 'appStart', 'messages']);
    expect([...new Set(progress.map((p) => p.step))]).toEqual(['deviceQuery', 'appStart', 'messages']);
  });

  it('records every frame in wire order with direction, decoded frame and timestamp', async () => {
    const s = await connected();
    const head = s.frames.slice(0, 4).map((f) => [f.direction, f.command ?? f.frame?.kind]);
    expect(head).toEqual([
      ['out', 'deviceQuery'],
      ['in', 'deviceInfo'],
      ['out', 'appStart'],
      ['in', 'selfInfo'],
    ]);
    expect(s.frames[0]!.bytes).toEqual(Uint8Array.of(CMD.DEVICE_QUERY, 3));
    const contactFrames = s.frames.filter((f) => f.frame?.kind === 'contact');
    expect(contactFrames).toHaveLength(6);
    for (let i = 1; i < s.frames.length; i++) expect(s.frames[i]!.timestamp).toBeGreaterThanOrEqual(s.frames[i - 1]!.timestamp);
    // every out frame is followed by its reply before the next out frame (one in flight)
    const dirs = s.frames.filter((f) => f.frame === undefined || f.frame.code < 0x80).map((f) => f.direction);
    for (let i = 0; i < dirs.length; i++) if (dirs[i] === 'out') expect(dirs[i + 1]).toBe('in');

    s.frames.length = 0;
    await s.run(s.client.getBattAndStorage());
    expect(s.frames.map((f) => [f.direction, f.command ?? f.frame?.kind])).toEqual([
      ['out', 'getBattAndStorage'],
      ['in', 'battAndStorage'],
    ]);
  });

  it('falls back when DEVICE_QUERY is answered with ERR (old firmware, V1 frames)', async () => {
    const s = await connected({
      emu: { appTargetVer: 0 },
      transport: filtered((f, reply) => {
        if (f[0] !== CMD.DEVICE_QUERY) return false;
        reply(Uint8Array.of(0x01, ERR.UNSUPPORTED_CMD));
        return true;
      }),
    });
    expect(s.client.deviceInfo).toBeUndefined();
    expect(s.client.protocolVersion).toBe(0);
    expect(s.client.selfInfo?.name).toBe('Emulator');
    const msgs = s.record('contactMessage');
    s.emu.injectContactMessage(s.keys.bob, 'old style');
    await runFor(s.clock, 10);
    expect(msgs.map((m) => [m.message.version, m.message.text, m.message.snr])).toEqual([[1, 'old style', undefined]]);
  });

  it('falls back when DEVICE_QUERY times out', async () => {
    const s = makeSetup({ client: { requestTimeoutMs: 1000 }, transport: filtered((f) => f[0] === CMD.DEVICE_QUERY) });
    await s.run(s.client.connect(s.transport));
    expect(s.client.deviceInfo).toBeUndefined();
    expect(s.client.connected).toBe(true);
    expect(s.clock.now() - START).toBeGreaterThanOrEqual(1000);
  });

  it('sets the device clock when it is behind and leaves it when ahead', async () => {
    const behind = await connected({ emu: { rtcEpochSecs: START_SECS - 3600 } });
    expect(behind.sent()).toContain('setDeviceTime');
    expect(Math.abs(behind.emu.rtcSecs - Math.floor(behind.clock.now() / 1000))).toBeLessThanOrEqual(1);

    const ahead = await connected({ emu: { rtcEpochSecs: START_SECS + 3600 }, client: { timeSync: 'always' } });
    expect(ahead.sent()).toContain('setDeviceTime'); // refused with ERR 6, ignored
    expect(ahead.client.connected).toBe(true);
    expect(ahead.emu.rtcSecs).toBeGreaterThanOrEqual(START_SECS + 3600);

    const never = await connected({ emu: { rtcEpochSecs: START_SECS - 3600 }, client: { timeSync: 'never' } });
    expect(never.sent()).not.toContain('getDeviceTime');
  });

  it('rejects connect and returns to disconnected when the handshake fails', async () => {
    const s = makeSetup({ client: { requestTimeoutMs: 500 }, transport: filtered((f) => f[0] === CMD.APP_START) });
    const disc = s.record('disconnected');
    await expect(s.run(s.client.connect(s.transport))).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(s.client.state).toBe('disconnected');
    expect(s.transport.state).toBe('disconnected');
    expect(disc).toHaveLength(1);
  });
});

describe('message versions and draining', () => {
  it('delivers V3 frames (with SNR) at protocol version 3', async () => {
    const s = makeSetup();
    const msgs = s.record('contactMessage');
    const chans = s.record('channelMessage');
    await s.run(s.client.connect(s.transport));
    expect(msgs.map((m) => [m.message.version, m.message.text, m.contact?.name])).toEqual([
      [3, 'Hi! Are you on the mesh today?', 'Alice'],
      [3, 'Welcome to Town Square', 'Town Square'],
    ]);
    expect(msgs[0]!.message.snr).toBe(6.5);
    expect(msgs[1]!.message.txtType).toBe(TxtType.SIGNED_PLAIN);
    expect(toHex(msgs[1]!.message.authorPrefix!)).toBe(toHex(s.keys.carol.slice(0, 4)));
    expect(chans.map((c) => [c.message.version, c.message.channelIdx, c.message.senderName, c.message.message])).toEqual([
      [3, 0, 'Dave', 'Good morning everyone'],
    ]);
  });

  it('keeps queued V3 history but receives new messages as V1 after DEVICE_QUERY(1)', async () => {
    const s = makeSetup({ client: { protocolVersion: 1 } });
    const msgs = s.record('contactMessage');
    const chans = s.record('channelMessage');
    await s.run(s.client.connect(s.transport));
    expect(s.frames[0]!.bytes).toEqual(Uint8Array.of(CMD.DEVICE_QUERY, 1));
    expect(s.client.protocolVersion).toBe(1);
    expect(msgs.map((m) => m.message.version)).toEqual([3, 3]);
    s.emu.injectContactMessage(s.keys.carol, 'v1 now');
    s.emu.injectChannelMessage(1, 'Erin', 'v1 channel');
    await runFor(s.clock, 10);
    expect(msgs.map((m) => m.message.version)).toEqual([3, 3, 1]);
    expect(msgs[2]!.message.snr).toBeUndefined();
    expect(chans.map((c) => [c.message.version, c.message.channelIdx, c.message.text])).toEqual([
      [3, 0, 'Dave: Good morning everyone'],
      [1, 1, 'Erin: v1 channel'],
    ]);
  });

  it('drains on MSG_WAITING and coalesces a burst into one drain', async () => {
    const s = await connected();
    const msgs = s.record('contactMessage');
    const waiting = s.record('msgWaiting');
    const before = s.sent().length;
    s.emu.injectContactMessage(s.keys.alice, 'one');
    s.emu.injectContactMessage(s.keys.bob, 'two');
    s.emu.injectChannelMessage(1, 'Erin', 'three');
    s.emu.injectContactMessage(s.keys.carol, 'four');
    await runFor(s.clock, 10);
    expect(waiting).toHaveLength(4);
    expect(msgs.map((m) => m.message.text)).toEqual(['one', 'two', 'four']);
    const syncs = s.sent().slice(before);
    expect(syncs.every((k) => k === 'syncNextMessage')).toBe(true);
    // 4 messages + NO_MORE (+ at most one extra pass for MSG_WAITINGs seen mid-drain)
    expect(syncs.length).toBeGreaterThanOrEqual(5);
    expect(syncs.length).toBeLessThanOrEqual(6);
    expect(s.emu.offlineQueue).toHaveLength(0);
  });

  it('does one extra pass for a message queued during a drain', async () => {
    const s = await connected({ client: { autoSyncMessages: false } });
    const msgs = s.record('contactMessage');
    s.emu.injectContactMessage(s.keys.alice, 'a');
    await runFor(s.clock, 10);
    expect(msgs).toHaveLength(0); // auto sync off
    let injected = false;
    s.client.events.on('contactMessage', () => {
      if (!injected) {
        injected = true;
        s.emu.injectContactMessage(s.keys.bob, 'b'); // MSG_WAITING arrives while draining
      }
    });
    const p1 = s.client.syncMessages();
    const p2 = s.client.syncMessages();
    expect(p2).toBe(p1);
    expect(await s.run(p1)).toBe(2);
    expect(msgs.map((m) => m.message.text)).toEqual(['a', 'b']);
  });

  it('emits channelData for queued channel datagrams', async () => {
    const s = await connected();
    const data = s.record('channelData');
    s.emu.injectChannelData(1, 0xffff, Uint8Array.of(1, 2, 3));
    await runFor(s.clock, 10);
    expect(data.map((d) => [d.message.channelIdx, d.message.dataType, [...d.message.data]])).toEqual([[1, 0xffff, [1, 2, 3]]]);
  });
});

describe('contacts', () => {
  it('syncs incrementally using the END_OF_CONTACTS lastmod', async () => {
    const s = await connected({ client: { autoRefreshContacts: false } });
    // history messages bumped Alice's / the room's lastmod to 'now' (§7.3)
    expect(s.client.contactsSince).toBe(Math.max(...s.emu.contacts.map((c) => c.lastMod)));
    const changes = s.record('contactsChanged');

    // since = previous mostRecentLastMod - 1: the firmware filter is strict `lastmod > since` at 1 s
    // resolution, so the boundary second is re-fetched (only contacts modified in that second)
    const since = s.client.contactsSince;
    const boundary = await s.run(s.client.syncContacts());
    expect(boundary.total).toBe(6);
    expect(boundary.contacts.length).toBeGreaterThan(0);
    expect(boundary.contacts.every((c) => c.lastMod === since)).toBe(true);
    const getContacts = s.frames.filter((f) => f.command === 'getContacts').at(-1)!;
    expect(readU32LE(getContacts.bytes, 1)).toBe(since - 1);

    s.clock.advance(5000);
    s.emu.injectAdvert({ pubKey: s.keys.carol, name: 'Carol 2', timestamp: START_SECS + 5 });
    await runFor(s.clock, 10);
    const r = await s.run(s.client.syncContacts());
    // Carol 2 plus the boundary-second contacts (lastMod === since) re-sent by the since-1 query
    expect(r.contacts.filter((c) => c.lastMod > since).map((c) => c.name)).toEqual(['Carol 2']);
    expect(s.client.findContact(s.keys.carol)?.name).toBe('Carol 2');
    expect(s.client.contactsSince).toBe(r.mostRecentLastMod);
    expect(changes.at(-1)!.updated.map((c) => c.name)).toContain('Carol 2');
    expect(changes.at(-1)!.full).toBe(false);
  });

  it('dispatches pushes that arrive while a multi-frame GET_CONTACTS is in flight', async () => {
    const s = await connected({ emu: { contactIntervalMs: 50 }, client: { autoRefreshContacts: false } });
    const log: string[] = [];
    s.client.events.on('advert', () => log.push('advert'));
    const sync = s.client.syncContacts({ full: true }).then((r) => {
      log.push(`synced:${r.contacts.length}`);
      return r;
    });
    await runFor(s.clock, 120);
    s.emu.injectAdvert({ pubKey: s.keys.bob, name: 'Bob', timestamp: START_SECS + 1 });
    const r = await s.run(sync);
    expect(log).toEqual(['advert', 'synced:6']);
    expect(r.total).toBe(6);
    const raw = await s.run(s.client.getContacts(START_SECS + 100_000));
    expect(raw).toEqual({ total: 6, contacts: [], mostRecentLastMod: 0 });
  });

  it('full sync drops contacts the device no longer has', async () => {
    const s = await connected();
    await s.run(s.client.request({ kind: 'removeContact', pubKey: s.keys.bob }, ['ok'])); // behind the cache's back
    expect(s.client.findContact(s.keys.bob)).toBeDefined();
    const changes = s.record('contactsChanged');
    await s.run(s.client.syncContacts({ full: true }));
    expect(s.client.findContact(s.keys.bob)).toBeUndefined();
    expect(changes.at(-1)!.removed.map(toHex)).toEqual([toHex(s.keys.bob)]);
    expect(changes.at(-1)!.full).toBe(true);
  });

  it('dispatches ADVERT and refreshes the contact; auto-added contacts appear', async () => {
    const s = await connected();
    const adverts = s.record('advert');
    const changes = s.record('contactsChanged');
    const erin = scenarioKey('erin');
    s.emu.injectAdvert({ pubKey: erin, name: 'Erin', type: ContactType.CHAT, timestamp: START_SECS + 1 });
    await runFor(s.clock, 10);
    expect(adverts.map((a) => toHex(a.pubKey))).toEqual([toHex(erin)]);
    expect(s.client.findContact(erin)?.name).toBe('Erin');
    expect(changes.at(-1)!.updated.map((c) => c.name)).toEqual(['Erin']);
    expect(s.sent().at(-1)).toBe('getContactByKey');
  });

  it('dispatches NEW_ADVERT in manual-add mode without caching it', async () => {
    const s = await connected();
    await s.run(s.client.setManualAddContacts(true));
    expect(s.emu.prefs.manualAddContacts & 1).toBe(1);
    expect(s.client.selfInfo?.manualAddContacts).toBe(1);
    const news = s.record('newAdvert');
    const frank = scenarioKey('frank');
    s.emu.injectAdvert({ pubKey: frank, name: 'Frank', timestamp: START_SECS + 1 });
    await runFor(s.clock, 10);
    expect(news.map((n) => n.contact.name)).toEqual(['Frank']);
    expect(s.client.findContact(frank)).toBeUndefined();
  });

  it('PATH_UPDATED refreshes the cached path', async () => {
    const s = await connected();
    const paths = s.record('pathUpdated');
    expect(s.client.findContact(s.keys.bob)?.outPathLen).toBe(0xff);
    s.emu.injectPathUpdate(s.keys.bob, encodePathLen(2), Uint8Array.of(0xaa, 0xbb));
    await runFor(s.clock, 10);
    expect(paths).toHaveLength(1);
    expect(s.client.findContact(s.keys.bob)?.outPathLen).toBe(2);
    expect([...s.client.findContact(s.keys.bob)!.outPath]).toEqual([0xaa, 0xbb]);
  });

  it('add / remove / reset path / share / export / import / getContactByKey', async () => {
    const s = await connected();
    const gina = scenarioKey('gina');
    await s.run(s.client.addOrUpdateContact({ pubKey: gina, type: ContactType.CHAT, flags: 0, outPathLen: 0xff, name: 'Gina', lastAdvert: START_SECS }));
    expect(s.client.findContact(gina)?.name).toBe('Gina');
    expect(s.emu.getContact(gina)?.name).toBe('Gina');

    await s.run(s.client.resetPath(s.keys.alice));
    expect(s.emu.getContact(s.keys.alice)?.outPathLen).toBe(0xff);
    expect(s.client.findContact(s.keys.alice)?.outPathLen).toBe(0xff);

    await s.run(s.client.removeContact(gina));
    expect(s.emu.getContact(gina)).toBeUndefined();
    expect(s.client.findContact(gina)).toBeUndefined();
    expect(await s.run(s.client.getContactByKey(gina))).toBeUndefined();
    expect((await s.run(s.client.getContactByKey(s.keys.bob)))?.name).toBe('Bob');

    await s.run(s.client.shareContact(s.keys.repeater));
    expect(s.emu.airLog.some((e) => e.type === 'shareContact')).toBe(true);

    const self = await s.run(s.client.exportContact());
    expect(self[0]).toBe(0x11);
    const exported = await s.run(s.client.exportContact(s.keys.repeater));
    await s.run(s.client.removeContact(s.keys.repeater));
    await s.run(s.client.importContact(exported));
    await runFor(s.clock, 10);
    expect(s.emu.getContact(s.keys.repeater)?.name).toBe('Hilltop Repeater');

    expect(await s.run(s.client.hasConnection(s.keys.bob))).toBe(false);
    expect((await s.run(s.client.getAdvertPath(s.keys.bob)))).toBeUndefined();
  });

  it('CONTACT_DELETED removes the contact from the cache', async () => {
    const s = await connected({ emu: { maxContacts: 6, prefs: { autoAddConfig: 0x01 } } });
    const deleted = s.record('contactDeleted');
    s.emu.injectAdvert({ pubKey: scenarioKey('hank'), name: 'Hank', timestamp: START_SECS + 1 });
    await runFor(s.clock, 10);
    expect(deleted).toHaveLength(1);
    expect(s.client.findContact(deleted[0]!.pubKey)).toBeUndefined();
    expect(s.client.findContact(scenarioKey('hank'))?.name).toBe('Hank');
  });
});

// ---------------------------------------------------------------------------

/** What an app would have saved from the previous session. */
function snapshotOf(s: Setup): ContactsSnapshot {
  return { selfPubKey: s.keys.self, contacts: s.client.contacts, since: s.client.contactsSince };
}

const keysOf = (cs: readonly { pubKey: Uint8Array }[]): string[] => cs.map((c) => toHex(c.pubKey)).sort();

/** Connects a fresh client (as after a page reload) to the same emulator, offering `snap`. */
async function reopen(s: Setup, snap: ContactsSnapshot | (() => never) | undefined, client: CompanionClientOptions = {}) {
  const c = new CompanionClient({ clock: s.clock, autoRefreshContacts: false, ...client });
  const frames: FrameLogEntry[] = [];
  c.events.on('frame', (f) => frames.push(f));
  const changes: ContactsChangedEvent[] = [];
  c.events.on('contactsChanged', (e) => changes.push(e));
  const errors: Error[] = [];
  c.events.on('error', (e) => errors.push(e));
  const loads: SelfInfo[] = [];
  await s.run(
    c.connect(s.emu.createLoopbackTransport(), {
      contactsSnapshot: (self) => {
        loads.push(self);
        return typeof snap === 'function' ? snap() : snap;
      },
    }),
  );
  return {
    client: c,
    changes,
    errors,
    loads,
    sent: frames.filter((f) => f.direction === 'out').map((f) => f.command ?? '?'),
    /** `since` of each GET_CONTACTS sent (§7.2: `[0x04]` or `[0x04, since u32]`; undefined = full). */
    getContacts: frames.filter((f) => f.command === 'getContacts').map((f) => (f.bytes.length === 5 ? readU32LE(f.bytes, 1) : undefined)),
    /** RESP_CODE_CONTACT frames received. */
    received: frames.filter((f) => f.frame?.kind === 'contact').length,
  };
}

describe('incremental contacts sync on reconnect', () => {
  it('asks only for the boundary second when nothing changed', async () => {
    const s = await connected({ client: { autoRefreshContacts: false } });
    const snap = snapshotOf(s);
    await s.run(s.client.disconnect());
    s.clock.advance(60_000);

    const r = await reopen(s, snap);
    expect(toHex(r.loads[0]!.pubKey)).toBe(toHex(s.keys.self));
    expect(r.getContacts).toEqual([snap.since - 1]);
    const boundary = s.emu.contacts.filter((c) => c.lastMod === snap.since).length;
    expect(boundary).toBeGreaterThan(0);
    expect(r.received).toBe(boundary);
    expect(r.received).toBeLessThan(s.emu.contacts.length);
    expect(keysOf(r.client.contacts)).toEqual(keysOf(s.emu.contacts));
    expect(r.client.contacts.map((c) => c.name).sort()).toEqual(s.emu.contacts.map((c) => c.name).sort());
    expect(r.client.contactsSince).toBe(snap.since);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ full: false, removed: [], since: snap.since });
    expect(r.changes[0]!.contacts).toHaveLength(6);
  });

  it('picks up contacts modified or added while disconnected', async () => {
    const s = await connected({ client: { autoRefreshContacts: false } });
    const snap = snapshotOf(s);
    await s.run(s.client.disconnect());
    s.clock.advance(5000);
    const erin = scenarioKey('erin');
    s.emu.injectAdvert({ pubKey: s.keys.carol, name: 'Carol 2', timestamp: START_SECS + 5 });
    s.emu.injectAdvert({ pubKey: erin, name: 'Erin', type: ContactType.CHAT, timestamp: START_SECS + 5 });
    await runFor(s.clock, 10);
    expect(s.emu.contacts).toHaveLength(7);

    const r = await reopen(s, snap);
    expect(r.getContacts).toEqual([snap.since - 1]);
    const boundary = snap.contacts.filter((c) => c.lastMod === snap.since).length;
    expect(r.received).toBe(boundary + 2);
    expect(r.client.findContact(s.keys.carol)?.name).toBe('Carol 2');
    expect(r.client.findContact(erin)?.name).toBe('Erin');
    expect(keysOf(r.client.contacts)).toEqual(keysOf(s.emu.contacts));
    expect(r.client.contactsSince).toBeGreaterThan(snap.since);
    expect(r.changes.at(-1)).toMatchObject({ full: false, removed: [] });
    expect(r.changes.at(-1)!.updated.map((c) => c.name)).toEqual(expect.arrayContaining(['Carol 2', 'Erin']));
  });

  it('falls back to a full sync when the count shows a contact was removed while disconnected', async () => {
    const s = await connected({ client: { autoRefreshContacts: false } });
    const snap = snapshotOf(s);
    await s.run(s.client.disconnect());
    s.emu.handleFrame(encodeCommand({ kind: 'removeContact', pubKey: s.keys.bob })); // e.g. by another app
    expect(s.emu.getContact(s.keys.bob)).toBeUndefined();

    const r = await reopen(s, snap);
    // the incremental reply had total 5 but the merged cache 6: re-read everything
    expect(r.getContacts).toEqual([snap.since - 1, undefined]);
    expect(r.client.findContact(s.keys.bob)).toBeUndefined();
    expect(keysOf(r.client.contacts)).toEqual(keysOf(s.emu.contacts));
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ full: true });
    expect(r.changes[0]!.removed.map(toHex)).toEqual([toHex(s.keys.bob)]);
    expect(r.changes[0]!.updated).toHaveLength(5);
  });

  it('ignores a snapshot of another radio', async () => {
    const s = await connected({ client: { autoRefreshContacts: false } });
    const snap = { ...snapshotOf(s), selfPubKey: DAVE };
    await s.run(s.client.disconnect());
    const r = await reopen(s, snap);
    expect(r.getContacts).toEqual([undefined]);
    expect(r.received).toBe(6);
    expect(r.changes[0]).toMatchObject({ full: true });
  });

  it('ignores the snapshot when the device clock is earlier than its cursor (RTC went backwards)', async () => {
    const s = await connected({ client: { autoRefreshContacts: false } });
    const snap = snapshotOf(s);
    await s.run(s.client.disconnect());
    s.emu.setRtc(snap.since - 3600); // rebooted without an RTC battery
    const r = await reopen(s, snap);
    // the RTC read by the time sync (before it is corrected) decides
    expect(r.sent.slice(2, 5)).toEqual(['getDeviceTime', 'setDeviceTime', 'getContacts']);
    expect(r.getContacts).toEqual([undefined]);
    expect(keysOf(r.client.contacts)).toEqual(keysOf(s.emu.contacts));
  });

  it('reads the RTC for the snapshot check when time sync is off or always sets it', async () => {
    const s = await connected({ client: { autoRefreshContacts: false } });
    const snap = snapshotOf(s);
    await s.run(s.client.disconnect());

    const never = await reopen(s, snap, { timeSync: 'never' });
    expect(never.sent.slice(2, 4)).toEqual(['getDeviceTime', 'getContacts']);
    expect(never.getContacts).toEqual([snap.since - 1]);
    await s.run(never.client.disconnect());

    s.emu.setRtc(snap.since - 10);
    const always = await reopen(s, snap, { timeSync: 'always' });
    expect(always.sent.slice(2, 5)).toEqual(['getDeviceTime', 'setDeviceTime', 'getContacts']);
    expect(always.getContacts).toEqual([undefined]);
    await s.run(always.client.disconnect());

    s.emu.setRtc(snap.since - 10);
    const neverBehind = await reopen(s, snap, { timeSync: 'never' });
    expect(neverBehind.getContacts).toEqual([undefined]);
  });

  it('does a full sync when the snapshot loader fails, and when asked to', async () => {
    const s = await connected({ client: { autoRefreshContacts: false } });
    const snap = snapshotOf(s);
    await s.run(s.client.disconnect());
    const r = await reopen(s, () => {
      throw new Error('IndexedDB unavailable');
    });
    expect(r.errors.map((e) => e.message)).toEqual(['IndexedDB unavailable']);
    expect(r.getContacts).toEqual([undefined]);
    await s.run(r.client.disconnect());

    const again = await reopen(s, snap);
    expect(again.getContacts).toEqual([snap.since - 1]);
    await s.run(again.client.syncContacts({ full: true }));
    const last = again.changes.at(-1)!;
    expect(last.full).toBe(true);
    expect(last.updated).toHaveLength(6);
  });
});

describe('sending text', () => {
  it('returns the ACK code from SENT and matches SEND_CONFIRMED', async () => {
    const s = await connected();
    const confirms = s.record('sendConfirmed');
    const ts = START_SECS + 10;
    const sent = await s.run(s.client.sendTextMessage(s.keys.bob, 'hello bob', { timestamp: ts }));
    expect(sent.ackCode).toBe(computeAckCode(ts, 0, utf8Encode('hello bob'), s.keys.self));
    expect(sent.flood).toBe(true);
    expect(sent.estTimeoutMs).toBeGreaterThan(500);
    const ack = await s.run(s.client.waitForAck(sent.ackCode, sent.estTimeoutMs));
    expect(ack?.ackCode).toBe(sent.ackCode);
    expect(ack?.roundTripMs).toBe(300);
    expect(confirms).toHaveLength(1);
    // already-confirmed acks resolve immediately
    expect(await s.client.waitForAck(sent.ackCode, 0)).toBe(ack);
    expect(await s.run(s.client.waitForAck(12345, 100))).toBeNull();
  });

  it('delivers on the first attempt with progress pending → sent → delivered', async () => {
    const s = await connected();
    const progress: SendProgress[] = [];
    const r = await s.run(s.client.sendTextMessageWithRetry(s.keys.alice, 'ping', { onProgress: (p) => progress.push(p) }));
    expect(r.status).toBe('delivered');
    expect(r.attempts).toBe(1);
    expect(r.pathReset).toBe(false);
    expect(progress.map((p) => p.status)).toEqual(['pending', 'sent', 'delivered']);
    expect(progress[1]!.flood).toBe(false); // Alice has a 1-hop path
    // Alice auto-replies "pong"
    const msgs = s.record('contactMessage');
    await runFor(s.clock, 2000);
    expect(msgs.map((m) => m.message.text)).toEqual(['pong']);
  });

  it('retries with incremented attempt, resets the path and floods when ACKs only come late', async () => {
    const s = await connected({
      nodes: [{ type: 'chat', pubKey: DAVE, name: 'Dave', ackPolicy: { minAttempt: 3 }, contact: onePathVia(scenarioKey('repeater')) }],
    });
    const progress: SendProgress[] = [];
    const t0 = s.clock.now();
    const r = await s.run(s.client.sendTextMessageWithRetry(DAVE, 'are you there?', { onProgress: (p) => progress.push(p) }));
    expect(r.status).toBe('delivered');
    expect(r.attempts).toBe(4);
    expect(r.pathReset).toBe(true);
    expect(r.confirmedAck).toBe(r.ackCodes[3]);
    const node = s.emu.getRemoteNode(DAVE)!;
    expect(node.messages.map((m) => m.attempt)).toEqual([0, 1, 2, 3]);
    expect(new Set(node.messages.map((m) => m.timestamp)).size).toBe(1);
    const air = s.emu.airLog.filter((e) => e.type === 'txtMsg');
    expect(air.map((e) => e.type === 'txtMsg' && e.flood)).toEqual([false, false, false, true]);
    const kinds = s.sent();
    const resetIdx = kinds.lastIndexOf('resetPath');
    expect(resetIdx).toBeGreaterThan(-1);
    expect(kinds.slice(resetIdx + 1)).toContain('sendTxtMsg');
    expect(progress.filter((p) => p.status === 'sent').map((p) => p.attempt)).toEqual([0, 1, 2, 3]);
    expect(progress.at(-1)).toMatchObject({ status: 'delivered', attempt: 3 });
    expect(new Set(r.ackCodes).size).toBe(4);
    // backoff 1 s, 2 s, 4 s between attempts plus est timeouts
    expect(s.clock.now() - t0).toBeGreaterThan(7000);
  });

  it('fails after maxAttempts when the peer never ACKs', async () => {
    const s = await connected({ nodes: [{ type: 'chat', pubKey: DAVE, name: 'Dave', ackPolicy: 'never' }] });
    const progress: SendProgress[] = [];
    const r = await s.run(
      s.client.sendTextMessageWithRetry(DAVE, 'hello?', { maxAttempts: 3, retryDelayMs: () => 100, onProgress: (p) => progress.push(p) }),
    );
    expect(r.status).toBe('failed');
    expect(r.attempts).toBe(3);
    expect(r.pathReset).toBe(false); // already flood: nothing to reset
    expect(progress.at(-1)).toMatchObject({ status: 'failed', attempt: 2 });
    expect(s.emu.getRemoteNode(DAVE)!.messages).toHaveLength(3);
  });

  it('reports a late ACK within lateAckGraceMs', async () => {
    const s = await connected({ nodes: [{ type: 'chat', pubKey: DAVE, name: 'Dave', ackPolicy: 'never' }] });
    const progress: SendProgress[] = [];
    const r = await s.run(s.client.sendTextMessageWithRetry(DAVE, 'x', { maxAttempts: 1, lateAckGraceMs: 30_000, onProgress: (p) => progress.push(p) }));
    expect(r.status).toBe('failed');
    s.emu.injectAck(r.ackCodes[0]!);
    await runFor(s.clock, 10);
    expect(progress.at(-1)).toMatchObject({ status: 'delivered', late: true, attempt: 0 });
  });

  it('serializes retried messages per contact', async () => {
    const s = await connected();
    const order: string[] = [];
    const a = s.client.sendTextMessageWithRetry(s.keys.bob, 'first', { onProgress: (p) => order.push(`first:${p.status}`) });
    const b = s.client.sendTextMessageWithRetry(s.keys.bob, 'second', { onProgress: (p) => order.push(`second:${p.status}`) });
    const [ra, rb] = await s.run(Promise.all([a, b]));
    expect(ra.status).toBe('delivered');
    expect(rb.status).toBe('delivered');
    expect(order).toEqual(['first:pending', 'first:sent', 'first:delivered', 'second:pending', 'second:sent', 'second:delivered']);
  });

  it('maps send errors', async () => {
    const s = await connected();
    const unknown = scenarioKey('nobody');
    await expect(s.run(s.client.sendTextMessage(unknown, 'x'))).rejects.toMatchObject({ name: 'DeviceError', errCode: ERR.NOT_FOUND, errName: 'NOT_FOUND', command: 'sendTxtMsg' });
    await expect(s.run(s.client.sendTextMessage(s.keys.bob, 'y'.repeat(161)))).rejects.toMatchObject({ errName: 'TABLE_FULL' });
    const r = await s.run(s.client.sendTextMessageWithRetry(unknown, 'x'));
    expect(r.status).toBe('failed');
    expect(r.error).toBeInstanceOf(DeviceError);
  });

  it('sends channel messages (OK, not SENT)', async () => {
    const s = await connected();
    await s.run(s.client.sendChannelMessage(1, 'hello channel', { timestamp: START_SECS + 1 }));
    const grp = s.emu.airLog.filter((e) => e.type === 'grpTxt');
    expect(grp).toEqual([{ type: 'grpTxt', channelIdx: 1, timestamp: START_SECS + 1, text: 'Emulator: hello channel' }]);
    await expect(s.run(s.client.sendChannelMessage(99, 'x'))).rejects.toMatchObject({ errName: 'NOT_FOUND' });
    await s.run(s.client.sendChannelData(1, 0xffff, Uint8Array.of(9, 9)));
    expect(s.emu.airLog.some((e) => e.type === 'grpData')).toBe(true);
  });
});

describe('remote requests', () => {
  it('logs in to a repeater and room server', async () => {
    const s = await connected();
    const events = s.record('loginSuccess');
    const ok = await s.run(s.client.login(s.keys.repeater, 'password'));
    expect(ok.isAdmin).toBe(true);
    expect(ok.aclPermissions).toBe(3);
    expect(ok.firmwareVerLevel).toBe(2);
    expect(events).toHaveLength(1);
    const guest = await s.run(s.client.login(s.keys.room, ''));
    expect(guest.adminFlag).toBe(2);
    await s.run(s.client.logout(s.keys.repeater));
  });

  it('times out on a wrong password (servers stay silent) and maps LOGIN_FAIL', async () => {
    const s = await connected({
      nodes: [{ type: 'repeater', pubKey: DAVE, name: 'Strict', password: 'secret', rejectWithResponse: true, contact: { outPathLen: 0 } }],
    });
    await expect(s.run(s.client.login(s.keys.repeater, 'wrong', { timeoutMs: 2000 }))).rejects.toBeInstanceOf(RemoteTimeoutError);
    const fails = s.record('loginFail');
    await expect(s.run(s.client.login(DAVE, 'wrong'))).rejects.toBeInstanceOf(LoginFailedError);
    expect(fails).toHaveLength(1);
  });

  it('gets repeater / room status and sensor telemetry', async () => {
    const s = await connected();
    const st = await s.run(s.client.getStatus(s.keys.repeater));
    expect(st.stats?.kind).toBe('repeater');
    expect(st.stats?.packetsRecv).toBe(1234);
    const room = await s.run(s.client.getStatus(s.keys.room));
    expect(room.stats?.kind).toBe('room');
    const tel = await s.run(s.client.getTelemetry(s.keys.sensor));
    expect(toHex(tel.pubKeyPrefix)).toBe(toHex(s.keys.sensor.slice(0, 6)));
    expect(tel.decoded.readings).toHaveLength(3);
    const self = await s.run(s.client.getTelemetry());
    expect(toHex(self.pubKeyPrefix)).toBe(toHex(s.keys.self.slice(0, 6)));
  });

  it('queues concurrent remote requests: one outstanding on the device at a time', async () => {
    const s = await connected();
    const order: string[] = [];
    const p = Promise.all([
      s.client.login(s.keys.repeater, 'password').then(() => order.push('login')),
      s.client.getStatus(s.keys.repeater).then(() => order.push('status')),
      s.client.getTelemetry(s.keys.sensor).then(() => order.push('telemetry')),
      s.client.binaryRequest(s.keys.repeater, Uint8Array.of(ReqType.GET_OWNER_INFO)).then((d) => order.push(`binary:${new TextDecoder().decode(d).split('\n')[1]}`)),
      // ordinary commands are not blocked by pending remote requests
      s.client.getBattAndStorage().then(() => order.push('batt')),
    ]);
    await s.run(p);
    expect(order).toEqual(['batt', 'login', 'status', 'telemetry', 'binary:Hilltop Repeater']);
    // each request command is only sent after the previous one's response push arrived
    const seq = s.frames
      .filter((f) => ['sendLogin', 'sendStatusReq', 'sendTelemetryReq', 'sendBinaryReq'].includes(f.command ?? '') || ['loginSuccess', 'statusResponse', 'telemetryResponse', 'binaryResponse'].includes(f.frame?.kind ?? ''))
      .map((f) => f.command ?? f.frame?.kind);
    expect(seq).toEqual(['sendLogin', 'loginSuccess', 'sendStatusReq', 'statusResponse', 'sendTelemetryReq', 'telemetryResponse', 'sendBinaryReq', 'binaryResponse']);
  });

  it('times out a silent node and moves on to the next request', async () => {
    const s = await connected({ nodes: [{ type: 'repeater', pubKey: DAVE, name: 'Offline', online: false, contact: { outPathLen: 0 } }] });
    const a = s.client.getStatus(DAVE);
    const b = s.client.getStatus(s.keys.repeater);
    await expect(s.run(a)).rejects.toBeInstanceOf(RemoteTimeoutError);
    expect((await s.run(b)).stats?.kind).toBe('repeater');
  });

  it('path discovery, trace, anon request and remote CLI', async () => {
    const s = await connected();
    const pd = await s.run(s.client.pathDiscovery(s.keys.sensor));
    expect(toHex(pd.pubKeyPrefix)).toBe(toHex(s.keys.sensor.slice(0, 6)));

    const trace = await s.run(s.client.tracePath(s.keys.repeater.slice(0, 1), { tag: 0x1234 }));
    expect(trace.tag).toBe(0x1234);
    expect(trace.snrs).toEqual([8]);

    const acl = await s.run(s.client.anonRequest(s.keys.repeater, Uint8Array.of(ReqType.GET_ACCESS_LIST)));
    expect(toHex(acl.subarray(0, 6))).toBe(toHex(s.keys.self.slice(0, 6)));

    const ver = await s.run(s.client.sendRemoteCliCommand(s.keys.repeater, 'ver'));
    expect(ver).toContain('v1.18.0');
  });
});

describe('device commands', () => {
  it('settings round-trip against the emulator', async () => {
    const s = await connected();
    const selfEvents = s.record('selfInfo');
    await s.run(s.client.setAdvertName('Renamed'));
    expect(s.emu.prefs.name).toBe('Renamed');
    expect(s.client.selfInfo?.name).toBe('Renamed');
    await s.run(s.client.setAdvertLatLon(1.5, -2.25));
    expect(s.emu.prefs.latE6).toBe(1_500_000);
    await s.run(s.client.setRadioParams({ freqKhz: 869525, bwHz: 250000, sf: 11, cr: 5 }));
    expect(s.emu.prefs.radio.sf).toBe(11);
    await s.run(s.client.setTxPower(10));
    expect(s.emu.prefs.radio.txPowerDbm).toBe(10);
    await s.run(s.client.setOtherParams({ multiAcks: 1 }));
    expect(s.emu.prefs.multiAcks).toBe(1);
    expect((await s.run(s.client.getOtherParams())).multiAcks).toBe(1);
    await s.run(s.client.setTuningParams(1.5, 2));
    expect(await s.run(s.client.getTuningParams())).toEqual({ rxDelayBase: 1.5, airtimeFactor: 2 });
    expect(selfEvents.length).toBeGreaterThanOrEqual(5);

    const chans = await s.run(s.client.getChannels());
    expect(chans).toHaveLength(8);
    expect(chans.map((c) => c.name).slice(0, 3)).toEqual(['Public', '#test', '']);
    await s.run(s.client.setChannel(2, 'Secret', new Uint8Array(16).fill(7)));
    expect((await s.run(s.client.getChannel(2))).name).toBe('Secret');
    await expect(s.run(s.client.getChannel(8))).rejects.toMatchObject({ errName: 'NOT_FOUND' });

    expect((await s.run(s.client.getBattAndStorage())).batteryMv).toBeGreaterThan(0);
    expect((await s.run(s.client.getStats('core'))).type).toBe('core');
    expect((await s.run(s.client.getStats('radio'))).type).toBe('radio');
    expect((await s.run(s.client.getStats('packets'))).type).toBe('packets');
    expect(await s.run(s.client.getCustomVars())).toEqual([
      { name: 'gps', value: '0' },
      { name: 'gps_interval', value: '60' },
    ]);
    await s.run(s.client.setCustomVar('gps', '1'));
    expect(s.emu.customVars['gps']).toBe('1');
    await s.run(s.client.setAutoAddConfig(0x06, 3));
    expect(await s.run(s.client.getAutoAddConfig())).toEqual({ config: 0x06, maxHops: 3 });
    expect((await s.run(s.client.getAllowedRepeatFreq())).length).toBeGreaterThan(0);
    await s.run(s.client.sendSelfAdvert('flood'));
    await s.run(s.client.sendSelfAdvert());
    expect(s.emu.airLog.filter((e) => e.type === 'advert').map((e) => e.type === 'advert' && e.flood)).toEqual([true, false]);
    expect(await s.run(s.client.runCliCommand('ver'))).toContain('v1.18.0');
    const t = await s.run(s.client.getDeviceTime());
    expect(t).toBe(s.emu.rtcSecs);
    expect(await s.run(s.client.getDefaultFloodScope())).toBeNull();
  });

  it('private key export / import and DISABLED mapping', async () => {
    const s = await connected();
    const key = await s.run(s.client.exportPrivateKey());
    expect(key).toHaveLength(64);
    await s.run(s.client.importPrivateKey(new Uint8Array(64).fill(3)));
    expect(toHex(s.client.selfInfo!.pubKey)).toBe(toHex(s.emu.publicKey));
    expect(toHex(s.emu.publicKey)).not.toBe(toHex(s.keys.self));

    const d = await connected({ emu: { privateKeyExport: false } });
    await expect(d.run(d.client.exportPrivateKey())).rejects.toMatchObject({ name: 'DeviceError', errName: 'DISABLED', errCode: -1 });
  });

  it('signs data in chunks', async () => {
    const s = await connected();
    const data = new Uint8Array(300).map((_, i) => i & 0xff);
    const sig = await s.run(s.client.sign(data));
    expect(sig).toHaveLength(64);
    const kinds = s.sent().slice(-4);
    expect(kinds).toEqual(['signStart', 'signData', 'signData', 'signFinish']);
    await expect(s.run(s.client.sign(new Uint8Array(9000)))).rejects.toBeInstanceOf(RangeError);
  });

  it('maps ERR codes to DeviceError names', async () => {
    const s = await connected();
    await expect(s.run(s.client.request({ kind: 'raw', bytes: Uint8Array.of(0x35) }, ['ok']))).rejects.toMatchObject({ errName: 'UNSUPPORTED_CMD', errCode: 1 });
    await expect(s.run(s.client.removeContact(scenarioKey('ghost')))).rejects.toMatchObject({ errName: 'NOT_FOUND' });
    await expect(s.run(s.client.setDeviceTime(START_SECS - 10_000))).rejects.toMatchObject({ errName: 'ILLEGAL_ARG' });
    await expect(s.run(s.client.request({ kind: 'signData', chunk: Uint8Array.of(1) }, ['ok']))).rejects.toMatchObject({ errName: 'BAD_STATE' });
    await expect(s.client.removeContact(Uint8Array.of(1, 2, 3, 4, 5, 6))).rejects.toThrow(/unknown contact/);
    await expect(s.client.getStatus(Uint8Array.of(1, 2, 3, 4, 5, 6))).rejects.toThrow(/unknown contact/);
  });

  it('reboot drops the link; factory reset tolerates the missing OK', async () => {
    const s = await connected();
    const disc = s.record('disconnected');
    await s.run(s.client.reboot());
    await runFor(s.clock, 10);
    expect(s.client.state).toBe('disconnected');
    expect(disc).toHaveLength(1);
    expect(disc[0]!.error).toBeInstanceOf(DisconnectedError);

    const f = await connected();
    await f.run(f.client.factoryReset());
    await runFor(f.clock, 10);
    expect(f.client.state).toBe('disconnected');
  });
});

describe('timeouts and disconnects', () => {
  it('times out a command with no reply and continues with the next one', async () => {
    const s = await connected({ client: { requestTimeoutMs: 800 }, transport: filtered((f) => f[0] === CMD.GET_BATT_AND_STORAGE) });
    const a = s.client.getBattAndStorage();
    const b = s.client.getDeviceTime();
    await expect(s.run(a)).rejects.toMatchObject({ name: 'RequestTimeoutError', command: 'getBattAndStorage', timeoutMs: 800 });
    expect(await s.run(b)).toBeGreaterThan(0);
  });

  it('rejects in-flight, queued and remote operations with DisconnectedError on disconnect', async () => {
    const s = await connected({ nodes: [{ type: 'chat', pubKey: DAVE, name: 'Dave', ackPolicy: 'never' }] });
    const disc = s.record('disconnected');
    const status = s.client.getStatus(s.keys.repeater);
    const queuedRemote = s.client.getTelemetry(s.keys.sensor);
    const retry = s.client.sendTextMessageWithRetry(DAVE, 'x');
    const ack = s.client.waitForAck(1, 60_000);
    await runFor(s.clock, 0);
    const inFlight = s.client.getBattAndStorage();
    const queued = s.client.getDeviceTime();
    void s.client.disconnect();
    await expect(status).rejects.toBeInstanceOf(DisconnectedError);
    await expect(queuedRemote).rejects.toBeInstanceOf(DisconnectedError);
    await expect(inFlight).rejects.toBeInstanceOf(DisconnectedError);
    await expect(queued).rejects.toBeInstanceOf(DisconnectedError);
    await expect(ack).rejects.toBeInstanceOf(DisconnectedError);
    const r = await retry;
    expect(r.status).toBe('failed');
    expect(r.error).toBeInstanceOf(DisconnectedError);
    expect(disc).toEqual([{}]);
    expect(s.client.state).toBe('disconnected');
    await expect(s.client.getDeviceTime()).rejects.toBeInstanceOf(DisconnectedError);
  });

  it('can reconnect after a disconnect', async () => {
    const s = await connected();
    await s.client.disconnect();
    const t2 = s.emu.createLoopbackTransport();
    const ev = await s.run(s.client.connect(t2));
    expect(ev.selfInfo.name).toBe('Emulator');
    expect(s.client.contacts).toHaveLength(6);
  });

  it('reports undecodable frames on the error event', async () => {
    let inject: ((f: Uint8Array) => void) | undefined;
    const s = await connected({
      transport: (emu) => {
        const t = new LoopbackTransport((frame) => emu.handleFrame(frame));
        emu.onFrame((f) => t.pushFromDevice(f));
        inject = (f) => t.pushFromDevice(f);
        return t;
      },
    });
    const errors = s.record('error');
    inject!(Uint8Array.of(0x05, 1, 2)); // truncated SELF_INFO
    await runFor(s.clock, 10);
    expect(errors).toHaveLength(1);
    expect(s.frames.at(-1)?.decodeError).toBeDefined();
  });
});

describe('clock', () => {
  it('uses the injected clock for default timestamps', async () => {
    const s = await connected();
    s.clock.advance(60_000);
    const expected = Math.floor(s.clock.now() / 1000);
    const sent = await s.run(s.client.sendTextMessage(s.keys.bob, 'ts'));
    expect(sent.timestamp).toBe(expected);
    expect(s.emu.getRemoteNode(s.keys.bob)).toBeUndefined();
    expect(s.emu.airLog.filter((e) => e.type === 'txtMsg').at(-1)).toMatchObject({ timestamp: expected, text: 'ts' });
  });
});

