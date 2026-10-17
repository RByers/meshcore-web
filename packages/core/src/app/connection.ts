/**
 * Connection state machine: picks a transport, runs the CompanionClient handshake, opens the
 * RadioStore of the connected radio and wires the capture pipeline.
 *
 *   idle ─connect()→ connecting ─transport up→ handshaking ─store open→ connected
 *     connected ─disconnect()→ disconnecting → disconnected
 *     connected ─link lost→ disconnected (error set)
 *     connecting / handshaking ─failure→ error
 *   connect() is allowed again from idle, disconnected and error.
 *   `handshake` reports the running step and an overall fraction from connect() until it settles.
 */

import { CompanionClient } from '../client/companion-client.js';
import type { CompanionClientOptions, ConnectProgressEvent, ConnectStep } from '../client/types.js';
import type { BattAndStorage, DeviceInfo, SelfInfo } from '../protocol/types.js';
import type { FrameTransport, TransportInfo } from '../transport/transport.js';
import { systemClock, type Clock } from '../util/clock.js';
import { TypedEmitter } from '../util/events.js';
import { toHex } from '../util/bytes.js';
import type { DevicesRepo } from '../store/devices.js';
import type { RadioStore } from '../store/radio-store.js';
import type { DeviceRecord } from '../store/schema.js';
import { CapturePipeline } from './capture.js';
import type { NotificationsModel } from './notifications.js';
import { batch, computed, signal, type ReadonlySignal, type Signal } from './signal.js';

export type ConnectionKind = 'serial' | 'ble' | 'emulator';
export const CONNECTION_KINDS: readonly ConnectionKind[] = ['serial', 'ble', 'emulator'];

export function isConnectionKind(v: unknown): v is ConnectionKind {
  return v === 'serial' || v === 'ble' || v === 'emulator';
}

export const CONNECTION_KIND_LABEL: Record<ConnectionKind, string> = {
  serial: 'USB Serial',
  ble: 'Bluetooth',
  emulator: 'Emulator',
};

export type ConnectionPhase = 'idle' | 'connecting' | 'handshaking' | 'connected' | 'disconnecting' | 'disconnected' | 'error';

/** A step of {@link ConnectionModel.connect}: the transport, the client handshake, the local store. */
export type HandshakeStep = 'transport' | ConnectStep | 'store';

/** Progress of a connect in progress ({@link ConnectionModel.handshake}). */
export interface HandshakeProgress {
  step: HandshakeStep;
  /** Human label for the step, with counts where known ("Syncing contacts (12/40)"). */
  label: string;
  done?: number;
  total?: number;
  /** Overall progress 0..1; non-decreasing within one connect. */
  fraction: number;
}

/** Relative share of the progress bar per step (only enabled steps count). */
const HANDSHAKE_WEIGHTS: Record<HandshakeStep, number> = {
  transport: 10,
  deviceQuery: 5,
  appStart: 5,
  timeSync: 5,
  contacts: 50,
  messages: 15,
  store: 10,
};

/** Messages drained at which the messages step is half full (the queue length is unknown). */
const MESSAGES_HALF = 10;

export function handshakeLabel(step: HandshakeStep, done?: number, total?: number): string {
  switch (step) {
    case 'transport':
      return 'Opening connection';
    case 'deviceQuery':
      return 'Querying device';
    case 'appStart':
      return 'Starting session';
    case 'timeSync':
      return 'Syncing clock';
    case 'contacts':
      return total !== undefined ? `Syncing contacts (${done ?? 0}/${total})` : 'Syncing contacts';
    case 'messages':
      return done ? `Fetching messages (${done})` : 'Fetching messages';
    case 'store':
      return 'Opening local database';
  }
}

/**
 * Progress for `step` of a connect running the client steps `clientSteps` (between 'transport'
 * and 'store'). The fraction is the weight of the finished steps plus the done share of the
 * current one (contacts: done/total; messages: asymptotic in done), over the enabled total.
 */
export function handshakeProgress(
  step: HandshakeStep,
  clientSteps: readonly ConnectStep[],
  done?: number,
  total?: number,
): HandshakeProgress {
  const steps: HandshakeStep[] = ['transport', ...clientSteps, 'store'];
  let sum = 0;
  let before = 0;
  for (const st of steps) {
    if (st === step) before = sum;
    sum += HANDSHAKE_WEIGHTS[st];
  }
  let within = 0;
  if (step === 'contacts' && total) within = Math.min(1, (done ?? 0) / total);
  else if (step === 'messages' && done) within = done / (done + MESSAGES_HALF);
  const fraction = steps.includes(step) ? Math.min(1, (before + HANDSHAKE_WEIGHTS[step] * within) / sum) : 0;
  return {
    step,
    label: handshakeLabel(step, done, total),
    ...(done !== undefined ? { done } : {}),
    ...(total !== undefined ? { total } : {}),
    fraction,
  };
}

export interface TransportRequest {
  kind: ConnectionKind;
  /**
   * True to reuse a previously granted device without a chooser (Web Serial `getPorts()`, the
   * emulator). Factories that cannot do so should fall back to (or reject in favour of) a chooser.
   */
  reconnect: boolean;
  /**
   * True when there was no user gesture (resuming on page load): the factory must not open a
   * chooser, and should reject if it has no granted device to reuse.
   */
  auto?: boolean;
  /** The known radio being reconnected, if any. */
  device?: DeviceRecord;
}

/** Thrown by a factory asked for an `auto` connect that has no granted device. */
export class NoGrantedDeviceError extends Error {
  constructor(message = 'No previously allowed device') {
    super(message);
    this.name = 'NoGrantedDeviceError';
  }
}

/** Builds a (not yet connected) transport. May show a browser chooser (needs a user gesture). */
export type TransportFactory = (req: TransportRequest) => FrameTransport | Promise<FrameTransport>;

/** Minimal string key/value store (localStorage in the browser; a Map in tests). */
export interface PreferencesStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function memoryPreferences(init: Record<string, string> = {}): PreferencesStore {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

export const PREF_LAST_KIND = 'meshcore-web.lastTransportKind';
/** '1' while a session is up or was lost; '0' after the user disconnects (see {@link ConnectionModel.resume}). */
export const PREF_RESUME = 'meshcore-web.resumeOnLoad';

export interface ConnectionModelDeps {
  factories: Partial<Record<ConnectionKind, TransportFactory>>;
  /** Kinds whose factory can reconnect without a chooser. Default ['emulator']. */
  reconnectableKinds?: readonly ConnectionKind[];
  openStore: (pubKey: Uint8Array) => Promise<RadioStore>;
  /** The global devices repo (null if IndexedDB is unavailable). */
  devices: () => Promise<DevicesRepo | null>;
  notifications: NotificationsModel;
  preferences?: PreferencesStore;
  /** Default client options; `clock` defaults to {@link ConnectionModelDeps.clock}. */
  clientOptions?: CompanionClientOptions;
  /** Host time + timers for the session (client, capture, device list). Default {@link systemClock}. */
  clock?: Clock;
  /** Read on each compressed DM: auto-enable the sender's SMAZ setting (CapturePipelineOptions). */
  smazAutoEnable?: () => boolean;
}

export interface ConnectionEvents {
  /** The radio is connected and its store is open. */
  connected: { pubKey: string; selfInfo: SelfInfo; kind: ConnectionKind };
  /** The session ended (manual, lost or failed); `error` set unless manual. */
  disconnected: { error?: Error };
}

interface Session {
  id: number;
  kind: ConnectionKind;
  transport?: FrameTransport;
  client?: CompanionClient;
  pipeline?: CapturePipeline;
  store?: RadioStore;
  offs: Array<() => void>;
}

function toErr(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** A dismissed browser chooser (DOMException NotFoundError, possibly wrapped). */
export function isChooserCancelled(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { name?: unknown }).name === 'NotFoundError') return true;
  }
  return false;
}

export class ConnectionModel {
  readonly events = new TypedEmitter<ConnectionEvents>();

  readonly #phase = signal<ConnectionPhase>('idle');
  readonly #kind = signal<ConnectionKind | null>(null);
  readonly #error = signal<Error | null>(null);
  readonly #client = signal<CompanionClient | null>(null);
  readonly #store = signal<RadioStore | null>(null);
  readonly #selfInfo = signal<SelfInfo | null>(null);
  readonly #deviceInfo = signal<DeviceInfo | null>(null);
  readonly #transportInfo = signal<TransportInfo | null>(null);
  readonly #battery = signal<BattAndStorage | null>(null);
  readonly #handshake = signal<HandshakeProgress | null>(null);
  readonly #lastKind: Signal<ConnectionKind | null>;

  readonly phase: ReadonlySignal<ConnectionPhase> = this.#phase.readonly;
  /** Transport kind of the current / last attempt. */
  readonly kind: ReadonlySignal<ConnectionKind | null> = this.#kind.readonly;
  /** Last connection error (cleared by the next connect). */
  readonly error: ReadonlySignal<Error | null> = this.#error.readonly;
  readonly client: ReadonlySignal<CompanionClient | null> = this.#client.readonly;
  /** The connected radio's store; null when not connected. */
  readonly store: ReadonlySignal<RadioStore | null> = this.#store.readonly;
  readonly selfInfo: ReadonlySignal<SelfInfo | null> = this.#selfInfo.readonly;
  readonly deviceInfo: ReadonlySignal<DeviceInfo | null> = this.#deviceInfo.readonly;
  readonly transportInfo: ReadonlySignal<TransportInfo | null> = this.#transportInfo.readonly;
  readonly battery: ReadonlySignal<BattAndStorage | null> = this.#battery.readonly;
  /** Current step and overall fraction while connecting / handshaking; null otherwise. */
  readonly handshake: ReadonlySignal<HandshakeProgress | null> = this.#handshake.readonly;
  /** Last successfully used kind (persisted in preferences). */
  readonly lastKind: ReadonlySignal<ConnectionKind | null>;
  readonly connected: ReadonlySignal<boolean> = computed(() => this.#phase.value === 'connected');
  /** connecting, handshaking or disconnecting. */
  readonly busy: ReadonlySignal<boolean> = computed(() => {
    const p = this.#phase.value;
    return p === 'connecting' || p === 'handshaking' || p === 'disconnecting';
  });
  /** Public key hex of the connected radio. */
  readonly pubKey: ReadonlySignal<string | null> = computed(() => this.#store.value?.pubKey ?? null);

  /** Host time + timers shared by the client and the feature models of this connection. */
  readonly clock: Clock;

  #session: Session | null = null;
  #seq = 0;
  /** Set by {@link expectDisconnect}: the session whose link loss is intentional (reboot…). */
  #expectedLoss: { session: Session; message: string } | null = null;
  #teardown: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ConnectionModelDeps) {
    this.clock = deps.clock ?? systemClock;
    const stored = deps.preferences?.getItem(PREF_LAST_KIND);
    this.#lastKind = signal<ConnectionKind | null>(isConnectionKind(stored) ? stored : null);
    this.lastKind = this.#lastKind.readonly;
  }

  /** Whether a factory for `kind` was provided. */
  isAvailable(kind: ConnectionKind): boolean {
    return this.deps.factories[kind] !== undefined;
  }

  canReconnect(kind: ConnectionKind): boolean {
    return this.isAvailable(kind) && (this.deps.reconnectableKinds ?? ['emulator']).includes(kind);
  }

  /** The capture pipeline of the current session (tests: `await capture.idle()`). */
  get capture(): CapturePipeline | null {
    return this.#session?.pipeline ?? null;
  }

  /**
   * Connects with the given transport kind. Resolves true once connected, false on failure or
   * cancellation (the error is in `error` and a toast is shown). Never rejects.
   */
  async connect(kind: ConnectionKind, opts: { reconnect?: boolean; auto?: boolean; device?: DeviceRecord } = {}): Promise<boolean> {
    const p = this.#phase.peek();
    if (p === 'connecting' || p === 'handshaking' || p === 'connected' || p === 'disconnecting') {
      this.deps.notifications.warning(`Already ${p}`);
      return false;
    }
    const s: Session = { id: ++this.#seq, kind, offs: [] };
    this.#session = s;
    batch(() => {
      this.#phase.value = 'connecting';
      this.#kind.value = kind;
      this.#error.value = null;
      this.#battery.value = null;
      this.#handshake.value = handshakeProgress('transport', []);
    });
    const live = (): boolean => this.#session === s;
    let clientSteps: readonly ConnectStep[] = [];
    const progress = (step: HandshakeStep, done?: number, total?: number): void => {
      if (!live()) return;
      const next = handshakeProgress(step, clientSteps, done, total);
      const prev = this.#handshake.peek();
      this.#handshake.value = prev && prev.fraction > next.fraction ? { ...next, fraction: prev.fraction } : next;
    };
    try {
      await this.#teardown; // a previous session may still be closing its store
      const factory = this.deps.factories[kind];
      if (!factory) throw new Error(`${CONNECTION_KIND_LABEL[kind]} is not available in this browser`);
      const req: TransportRequest = {
        kind,
        reconnect: opts.reconnect ?? false,
        ...(opts.auto ? { auto: true } : {}),
        ...(opts.device ? { device: opts.device } : {}),
      };
      const transport = await factory(req);
      s.transport = transport;
      if (!live()) throw new CancelledError();
      if (transport.state !== 'connected') await transport.connect();
      if (!live()) throw new CancelledError();
      this.#transportInfo.value = transport.info;
      const bleDeviceId = kind === 'ble' ? transport.info.detail : undefined;

      this.#phase.value = 'handshaking';
      const client = new CompanionClient({ clock: this.clock, ...this.deps.clientOptions });
      s.client = client;
      s.offs.push(
        client.events.on('connectProgress', (e: ConnectProgressEvent) => {
          clientSteps = e.steps;
          progress(e.step, e.done, e.total);
        }),
      );
      const devices = await this.deps.devices().catch(() => null);
      s.pipeline = new CapturePipeline(client, {
        devices,
        ...(this.deps.smazAutoEnable ? { smazAutoEnable: this.deps.smazAutoEnable } : {}),
        onError: (err, step) => {
          if (live()) this.deps.notifications.error(`Could not save ${step}`, err);
        },
      });
      const info = await client.connect(transport, {
        // SELF_INFO names the radio: open its store now, so its saved contacts and sync cursor
        // make the connect-time contacts sync incremental
        contactsSnapshot: async (self) => {
          const opened = await this.deps.openStore(self.pubKey);
          if (!live()) {
            opened.close();
            return undefined;
          }
          s.store = opened;
          const snap = await opened.contacts.deviceSnapshot();
          return snap && { selfPubKey: self.pubKey, ...snap };
        },
      });
      if (!live()) throw new CancelledError();

      progress('store');
      let store = s.store;
      if (store?.pubKey !== toHex(info.selfInfo.pubKey)) {
        store?.close();
        store = await this.deps.openStore(info.selfInfo.pubKey);
        s.store = store;
      }
      if (!live()) throw new CancelledError();
      s.pipeline.attachStore(store, async (st) => {
        await devices?.recordConnection(
          {
            pubKey: st.pubKey,
            transport: kind,
            selfInfo: info.selfInfo,
            ...(info.deviceInfo ? { deviceInfo: info.deviceInfo } : {}),
            ...(bleDeviceId !== undefined ? { bleDeviceId } : {}),
          },
          client.clock.now(),
        );
        if (client.connected) await st.channels.syncFromDevice(await client.getChannels(), client.clock.now());
      });

      s.offs.push(
        client.events.on('selfInfo', (si) => {
          if (live()) this.#selfInfo.value = si;
        }),
        client.events.on('disconnected', (e) => {
          if (live()) this.#onLinkLost(s, e.error ?? new Error('link lost'));
        }),
      );
      batch(() => {
        this.#client.value = client;
        this.#store.value = store;
        this.#selfInfo.value = info.selfInfo;
        this.#deviceInfo.value = info.deviceInfo ?? null;
        this.#phase.value = 'connected';
        this.#handshake.value = null;
        this.#lastKind.value = kind;
      });
      this.deps.preferences?.setItem(PREF_LAST_KIND, kind);
      this.deps.preferences?.setItem(PREF_RESUME, '1');
      void this.refreshBattery();
      this.events.emit('connected', { pubKey: store.pubKey, selfInfo: info.selfInfo, kind });
      return true;
    } catch (err) {
      if (err instanceof CancelledError || !live()) {
        await this.#cleanup(s);
        return false;
      }
      this.#session = null;
      await this.#cleanup(s);
      const e = toErr(err);
      if (opts.auto) {
        // resuming on load is best effort: no error state, just say why and offer the buttons
        batch(() => {
          this.#phase.value = 'idle';
          this.#transportInfo.value = null;
        });
        const name = opts.device?.name || CONNECTION_KIND_LABEL[kind];
        this.deps.notifications.warning(`Could not reconnect to ${name} automatically`, e.message || e.name);
        return false;
      }
      if (isChooserCancelled(e)) {
        batch(() => {
          this.#phase.value = 'idle';
          this.#handshake.value = null;
          this.#transportInfo.value = null;
        });
        this.deps.notifications.info('No device selected');
        return false;
      }
      batch(() => {
        this.#phase.value = 'error';
        this.#handshake.value = null;
        this.#error.value = e;
        this.#transportInfo.value = null;
      });
      this.deps.notifications.error(`Could not connect via ${CONNECTION_KIND_LABEL[kind]}`, e);
      this.events.emit('disconnected', { error: e });
      return false;
    }
  }

  /** Reconnects to a known radio (or the last used kind) without a chooser where possible. */
  reconnect(device?: DeviceRecord): Promise<boolean> {
    const kind = device && isConnectionKind(device.transport) ? device.transport : this.#lastKind.peek();
    if (!kind) {
      this.deps.notifications.warning('Nothing to reconnect to');
      return Promise.resolve(false);
    }
    return this.connect(kind, { reconnect: this.canReconnect(kind), ...(device ? { device } : {}) });
  }

  /**
   * On page load: reconnects without a chooser if the previous page was connected (or lost its
   * link) and the user had not disconnected. `device` is the radio to resume (normally the most
   * recently connected one). Resolves false without a toast when there is nothing to resume.
   */
  resume(device?: DeviceRecord): Promise<boolean> {
    if (this.deps.preferences?.getItem(PREF_RESUME) !== '1') return Promise.resolve(false);
    const kind = device ? (isConnectionKind(device.transport) ? device.transport : null) : this.#lastKind.peek();
    if (!kind || !this.canReconnect(kind)) return Promise.resolve(false);
    return this.connect(kind, { reconnect: true, auto: true, ...(device ? { device } : {}) });
  }

  /**
   * Closes the session (also cancels a connect in progress). Unless `keepResume`, the next page
   * load will not reconnect by itself ({@link resume}).
   */
  async disconnect(opts: { keepResume?: boolean } = {}): Promise<void> {
    if (!opts.keepResume) this.deps.preferences?.setItem(PREF_RESUME, '0');
    const s = this.#session;
    if (!s) return;
    this.#session = null;
    batch(() => {
      this.#phase.value = 'disconnecting';
      this.#handshake.value = null;
    });
    await this.#cleanup(s);
    this.#phase.value = 'disconnected';
    this.events.emit('disconnected', {});
  }

  /** Re-reads battery / storage (null if the device does not answer). */
  async refreshBattery(): Promise<BattAndStorage | null> {
    const s = this.#session;
    const client = s?.client;
    if (!client?.connected) return null;
    try {
      const b = await client.getBattAndStorage();
      if (this.#session === s) this.#battery.value = b;
      return b;
    } catch {
      return null;
    }
  }

  /**
   * Marks the next link loss of the current session as intentional (REBOOT, FACTORY_RESET,
   * identity change): it is reported as an info toast with `message` and `disconnected` is
   * emitted without an error.
   */
  expectDisconnect(message: string): void {
    const s = this.#session;
    if (s) this.#expectedLoss = { session: s, message };
  }

  #onLinkLost(s: Session, error: Error): void {
    this.#session = null;
    const expected = this.#expectedLoss?.session === s ? this.#expectedLoss : null;
    this.#expectedLoss = null;
    if (expected) {
      this.#phase.value = 'disconnected';
      this.deps.notifications.info(expected.message);
      void this.#cleanup(s);
      this.events.emit('disconnected', {});
      return;
    }
    batch(() => {
      this.#phase.value = 'disconnected';
      this.#error.value = error;
    });
    this.deps.notifications.error('Connection lost', error);
    void this.#cleanup(s);
    this.events.emit('disconnected', { error });
  }

  /** Releases everything a session holds; store-bound signals clear before the store closes. */
  #cleanup(s: Session): Promise<void> {
    const run = async (): Promise<void> => {
      for (const off of s.offs.splice(0)) off();
      s.pipeline?.stop();
      if (s.client) await s.client.disconnect().catch(() => undefined);
      else if (s.transport) await s.transport.disconnect().catch(() => undefined);
      await s.pipeline?.idle();
      if (this.#session === null || this.#session === s) {
        batch(() => {
          if (this.#store.peek() === s.store || this.#store.peek() === null) {
            this.#store.value = null;
            this.#client.value = null;
            this.#selfInfo.value = null;
            this.#deviceInfo.value = null;
            this.#transportInfo.value = null;
            this.#battery.value = null;
          }
        });
      }
      s.store?.close();
    };
    this.#teardown = this.#teardown.then(run, run);
    return this.#teardown;
  }
}

class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}
