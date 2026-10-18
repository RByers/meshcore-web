import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { toHex } from '@meshcore-web/core/util/bytes';
import '../src/mc-app.js';
import type { McMapMarker, McTileMap } from '../src/components/tile-map.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function openMap(): Promise<{ t: Harness; map: McTileMap; alice: string; repeater: string }> {
  const t = (h = createHarness());
  await t.mount();
  t.app.map.setTileUrl(GIF); // no network tiles in tests
  await t.connectEmulator('/map');
  const s = t.emulatorScenario();
  const alice = toHex(s.keys.alice);
  const repeater = toHex(s.keys.repeater);
  await t.until(() => t.query(`mc-map-marker[data-key="${alice}"]`) && t.query(`mc-map-marker[data-key="${repeater}"]`), 5000, 'markers');
  const map = t.query<McTileMap>('mc-tile-map')!;
  await t.until(() => map.size.width > 0 && map.shadowRoot!.querySelectorAll('img').length > 0, 3000, 'tiles');
  await map.updateComplete;
  return { t, map, alice, repeater };
}

function pos(t: Harness, map: McTileMap, key: string): { x: number; y: number } {
  const r = t.query(`mc-map-marker[data-key="${key}"]`)!.getBoundingClientRect();
  const base = map.getBoundingClientRect();
  return { x: r.left - base.left, y: r.top - base.top };
}

describe('/map page', () => {
  it('shows contacts with a location and this radio, at their projected positions', async () => {
    const { t, map, alice, repeater } = await openMap();
    expect(t.query('nav a[aria-current="page"]')?.dataset['path']).toBe('/map');
    // only Alice and the repeater have a location in basicScenario; plus self
    expect(t.queryAll('mc-map-marker[data-key]')).toHaveLength(2);
    expect(t.query<McMapMarker>('mc-map-marker[data-self]')?.label).toBe('Emulator (you)');
    expect(t.query('[data-without]')?.textContent).toContain('4 contacts without a location');
    const a = pos(t, map, alice);
    const r = pos(t, map, repeater);
    // the repeater (47.62, -122.35) is north-west of Alice (47.61, -122.33)
    expect(r.x).toBeLessThan(a.x);
    expect(r.y).toBeLessThan(a.y);
    const want = map.project(47.61, -122.33);
    expect(Math.abs(a.x - want.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.y - want.y)).toBeLessThanOrEqual(1);
    // the initial view fits all markers inside the map
    const size = map.size;
    for (const p of [a, r]) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(size.width);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(size.height);
    }
    expect(t.query(`mc-map-marker[data-key="${alice}"]`)!.getAttribute('kind')).toBe('chat');
    expect(t.query(`mc-map-marker[data-key="${repeater}"]`)!.getAttribute('kind')).toBe('repeater');
  });

  it('filter chips hide repeaters', async () => {
    const { t, alice, repeater } = await openMap();
    await t.click('[data-filter="repeater"]');
    await t.until(() => !t.query(`mc-map-marker[data-key="${repeater}"]`), 2000, 'repeater hidden');
    expect(t.query(`mc-map-marker[data-key="${alice}"]`)).not.toBeNull();
    expect(t.query('[data-filter="repeater"]')?.getAttribute('aria-pressed')).toBe('false');
    await t.click('[data-filter="chat"]');
    await t.until(() => t.query('[data-empty]'), 2000, 'empty state');
    expect(t.query('[data-empty]')?.textContent).toContain('No nodes match');
    await t.click('[data-filter="repeater"]');
    await t.until(() => t.query(`mc-map-marker[data-key="${repeater}"]`), 2000, 'repeater back');
  });

  it('clicking a marker opens its card with distance and Chat / Node links', async () => {
    const { t, alice, repeater } = await openMap();
    t.query<McMapMarker>(`mc-map-marker[data-key="${alice}"]`)!.shadowRoot!.querySelector('button')!.click();
    await t.until(() => t.query('[data-card]'), 2000, 'card');
    const card = t.query('[data-card]')!;
    expect(card.querySelector('h3')?.textContent).toBe('Alice');
    expect(card.querySelector('[data-field="type"]')?.textContent).toBe('Chat');
    expect(card.querySelector('[data-field="distance"]')?.textContent).toMatch(/^\d+ m N \(\d+°\)$/);
    expect(card.querySelector<HTMLAnchorElement>('[data-action="chat"]')?.getAttribute('href')).toBe(`#/node/${alice}/messages`);
    expect(t.query(`mc-map-marker[data-key="${alice}"]`)!.hasAttribute('selected')).toBe(true);

    t.query<McMapMarker>(`mc-map-marker[data-key="${repeater}"]`)!.shadowRoot!.querySelector('button')!.click();
    await t.until(() => t.query('[data-card] h3')?.textContent === 'Hilltop Repeater', 2000, 'repeater card');
    expect(t.query<HTMLAnchorElement>('[data-card] [data-action="node"]')?.getAttribute('href')).toBe(`#/node/${repeater}`);
    await t.click('[data-card] .close');
    await t.until(() => !t.query('[data-card]'), 2000, 'card closed');

    t.query<McMapMarker>(`mc-map-marker[data-key="${repeater}"]`)!.shadowRoot!.querySelector('button')!.click();
    await t.until(() => t.query('[data-card]'), 2000, 'card again');
    t.query<HTMLAnchorElement>('[data-card] [data-action="node"]')!.click();
    await t.until(() => location.hash === `#/node/${repeater}` && t.query('mc-node-page'), 3000, 'node page');
  });

  it('zoom buttons and Centre on me work', async () => {
    const { t, map, alice, repeater } = await openMap();
    const z = map.zoom;
    const gap = (): number => pos(t, map, alice).x - pos(t, map, repeater).x;
    const before = gap();
    map.shadowRoot!.querySelector<HTMLButtonElement>('[data-zoom="in"]')!.click();
    await map.updateComplete;
    expect(map.zoom).toBe(Math.round(z) + 1);
    expect(gap() / before).toBeCloseTo(2 ** (map.zoom - z), 1);
    map.shadowRoot!.querySelector<HTMLButtonElement>('[data-zoom="out"]')!.click();
    await map.updateComplete;
    expect(map.zoom).toBe(Math.round(z));

    map.panBy(500, 500);
    await t.click('[data-action="centre"]');
    await map.updateComplete;
    expect(map.lat).toBeCloseTo(47.6062, 6);
    expect(map.lon).toBeCloseTo(-122.3321, 6);
    expect(map.zoom).toBeGreaterThanOrEqual(13);
  });

  it('never requests network tiles in tests', async () => {
    const { map } = await openMap();
    const srcs = [...map.shadowRoot!.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs.length).toBeGreaterThan(0);
    expect(srcs.every((s) => s === GIF)).toBe(true);
    const net = performance.getEntriesByType('resource').filter((e) => /openstreetmap|\/\d+\/\d+\/\d+\.png/.test(e.name));
    expect(net).toEqual([]);
  });

  it('keeps the mobile bottom nav on top of the map', async () => {
    await page.viewport(375, 560);
    try {
      const { t, map } = await openMap();
      const root = t.el!.shadowRoot!;
      await t.until(() => getComputedStyle(root.querySelector('nav ul')!).flexDirection === 'row', 2000, 'row nav');
      // put the map's bottom edge at the viewport bottom, under the sticky nav
      map.scrollIntoView({ block: 'end' });
      const m = map.getBoundingClientRect();
      for (const a of t.queryAll<HTMLAnchorElement>('nav a')) {
        const r = a.getBoundingClientRect();
        expect(r.top).toBeLessThan(m.bottom); // the nav overlaps the map here
        const hit = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        expect(hit?.closest('nav a'), a.dataset['path']).toBe(a);
      }
    } finally {
      await page.viewport(1280, 800);
    }
  });
});
