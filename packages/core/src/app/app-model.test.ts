import { describe, expect, it, vi } from 'vitest';
import { toHex } from '../util/bytes.js';
import { TypedEmitter } from '../util/events.js';
import { channelKeyForPsk } from '../store/channels.js';
import type { FrameTransport, TransportEvents } from '../transport/transport.js';
import { FAST_TIMING, publicChannelSecret } from '../emulator/scenarios.js';
import { createEmulatorTransportFactory, type AppModelOptions } from './app-model.js';
import { testApp } from './testing.js';
import { PREF_LAST_KIND, memoryPreferences, type ConnectionPhase } from './connection.js';
import { NotificationsModel } from './notifications.js';
import { effect } from './signal.js';

function makeApp(over: AppModelOptions = {}) {
  const { app, emulator, prefs } = testApp({ app: over });
  const phases: ConnectionPhase[] = [];
  effect(() => {
    phases.push(app.connection.phase.value);
  });
  return { app, emulator, prefs, phases };
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
    await app.connection.disconnect();
    release();
    expect(await p).toBe(false);
    expect(app.connection.phase.value).toBe('disconnected');
    expect(app.notifications.toasts.value.filter((t) => t.kind === 'error')).toEqual([]);
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
    const { app } = makeApp({
      clientOptions: { requestTimeoutMs: 20 },
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
    expect(await app.connection.connect('serial')).toBe(false);
    expect(app.connection.phase.value).toBe('error');
    expect(app.connection.error.value?.name).toBe('RequestTimeoutError');
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
    vi.useFakeTimers();
    try {
      const n = new NotificationsModel(undefined, 3);
      n.info('a');
      n.error('b', new Error('why'));
      n.warning('c');
      expect(n.toasts.value.map((t) => t.message)).toEqual(['a', 'b', 'c']);
      expect(n.toasts.value[1]).toMatchObject({ kind: 'error', detail: 'why', timeoutMs: 0 });
      vi.advanceTimersByTime(5000);
      expect(n.toasts.value.map((t) => t.message)).toEqual(['b', 'c']);
      vi.advanceTimersByTime(3000);
      expect(n.toasts.value.map((t) => t.message)).toEqual(['b']);
      n.success('d');
      n.info('e');
      n.info('f');
      expect(n.toasts.value.map((t) => t.message)).toEqual(['d', 'e', 'f']);
      n.dismiss(n.toasts.value[0]!.id);
      expect(n.toasts.value.map((t) => t.message)).toEqual(['e', 'f']);
      n.clear();
      expect(n.toasts.value).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
