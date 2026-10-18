/**
 * Root of the application model. The UI creates one AppModel (with real transport factories in
 * the browser, mocks in tests) and binds components to its signals.
 */

import type { CompanionClientOptions } from '../client/types.js';
import type { FrameTransport } from '../transport/transport.js';
import { DevicesRepo } from '../store/devices.js';
import { RadioStore, type RadioStoreOptions } from '../store/radio-store.js';
import type { ConversationType, DeviceRecord } from '../store/schema.js';
import { basicScenario, type BasicScenario, type BasicScenarioOptions } from '../emulator/scenarios.js';
import { systemClock, type Clock } from '../util/clock.js';
import { ChannelsModel } from './channels-model.js';
import { ChatModel, type ChatModelOptions } from './chat-model.js';
import { NodeModel, normalizeNodeRef, type NodeModelOptions } from './node-model.js';
import {
  ConnectionModel,
  memoryPreferences,
  type ConnectionKind,
  type PreferencesStore,
  type TransportFactory,
} from './connection.js';
import { ContactsModel } from './contacts-model.js';
import { ConversationsModel } from './conversations-model.js';
import { DeviceSettingsModel, type GeolocationProvider } from './device-settings-model.js';
import { AppSettingsModel } from './app-settings-model.js';
import { NotificationsModel } from './notifications.js';
import { MapModel } from './map-model.js';
import { PositionEstimatorModel } from './position-estimator.js';
import { PathModel } from './path-model.js';
import { PacketLogModel } from './packet-log-model.js';
import { StorageModel } from './storage-model.js';
import { PacketStatsModel } from './packet-stats-model.js';
import { ContactPathsModel } from './path-history.js';
import { RemoteAdminModel, type RemoteAdminOptions } from './remote-admin-model.js';
import { signal, type ReadonlySignal } from './signal.js';
import { UnreadModel } from './unread-model.js';

export interface AppModelOptions {
  createSerialTransport?: TransportFactory;
  createBleTransport?: TransportFactory;
  /** Default: {@link createEmulatorTransportFactory}(). */
  createEmulatorTransport?: TransportFactory;
  /** Kinds that can reconnect without a chooser. Default ['emulator']. */
  reconnectableKinds?: readonly ConnectionKind[];
  /**
   * `init()` reconnects to the most recent radio if the previous page was connected and the user
   * had not disconnected (see `ConnectionModel.resume`). Default false; on in the browser.
   */
  autoReconnect?: boolean;
  /** IndexedDB factory (default `globalThis.indexedDB`); null disables persistence of the device list. */
  indexedDB?: IDBFactory;
  keyRange?: typeof IDBKeyRange;
  /** Global preferences (last used transport kind…); localStorage in the browser. */
  preferences?: PreferencesStore;
  /** Client options; `clock` defaults to {@link AppModelOptions.clock}. */
  clientOptions?: CompanionClientOptions;
  storeOptions?: Omit<RadioStoreOptions, 'factory' | 'keyRange' | 'clock'>;
  /**
   * The one host time source (wall clock + timers) for every model, store and the client:
   * toasts, cooldowns, timestamps, request timeouts. Default {@link systemClock}.
   */
  clock?: Clock;
  /** Current position for "use my location" in device settings (navigator.geolocation in the browser). */
  geolocation?: GeolocationProvider;
  /** Chat paging and DM retry tuning (tests use short timeouts). */
  messaging?: ChatModelOptions;
  /** Remote admin tuning (tests use short remote timeouts). */
  remoteAdmin?: RemoteAdminOptions;
}

/**
 * The emulator transport: one `basicScenario()` per factory (built on first use and kept, so
 * reconnecting finds the same simulated radio with its state), returning the host end of a new
 * loopback link each time.
 */
export function createEmulatorTransportFactory(
  options: BasicScenarioOptions = {},
): TransportFactory & { scenario(): BasicScenario } {
  let scenario: BasicScenario | undefined;
  const get = (): BasicScenario => (scenario ??= basicScenario(options));
  const f = (): FrameTransport => get().emulator.createLoopbackTransport();
  return Object.assign(f, { scenario: get });
}

/** How many {@link NodeModel}s `AppModel.node` keeps (most recently requested first). */
export const NODE_CACHE_SIZE = 16;

export class AppModel {
  /** Host time + timers shared by every model (UI code reads `app.clock.now()`). */
  readonly clock: Clock;
  readonly notifications: NotificationsModel;
  readonly connection: ConnectionModel;

  readonly #devices = signal<readonly DeviceRecord[]>([]);
  /** Known radios, most recently connected first. */
  readonly devices: ReadonlySignal<readonly DeviceRecord[]> = this.#devices.readonly;

  readonly #opts: AppModelOptions;
  #devicesRepo: Promise<DevicesRepo | null> | undefined;
  #contacts: ContactsModel | undefined;
  #channels: ChannelsModel | undefined;
  #unread: UnreadModel | undefined;
  #conversations: ConversationsModel | undefined;
  #packetLog: PacketLogModel | undefined;
  #packetStats: PacketStatsModel | undefined;
  #deviceSettings: DeviceSettingsModel | undefined;
  #appSettings: AppSettingsModel | undefined;
  readonly #prefs: PreferencesStore;
  #remoteAdmin: RemoteAdminModel | undefined;
  #map: MapModel | undefined;
  #positions: PositionEstimatorModel | undefined;
  #paths: PathModel | undefined;
  #contactPaths: ContactPathsModel | undefined;
  #storage: StorageModel | undefined;
  readonly #chats = new Map<string, ChatModel>();
  readonly #nodes = new Map<string, NodeModel>();
  #offs: Array<() => void> = [];

  constructor(opts: AppModelOptions = {}) {
    this.#opts = opts;
    this.clock = opts.clock ?? systemClock;
    this.#prefs = opts.preferences ?? memoryPreferences();
    this.notifications = new NotificationsModel(this.clock);
    const factories: Partial<Record<ConnectionKind, TransportFactory>> = {
      emulator: opts.createEmulatorTransport ?? createEmulatorTransportFactory(),
    };
    if (opts.createSerialTransport) factories.serial = opts.createSerialTransport;
    if (opts.createBleTransport) factories.ble = opts.createBleTransport;
    this.connection = new ConnectionModel({
      factories,
      reconnectableKinds: opts.reconnectableKinds ?? ['emulator'],
      openStore: (pubKey) => RadioStore.open(pubKey, { ...opts.storeOptions, ...this.#idbOpts() }),
      devices: () => this.devicesRepo(),
      notifications: this.notifications,
      preferences: this.#prefs,
      clock: this.clock,
      smazAutoEnable: () => this.appSettings.smazAutoEnable.peek(),
      ...(opts.clientOptions ? { clientOptions: opts.clientOptions } : {}),
    });
    this.#offs.push(
      this.connection.events.on('connected', () => {
        // the pipeline records the connection first; refresh after its setup step
        void this.connection.capture?.idle().then(() => this.refreshDevices());
      }),
    );
  }

  #idbOpts(): { factory?: IDBFactory; keyRange?: typeof IDBKeyRange; clock: Clock } {
    return {
      clock: this.clock,
      ...(this.#opts.indexedDB ? { factory: this.#opts.indexedDB } : {}),
      ...(this.#opts.keyRange ? { keyRange: this.#opts.keyRange } : {}),
    };
  }

  /**
   * Loads the known-radios list and (with `autoReconnect`) starts resuming the last connection;
   * that runs in the background (watch `connection.phase`). Call once at startup.
   */
  async init(): Promise<void> {
    const devices = await this.refreshDevices();
    if (this.#opts.autoReconnect) void this.connection.resume(devices[0]);
  }

  /** The global DevicesRepo, or null when IndexedDB cannot be opened. */
  devicesRepo(): Promise<DevicesRepo | null> {
    this.#devicesRepo ??= DevicesRepo.open(this.#idbOpts()).catch((err: unknown) => {
      this.notifications.error('Storage unavailable', err);
      return null;
    });
    return this.#devicesRepo;
  }

  async refreshDevices(): Promise<readonly DeviceRecord[]> {
    const repo = await this.devicesRepo();
    this.#devices.value = repo ? await repo.list() : [];
    return this.#devices.peek();
  }

  /** Forgets a known radio (optionally deleting its data). */
  async forgetDevice(pubKey: string, opts: { deleteData?: boolean } = {}): Promise<void> {
    if (this.connection.pubKey.peek() === pubKey) await this.connection.disconnect();
    await (await this.devicesRepo())?.forget(pubKey, opts);
    await this.refreshDevices();
  }

  // ---- feature models (created on first use) ----

  get contacts(): ContactsModel {
    return (this.#contacts ??= new ContactsModel(this.connection).start());
  }

  get channels(): ChannelsModel {
    return (this.#channels ??= new ChannelsModel(this.connection).start());
  }

  get unread(): UnreadModel {
    return (this.#unread ??= new UnreadModel(this.connection).start());
  }

  /** Recent DMs and channels for the messages overview. */
  get conversations(): ConversationsModel {
    return (this.#conversations ??= new ConversationsModel(this.connection).start());
  }

  get packetLog(): PacketLogModel {
    return (this.#packetLog ??= new PacketLogModel(this.connection).start());
  }

  /** Packet log statistics: per-packet points and aggregations for the Stats tab (docs/packet-stats.md). */
  get packetStats(): PacketStatsModel {
    if (!this.#packetStats) {
      const log = this.packetLog;
      // one filter for the List and Stats tabs, owned by the packet log; the log matches the
      // stats drill-downs against the stats model's points
      this.#packetStats = new PacketStatsModel(this.connection, {
        filter: log.sharedFilter,
        context: log.context,
        dmKeys: log.dmKeys,
        contacts: this.contacts.contacts,
        ready: () => Promise.all([log.settled(), this.contacts.settled()]),
      }).start();
      log.attachStats(this.#packetStats);
    }
    return this.#packetStats;
  }

  get deviceSettings(): DeviceSettingsModel {
    return (this.#deviceSettings ??= new DeviceSettingsModel(this.connection, {
      ...(this.#opts.geolocation ? { geolocation: this.#opts.geolocation } : {}),
      storePrivateKey: () => this.appSettings.storePrivateKey.peek(),
      clock: this.clock,
    }));
  }

  /** Local app preferences (theme, time format, retention, private key storage). */
  get appSettings(): AppSettingsModel {
    return (this.#appSettings ??= new AppSettingsModel(this.#prefs, this.connection));
  }

  get remoteAdmin(): RemoteAdminModel {
    return (this.#remoteAdmin ??= new RemoteAdminModel(this.connection, { clock: this.clock, ...this.#opts.remoteAdmin, contacts: this.contacts }));
  }

  /** Node map: contacts with a location, own location, filters (Phase 12). */
  get map(): MapModel {
    return (this.#map ??= new MapModel(this.contacts.views, this.connection.selfInfo, { preferences: this.#prefs, now: () => this.clock.now(), estimates: this.positions.estimates }));
  }

  /** Approximate positions of contacts without a location, while the app setting is on (issue #7). */
  get positions(): PositionEstimatorModel {
    return (this.#positions ??= new PositionEstimatorModel(this.connection, this.contacts, this.appSettings.approximatePositions, { clock: this.clock }).start());
  }

  /** Path views for the "N hops" links: contact / message / packet routes and their map layout (issue #2). */
  get paths(): PathModel {
    return (this.#paths ??= new PathModel({
      contacts: this.contacts.views,
      selfInfo: this.connection.selfInfo,
      store: this.connection.store,
      approximatePositions: this.appSettings.approximatePositions,
    }));
  }

  /** Contact paths: set path, path history with delivery stats, repeater candidates (issue #6). */
  get contactPaths(): ContactPathsModel {
    return (this.#contactPaths ??= new ContactPathsModel(this.connection, this.contacts).start());
  }

  /** Per-radio IndexedDB usage (record counts, approximate size) for the known radios. */
  get storage(): StorageModel {
    return (this.#storage ??= new StorageModel({ devices: this.devices, storeOptions: () => this.#idbOpts() }));
  }

  /** The model of one conversation (cached per conversation). */
  chat(convType: ConversationType, convKey: string): ChatModel {
    const id = `${convType}:${convKey.toLowerCase()}`;
    let m = this.#chats.get(id);
    if (!m) {
      m = new ChatModel(this.connection, convType, convKey, { pathRecorder: this.contactPaths, ...this.#opts.messaging }).start();
      this.#chats.set(id, m);
    }
    return m;
  }

  /**
   * The node page model for a node reference (key, key prefix or hash; cached per normalised ref).
   * The cache keeps the {@link NODE_CACHE_SIZE} most recently requested models and disposes the
   * rest: a non-contact model re-scans the packet log on every logged packet, so an unbounded cache
   * would grow that work forever. Callers must not hold a model across renders — re-request it
   * (the node page calls this on every render) and read the model's `disposed` signal while
   * rendering, so a view still showing an evicted model re-renders and picks up a fresh one.
   * `opts.list` gives the listing-mode model (`/nodes/:prefix`), cached separately.
   */
  node(ref: string, opts: NodeModelOptions = {}): NodeModel {
    const n = normalizeNodeRef(ref) ?? ref.trim().toLowerCase();
    const id = opts.list ? `list:${n}` : n;
    let m = this.#nodes.get(id);
    if (m) {
      this.#nodes.delete(id); // re-insert: Map order is the LRU order, most recent last
    } else {
      m = new NodeModel(n, { connection: this.connection, contacts: this.contacts, packetLog: this.packetLog }, { list: opts.list ?? false });
    }
    this.#nodes.set(id, m);
    for (const [k, old] of this.#nodes) {
      if (this.#nodes.size <= NODE_CACHE_SIZE) break;
      this.#nodes.delete(k);
      old.dispose();
    }
    return m;
  }

  /** Disconnects and releases everything (tests; page unload). The next load may still resume. */
  async dispose(): Promise<void> {
    await this.connection.disconnect({ keepResume: true });
    for (const off of this.#offs.splice(0)) off();
    for (const m of [this.#contacts, this.#channels, this.#unread, this.#conversations, this.#packetLog, this.#packetStats, this.#contactPaths, this.#positions, ...this.#chats.values()]) m?.dispose();
    this.#remoteAdmin?.dispose();
    this.#deviceSettings?.dispose();
    this.#appSettings?.dispose();
    this.#chats.clear();
    for (const m of this.#nodes.values()) m.dispose();
    this.#nodes.clear();
    this.notifications.clear();
    const repo = await this.#devicesRepo;
    repo?.close();
    this.#devicesRepo = undefined;
  }
}
