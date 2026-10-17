/**
 * Creates the real AppModel (browser transports, IndexedDB, localStorage) and hands it to
 * components without a context library:
 *
 * - `<mc-app>` owns the model (`.app` property, or `getDefaultApp()`), and answers
 *   `mc-app-request` events dispatched by descendants (they bubble and cross shadow roots);
 * - descendants call `requestApp(this)` (or extend `AppElement`), typically in
 *   `connectedCallback`. Tests mount `<mc-app .app=${harness.app}>`.
 */
import { LitElement } from 'lit';
import {
  AppModel,
  NoGrantedDeviceError,
  type AppModelOptions,
  type ConnectionKind,
  type PreferencesStore,
  type TransportFactory,
} from '@meshcore-web/core/app';
import {
  WebBluetoothTransport,
  WebSerialTransport,
  type BluetoothLike,
  type SerialLike,
} from '@meshcore-web/core/transport';
import type { Clock } from '@meshcore-web/core/util/clock';
import { detectFeatures } from './features.js';
import { SignalController } from './signal-controller.js';

export const APP_REQUEST_EVENT = 'mc-app-request';

export interface AppRequestDetail {
  app?: AppModel;
}

/** localStorage, or null when it is unavailable (privacy mode, sandboxed frames). */
export function browserPreferences(): PreferencesStore | undefined {
  try {
    const ls = globalThis.localStorage;
    const probe = '__mc_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return {
      getItem: (k) => {
        try {
          return ls.getItem(k);
        } catch {
          return null;
        }
      },
      setItem: (k, v) => {
        try {
          ls.setItem(k, v);
        } catch {
          /* quota / disabled */
        }
      },
    };
  } catch {
    return undefined;
  }
}

/** How long a remembered Bluetooth radio may take to show up (advertise) before we try anyway. */
export const BLE_RECONNECT_ADVERTISEMENT_TIMEOUT_MS = 10000;

/** USB Serial: a reconnect reopens a port granted before (`getPorts()`), else shows the chooser. */
export function serialTransportFactory(serial: SerialLike): TransportFactory {
  return async (req) => {
    if (req.reconnect) {
      const [port] = await serial.getPorts();
      if (port) return new WebSerialTransport({ port });
    }
    if (req.auto) throw new NoGrantedDeviceError('No previously allowed serial port');
    return new WebSerialTransport({ serial });
  };
}

/**
 * Bluetooth: a reconnect reuses the radio's granted device (`getDevices()`, matched by the stored
 * `bleDeviceId`) and waits for it to advertise; otherwise it shows the chooser.
 */
export function bleTransportFactory(bluetooth: BluetoothLike, clock?: Clock): TransportFactory {
  return async (req) => {
    if (req.reconnect) {
      const device = await WebBluetoothTransport.getGrantedDevice(bluetooth, req.device?.bleDeviceId);
      if (device) {
        return new WebBluetoothTransport({
          device,
          advertisementTimeoutMs: BLE_RECONNECT_ADVERTISEMENT_TIMEOUT_MS,
          ...(clock ? { clock } : {}),
        });
      }
    }
    if (req.auto) throw new NoGrantedDeviceError('No previously allowed Bluetooth device');
    return new WebBluetoothTransport({ bluetooth });
  };
}

/** Options for the real browser AppModel; transports only for the APIs this browser has. */
export function browserAppOptions(g: typeof globalThis = globalThis): AppModelOptions {
  const features = detectFeatures(g);
  const nav = g.navigator as Navigator & { serial?: unknown; bluetooth?: unknown };
  const opts: AppModelOptions = {};
  const reconnectable: ConnectionKind[] = ['emulator'];
  if (features.webSerial) {
    const serial = nav.serial as SerialLike;
    reconnectable.push('serial');
    opts.createSerialTransport = serialTransportFactory(serial);
  }
  if (features.webBluetooth) {
    const bluetooth = nav.bluetooth as BluetoothLike;
    // getDevices() needs persistent Bluetooth permissions (missing in some browsers / behind a flag)
    if (typeof bluetooth.getDevices === 'function') reconnectable.push('ble');
    opts.createBleTransport = bleTransportFactory(bluetooth);
  }
  opts.reconnectableKinds = reconnectable;
  opts.autoReconnect = true;
  const geo = (nav as Navigator & { geolocation?: Geolocation }).geolocation;
  if (geo) {
    opts.geolocation = () =>
      new Promise((resolve, reject) =>
        geo.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
          (e) => reject(new Error(e.message || 'Location unavailable')),
          { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 },
        ),
      );
  }
  const prefs = browserPreferences();
  if (prefs) opts.preferences = prefs;
  return opts;
}

let defaultApp: AppModel | undefined;

/** The page-wide AppModel used when `<mc-app>` is not given one. */
export function getDefaultApp(): AppModel {
  if (!defaultApp) {
    defaultApp = new AppModel(browserAppOptions());
    void defaultApp.init();
  }
  return defaultApp;
}

/** Asks the nearest `<mc-app>` ancestor for the model. */
export function requestApp(el: Element): AppModel | undefined {
  const detail: AppRequestDetail = {};
  el.dispatchEvent(new CustomEvent<AppRequestDetail>(APP_REQUEST_EVENT, { detail, bubbles: true, composed: true }));
  return detail.app;
}

/** Makes `host` answer app requests from its descendants. Returns a remover. */
export function provideApp(host: Element, get: () => AppModel): () => void {
  const onRequest = (e: Event): void => {
    const ev = e as CustomEvent<AppRequestDetail>;
    // the provider's own requests go to its ancestors
    if (ev.detail.app || ev.composedPath()[0] === host) return;
    ev.detail.app = get();
    ev.stopPropagation();
  };
  host.addEventListener(APP_REQUEST_EVENT, onRequest);
  return () => host.removeEventListener(APP_REQUEST_EVENT, onRequest);
}

/**
 * Base for components bound to the AppModel: resolves `app` on connect (an explicitly set
 * `.app` wins) and re-renders on signals read in render.
 */
export class AppElement extends LitElement {
  #app: AppModel | undefined;
  protected readonly signals = new SignalController(this);

  get app(): AppModel {
    if (!this.#app) this.#app = requestApp(this) ?? getDefaultApp();
    return this.#app;
  }

  set app(v: AppModel) {
    this.#app = v;
    this.requestUpdate();
  }

  override connectedCallback(): void {
    if (!this.#app) {
      const found = requestApp(this);
      if (found) this.#app = found;
    }
    super.connectedCallback();
  }
}
