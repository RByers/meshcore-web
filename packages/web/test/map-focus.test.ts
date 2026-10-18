/** Issue #13: "Show on map" from the node page header (any tab) focuses it on /map/node/:key. */
import { afterEach, describe, expect, it } from 'vitest';
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

async function connected(path?: string): Promise<{ t: Harness; alice: string; repeater: string }> {
  const t = (h = createHarness());
  await t.mount();
  t.app.map.setTileUrl(GIF); // no network tiles in tests
  await t.connectEmulator(path);
  await t.app.connection.capture!.idle();
  const k = t.emulatorScenario().keys;
  return { t, alice: toHex(k.alice), repeater: toHex(k.repeater) };
}

describe('Show on map (issue #13)', () => {
  it('the node page header on the Messages tab links a located contact to the map, which selects and centres it', async () => {
    const { t, alice } = await connected();
    location.hash = `#/node/${alice}/messages`;
    await t.click('[data-field="header"] [data-action="show-on-map"]');
    await t.until(() => location.hash === `#/map/node/${alice}`, 3000, 'map route');
    await t.until(() => t.query('[data-card]'), 5000, 'card');
    expect(t.query('#card-title')!.textContent).toBe('Alice');
    expect(t.query<McMapMarker>(`mc-map-marker[data-key="${alice}"]`)!.selected).toBe(true);
    expect(t.query('nav a[aria-current="page"]')?.dataset['path']).toBe('/map');
    const map = t.query<McTileMap>('mc-tile-map')!;
    await t.until(() => Math.abs(map.lat - 47.61) < 1e-6, 3000, 'centred');
    expect(map.lon).toBeCloseTo(-122.33, 6);
    expect(map.zoom).toBeGreaterThanOrEqual(14);
    // the card links back to the contact
    expect(t.query('[data-card] [data-action="chat"]')!.getAttribute('href')).toBe(`#/node/${alice}/messages`);
  });

  it('is absent for a contact without a location', async () => {
    const { t } = await connected();
    const bob = toHex(t.emulatorScenario().keys.bob);
    location.hash = `#/node/${bob}/messages`;
    await t.until(() => t.query('[data-field="header"] [data-field="subtitle"]') && t.query('[data-field="composer"]'), 3000, 'node page');
    expect(t.query('[data-action="show-on-map"]')).toBeNull();
  });

  it('the node page links to the map, and focusing re-enables a hidden kind', async () => {
    const { t, repeater } = await connected();
    t.app.map.setKindVisible('repeater', false);
    location.hash = `#/node/${repeater}`;
    await t.click('[data-action="show-on-map"]');
    await t.until(() => location.hash === `#/map/node/${repeater}` && t.query('#card-title'), 5000, 'focused repeater');
    expect(t.query('#card-title')!.textContent).toBe('Hilltop Repeater');
    expect(t.app.map.isKindVisible('repeater')).toBe(true);
    const map = t.query<McTileMap>('mc-tile-map')!;
    await t.until(() => Math.abs(map.lat - 47.62) < 1e-6, 3000, 'centred');
  });
});
