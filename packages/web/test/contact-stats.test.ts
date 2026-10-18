/** Contact page Stats tab (docs/packet-stats.md §5). */
import { afterEach, describe, expect, it } from 'vitest';
import { PayloadType, RouteType, buildPacket, encodeAdvertAppData } from '@meshcore-web/core/packet';
import { concatBytes, toHex } from '@meshcore-web/core/util/bytes';
import '../src/mc-app.js';
import type { McContactStats } from '../src/pages/messaging/contact-stats.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  localStorage.clear();
});

/** A flood ADVERT from `key` (mesh-packet-format.md §1 envelope, §3.5 payload; signature zeros). */
function advert(key: Uint8Array, name: string, path: number[]): Uint8Array {
  const payload = concatBytes(key, new Uint8Array(4), new Uint8Array(64), encodeAdvertAppData({ nodeType: 1, name }));
  return buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, path: Uint8Array.from(path), payload });
}

function stats(t: Harness): McContactStats {
  return t.query<McContactStats>('mc-contact-stats')!;
}

function within(root: Element | null | undefined, selector: string): Element[] {
  return root?.shadowRoot ? [...root.shadowRoot.querySelectorAll(selector)] : [];
}

describe('contact Stats tab', () => {
  it('shows tiles, paths (direct + repeated), the timeline and a signal plot with a y selector', async () => {
    const t = (h = createHarness());
    await t.mount();
    await t.connectEmulator();
    const capture = t.app.connection.capture!;
    await capture.idle();
    const s = t.emulatorScenario();
    const alice = toHex(s.keys.alice);
    const hill = s.keys.repeater[0]!;

    // logged directly (not sent through the emulator, whose repeater would add relayed copies
    // asynchronously): once direct, twice via Hilltop, once over two hops
    const store = t.app.connection.store.value!;
    const now = t.clock.now();
    await store.packets.append({ direction: 'rx', source: 'logRxData', bytes: advert(s.keys.alice, 'Alice', []), ts: now, snr: 8, rssi: -80 });
    await store.packets.append({ direction: 'rx', source: 'logRxData', bytes: advert(s.keys.alice, 'Alice', [hill]), ts: now + 1, snr: 4, rssi: -100 });
    await store.packets.append({ direction: 'rx', source: 'logRxData', bytes: advert(s.keys.alice, 'Alice', [hill]), ts: now + 2, snr: 2, rssi: -104 });
    await store.packets.append({ direction: 'rx', source: 'logRxData', bytes: advert(s.keys.alice, 'Alice', [0x55, hill]), ts: now + 3, snr: -3, rssi: -110 });
    await t.app.packetStats.settled();
    expect(t.app.packetStats.forContact(alice).value.from).toHaveLength(4);

    location.hash = `#/node/${alice}`;
    await t.until(() => t.query('[data-tab="stats"]') && t.query('[data-field="key"]'), 5000, 'stats tab');
    expect(t.query('mc-node-page')).not.toBeNull();
    expect(t.query('[data-tab="info"]')!.getAttribute('aria-selected')).toBe('true');
    expect(t.query('[data-tab="stats"]')!.getAttribute('href')).toBe(`#/node/${alice}/stats`);

    await t.click('[data-tab="stats"]');
    await t.until(() => location.hash === `#/node/${alice}/stats` && t.query('[data-tab="stats"]')?.getAttribute('aria-selected') === 'true' && stats(t), 3000, 'stats tab selected');
    expect(t.query('[data-field="key"]')).toBeNull();
    const el = stats(t);
    expect(el).not.toBeNull();
    await el.updateComplete;
    expect(t.query('mc-stats-range')).not.toBeNull();

    const tile = (id: string) => within(t.query(`[data-tile="${id}"]`), '[data-field="value"]')[0]?.textContent?.trim();
    expect(tile('from')).toBe('4');
    expect(tile('paths')).toBe('3');
    expect(tile('direct')).toBe('25%');
    expect(tile('snr')).toMatch(/dB$/);

    // paths: count desc — the repeated path (Alice's current out_path, so linked), then the others
    const pathsChart = t.query('[data-section="paths"] mc-bar-chart');
    await t.until(() => within(pathsChart, '[data-label]').length === 3, 3000, 'path rows');
    const rows = within(pathsChart, '[data-label]').map((r) => r.textContent!.trim());
    expect(rows[0]).toBe('Hilltop Repeater');
    expect(rows).toContain('direct');
    expect(rows.some((r) => r.includes(' > '))).toBe(true);
    expect(within(pathsChart, '[data-label] a')[0]?.getAttribute('href')).toBe(`#/node/${alice}/path`);

    // paths map: one line per hop segment, as thick as the packets that crossed it. With the
    // "approximate positions" setting off, hop 55 (unknown) is left off: Alice–Hilltop 3 (one of
    // them skipping 55, but the hop is firm), Hilltop–me 3, Alice–me 1
    expect(t.app.appSettings.approximatePositions.peek()).toBe(false);
    await t.click('[data-section="paths"] [data-action="paths-map"]');
    await el.updateComplete;
    expect(t.query('[data-section="paths"] mc-bar-chart')).toBeNull();
    const map = t.query('[data-section="paths"] mc-tile-map');
    expect(map).not.toBeNull();
    const lineWidths = () => within(map, 'path[data-line]').map((p) => parseFloat((p as SVGPathElement).style.strokeWidth));
    await t.until(() => within(map, 'path[data-line]').length === 3, 3000, 'paths map lines');
    expect(lineWidths().map((w) => w.toFixed(2)).sort()).toEqual(['14.00', '14.00', '4.67']);
    expect(within(map, 'path[data-dashed]')).toHaveLength(0);
    // one arrow per hop, pointing towards this radio
    expect(within(map, 'polygon[data-arrow]')).toHaveLength(3);
    expect(within(map, 'polygon[data-arrow]').every((p) => /^[0-9a-f]+>/.test(p.getAttribute('data-arrow')!))).toBe(true);
    expect(t.query('[data-field="paths-map-note"]')!.textContent).toMatch(/1 packet came over hops with no known location/);

    // with estimates on, 55 is placed between Alice and Hilltop: Hilltop–me 3 (busiest), Alice–
    // Hilltop 2, Alice–me 1, Alice–55 and 55–Hilltop 1 each (dashed)
    const box = t.query<HTMLInputElement>('[data-section="paths"] [data-approximate]')!;
    box.click();
    await el.updateComplete;
    expect(t.app.appSettings.approximatePositions.peek()).toBe(true);
    await t.until(() => within(map, 'path[data-line]').length === 5, 3000, 'estimated paths map lines');
    const widths = lineWidths();
    expect(Math.max(...widths)).toBe(14);
    const busiest = within(map, 'path[data-line]').find((p) => (p as SVGPathElement).style.strokeWidth === '14px')!;
    expect(busiest.getAttribute('data-line')).toContain(toHex(s.keys.repeater));
    expect(widths.filter((w) => Math.abs(w - 14 / 3) < 0.01)).toHaveLength(3);
    expect(within(map, 'path[data-dashed]')).toHaveLength(2);
    expect(t.query('[data-field="paths-map-note"]')!.textContent).toMatch(/4 packets.*busiest: 3/s);
    await t.click('[data-section="paths"] [data-action="paths-map"]');
    await el.updateComplete;
    expect(t.query('[data-section="paths"] mc-bar-chart')).not.toBeNull();

    // timeline
    const line = t.query('[data-section="timeline"] mc-line-chart');
    await t.until(() => within(line, '[data-mark="line"]').length > 0, 3000, 'timeline line');

    // hop count chart
    const hopsChart = t.query('[data-section="hops"] mc-bar-chart');
    await t.until(() => within(hopsChart, '[data-label]').length === 3, 3000, 'hop rows');

    // signal plot: SNR by default, the selector switches the y axis
    const plot = t.query('[data-section="signal"] mc-dot-plot');
    const yLabel = () => within(plot, '[data-field="y-label"]')[0]?.textContent;
    await t.until(() => within(plot, '[data-mark="dot"]').length === 4 && yLabel(), 3000, 'dots');
    expect(yLabel()).toBe('SNR (dB)');
    const select = t.query<HTMLSelectElement>('[data-section="signal"] select[data-y]')!;
    select.value = 'rssi';
    select.dispatchEvent(new Event('change'));
    await el.updateComplete;
    await (plot as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(yLabel()).toBe('RSSI (dBm)');
    select.value = 'hops';
    select.dispatchEvent(new Event('change'));
    await el.updateComplete;
    await (plot as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(yLabel()).toBe('Hops');
  });

  it('shows one empty-state line when nothing was heard from the contact', async () => {
    const t = (h = createHarness());
    await t.mount();
    await t.connectEmulator();
    await t.app.connection.capture!.idle();
    await t.app.packetStats.settled();
    const carol = toHex(t.emulatorScenario().keys.carol);
    location.hash = `#/node/${carol}`;
    await t.click('[data-tab="stats"]');
    await t.until(() => stats(t), 3000, 'stats element');
    await stats(t).updateComplete;
    expect(within(stats(t), '[data-empty]')).toHaveLength(1);
    expect(within(stats(t), 'mc-stat-tile')).toHaveLength(0);
    expect(t.query('mc-stats-range')).not.toBeNull();
  });
});
