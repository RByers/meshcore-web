import { afterEach, describe, expect, it } from 'vitest';
import { toHex } from '@meshcore-web/core/util/bytes';
import '../src/mc-app.js';
import '../src/pages/messaging/index.js';
import '../src/pages/admin/index.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function connected(): Promise<Harness> {
  const t = (h = createHarness({ app: { remoteAdmin: { timeoutMs: 400 } } }));
  await t.mount();
  await t.click('[data-connect="emulator"]');
  await t.until(() => t.app.connection.phase.value === 'connected', 5000, 'connected');
  await t.app.connection.capture!.idle();
  return t;
}

function key(t: Harness, name: 'repeater' | 'room' | 'sensor'): string {
  return toHex(t.emulatorScenario().keys[name]);
}

async function login(t: Harness, password: string): Promise<void> {
  await t.fill('[data-field="password"]', password);
  await t.click('[data-action="login"]');
}

describe('node admin page', () => {
  it('opens from the contacts list; admin login shows status cards', async () => {
    const t = await connected();
    const k = key(t, 'repeater');
    await t.until(() => location.hash === '#/messages', 5000, 'landing page');
    await t.go('/contacts', `[data-contact="${k}"] a`);
    t.query<HTMLAnchorElement>(`[data-contact="${k}"] a`)!.click();
    await t.until(() => location.hash === `#/node/${k}` && t.query('mc-node-admin-page') && t.query('[data-field="password"]'), 5000, 'admin page');
    await expect.poll(() => t.query('[data-field="name"]')?.textContent, { timeout: 3000 }).toBe('Hilltop Repeater');
    expect(t.query('[data-field="type"]')!.textContent).toBe('Repeater');
    await login(t, 'password');
    await t.until(() => t.query('[data-field="login-state"]')?.textContent?.includes('admin'), 8000, 'admin login');
    await t.until(() => t.query('[data-stat="battery"]'), 8000, 'status cards');
    expect(t.query('[data-stat="battery"] .value')!.textContent).toBe('4.10 V (4100 mV)');
    expect(t.query('[data-stat="recv"] .value')!.textContent).toBe('1,234');
    expect(t.query('[data-stat="noiseFloor"] .value')!.textContent).toBe('-112 dBm');
  });

  it('shows an error for a wrong password', async () => {
    const t = await connected();
    await t.go(`/node/${key(t, 'repeater')}`, '[data-field="password"]');
    await login(t, 'nope');
    await t.until(() => t.query('[data-field="login-state"].error'), 10000, 'login error');
    expect(t.query('[data-field="login-state"]')!.textContent).toMatch(/wrong password/i);
  });

  it('runs a CLI command and shows the reply in the transcript', async () => {
    const t = await connected();
    const k = key(t, 'repeater');
    await t.go(`/node/${k}`, '[data-field="password"]');
    await login(t, 'password');
    await t.until(() => t.app.remoteAdmin.node(k).isAdmin.value, 8000, 'admin');
    await t.go(`/node/${k}/cli`, '[data-field="cli-input"]');
    await t.fill('[data-field="cli-input"]', 've');
    await t.until(() => t.query('[data-suggestion="ver"]'), 2000, 'autocomplete');
    await t.fill('[data-field="cli-input"]', 'ver');
    await t.click('[data-action="send-cli"]');
    await t.until(() => t.query('[data-field="transcript"] [data-dir="in"]'), 8000, 'cli reply');
    expect(t.query('[data-dir="out"]')!.textContent).toContain('ver');
    expect(t.query('[data-dir="in"]')!.textContent).toContain('v1.18.0');
  });

  it('shows sensor telemetry readings', async () => {
    const t = await connected();
    await t.go(`/node/${key(t, 'sensor')}/telemetry`, '[data-action="refresh-telemetry"]');
    await t.click('[data-action="refresh-telemetry"]');
    await t.until(() => t.queryAll('[data-reading]').length === 3, 8000, 'readings');
    const rows = t.queryAll('[data-reading]').map((r) => [r.children[0]!.textContent, r.querySelector('[data-field="value"]')!.textContent]);
    expect(rows).toEqual([
      ['Battery', '3.95 V'],
      ['MCU temperature', '18.4 °C'],
      ['Temperature (ch 2)', '12.5 °C'],
    ]);
  });

  it('traces via the repeater and shows the hop SNR', async () => {
    const t = await connected();
    const k = key(t, 'repeater');
    await t.go(`/node/${k}/tools`, '[data-action="trace"]');
    expect(t.query<HTMLInputElement>('[data-field="trace-path"]')!.value).toBe(k.slice(0, 2));
    await t.click('[data-action="trace"]');
    await t.until(() => t.query(`[data-trace-hop="${k.slice(0, 2)}"]`), 8000, 'trace hop');
    const hop = t.query(`[data-trace-hop="${k.slice(0, 2)}"]`)!;
    expect(hop.textContent).toContain('Hilltop Repeater');
    expect(hop.querySelector('[data-field="snr"]')!.textContent).toBe('8 dB');
  });

  it('logs in to the room server as guest and links to the room chat', async () => {
    const t = await connected();
    const k = key(t, 'room');
    await t.go(`/node/${k}`, '[data-field="password"]');
    expect(t.query('[data-field="type"]')!.textContent).toBe('Room server');
    await login(t, '');
    await t.until(() => t.query('[data-field="login-state"]')?.textContent?.includes('guest'), 8000, 'guest login');
    await t.until(() => t.query('[data-stat="posted"]'), 8000, 'room status');
    await t.go(`/node/${k}/messages`, '[data-action="open-chat"]');
    expect(t.query<HTMLAnchorElement>('[data-action="open-chat"]')!.getAttribute('href')).toBe(`#/chat/${k}`);
  });
});
