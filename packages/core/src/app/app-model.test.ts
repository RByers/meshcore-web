import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { toHex } from '../util/bytes.js';
import { TypedEmitter } from '../util/events.js';
import { channelKeyForPsk } from '../store/channels.js';
import type { FrameTransport, TransportEvents } from '../transport/transport.js';
import { FAST_TIMING, publicChannelSecret } from '../emulator/scenarios.js';
import { createEmulatorTransportFactory, type AppModelOptions } from './app-model.js';
import { testApp } from './testing.js';
import { NoGrantedDeviceError, PREF_LAST_KIND, PREF_RESUME, handshakeLabel, handshakeProgress, memoryPreferences, type ConnectionPhase, type HandshakeProgress } from './connection.js';
import { NotificationsModel } from './notifications.js';
import { ManualClock } from '../util/clock.js';
import { effect } from './signal.js';

function makeApp(over: AppModelOptions = {}) {
  const t = testApp({ app: over });
  const { app, emulator, prefs } = t;
  const phases: ConnectionPhase[] = [];
  const handshakes: Array<{ phase: ConnectionPhase; progress: HandshakeProgress | null }> = [];
  effect(() => {
    phases.push(app.connection.phase.value);
  });
  effect(() => {
    handshakes.push({ phase: app.connection.phase.peek(), progress: app.connection.handshake.value });
  });
  return { t, app, emulator, prefs, phases, handshakes };
}

/** A transport that fails to connect. */
function brokenTransport(err: Error): FrameTransport {
  return {
    kind: 'serial',
    state: 'disconnected',
    info: { kind: 'serial', name: 'broken' },
    events: new TypedEmitter<TransportEvents>(),
    connect: () => Promise.reject(err),
    disconnect: () => Promise.resolve(),
    send: () => Promise.reject(new Error('not connected')),
  };
}

describe('ConnectionModel with the emulator', () => {
  it('connects, handshakes and opens the store under the radio pubkey', async () => {
    const { app, emulator, phases, prefs } = makeApp();
    await app.init();
    expect(app.devices.value).toEqual([]);
    expect(await app.connection.connect('emulator')).toBe(true);
    const keys = emulator.scenario().keys;
    expect(phases).toEqual(['idle', 'connecting', 'handshaking', 'connected']);
    expect(app.connection.selfInfo.value?.name).toBe('Emulator');
    expect(app.connection.deviceInfo.value?.firmwareVerCode).toBeGreaterThan(0);
    expect(app.connection.store.value?.pubKey).toBe(toHex(keys.self));
    expect(app.connection.pubKey.value).toBe(toHex(keys.self));
    expect(app.connection.transportInfo.value?.name).toBe('Emulator');
    expect(app.connection.lastKind.value).toBe('emulator');
    expect(prefs.getItem(PREF_LAST_KIND)).toBe('emulator');
    await vi.waitFor(() => expect(app.connection.battery.value?.batteryMv).toBeGreaterThan(0));
  });

  it('reports handshake progress step by step with a monotonic fraction, then clears it', async () => {
    const { app, handshakes } = makeApp();
    expect(await app.connection.connect('emulator')).toBe(true);
    expect(app.connection.handshake.value).toBeNull();
    expect(handshakes.at(-1)).toEqual({ phase: 'connected', progress: null });

    const progress = handshakes.slice(1, -1).map((h) => h.progress!);
    expect(handshakes[0]?.progress).toBeNull();
    expect(progress.every((p) => p !== null)).toBe(true);
    expect([...new Set(progress.map((p) => p.step))]).toEqual([
      'transport',
      'deviceQuery',
      'appStart',
      'timeSync',
      'contacts',
      'messages',
      'store',
    ]);
    const fractions = progress.map((p) => p.fraction);
    expect(fractions[0]).toBe(0);
    for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]!);
    expect(progress.at(-1)).toMatchObject({ step: 'store', label: 'Opening local database', fraction: 0.9 });
    expect(progress.map((p) => p.label)).toContain('Syncing contacts (6/6)');
    expect(progress.map((p) => p.label)).toContain('Fetching messages (1)');
    // contacts reach the end of their share before messages start
    const lastContacts = progress.filter((p) => p.step === 'contacts').at(-1)!;
    expect(lastContacts.fraction).toBeCloseTo(0.75);
  });

  it('captures every frame, persists messages, contacts, channels and the device record', async () => {
    const { app, emulator } = makeApp();
    await app.connection.connect('emulator');
    const store = app.connection.store.value!;
    await app.connection.capture!.idle();
    const keys = emulator.scenario().keys;

    const frames = await store.frames.query({ limit: 1000 });
    const kinds = frames.items.map((f) => `${f.direction}:${f.kind}`);
    expect(kinds).toContain('out:deviceQuery');
    expect(kinds).toContain('in:deviceInfo');
    expect(kinds).toContain('out:appStart');
    expect(kinds).toContain('in:selfInfo');
    expect(kinds).toContain('in:channelInfo');
    expect(app.connection.capture!.framesCaptured).toBe(frames.items.length);

    const contacts = await store.contacts.list();
    expect(contacts.map((c) => c.name).sort()).toEqual(['Alice', 'Bob', 'Carol', 'Hilltop Repeater', 'Town Square', 'Weather Station']);

    const alice = await store.messages.list(toHex(keys.alice));
    expect(alice.items.map((m) => m.text)).toEqual(['Hi! Are you on the mesh today?']);
    expect(alice.items[0]!.rawFrameId).toBeGreaterThan(0);
    const publicKey = await channelKeyForPsk(publicChannelSecret());
    const pub = await store.messages.list(publicKey);
    expect(pub.items.map((m) => [m.senderName, m.text])).toEqual([['Dave', 'Good morning everyone']]);
    expect((await store.channels.list()).map((c) => c.name)).toEqual(['Public', '#test']);
    expect(await store.messages.totalUnread()).toEqual({ contacts: 2, channels: 1, total: 3 });

    await vi.waitFor(() => expect(app.devices.value.map((d) => d.pubKey)).toEqual([toHex(keys.self)]));
    expect(app.devices.value[0]!.transport).toBe('emulator');
    expect(app.devices.value[0]!.deviceInfo).toBeDefined();
  });

  it('feeds the feature models from the store', async () => {
    const { app, emulator } = makeApp();
    const contacts = app.contacts;
    expect(contacts.contacts.value).toEqual([]);
    await app.connection.connect('emulator');
    await app.connection.capture!.idle();
    await vi.waitFor(() => expect(contacts.contacts.value).toHaveLength(6));
    await vi.waitFor(() => expect(app.channels.channels.value.map((c) => c.name)).toEqual(['Public', '#test']));
    await vi.waitFor(() => expect(app.unread.totals.value.total).toBe(3));
    expect(contacts.countsByType.value).toEqual({ chat: 3, repeater: 1, room: 1, sensor: 1 });

    const keys = emulator.scenario().keys;
    const chat = app.chat('contact', toHex(keys.alice));
    await chat.settled();
    expect(chat.messages.value.map((m) => m.text)).toEqual(['Hi! Are you on the mesh today?']);
    expect(chat.unread.value).toBe(1);

    // a live message arrives (MSG_WAITING → sync → capture → model)
    emulator.scenario().emulator.injectContactMessage(keys.alice, 'Still there?');
    await vi.waitFor(() => expect(chat.messages.value.map((m) => m.text)).toContain('Still there?'));
    await vi.waitFor(() => expect(chat.unread.value).toBe(2));
    await chat.markRead();
    await vi.waitFor(() => expect(app.unread.totals.value.contacts).toBe(1));

    await app.connection.disconnect();
    expect(contacts.contacts.value).toEqual([]);
    expect(chat.messages.value).toEqual([]);
    expect(app.unread.totals.value.total).toBe(0);
  });

  it('disconnects and reconnects to the same radio without duplicating history', async () => {
    const { app, phases } = makeApp();
    await app.connection.connect('emulator');
    const pubKey = app.connection.pubKey.value!;
    await app.connection.capture!.idle();
    await app.connection.disconnect();
    expect(app.connection.phase.value).toBe('disconnected');
    expect(app.connection.store.value).toBeNull();
    expect(app.connection.client.value).toBeNull();
    expect(app.connection.selfInfo.value).toBeNull();
    expect(app.connection.error.value).toBeNull();

    await app.refreshDevices();
    const dev = app.devices.value[0]!;
    expect(app.connection.canReconnect('emulator')).toBe(true);
    expect(await app.connection.reconnect(dev)).toBe(true);
    expect(app.connection.pubKey.value).toBe(pubKey);
    expect(phases.slice(-5)).toEqual(['disconnecting', 'disconnected', 'connecting', 'handshaking', 'connected']);
    await app.connection.capture!.idle();
    const store = app.connection.store.value!;
    const total = (await store.messages.totalUnread()).total;
    expect(total).toBe(3);
  });

  it('refuses a second connect while connected', async () => {
    const { app } = makeApp();
    await app.connection.connect('emulator');
    expect(await app.connection.connect('emulator')).toBe(false);
    expect(app.notifications.toasts.value.at(-1)?.kind).toBe('warning');
    expect(app.connection.phase.value).toBe('connected');
  });

  it('reports a lost link', async () => {
    const { app } = makeApp();
    await app.connection.connect('emulator');
    await app.connection.client.value!.transport!.disconnect();
    await vi.waitFor(() => expect(app.connection.phase.value).toBe('disconnected'));
    expect(app.connection.error.value).toBeInstanceOf(Error);
    expect(app.notifications.toasts.value.map((t) => t.message)).toContain('Connection lost');
    await vi.waitFor(() => expect(app.connection.store.value).toBeNull());
  });

  it('cancels a connect in progress on disconnect()', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const emu = createEmulatorTransportFactory({ timing: FAST_TIMING });
    const { app } = makeApp({
      createEmulatorTransport: async (req) => {
        await gate;
        return emu(req);
      },
    });
    const p = app.connection.connect('emulator');
    expect(app.connection.phase.value).toBe('connecting');
    expect(app.connection.handshake.value).toMatchObject({ step: 'transport', label: 'Opening connection', fraction: 0 });
    await app.connection.disconnect();
    expect(app.connection.handshake.value).toBeNull();
    release();
    expect(await p).toBe(false);
    expect(app.connection.phase.value).toBe('disconnected');
    expect(app.notifications.toasts.value.filter((t) => t.kind === 'error')).toEqual([]);
  });
});

describe('handshake progress helpers', () => {
  it('labels steps with their counts', () => {
    expect(handshakeLabel('contacts')).toBe('Syncing contacts');
    expect(handshakeLabel('contacts', 12, 40)).toBe('Syncing contacts (12/40)');
    expect(handshakeLabel('messages', 0)).toBe('Fetching messages');
    expect(handshakeLabel('messages', 3)).toBe('Fetching messages (3)');
  });

  it('weights only the enabled steps so the bar reaches the end', () => {
    // transport 10 + deviceQuery 5 + appStart 5 + store 10 = 30
    const steps = ['deviceQuery', 'appStart'] as const;
    expect(handshakeProgress('transport', steps).fraction).toBe(0);
    expect(handshakeProgress('appStart', steps).fraction).toBeCloseTo(15 / 30);
    expect(handshakeProgress('store', steps).fraction).toBeCloseTo(20 / 30);
    const all = ['deviceQuery', 'appStart', 'timeSync', 'contacts', 'messages'] as const;
    expect(handshakeProgress('contacts', all, 20, 40)).toMatchObject({ done: 20, total: 40, fraction: 0.5 });
    expect(handshakeProgress('contacts', all, 0, 0).fraction).toBeCloseTo(0.25);
    const m = handshakeProgress('messages', all, 1000).fraction;
    expect(m).toBeGreaterThan(0.89);
    expect(m).toBeLessThan(0.9);
  });
});

describe('ConnectionModel errors', () => {
  it('enters the error state when the transport connect rejects', async () => {
    const { app, phases } = makeApp({ createSerialTransport: () => brokenTransport(new Error('port busy')) });
    expect(app.connection.isAvailable('serial')).toBe(true);
    expect(app.connection.isAvailable('ble')).toBe(false);
    expect(await app.connection.connect('serial')).toBe(false);
    expect(phases).toEqual(['idle', 'connecting', 'error']);
    expect(app.connection.error.value?.message).toBe('port busy');
    expect(app.connection.handshake.value).toBeNull();
    const t = app.notifications.toasts.value.at(-1)!;
    expect(t).toMatchObject({ kind: 'error', message: 'Could not connect via USB Serial', detail: 'port busy' });
    expect(app.connection.store.value).toBeNull();
    // and can connect again afterwards
    expect(await app.connection.connect('emulator')).toBe(true);
    expect(app.connection.error.value).toBeNull();
  });

  it('errors when no factory exists for the kind', async () => {
    const { app } = makeApp();
    expect(await app.connection.connect('ble')).toBe(false);
    expect(app.connection.error.value?.message).toMatch(/Bluetooth is not available/);
  });

  it('treats a dismissed chooser as a cancel, not an error', async () => {
    const { app } = makeApp({
      createBleTransport: () => {
        const e = new Error('User cancelled the requestDevice() chooser.');
        e.name = 'NotFoundError';
        throw e;
      },
    });
    expect(await app.connection.connect('ble')).toBe(false);
    expect(app.connection.phase.value).toBe('idle');
    expect(app.connection.error.value).toBeNull();
    expect(app.notifications.toasts.value.at(-1)).toMatchObject({ kind: 'info', message: 'No device selected' });
  });

  it('fails the handshake when the device never answers', async () => {
    const { t, app } = makeApp({
      createSerialTransport: () => {
        const ev = new TypedEmitter<TransportEvents>();
        let state: FrameTransport['state'] = 'disconnected';
        return {
          kind: 'serial',
          get state() {
            return state;
          },
          info: { kind: 'serial', name: 'silent' },
          events: ev,
          connect: async () => {
            state = 'connected';
          },
          disconnect: async () => {
            state = 'disconnected';
          },
          send: async () => undefined,
        };
      },
    });
    const connecting = app.connection.connect('serial');
    // the client's default 5 s request timeout (armed once the write lands): DEVICE_QUERY's is
    // tolerated (very old firmware), APP_START's fails the handshake
    await vi.waitFor(() => expect(app.connection.handshake.value?.step).toBe('deviceQuery'));
    await t.elapsePending(5000);
    await vi.waitFor(() => expect(app.connection.handshake.value?.label).toBe('Starting session'));
    await t.elapsePending(5000);
    expect(await connecting).toBe(false);
    expect(app.connection.phase.value).toBe('error');
    expect(app.connection.error.value?.name).toBe('RequestTimeoutError');
    expect(app.connection.handshake.value).toBeNull();
  });

  it('resumes the last connection on load unless the user disconnected', async () => {
    // three page loads sharing storage, preferences and the emulated radio
    const base = testApp();
    const shared: AppModelOptions = {
      indexedDB: new IDBFactory(),
      createEmulatorTransport: base.emulator,
      preferences: base.prefs,
      autoReconnect: true,
    };
    const prefs = base.prefs;
    const load = () => testApp({ app: shared }).app;

    const first = load();
    await first.init();
    expect(first.connection.phase.value).toBe('idle'); // nothing to resume yet
    expect(await first.connection.connect('emulator')).toBe(true);
    const pubKey = first.connection.pubKey.value;
    await first.connection.capture!.idle();
    expect(prefs.getItem(PREF_RESUME)).toBe('1');
    await first.dispose(); // page unload: still resumable

    const second = load();
    await second.init();
    await vi.waitFor(() => expect(second.connection.phase.value).toBe('connected'));
    expect(second.connection.pubKey.value).toBe(pubKey);
    await second.connection.disconnect(); // user choice: do not resume
    expect(prefs.getItem(PREF_RESUME)).toBe('0');
    await second.dispose();

    const third = load();
    await third.init();
    expect(third.connection.phase.value).toBe('idle');
  });

  it('does not resume on load without autoReconnect or for a kind that needs a chooser', async () => {
    const prefs = memoryPreferences({ [PREF_RESUME]: '1', [PREF_LAST_KIND]: 'emulator' });
    const off = makeApp({ preferences: prefs }).app;
    await off.init();
    expect(off.connection.phase.value).toBe('idle');

    const serial = vi.fn(() => brokenTransport(new Error('unused')));
    const chooser = makeApp({
      preferences: memoryPreferences({ [PREF_RESUME]: '1', [PREF_LAST_KIND]: 'serial' }),
      createSerialTransport: serial,
      autoReconnect: true,
    }).app;
    await chooser.init();
    expect(serial).not.toHaveBeenCalled(); // serial is not in reconnectableKinds here
    expect(chooser.connection.phase.value).toBe('idle');
  });

  it('a failed resume goes back to idle with a warning, not an error', async () => {
    const factory = vi.fn((req: { auto?: boolean; reconnect: boolean }) => {
      expect(req).toMatchObject({ auto: true, reconnect: true });
      throw new NoGrantedDeviceError();
    });
    const { app, phases } = makeApp({
      preferences: memoryPreferences({ [PREF_RESUME]: '1', [PREF_LAST_KIND]: 'serial' }),
      createSerialTransport: factory,
      reconnectableKinds: ['serial'],
    });
    expect(await app.connection.resume()).toBe(false);
    expect(factory).toHaveBeenCalledOnce();
    expect(phases).toEqual(['idle', 'connecting', 'idle']);
    expect(app.connection.error.value).toBeNull();
    const toast = app.notifications.toasts.value.at(-1);
    expect(toast).toMatchObject({ kind: 'warning', message: 'Could not reconnect to USB Serial automatically' });
  });

  it('restores the last used kind from preferences', () => {
    const { app } = testApp({ app: { preferences: memoryPreferences({ [PREF_LAST_KIND]: 'serial' }) } });
    expect(app.connection.lastKind.value).toBe('serial');
    const { app: bad } = testApp({ app: { preferences: memoryPreferences({ [PREF_LAST_KIND]: 'tcp' }) } });
    expect(bad.connection.lastKind.value).toBeNull();
  });
});

describe('NotificationsModel', () => {
  it('auto-dismisses by kind, keeps errors, caps the list', () => {
    const clock = new ManualClock();
    const n = new NotificationsModel(clock, 3);
    n.info('a');
    n.error('b', new Error('why'));
    n.warning('c');
    expect(n.toasts.value.map((t) => t.message)).toEqual(['a', 'b', 'c']);
    expect(n.toasts.value[0]).toMatchObject({ kind: 'info', createdAt: clock.now() });
    expect(n.toasts.value[1]).toMatchObject({ kind: 'error', detail: 'why', timeoutMs: 0 });
    clock.advance(4999);
    expect(n.toasts.value).toHaveLength(3);
    clock.advance(1);
    expect(n.toasts.value.map((t) => t.message)).toEqual(['b', 'c']);
    clock.advance(3000);
    expect(n.toasts.value.map((t) => t.message)).toEqual(['b']);
    n.success('d');
    n.info('e');
    n.info('f');
    expect(n.toasts.value.map((t) => t.message)).toEqual(['d', 'e', 'f']);
    n.dismiss(n.toasts.value[0]!.id);
    expect(n.toasts.value.map((t) => t.message)).toEqual(['e', 'f']);
    n.clear();
    expect(n.toasts.value).toEqual([]);
  });
});
