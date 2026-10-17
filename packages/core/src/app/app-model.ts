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
import { ChannelsModel } from './channels-model.js';
import { ChatModel, type ChatModelOptions } from './chat-model.js';
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
import { NotificationsModel, type NotificationsTimers } from './notifications.js';
import { MapModel } from './map-model.js';
import { PathModel } from './path-model.js';
import { PacketLogModel } from './packet-log-model.js';
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
  /** IndexedDB factory (default `globalThis.indexedDB`); null disables persistence of the device list. */
  indexedDB?: IDBFactory;
  keyRange?: typeof IDBKeyRange;
  /** Global preferences (last used transport kind…); localStorage in the browser. */
  preferences?: PreferencesStore;
  clientOptions?: CompanionClientOptions;
  storeOptions?: Omit<RadioStoreOptions, 'factory' | 'keyRange'>;
  notificationTimers?: NotificationsTimers;
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

export class AppModel {
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
  #deviceSettings: DeviceSettingsModel | undefined;
  #appSettings: AppSettingsModel | undefined;
  readonly #prefs: PreferencesStore;
  #remoteAdmin: RemoteAdminModel | undefined;
  #map: MapModel | undefined;
  #paths: PathModel | undefined;
  #contactPaths: ContactPathsModel | undefined;
  readonly #chats = new Map<string, ChatModel>();
  #offs: Array<() => void> = [];

  constructor(opts: AppModelOptions = {}) {
    this.#opts = opts;
    this.#prefs = opts.preferences ?? memoryPreferences();
    this.notifications = new NotificationsModel(opts.notificationTimers);
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
      ...(opts.clientOptions ? { clientOptions: opts.clientOptions } : {}),
    });
    this.#offs.push(
      this.connection.events.on('connected', () => {
        // the pipeline records the connection first; refresh after its setup step
        void this.connection.capture?.idle().then(() => this.refreshDevices());
      }),
    );
  }

  #idbOpts(): { factory?: IDBFactory; keyRange?: typeof IDBKeyRange } {
    return {
      ...(this.#opts.indexedDB ? { factory: this.#opts.indexedDB } : {}),
      ...(this.#opts.keyRange ? { keyRange: this.#opts.keyRange } : {}),
    };
  }

  /** Loads the known-radios list. Call once at startup. */
  async init(): Promise<void> {
    await this.refreshDevices();
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

  get deviceSettings(): DeviceSettingsModel {
    return (this.#deviceSettings ??= new DeviceSettingsModel(this.connection, {
      ...(this.#opts.geolocation ? { geolocation: this.#opts.geolocation } : {}),
      storePrivateKey: () => this.appSettings.storePrivateKey.peek(),
    }));
  }

  /** Local app preferences (theme, time format, retention, private key storage). */
  get appSettings(): AppSettingsModel {
    return (this.#appSettings ??= new AppSettingsModel(this.#prefs, this.connection));
  }

  get remoteAdmin(): RemoteAdminModel {
    return (this.#remoteAdmin ??= new RemoteAdminModel(this.connection, { ...this.#opts.remoteAdmin, contacts: this.contacts }));
  }

  /** Node map: contacts with a location, own location, filters (Phase 12). */
  get map(): MapModel {
    return (this.#map ??= new MapModel(this.contacts.views, this.connection.selfInfo, { preferences: this.#prefs }));
  }

  /** Path views for the "N hops" links: contact / message / packet routes and their map layout (issue #2). */
  get paths(): PathModel {
    return (this.#paths ??= new PathModel({ contacts: this.contacts.views, selfInfo: this.connection.selfInfo, store: this.connection.store }));
  }

  /** Contact paths: set path, path history with delivery stats, repeater candidates (issue #6). */
  get contactPaths(): ContactPathsModel {
    return (this.#contactPaths ??= new ContactPathsModel(this.connection, this.contacts).start());
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

  /** Disconnects and releases everything (tests; page unload). */
  async dispose(): Promise<void> {
    await this.connection.disconnect();
    for (const off of this.#offs.splice(0)) off();
    for (const m of [this.#contacts, this.#channels, this.#unread, this.#conversations, this.#packetLog, this.#contactPaths, ...this.#chats.values()]) m?.dispose();
    this.#remoteAdmin?.dispose();
    this.#deviceSettings?.dispose();
    this.#appSettings?.dispose();
    this.#chats.clear();
    this.notifications.clear();
    const repo = await this.#devicesRepo;
    repo?.close();
    this.#devicesRepo = undefined;
  }
}
