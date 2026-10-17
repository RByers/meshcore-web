import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { toHex } from '@meshcore-web/core/util/bytes';
import { RadioStore } from '@meshcore-web/core/store';
import { TypedEmitter } from '@meshcore-web/core/util/events';
import type { FrameTransport, TransportEvents } from '@meshcore-web/core/transport';
import '../src/mc-app.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

let h: Harness | undefined;

function harness(...args: Parameters<typeof createHarness>): Harness {
  h = createHarness(...args);
  return h;
}

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('<mc-app> shell', () => {
  it('renders header, nav from the registry and the connect page', async () => {
    const t = harness();
    await t.mount();
    expect(t.query('.brand')?.textContent).toBe('MeshCore Web');
    const nav = t.queryAll<HTMLAnchorElement>('nav a').map((a) => a.dataset['path']);
    expect(nav).toEqual(['/', '/device', '/messages', '/contacts', '/channels', '/map', '/packets', '/settings']);
    expect(t.query('nav a[aria-current="page"]')?.dataset['path']).toBe('/');
    expect(t.query('mc-connect-page')).not.toBeNull();
    expect(t.query('.chip')?.textContent).toContain('Not connected');
    expect(t.query('[data-action="disconnect"]')).toBeNull();
  });

  it('redirects connection-only pages while disconnected, routes them once connected, and 404s unknown paths', async () => {
    const t = harness();
    await t.mount();
    for (const path of ['/channels', '/device', '/messages']) {
      location.hash = `#${path}`;
      await t.until(() => location.hash === '#/' && t.query('mc-connect-page'), 3000, `redirect from ${path}`);
    }
    expect(t.query('mc-channels-page')).toBeNull();
    location.hash = '#/nope';
    await t.until(() => t.text().includes('Page not found'), 3000, 'not found');

    location.hash = '#/';
    await t.until(() => t.query('mc-connect-page'), 3000, 'connect page');
    await t.connectEmulator('/channels');
    await t.until(() => t.query('mc-channels-page'), 3000, 'channels page');
    expect(t.query('nav a[aria-current="page"]')?.dataset['path']).toBe('/channels');
    expect(document.title).toBe('Channels · MeshCore Web');
  });

  it('nav links are keyboard reachable', async () => {
    const t = harness();
    await t.mount();
    const links = t.queryAll<HTMLAnchorElement>('nav a');
    links[2]!.focus();
    expect(t.el!.shadowRoot!.activeElement).toBe(links[2]);
    expect(links.every((a) => a.getAttribute('href')?.startsWith('#/'))).toBe(true);
  });
});

describe('connect flows', () => {
  it('connects via the Emulator and shows the device page', async () => {
    const t = harness();
    await t.mount();
    expect(t.text()).toContain('simulated radio');
    await t.connectEmulator();
    expect(location.hash).toBe('#/messages');
    location.hash = '#/device';
    await t.until(() => t.query('[data-field="name"]'), 5000, 'device page');
    expect(t.query('[data-field="name"]')!.textContent).toBe('Emulator');
    const scenario = t.emulatorScenario();
    expect(t.query('[data-field="pubkey"]')!.textContent!.trim()).toBe(toHex(scenario.keys.self));
    expect(t.query('[data-field="firmware"]')!.textContent!.trim()).not.toBe('unknown');
    expect(t.query('[data-field="radio"]')!.textContent).toContain('MHz');
    await t.until(() => t.query('[data-field="battery"]')!.textContent!.includes('V'), 3000, 'battery');
    expect(t.query('.chip')!.textContent).toContain('Connected');
    expect(t.query('.chip')!.textContent).toContain('Emulator');
  });

  it('connects via mocked USB Serial end-to-end, and disconnect returns to the connect page', async () => {
    const t = harness();
    await t.mount();
    await t.click('[data-connect="serial"]');
    await t.until(() => t.app.connection.phase.value === 'connected', 5000, 'connected');
    expect(t.serial.port.openOptions).toEqual({ baudRate: 115200 });
    expect(t.serial.framesFromHost.length).toBeGreaterThan(3);
    await t.until(() => location.hash === '#/messages', 3000, 'landing page');
    location.hash = '#/device';
    await t.until(() => t.query('[data-field="link"]')?.textContent?.includes('USB serial 239a:8029'), 5000, 'link');
    expect(t.app.connection.kind.value).toBe('serial');

    await t.click('[data-action="disconnect"]');
    await t.until(() => t.app.connection.phase.value === 'disconnected', 3000, 'disconnected');
    await t.until(() => location.hash === '#/' && t.query('mc-connect-page'), 3000, 'connect page');
    expect(t.serial.port.isOpen).toBe(false);
    expect(t.query('.chip')!.textContent).toContain('Disconnected');
  });

  it('while connected the connect page shows only the current connection, with Disconnect', async () => {
    const t = harness();
    await t.mount();
    await t.connectEmulator('/');
    await t.until(() => t.query('[data-section="current"]'), 3000, 'current connection');
    expect(t.query('[data-field="current-name"]')!.textContent).toBe('Emulator');
    expect(t.query('[data-field="current-kind"]')!.textContent).toBe('Emulator');
    expect(t.text()).toContain('Disconnect this radio to connect to a different one');
    // no way to start another connection while connected
    expect(t.queryAll('[data-connect]')).toEqual([]);
    expect(t.queryAll('[data-reconnect]')).toEqual([]);

    await t.click('[data-action="disconnect-current"]');
    await t.until(() => t.app.connection.phase.value === 'disconnected', 3000, 'disconnected');
    await t.until(() => t.query('[data-connect="emulator"]'), 3000, 'connect options back');
    expect(t.query('[data-section="current"]')).toBeNull();
    // the known-radios list is read back from IndexedDB after the device record is written
    await t.until(() => t.query('[data-reconnect]'), 3000, 'reconnect option');
  });

  it('connects via mocked Bluetooth', async () => {
    const t = harness();
    await t.mount();
    await t.click('[data-connect="ble"]');
    await t.until(() => t.app.connection.phase.value === 'connected', 5000, 'connected');
    expect(t.app.connection.selfInfo.value?.name).toBe('Emulator');
    expect(t.app.connection.transportInfo.value?.name).toContain('MeshCore-Emulator');
  });

  it('shows an error toast when the transport fails', async () => {
    const broken = (): FrameTransport => ({
      kind: 'serial',
      state: 'disconnected',
      info: { kind: 'serial', name: 'broken' },
      events: new TypedEmitter<TransportEvents>(),
      connect: () => Promise.reject(new Error('Failed to open serial port.')),
      disconnect: () => Promise.resolve(),
      send: () => Promise.reject(new Error('closed')),
    });
    const t = harness({ app: { createSerialTransport: broken } });
    await t.mount();
    await t.click('[data-connect="serial"]');
    await t.until(() => t.query('[role="alert"] .toast'), 3000, 'error toast');
    const toast = t.query('[role="alert"] .toast')!;
    expect(toast.textContent).toContain('Could not connect via USB Serial');
    expect(toast.textContent).toContain('Failed to open serial port.');
    expect(t.app.connection.phase.value).toBe('error');
    expect(t.query('.chip')!.textContent).toContain('Connection failed');
    // dismiss with the close button
    await t.click('[role="alert"] .toast button');
    await t.until(() => !t.query('.toast'), 2000, 'dismissed');
  });

  it('a dismissed chooser is not an error', async () => {
    const t = harness();
    t.serial.serial.cancelChooser = true;
    await t.mount();
    await t.click('[data-connect="serial"]');
    await t.until(() => t.query('.toast'), 3000, 'toast');
    expect(t.query('[role="alert"] .toast')).toBeNull();
    expect(t.text()).toContain('No device selected');
    expect(t.app.connection.phase.value).toBe('idle');
  });

  it('disables unavailable transports with an explanation', async () => {
    const t = harness({ serial: false, ble: false });
    await t.mount();
    const serialBtn = t.query<HTMLButtonElement>('[data-connect="serial"]')!;
    expect(serialBtn.disabled).toBe(true);
    const why = t.query(`#${serialBtn.getAttribute('aria-describedby')}`);
    expect(why?.textContent).toContain('Web Serial is not available');
    expect(t.query<HTMLButtonElement>('[data-connect="ble"]')!.disabled).toBe(true);
    expect(t.query<HTMLButtonElement>('[data-connect="emulator"]')!.disabled).toBe(false);
  });

  it('stores frames, contacts and messages in IndexedDB', async () => {
    const t = harness();
    await t.mount();
    await t.click('[data-connect="emulator"]');
    await t.until(() => t.app.connection.phase.value === 'connected', 5000, 'connected');
    await t.app.connection.capture!.idle();
    const pub = t.app.connection.pubKey.value!;
    // a second, independent handle on the same database
    const store = await RadioStore.open(pub, { factory: t.indexedDB });
    try {
      const frames = await store.frames.query({ limit: 500 });
      expect(frames.items.length).toBeGreaterThan(10);
      expect(frames.items.some((f) => f.kind === 'selfInfo' && f.direction === 'in')).toBe(true);
      expect(await store.contacts.count()).toBe(6);
      const alice = toHex(t.emulatorScenario().keys.alice);
      expect((await store.messages.list(alice)).items[0]?.text).toBe('Hi! Are you on the mesh today?');
    } finally {
      store.close();
    }
  });

  it('remembers the last kind and lists the radio for reconnect', async () => {
    const t = harness();
    await t.mount();
    await t.click('[data-connect="emulator"]');
    await t.until(() => t.app.connection.phase.value === 'connected', 5000, 'connected');
    await t.click('[data-action="disconnect"]');
    await t.until(() => t.query('mc-connect-page') && t.query('[data-reconnect]'), 3000, 'known radio');
    expect(t.query('.option[data-kind="emulator"]')!.hasAttribute('data-last')).toBe(true);
    expect(t.query('.option[data-kind="emulator"] .badge')?.textContent).toBe('Last used');
    expect(t.query('[data-reconnect]')!.closest('li')!.textContent).toContain('Emulator');
    await t.click('[data-reconnect]');
    await t.until(() => location.hash === '#/messages' && t.app.connection.connected.value, 10000, 'reconnected');
  });

  it('keeps the nav visible on a narrow viewport', async () => {
    const t = harness();
    await page.viewport(375, 700);
    try {
      await t.mount();
      const nav = t.query('nav')!;
      await t.until(() => getComputedStyle(t.el!.shadowRoot!.querySelector('nav ul')!).flexDirection === 'row', 2000, 'row nav');
      const r = nav.getBoundingClientRect();
      expect(r.width).toBeGreaterThan(300);
      expect(r.height).toBeGreaterThan(0);
      const main = t.query('main')!.getBoundingClientRect();
      expect(r.top).toBeGreaterThanOrEqual(main.top);
      expect(t.queryAll('nav a').length).toBe(8);
    } finally {
      await page.viewport(1280, 800);
    }
  });
});
