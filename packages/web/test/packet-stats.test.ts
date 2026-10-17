/** The Stats tab of /packets (docs/packet-stats.md §3). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { buildPacket, PayloadType, RouteType } from '@meshcore-web/core/packet';
import '../src/mc-app.js';
import '../src/pages/packets/index.js';
import { createHarness, type Harness } from '../src/testing/harness.js';
import type { McPacketStats } from '../src/pages/packets/packet-stats.js';

let h: Harness | undefined;

beforeEach(async () => {
  await page.viewport(1400, 900);
});

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  await page.viewport(1280, 800);
});

/** Connects the emulator, makes some air traffic, opens the Stats tab and waits for it to settle. */
async function openStats(): Promise<{ t: Harness; el: McPacketStats }> {
  const t = (h = createHarness());
  await t.mount();
  await t.connectEmulator('/packets');
  await t.until(() => t.query('[data-tab="stats"]'), 3000, 'stats tab');
  const s = t.emulatorScenario();
  s.nodes.alice.advertise();
  s.nodes.bob.sendChannelMessage('Public', 'hello from bob');
  await t.app.connection.capture!.idle();
  await t.app.packetStats.settled();
  await t.until(() => t.app.packetStats.points.value.some((p) => p.typeName === 'ADVERT') && t.app.packetStats.points.value.some((p) => p.typeName === 'GRP_TXT'), 5000, 'packets');
  await t.click('[data-tab="stats"]');
  await t.until(() => t.query('mc-packet-stats'), 3000, 'stats element');
  const el = t.query<McPacketStats>('mc-packet-stats')!;
  await settle(t, el);
  return { t, el };
}

async function settle(t: Harness, el: McPacketStats): Promise<void> {
  await t.app.packetStats.settled();
  await el.updateComplete;
  for (const c of el.shadowRoot!.querySelectorAll('*')) if ('updateComplete' in c) await (c as unknown as { updateComplete: Promise<unknown> }).updateComplete;
}

function tileValue(t: Harness, name: string): string {
  return t.query(`mc-stat-tile[data-tile="${name}"]`)!.shadowRoot!.querySelector('[data-field="value"]')!.textContent!.trim();
}

/** Elements matching `sel` in the shadow root of the chart `chart` inside the stats section `section`. */
function inChart(el: McPacketStats, section: string, chart: string, sel: string): HTMLElement[] {
  const host = el.shadowRoot!.querySelector(`[data-section="${section}"] ${chart}`);
  return host ? [...host.shadowRoot!.querySelectorAll<HTMLElement>(sel)] : [];
}

function select(el: Element, value: string): void {
  const s = el as HTMLSelectElement;
  s.value = value;
  s.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('/packets Stats tab', () => {
  it('renders the tiles and charts, with contact links for attributed sources', async () => {
    const { t, el } = await openStats();
    expect(t.query('[data-tab="stats"]')!.getAttribute('aria-selected')).toBe('true');
    // only the stats panel: no list toolbar or table
    expect(t.query('[data-field="counts"]')).toBeNull();
    expect(t.query('table[data-table="packets"]')).toBeNull();
    expect(t.query('mc-stats-range')).not.toBeNull();

    expect(t.queryAll('mc-stat-tile')).toHaveLength(5);
    expect(Number(tileValue(t, 'packets'))).toBe(t.app.packetStats.summary.value.packets);
    expect(Number(tileValue(t, 'packets'))).toBeGreaterThan(0);
    for (const kind of ['bar', 'dot', 'line', 'breakdown']) expect(t.query(`[data-chart="${kind}"]`), kind).not.toBeNull();

    const alice = t.app.contacts.contacts.value.find((c) => c.name === 'Alice')!;
    const links = inChart(el, 'sources', 'mc-bar-chart', 'a');
    expect(links.some((a) => a.getAttribute('href') === `#/contact/${alice.key}`)).toBe(true);
  });

  it('switches the dot plot y axis and colouring', async () => {
    const { t, el } = await openStats();
    const yLabel = () => inChart(el, 'dots', 'mc-dot-plot', '[data-field="y-label"]')[0]?.textContent;
    const legend = () =>
      inChart(el, 'dots', 'mc-dot-plot', '[data-legend] li')
        .map((li) => li.dataset['legendKey'])
        .join(',');
    // axes render once the chart has measured its width
    await t.until(() => yLabel() !== undefined, 3000, 'dot plot axes');
    expect(yLabel()).toBe('SNR (dB)');
    const typeLegend = legend();
    expect(typeLegend).toContain('ADVERT');

    select(t.query('[data-select="y"]')!, 'rssi');
    await settle(t, el);
    expect(yLabel()).toBe('RSSI (dBm)');

    select(t.query('[data-select="color"]')!, 'source');
    await settle(t, el);
    const alice = t.app.contacts.contacts.value.find((c) => c.name === 'Alice')!;
    expect(legend()).not.toContain('ADVERT');
    expect(legend()).toContain(alice.key);
  });

  it('a date preset narrows the packets counted', async () => {
    const { t, el } = await openStats();
    // one packet logged two hours ago: inside "All", outside "Last hour"
    const store = t.app.connection.store.value!;
    const old = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ACK, path: new Uint8Array(0), payload: new Uint8Array(4).fill(7) });
    await store.packets.append({ direction: 'rx', bytes: old, ts: t.clock.now() - 2 * 3_600_000, source: 'logRxData', snr: 4, rssi: -95 });
    await settle(t, el);
    const all = Number(tileValue(t, 'packets'));
    expect(all).toBe(t.app.packetStats.summary.value.packets);

    await t.click('[data-preset="1h"]');
    await t.until(() => t.app.packetStats.range.value.from !== null, 3000, 'range set');
    await settle(t, el);
    const hour = Number(tileValue(t, 'packets'));
    expect(hour).toBeLessThan(all);
    expect(hour).toBe(t.app.packetStats.summary.value.packets);
  });
});
