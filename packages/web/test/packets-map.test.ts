import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { buildPacket, encodeAdvertAppData, PayloadType, RouteType } from '@meshcore-web/core/packet';
import { concatBytes, toHex } from '@meshcore-web/core/util/bytes';
import '../src/mc-app.js';
import '../src/pages/packets/index.js';
import { createHarness, type Harness } from '../src/testing/harness.js';
import type { McTileMap } from '../src/components/tile-map.js';

let h: Harness | undefined;

beforeEach(async () => {
  await page.viewport(1400, 900);
});

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  localStorage.clear();
  await page.viewport(1280, 800);
});

/** A flood ADVERT from `key` (mesh-packet-format.md §1 envelope, §3.5 payload; signature zeros). */
function advert(key: Uint8Array, name: string, path: number[]): Uint8Array {
  const payload = concatBytes(key, new Uint8Array(4), new Uint8Array(64), encodeAdvertAppData({ nodeType: 1, name }));
  return buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, path: Uint8Array.from(path), payload });
}

const within = (root: Element | null | undefined, selector: string): Element[] => (root?.shadowRoot ? [...root.shadowRoot.querySelectorAll(selector)] : []);

describe('/packets Map button', () => {
  it('maps the listed packets as directed, arrowed hops with a count note; filters narrow it; hides again', async () => {
    const t = (h = createHarness());
    await t.mount();
    await t.connectEmulator('/packets');
    await t.until(() => t.query('[data-tab="packets"]'), 3000, 'packets page');
    await t.click('[data-tab="packets"]'); // the page opens on Stats
    await t.app.connection.capture!.idle();
    const s = t.emulatorScenario();
    const hill = s.keys.repeater[0]!;
    const store = t.app.connection.store.value!;
    const now = t.clock.now();
    // logged directly (no relayed copies): Alice direct, twice via Hilltop, once via unknown 55 then
    // Hilltop; Bob (no location) via Hilltop. Alice, Hilltop and this radio have locations.
    const rx = (bytes: Uint8Array, dt: number) => store.packets.append({ direction: 'rx', source: 'logRxData', bytes, ts: now + dt, snr: 4, rssi: -100 });
    await rx(advert(s.keys.alice, 'Alice', []), 0);
    await rx(advert(s.keys.alice, 'Alice', [hill]), 1);
    await rx(advert(s.keys.alice, 'Alice', [hill]), 2);
    await rx(advert(s.keys.alice, 'Alice', [0x55, hill]), 3);
    await rx(advert(s.keys.bob, 'Bob', [hill]), 4);
    await t.app.packetStats.settled();
    await t.until(() => t.app.packetStats.recentRoutes.value.mapped === 5, 5000, 'routes');
    const [alice, hillKey, self] = [toHex(s.keys.alice), toHex(s.keys.repeater), toHex(s.keys.self)];

    const button = t.query<HTMLButtonElement>('[data-action="map"]')!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(t.query('mc-packets-map')).toBeNull();
    await t.click('[data-action="map"]');
    await t.until(() => t.query('[data-field="packets-map"]'), 3000, 'map');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent!.trim()).toBe('Hide map');
    const map = () => t.query('[data-field="packets-map"]');
    await t.until(() => within(map(), 'path[data-line]').length === 3, 3000, 'map lines');

    // directed edges in travel order: Alice→Hilltop (3, one skipping 55), Hilltop→me (4), Alice→me (1)
    const ids = within(map(), 'path[data-line]').map((p) => p.getAttribute('data-line')!);
    const edge = (from: string, to: string) => ids.find((id) => id.split('>')[0]!.includes(from) && id.split('>')[1]!.includes(to));
    expect(edge(alice, hillKey)).toBeDefined();
    expect(edge(hillKey, self)).toBeDefined();
    expect(edge(alice, self)).toBeDefined();
    expect(edge(hillKey, alice)).toBeUndefined();
    const busiest = within(map(), 'path[data-line]').find((p) => (p as SVGPathElement).style.strokeWidth === '14px')!;
    expect(busiest.getAttribute('data-line')).toBe(edge(hillKey, self));

    // the busiest hop's arrowhead points at this radio: its tip (first corner) is the one nearest it
    const tileMap = map() as McTileMap;
    const me = t.app.paths.routesUsage(t.app.packetStats.recentRoutes.value.routes, { directed: true }).stops.find((st) => st.id.includes(self))!;
    const pMe = tileMap.project(me.lat, me.lon);
    const head = within(map(), `polygon[data-arrow="${edge(hillKey, self)}"]`)[0]!;
    const corners = head.getAttribute('points')!.split(' ').map((p) => p.split(',').map(Number) as [number, number]);
    const dist = corners.map(([x, y]) => Math.hypot(x - pMe.x, y - pMe.y));
    expect(dist[0]).toBe(Math.min(...dist));
    expect(t.query<HTMLElement>('mc-packets-map')!.shadowRoot!.querySelectorAll('mc-map-marker')).toHaveLength(3);

    const note = () => t.query('[data-field="packets-map-note"]')!.textContent!.replace(/\s+/g, ' ');
    expect(note()).toMatch(/Paths of the 5 packets listed \(5 have a known path\)\. Arrows show travel direction/);
    expect(note()).toMatch(/busiest: 4/);
    expect(within(t.query('mc-packets-map'), '[data-field="packets-map-limit"]')).toHaveLength(0);

    // a filter narrows it: 1-hop packets only (Alice ×2 and Bob via Hilltop)
    t.app.packetStats.addFilter({ field: 'hops', value: '1', label: '1 hop' });
    await t.until(() => within(map(), 'path[data-line]').length === 2, 3000, 'filtered lines');
    expect(note()).toMatch(/Paths of the 3 packets listed \(3 have a known path\)/);
    t.app.packetStats.clearFilters();

    await t.click('[data-action="map"]');
    await t.until(() => !t.query('mc-packets-map'), 3000, 'map hidden');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('says up front when more packets are listed than the map shows', async () => {
    const t = (h = createHarness());
    await t.mount();
    await t.connectEmulator('/packets');
    await t.until(() => t.query('[data-tab="packets"]'), 3000, 'packets page');
    await t.click('[data-tab="packets"]'); // the page opens on Stats
    await t.app.connection.capture!.idle();
    const s = t.emulatorScenario();
    const hill = s.keys.repeater[0]!;
    const store = t.app.connection.store.value!;
    const now = t.clock.now();
    const bytes = advert(s.keys.alice, 'Alice', [hill]);
    for (let i = 0; i < 502; i++) await store.packets.append({ direction: 'rx', source: 'logRxData', bytes, ts: now + i, snr: 4, rssi: -100 });
    await t.app.packetStats.settled();
    await t.until(() => t.app.packetStats.points.value.length === 502, 10000, 'stats points');

    const label = () => t.query<HTMLButtonElement>('[data-action="map"]')!.textContent!.trim();
    await t.until(() => label() === 'Map newest 500', 5000, 'limited button label');
    expect(t.query('[data-action="map"]')!.getAttribute('title')).toMatch(/newest 500 of the 502 packets listed/);

    await t.click('[data-action="map"]');
    await t.until(() => within(t.query('mc-packets-map'), '[data-field="packets-map-limit"]').length === 1, 3000, 'limit banner');
    const banner = within(t.query('mc-packets-map'), '[data-field="packets-map-limit"]')[0]!.textContent!.replace(/\s+/g, ' ');
    expect(banner).toMatch(/Only the newest 500 of the 502 packets listed are mapped/);
    await t.until(() => within(t.query('mc-packets-map'), '[data-field="packets-map-note"]').length === 1, 3000, 'note');
    const note = within(t.query('mc-packets-map'), '[data-field="packets-map-note"]')[0]!.textContent!.replace(/\s+/g, ' ');
    expect(note).toMatch(/Paths of the newest 500 of the 502 packets listed \(500 have a known path\)/);
  });
});
