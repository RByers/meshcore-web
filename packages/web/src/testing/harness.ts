/**
 * End-to-end test harness: an AppModel whose USB Serial and Bluetooth factories use the real
 * WebSerialTransport / WebBluetoothTransport over the navigator mocks, with a CompanionEmulator
 * (basicScenario) as the device, plus the in-page Emulator kind. Uses the browser's real
 * IndexedDB behind a per-harness name prefix, so test files can run in parallel iframes;
 * `cleanup()` disposes the model and deletes this harness's databases. Scenarios default to
 * `FAST_TIMING` (ms-scale node delays): tests wait on state, never on wall-clock time. One
 * `SkippableClock` (`h.clock`) drives the app and all three scenarios, so a test reaches a timeout
 * path (ACK timeout, remote-admin timeout, cooldown) by observing the armed state and then calling
 * `h.elapse(ms)` instead of waiting.
 *
 *   const h = createHarness();
 *   const el = await h.mount();             // <mc-app .app=${h.app}> at '#/'
 *   await h.click('[data-connect="serial"]');
 *   await h.until(() => h.app.connection.phase.value === 'connected');
 *   // or, for the in-page emulator: connect, wait for the landing page, then go to a route
 *   await h.connectEmulator('/settings');
 *   ...
 *   afterEach(() => h.cleanup());
 */
import { AppModel, createEmulatorTransportFactory, memoryPreferences, type AppModelOptions } from '@meshcore-web/core/app';
import { FAST_TIMING, basicScenario, type BasicScenario, type BasicScenarioOptions } from '@meshcore-web/core/emulator';
import { DB_PREFIX } from '@meshcore-web/core/store';
import { SkippableClock } from '@meshcore-web/core/util/clock';
import { bleTransportFactory, serialTransportFactory } from '../app-context.js';
import type { McApp } from '../mc-app.js';
import { createMockBluetooth, type MockBluetoothHandle } from './mock-bluetooth.js';
import { createMockSerial, type MockSerialHandle } from './mock-serial.js';

export interface HarnessOptions {
  /** basicScenario options for all three devices (default timing: FAST_TIMING). */
  scenario?: BasicScenarioOptions;
  /** Drop the serial / BLE kinds (as in a browser without the APIs). */
  serial?: boolean;
  ble?: boolean;
  /** Give the mock Bluetooth `getDevices()` (persistent permissions); default true. */
  bleGetDevices?: boolean;
  /** Extra AppModel options (override the defaults below). */
  app?: AppModelOptions;
  /** The clock to use (default: a fresh SkippableClock); pass one to derive scenario options from it. */
  clock?: SkippableClock;
}

export interface Harness {
  app: AppModel;
  /** The one clock behind `app` (unless `opts.app.clock` overrides it) and every scenario. */
  clock: SkippableClock;
  /**
   * Jumps the clock `ms` forward, synchronously firing every timer that falls due (timers must
   * already be armed: wait for the state that proves it first), then lets Lit and one macrotask
   * settle.
   */
  elapse(ms: number): Promise<void>;
  /** The scoped IndexedDB factory `app` uses; pass it to open a second handle on the same databases. */
  indexedDB: IDBFactory;
  /** Mocked navigator.serial with a basicScenario emulator behind it. */
  serial: MockSerialHandle;
  serialScenario: BasicScenario;
  /** Mocked navigator.bluetooth with a basicScenario emulator behind it. */
  ble: MockBluetoothHandle;
  bleScenario: BasicScenario;
  /** The "Emulator" kind's scenario (built on first connect). */
  emulatorScenario(): BasicScenario;
  /** Mounts `<mc-app>` bound to `app` (location hash reset to '#/'). */
  mount(): Promise<McApp>;
  el: McApp | undefined;
  /** Shadow-piercing querySelector across mc-app and its page / toasts. */
  query<T extends Element = HTMLElement>(selector: string): T | null;
  queryAll<T extends Element = HTMLElement>(selector: string): T[];
  click(selector: string): Promise<void>;
  /**
   * Clicks the Emulator connect button, waits for phase 'connected' and for the app's post-connect
   * landing navigation (away from '#/'), then (if `path` is given) navigates to `path` and waits
   * for the hash to settle there. Without `path` the app stays wherever it landed.
   */
  connectEmulator(path?: string, timeoutMs?: number): Promise<void>;
  /** Navigates to `path` (hash route) and waits until `selector` is in the UI. */
  go(path: string, selector: string, timeoutMs?: number): Promise<void>;
  /** Polls `cond` (every animation frame) until truthy; throws after `timeoutMs`. */
  until(cond: () => unknown, timeoutMs?: number, what?: string): Promise<void>;
  /** Text content of the whole UI, shadow roots included. */
  text(): string;
  /** Sets an input / textarea / select value and fires input + change. */
  fill(selector: string, value: string): Promise<void>;
  /**
   * Simulates a page reload: unmounts, disposes `app` and mounts a fresh AppModel (same options,
   * same emulator scenarios, same IndexedDB). `h.app` is replaced.
   */
  reload(): Promise<McApp>;
  cleanup(): Promise<void>;
}

/** Deletes every IndexedDB database whose name starts with `prefix` (default: all of this app's). */
export async function deleteAppDatabases(prefix = DB_PREFIX): Promise<void> {
  const dbs = await indexedDB.databases();
  await Promise.all(
    dbs
      .map((d) => d.name)
      .filter((n): n is string => !!n && n.startsWith(prefix))
      .map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          }),
      ),
  );
}

const RUN_ID = crypto.randomUUID().slice(0, 8);
let harnessSeq = 0;

/**
 * An IDBFactory whose database names are prefixed, so each harness gets private databases even
 * though every scenario shares the same emulator self key and vitest runs files in parallel iframes.
 */
function scopedIndexedDB(prefix: string): IDBFactory {
  const idb = indexedDB;
  return {
    open: (name, version) => idb.open(prefix + name, version),
    deleteDatabase: (name) => idb.deleteDatabase(prefix + name),
    databases: async () =>
      (await idb.databases())
        .filter((d) => d.name?.startsWith(prefix))
        .map((d) => ({ ...d, name: d.name!.slice(prefix.length) })),
    cmp: (a, b) => idb.cmp(a, b),
  } as IDBFactory;
}

function deepQueryAll(root: ParentNode, selector: string, out: Element[] = []): Element[] {
  out.push(...root.querySelectorAll(selector));
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, out);
  return out;
}

function deepText(node: Node): string {
  let s = '';
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof Element && node.shadowRoot) s += deepText(node.shadowRoot);
  for (const c of node.childNodes) s += deepText(c);
  return s;
}

export function createHarness(opts: HarnessOptions = {}): Harness {
  const clock = opts.clock ?? new SkippableClock();
  const scenarioOptions: BasicScenarioOptions = { timing: FAST_TIMING, ...opts.scenario, clock };
  const dbPrefix = `test-${RUN_ID}-${harnessSeq++}/`;
  const idb = scopedIndexedDB(dbPrefix);
  const serialScenario = basicScenario(scenarioOptions);
  const serial = createMockSerial({
    onFrameFromHost: (frame) => serialScenario.emulator.handleFrame(frame),
    info: { usbVendorId: 0x239a, usbProductId: 0x8029 },
  });
  serialScenario.emulator.onFrame((f) => serial.pushFrameToHost(f));

  const bleScenario = basicScenario(scenarioOptions);
  const ble = createMockBluetooth({
    name: 'MeshCore-Emulator',
    getDevices: opts.bleGetDevices ?? true,
    onFrameFromHost: (frame) => bleScenario.emulator.handleFrame(frame),
  });
  bleScenario.emulator.onFrame((f) => ble.pushFrameToHost(f));

  const emulatorFactory = createEmulatorTransportFactory(scenarioOptions);
  // shared across reload() like localStorage
  const preferences = memoryPreferences();
  const makeApp = (): AppModel => new AppModel({
    ...(opts.serial === false ? {} : { createSerialTransport: serialTransportFactory(serial.serial) }),
    ...(opts.ble === false ? {} : { createBleTransport: bleTransportFactory(ble.bluetooth, clock) }),
    createEmulatorTransport: emulatorFactory,
    reconnectableKinds: ['emulator', 'serial', 'ble'],
    indexedDB: idb,
    clock,
    preferences,
    ...opts.app,
  });
  const app = makeApp();

  const h: Harness = {
    app,
    clock,
    async elapse(ms) {
      clock.skip(ms);
      await h.el?.updateComplete;
      await new Promise((r) => setTimeout(r, 0));
      await h.el?.updateComplete;
    },
    indexedDB: idb,
    serial,
    serialScenario,
    ble,
    bleScenario,
    emulatorScenario: () => emulatorFactory.scenario(),
    el: undefined,
    async mount() {
      history.replaceState(null, '', '#/');
      await h.app.init();
      const el = document.createElement('mc-app');
      el.app = h.app;
      document.body.append(el);
      h.el = el;
      await el.updateComplete;
      return el;
    },
    query<T extends Element = HTMLElement>(selector: string): T | null {
      return (h.queryAll<T>(selector)[0] ?? null) as T | null;
    },
    queryAll<T extends Element = HTMLElement>(selector: string): T[] {
      return h.el ? (deepQueryAll(h.el.shadowRoot ?? h.el, selector) as T[]) : [];
    },
    async click(selector) {
      await h.until(() => h.query(selector), 2000, selector);
      h.query(selector)!.click();
      await h.el?.updateComplete;
    },
    async connectEmulator(path, timeoutMs = 10000) {
      await h.click('[data-connect="emulator"]');
      await h.until(() => h.app.connection.phase.value === 'connected', timeoutMs, 'phase connected');
      // the app navigates from '/' to its landing page on 'connected'; wait so it can't override `path`
      await h.until(() => location.hash !== '' && location.hash !== '#/', timeoutMs, 'post-connect landing page');
      if (path !== undefined) {
        const target = `#${path}`;
        if (location.hash !== target) location.hash = target;
        await h.until(() => location.hash === target && h.app.connection.phase.value === 'connected', timeoutMs, `route ${path}`);
      }
      // let the capture pipeline finish the post-connect sync so the stores hold the device's state
      await h.app.connection.capture?.idle();
      await h.el?.updateComplete;
    },
    async go(path, selector, timeoutMs = 5000) {
      location.hash = `#${path}`;
      await h.until(() => h.query(selector), timeoutMs, selector);
    },
    async until(cond, timeoutMs = 5000, what = 'condition') {
      const start = performance.now();
      while (!cond()) {
        if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        // next frame, but never stall if the iframe is throttled / backgrounded
        await new Promise((r) => {
          const t = setTimeout(r, 16);
          requestAnimationFrame(() => (clearTimeout(t), r(undefined)));
        });
      }
    },
    text() {
      return h.el ? deepText(h.el) : '';
    },
    async fill(selector, value) {
      await h.until(() => h.query(selector), 2000, selector);
      const el = h.query<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      await h.el?.updateComplete;
    },
    async reload() {
      h.el?.remove();
      h.el = undefined;
      await h.app.dispose();
      h.app = makeApp();
      return h.mount();
    },
    async cleanup() {
      h.el?.remove();
      h.el = undefined;
      await h.app.dispose();
      clock.clearAll();
      await deleteAppDatabases(dbPrefix);
      history.replaceState(null, '', '#/');
    },
  };
  return h;
}
