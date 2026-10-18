import { afterEach, describe, expect, it } from 'vitest';
import { toHex } from '@meshcore-web/core/util/bytes';
import '../src/mc-app.js';
import '../src/pages/messaging/index.js';
import '../src/pages/node/index.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** A realistic remote-request timeout; the wrong-password test elapses it on the harness clock. */
const REMOTE_TIMEOUT_MS = 5000;

async function connected(): Promise<Harness> {
  const t = (h = createHarness({ app: { remoteAdmin: { timeoutMs: REMOTE_TIMEOUT_MS } } }));
  await t.mount();
  await t.click('[data-connect="emulator"]');
  await t.until(() => t.app.connection.phase.value === 'connected', 5000, 'connected');
  await t.app.connection.capture!.idle();
  return t;
}

/** Elements matching `selector` inside the `[data-history="chart"]` chart's shadow root. */
function inChart(t: Harness, chart: 'battery' | 'temperature', selector: string): Element[] {
  return [...(t.query(`[data-history="${chart}"]`)?.shadowRoot?.querySelectorAll(selector) ?? [])];
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
    await t.until(() => location.hash === `#/node/${k}` && t.query('mc-node-page')?.dataset['activeTab'] === 'info', 5000, 'node page (Info)');
    await t.click('[data-tab="overview"]');
    await t.until(() => location.hash === `#/node/${k}/overview` && t.query('[data-field="password"]'), 5000, 'admin overview');
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
    await t.go(`/node/${key(t, 'repeater')}/overview`, '[data-field="password"]');
    // the client arms the timeout when the device answers SEND_LOGIN with SENT
    let sent = false;
    t.app.connection.client.value!.events.on('frame', (f) => {
      if (f.direction === 'in' && f.frame?.kind === 'sent') sent = true;
    });
    await login(t, 'nope');
    await t.until(() => sent && t.query<HTMLButtonElement>('[data-action="login"]')?.disabled, 3000, 'login in flight');
    expect(t.query('[data-action="login"]')!.textContent).toContain('Logging in');
    // a wrong password gets no reply: the request times out
    await t.elapse(REMOTE_TIMEOUT_MS);
    await t.until(() => t.query('[data-field="login-state"].error'), 3000, 'login error');
    expect(t.query('[data-field="login-state"]')!.textContent).toMatch(/wrong password/i);
  });

  it('runs a CLI command and shows the reply in the transcript', async () => {
    const t = await connected();
    const k = key(t, 'repeater');
    await t.go(`/node/${k}/overview`, '[data-field="password"]');
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

  it('graphs the archived sensor telemetry: battery and one temperature line per channel', async () => {
    const t = await connected();
    const k = key(t, 'sensor');
    await t.go(`/node/${k}/telemetry`, '[data-action="refresh-telemetry"]');
    await t.until(() => t.query('[data-field="history-empty"]'), 5000, 'empty history');
    expect(t.query('[data-field="history-empty"]')!.textContent).toContain('No saved telemetry');
    expect(t.query('mc-time-series-chart')).toBeNull();

    const points = (chart: 'battery' | 'temperature', series?: string): Element[] =>
      inChart(t, chart, `[data-mark="point"]${series ? `[data-series="${series}"]` : ''}`);
    await t.click('[data-action="refresh-telemetry"]');
    // a single response: one point per series, no lines yet
    await t.until(() => points('temperature').length === 2, 8000, 'first history points');
    expect(points('battery')).toHaveLength(1);
    expect(t.queryAll('[data-mark="line"]')).toHaveLength(0);

    await t.elapse(10 * 60_000);
    await t.click('[data-action="refresh-telemetry"]');
    await t.until(() => points('temperature').length === 4, 8000, 'second history points');
    expect(points('battery')).toHaveLength(2);
    expect(points('battery').filter((p) => p.hasAttribute('data-hollow'))).toHaveLength(0);
    expect(points('temperature', 'temp-1')).toHaveLength(2);
    expect(points('temperature', 'temp-2')).toHaveLength(2);
    expect(inChart(t, 'temperature', '[data-mark="line"]').map((l) => l.getAttribute('data-series'))).toEqual(['temp-1', 'temp-2']);
    expect(inChart(t, 'temperature', '[data-legend-key]').map((l) => l.textContent!.trim())).toEqual(['MCU', 'Sensor (ch 2)']);
    expect(points('temperature', 'temp-2')[0]!.querySelector('title')!.textContent).toMatch(/^Sensor \(ch 2\): 12\.5 · /);
    expect(points('battery')[0]!.querySelector('title')!.textContent).toMatch(/^Battery: 3\.95 · /);
    expect(t.query('[data-field="history-empty"]')).toBeNull();
  });

  it('graphs repeater battery from status reports (hollow) and telemetry (filled)', async () => {
    const t = await connected();
    const k = key(t, 'repeater');
    await t.go(`/node/${k}/overview`, '[data-field="password"]');
    await login(t, 'password');
    await t.until(() => t.query('[data-stat="battery"]'), 8000, 'status cards');
    await t.go(`/node/${k}/telemetry`, '[data-action="refresh-telemetry"]');
    const points = (): Element[] => inChart(t, 'battery', '[data-mark="point"]');
    await t.until(() => points().length === 1, 5000, 'status point from the archive');
    expect(points()[0]!.hasAttribute('data-hollow')).toBe(true);

    await t.elapse(60_000);
    await t.click('[data-action="refresh-telemetry"]');
    await t.until(() => points().length === 2, 8000, 'telemetry point');
    expect(points().map((p) => p.hasAttribute('data-hollow'))).toEqual([true, false]);
    expect(inChart(t, 'battery', '[data-mark="line"]')).toHaveLength(1);
    expect(inChart(t, 'battery', '[data-marker-legend]')[0]!.textContent).toMatch(/telemetry\s+status report/);
    expect(t.query('[data-history="temperature"]')).toBeNull();
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

  it('logs in to the room server as guest and shows the room chat in its Messages tab', async () => {
    const t = await connected();
    const k = key(t, 'room');
    await t.go(`/node/${k}/overview`, '[data-field="password"]');
    expect(t.query('[data-field="type"]')!.textContent).toBe('Room server');
    await login(t, '');
    await t.until(() => t.query('[data-field="login-state"]')?.textContent?.includes('guest'), 8000, 'guest login');
    await t.until(() => t.query('[data-stat="posted"]'), 8000, 'room status');
    // the Messages tab is the room chat itself, without the login hint once logged in
    expect(t.query<HTMLAnchorElement>('[data-tab="messages"]')!.getAttribute('href')).toBe(`#/node/${k}/messages`);
    await t.click('[data-tab="messages"]');
    await t.until(() => location.hash === `#/node/${k}/messages` && t.query('[data-field="composer"]'), 5000, 'room chat');
    expect(t.query('mc-chat-page')!.hasAttribute('embedded')).toBe(true);
    expect(t.query('[data-action="open-chat"]')).toBeNull();
    expect(t.query('[data-field="room-login-hint"]')).toBeNull();
  });
});
