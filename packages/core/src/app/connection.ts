/**
 * Connection state machine: picks a transport, runs the CompanionClient handshake, opens the
 * RadioStore of the connected radio and wires the capture pipeline.
 *
 *   idle ─connect()→ connecting ─transport up→ handshaking ─store open→ connected
 *     connected ─disconnect()→ disconnecting → disconnected
 *     connected ─link lost→ disconnected (error set)
 *     connecting / handshaking ─failure→ error
 *   connect() is allowed again from idle, disconnected and error.
 */

import { CompanionClient } from '../client/companion-client.js';
import type { CompanionClientOptions } from '../client/types.js';
import type { BattAndStorage, DeviceInfo, SelfInfo } from '../protocol/types.js';
import type { FrameTransport, TransportInfo } from '../transport/transport.js';
import { TypedEmitter } from '../util/events.js';
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

export interface TransportRequest {
  kind: ConnectionKind;
  /**
   * True to reuse a previously granted device without a chooser (Web Serial `getPorts()`, the
   * emulator). Factories that cannot do so should fall back to (or reject in favour of) a chooser.
   */
  reconnect: boolean;
  /** The known radio being reconnected, if any. */
  device?: DeviceRecord;
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

export interface ConnectionModelDeps {
  factories: Partial<Record<ConnectionKind, TransportFactory>>;
  /** Kinds whose factory can reconnect without a chooser. Default ['emulator']. */
  reconnectableKinds?: readonly ConnectionKind[];
  openStore: (pubKey: Uint8Array) => Promise<RadioStore>;
  /** The global devices repo (null if IndexedDB is unavailable). */
  devices: () => Promise<DevicesRepo | null>;
  notifications: NotificationsModel;
  preferences?: PreferencesStore;
  clientOptions?: CompanionClientOptions;
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

  #session: Session | null = null;
  #seq = 0;
  #teardown: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ConnectionModelDeps) {
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
  async connect(kind: ConnectionKind, opts: { reconnect?: boolean; device?: DeviceRecord } = {}): Promise<boolean> {
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
    });
    const live = (): boolean => this.#session === s;
    try {
      await this.#teardown; // a previous session may still be closing its store
      const factory = this.deps.factories[kind];
      if (!factory) throw new Error(`${CONNECTION_KIND_LABEL[kind]} is not available in this browser`);
      const req: TransportRequest = { kind, reconnect: opts.reconnect ?? false, ...(opts.device ? { device: opts.device } : {}) };
      const transport = await factory(req);
      s.transport = transport;
      if (!live()) throw new CancelledError();
      if (transport.state !== 'connected') await transport.connect();
      if (!live()) throw new CancelledError();
      this.#transportInfo.value = transport.info;

      this.#phase.value = 'handshaking';
      const client = new CompanionClient(this.deps.clientOptions);
      s.client = client;
      const devices = await this.deps.devices().catch(() => null);
      s.pipeline = new CapturePipeline(client, {
        devices,
        onError: (err, step) => {
          if (live()) this.deps.notifications.error(`Could not save ${step}`, err);
        },
      });
      const info = await client.connect(transport);
      if (!live()) throw new CancelledError();

      const store = await this.deps.openStore(info.selfInfo.pubKey);
      s.store = store;
      if (!live()) throw new CancelledError();
      s.pipeline.attachStore(store, async (st) => {
        await devices?.recordConnection(
          { pubKey: st.pubKey, transport: kind, selfInfo: info.selfInfo, ...(info.deviceInfo ? { deviceInfo: info.deviceInfo } : {}) },
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
        this.#lastKind.value = kind;
      });
      this.deps.preferences?.setItem(PREF_LAST_KIND, kind);
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
      if (isChooserCancelled(e)) {
        batch(() => {
          this.#phase.value = 'idle';
          this.#transportInfo.value = null;
        });
        this.deps.notifications.info('No device selected');
        return false;
      }
      batch(() => {
        this.#phase.value = 'error';
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

  /** Closes the session (also cancels a connect in progress). */
  async disconnect(): Promise<void> {
    const s = this.#session;
    if (!s) return;
    this.#session = null;
    this.#phase.value = 'disconnecting';
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

  #onLinkLost(s: Session, error: Error): void {
    this.#session = null;
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
