import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { decodeLpp } from '../packet/lpp.js';
import type { RepeaterStats, ServerStats } from '../protocol/types.js';
import { concatBytes, toHex, u32le } from '../util/bytes.js';
import { AppModel, createEmulatorTransportFactory } from './app-model.js';
import { memoryPreferences } from './connection.js';
import {
  REMOTE_CLI_COMMANDS,
  RemoteAdminModel,
  aclRole,
  completeCliCommand,
  formatSeconds,
  parseHopList,
  rememberedPasswordKey,
  statusFields,
  telemetryItems,
  type RemoteAdminOptions,
} from './remote-admin-model.js';

const apps: AppModel[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
});

async function connected(remoteAdmin: RemoteAdminOptions = { timeoutMs: 4000 }) {
  const factory = createEmulatorTransportFactory();
  const app = new AppModel({
    indexedDB: new IDBFactory(),
    keyRange: IDBKeyRange,
    createEmulatorTransport: factory,
    preferences: memoryPreferences(),
    remoteAdmin,
  });
  apps.push(app);
  expect(await app.connection.connect('emulator')).toBe(true);
  await app.connection.capture!.idle();
  await app.contacts.settled();
  const scenario = factory.scenario();
  const k = Object.fromEntries(Object.entries(scenario.keys).map(([n, v]) => [n, toHex(v)])) as Record<keyof typeof scenario.keys, string>;
  return { app, scenario, k, admin: app.remoteAdmin };
}

const COMMON = {
  batteryMv: 4100,
  txQueueLen: 1,
  noiseFloorDbm: -112,
  lastRssiDbm: -70,
  packetsRecv: 1234,
  packetsSent: 567,
  airTimeSecs: 89,
  upTimeSecs: 90061,
  sentFlood: 300,
  sentDirect: 267,
  recvFlood: 1000,
  recvDirect: 234,
  errEvents: 0,
  lastSnr: 7.25,
  directDups: 3,
  floodDups: 45,
};

describe('pure helpers', () => {
  it('formats repeater and room status fields with units (mesh-packet-format.md §3.2)', () => {
    const rep: RepeaterStats = { kind: 'repeater', ...COMMON, rxAirTimeSecs: 456, recvErrors: 2 };
    const f = Object.fromEntries(statusFields(rep).map((x) => [x.id, x]));
    expect(f['battery']!.display).toBe('4.10 V (4100 mV)');
    expect(f['uptime']!.display).toBe('1d 1h 1m');
    expect(f['noiseFloor']!.display).toBe('-112 dBm');
    expect(f['lastSnr']!.display).toBe('7.25 dB');
    expect(f['rxAirtime']!.display).toBe('7m 36s');
    expect(f['recv']!.display).toBe('1,234');
    expect(f['posted']).toBeUndefined();
    const room: ServerStats = { kind: 'room', ...COMMON, posted: 10, postPush: 20 };
    const r = Object.fromEntries(statusFields(room).map((x) => [x.id, x]));
    expect(r['posted']!.value).toBe(10);
    expect(r['rxAirtime']).toBeUndefined();
    expect(formatSeconds(42)).toBe('42s');
  });

  it('labels LPP telemetry (channel 1 = battery / MCU temperature, §4)', () => {
    // ch1 voltage 3.95 V (116, u16 BE /100 = 0x018B), ch2 temperature 12.5 °C (103, i16 BE /10 = 0x007D)
    const items = telemetryItems(decodeLpp(Uint8Array.of(1, 116, 0x01, 0x8b, 2, 103, 0x00, 0x7d, 1, 103, 0xff, 0xec)));
    expect(items.map((i) => [i.label, i.display])).toEqual([
      ['Battery', '3.95 V'],
      ['Temperature (ch 2)', '12.5 °C'],
      ['MCU temperature', '-2.0 °C'],
    ]);
  });

  it('parses hop lists and ACL roles', () => {
    expect(toHex(parseHopList('a1,b2 c3'))).toBe('a1b2c3');
    expect(toHex(parseHopList('a1b2'))).toBe('a1b2');
    expect(toHex(parseHopList('a1b2,c3d4'))).toBe('a1b2c3d4');
    expect(() => parseHopList('a1,b2c3')).toThrow();
    expect([0, 1, 2, 3, 0x83].map(aclRole)).toEqual(['guest', 'readOnly', 'readWrite', 'admin', 'admin']);
  });

  it('completes CLI commands from the firmware command set', () => {
    expect(REMOTE_CLI_COMMANDS.some((c) => c.usage === 'get radio')).toBe(true);
    expect(completeCliCommand('ve').map((c) => c.usage)).toEqual(['ver']);
    const set = completeCliCommand('set tx', 'repeater');
    expect(set[0]).toMatchObject({ usage: 'set tx <dBm>', completion: 'set tx ' });
    expect(completeCliCommand('neighbors', 'sensor')).toEqual([]);
    expect(completeCliCommand('room.post', 'room')).toHaveLength(1);
  });
});

describe('RemoteNodeModel against the emulator', () => {
  it('logs in as admin and guest to the repeater; wrong password times out', async () => {
    const { admin, k } = await connected({ timeoutMs: 1500 });
    const rep = admin.node(k.repeater);
    expect(rep.contact.value?.name).toBe('Hilltop Repeater');
    expect(rep.kind.value).toBe('repeater');
    const s = await rep.login('password');
    expect(s).toMatchObject({ state: 'admin', role: 'admin', aclPermissions: 3, firmwareVerLevel: 2 });
    expect(rep.isAdmin.value).toBe(true);
    expect((await rep.login('guest')).state).toBe('guest');
    const bad = await rep.login('wrong');
    expect(bad).toMatchObject({ state: 'failed', timedOut: true });
    expect(rep.errors.value.login).toMatch(/timed out/);
    expect(rep.loggedIn.value).toBe(false);
    await rep.logout();
    expect(rep.loginState.value.state).toBe('loggedOut');
  });

  it('logs in to the room server (empty guest password) and decodes room status', async () => {
    const { admin, k } = await connected();
    const room = admin.node(k.room);
    expect((await room.login('')).state).toBe('guest');
    expect((await room.login('password')).state).toBe('admin');
    const st = await room.refreshStatus();
    expect(st.stats.kind).toBe('room');
    expect(st.fields.find((f) => f.id === 'posted')?.value).toBe(10);
    expect(room.lastStatus.value).toBe(st);
  });

  it('decodes repeater status, neighbours, ACL and owner info', async () => {
    const { admin, k } = await connected();
    const rep = admin.node(k.repeater);
    await rep.login('password');
    const st = await rep.refreshStatus();
    expect(st.stats.kind).toBe('repeater');
    const f = Object.fromEntries(st.fields.map((x) => [x.id, x.display]));
    expect(f['battery']).toBe('4.10 V (4100 mV)');
    expect(f['recv']).toBe('1,234');
    expect(f['noiseFloor']).toBe('-112 dBm');
    expect(f['rxAirtime']).toBe('7m 36s');

    const n = await rep.fetchNeighbours();
    expect(n.total).toBe(2);
    expect(n.items.map((i) => [i.name, i.hash, i.heardSecsAgo, i.snr])).toEqual([
      ['Alice', k.alice.slice(0, 12), 120, 9.5],
      ['Bob', k.bob.slice(0, 12), 3600, -4.25],
    ]);
    const acl = await rep.fetchAcl();
    expect(acl.items).toMatchObject([{ hash: k.self.slice(0, 12), name: 'You', role: 'admin', permissions: 3 }]);
    const owner = await rep.fetchOwnerInfo();
    expect(owner).toMatchObject({ firmwareVersion: 'v1.18.0', nodeName: 'Hilltop Repeater', ownerInfo: 'Emulated repeater' });
  });

  it('reads sensor telemetry and min/max/avg', async () => {
    const { admin, k, scenario } = await connected();
    const sensor = admin.node(k.sensor);
    await sensor.login('password');
    const t = await sensor.refreshTelemetry();
    expect(t.items.map((i) => [i.label, i.display])).toEqual([
      ['Battery', '3.95 V'],
      ['MCU temperature', '18.4 °C'],
      ['Temperature (ch 2)', '12.5 °C'],
    ]);
    // GET_AVG_MIN_MAX body after the tag: [now u32] + {ch, type, min, max, avg} (LPPDataHelpers sizes: temp 2 B ×10)
    let req: Uint8Array | undefined;
    scenario.nodes.sensor.remote.config.onBinaryRequest = (type, data) => {
      if (type !== 0x04) return undefined;
      req = data.slice();
      return concatBytes(u32le(scenario.startSecs), Uint8Array.of(2, 103, 0x00, 0x64, 0x00, 0x9b, 0x00, 0x7d));
    };
    const mm = await sensor.fetchAvgMinMax(7200, 0);
    // [type][start u32][end u32][2 reserved]
    expect(toHex(req!)).toBe('04201c00000000000000' + '0000');
    expect(mm.entries).toMatchObject([{ channel: 2, label: 'Temperature (ch 2)', unit: '°C', min: 10, max: 15.5, avg: 12.5 }]);
  });

  it('round-trips CLI commands into the transcript', async () => {
    const { admin, k } = await connected();
    const rep = admin.node(k.repeater);
    await rep.login('password');
    const reply = await rep.runCli('ver');
    expect(reply).toContain('v1.18.0');
    expect(rep.transcript.value.map((e) => [e.direction, e.text])).toEqual([
      ['out', 'ver'],
      ['in', reply],
    ]);
    expect(await rep.runCli('get name')).toBe('> Hilltop Repeater');
    expect(rep.transcript.value).toHaveLength(4);
    rep.clearTranscript();
    expect(rep.transcript.value).toEqual([]);
  });

  it('traces via the repeater (per-hop SNR, names) and discovers a path', async () => {
    const { admin, k } = await connected();
    const rep = admin.node(k.repeater);
    expect(toHex(rep.defaultTracePath().path)).toBe(k.repeater.slice(0, 2));
    const t = await rep.tracePath();
    expect(t.hops).toEqual([{ hash: k.repeater.slice(0, 2), name: 'Hilltop Repeater', ambiguous: false, snr: 8 }]);
    expect(t.finalSnr).toBe(8);
    expect(rep.lastTrace.value).toBe(t);

    const sensor = admin.node(k.sensor);
    expect(toHex(sensor.defaultTracePath().path)).toBe(k.repeater.slice(0, 2).repeat(2));
    const pd = await sensor.discoverPath();
    expect(pd.outPath.map((h) => h.name)).toEqual(['Hilltop Repeater']);
    expect(sensor.pathDiscovery.value).toBe(pd);
  });

  it('resets a path', async () => {
    const { app, admin, k } = await connected();
    const sensor = admin.node(k.sensor);
    expect(sensor.contact.value?.path.kind).not.toBe('flood');
    await sensor.resetPath();
    await app.connection.capture!.idle();
    await app.contacts.settled();
    expect(app.contacts.view(k.sensor)?.path.kind).toBe('flood');
  });

  it('remembers passwords per node (opt-in) in the radio SettingsRepo', async () => {
    const { app, admin, k } = await connected();
    const rep = admin.node(k.repeater);
    await rep.login('password', { remember: true });
    expect(rep.savedPassword.value).toBe('password');
    const store = app.connection.store.value!;
    expect(await store.settings.get(rememberedPasswordKey(k.repeater))).toBe('password');
    const fresh = new RemoteAdminModel(app.connection).node(k.repeater.toUpperCase());
    await fresh.loadSavedPassword();
    expect(fresh.savedPassword.value).toBe('password');
    await rep.login('password', { remember: false });
    expect(rep.savedPassword.value).toBeNull();
    expect(await store.settings.get(rememberedPasswordKey(k.repeater))).toBeUndefined();
  });

  it('surfaces errors and timeouts, and resets on disconnect', async () => {
    const { app, admin, k } = await connected({ timeoutMs: 1500 });
    const sensor = admin.node(k.sensor);
    // sensors do not answer GET_STATUS
    await expect(sensor.refreshStatus()).rejects.toThrow();
    expect(sensor.errors.value.status).toMatch(/timed out/);
    expect(sensor.busy.value.size).toBe(0);
    const rep = admin.node(k.repeater);
    await rep.login('password');
    expect(await rep.runCli('nonsense')).toBe('Unknown command');
    await app.connection.disconnect();
    expect(rep.loginState.value.state).toBe('loggedOut');
    await expect(rep.refreshStatus()).rejects.toThrow('Not connected');
    expect(rep.errors.value.status).toBe('Not connected');
    expect(await rep.runCli('ver')).toBeNull();
    expect(rep.transcript.value.at(-1)).toMatchObject({ direction: 'error', text: 'Not connected' });
  });
});
