/**
 * End-to-end test harness: an AppModel whose USB Serial and Bluetooth factories use the real
 * WebSerialTransport / WebBluetoothTransport over the navigator mocks, with a CompanionEmulator
 * (basicScenario) as the device, plus the in-page Emulator kind. Uses the browser's real
 * IndexedDB; `cleanup()` disposes the model and deletes every meshcore-web database.
 *
 *   const h = createHarness();
 *   const el = await h.mount();             // <mc-app .app=${h.app}> at '#/'
 *   await h.click('[data-connect="serial"]');
 *   await h.until(() => h.app.connection.phase.value === 'connected');
 *   ...
 *   afterEach(() => h.cleanup());
 */
import { AppModel, createEmulatorTransportFactory, type AppModelOptions } from '@meshcore-web/core/app';
import { basicScenario, type BasicScenario, type BasicScenarioOptions } from '@meshcore-web/core/emulator';
import { DB_PREFIX } from '@meshcore-web/core/store';
import { WebBluetoothTransport, WebSerialTransport } from '@meshcore-web/core/transport';
import type { McApp } from '../mc-app.js';
import { createMockBluetooth, type MockBluetoothHandle } from './mock-bluetooth.js';
import { createMockSerial, type MockSerialHandle } from './mock-serial.js';

export interface HarnessOptions {
  /** basicScenario options for all three devices. */
  scenario?: BasicScenarioOptions;
  /** Drop the serial / BLE kinds (as in a browser without the APIs). */
  serial?: boolean;
  ble?: boolean;
  /** Extra AppModel options (override the defaults below). */
  app?: AppModelOptions;
}

export interface Harness {
  app: AppModel;
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
  /** Polls `cond` (every animation frame) until truthy; throws after `timeoutMs`. */
  until(cond: () => unknown, timeoutMs?: number, what?: string): Promise<void>;
  /** Text content of the whole UI, shadow roots included. */
  text(): string;
  cleanup(): Promise<void>;
}

/** Deletes every IndexedDB database of this app. */
export async function deleteAppDatabases(): Promise<void> {
  const dbs = await indexedDB.databases();
  await Promise.all(
    dbs
      .map((d) => d.name)
      .filter((n): n is string => !!n && n.startsWith(DB_PREFIX))
      .map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          }),
      ),
  );
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
  const serialScenario = basicScenario(opts.scenario);
  const serial = createMockSerial({
    onFrameFromHost: (frame) => serialScenario.emulator.handleFrame(frame),
    info: { usbVendorId: 0x239a, usbProductId: 0x8029 },
  });
  serialScenario.emulator.onFrame((f) => serial.pushFrameToHost(f));

  const bleScenario = basicScenario(opts.scenario);
  const ble = createMockBluetooth({
    name: 'MeshCore-Emulator',
    onFrameFromHost: (frame) => bleScenario.emulator.handleFrame(frame),
  });
  bleScenario.emulator.onFrame((f) => ble.pushFrameToHost(f));

  const emulatorFactory = createEmulatorTransportFactory(opts.scenario);
  const app = new AppModel({
    ...(opts.serial === false
      ? {}
      : {
          createSerialTransport: async (req) => {
            if (req.reconnect) {
              const [port] = await serial.serial.getPorts();
              if (port) return new WebSerialTransport({ port });
            }
            return new WebSerialTransport({ serial: serial.serial });
          },
        }),
    ...(opts.ble === false ? {} : { createBleTransport: () => new WebBluetoothTransport({ bluetooth: ble.bluetooth }) }),
    createEmulatorTransport: emulatorFactory,
    reconnectableKinds: ['emulator', 'serial'],
    ...opts.app,
  });

  const h: Harness = {
    app,
    serial,
    serialScenario,
    ble,
    bleScenario,
    emulatorScenario: () => emulatorFactory.scenario(),
    el: undefined,
    async mount() {
      history.replaceState(null, '', '#/');
      await app.init();
      const el = document.createElement('mc-app');
      el.app = app;
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
    async until(cond, timeoutMs = 5000, what = 'condition') {
      const start = performance.now();
      while (!cond()) {
        if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      }
    },
    text() {
      return h.el ? deepText(h.el) : '';
    },
    async cleanup() {
      h.el?.remove();
      h.el = undefined;
      await app.dispose();
      await deleteAppDatabases();
      history.replaceState(null, '', '#/');
    },
  };
  return h;
}
