/** Issue #7: the map can show nodes without a location near the repeater they were last heard through. */
import { afterEach, describe, expect, it } from 'vitest';
import { toHex } from '@meshcore-web/core/util/bytes';
import { haversineMeters } from '@meshcore-web/core/app';
import '../src/mc-app.js';
import type { McMapMarker } from '../src/components/tile-map.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('approximate positions (issue #7)', () => {
  it('map toggle shows a dashed "?" marker near the repeater, with an "Approximate" card', async () => {
    const t = (h = createHarness());
    await t.mount();
    t.app.map.setTileUrl(GIF); // no network tiles in tests
    await t.connectEmulator('/map');
    const s = t.emulatorScenario();
    const sensor = toHex(s.keys.sensor); // no location, stored out_path via the repeater
    await t.until(() => t.query(`mc-map-marker[data-key="${toHex(s.keys.repeater)}"]`), 5000, 'markers');
    expect(t.query(`mc-map-marker[data-key="${sensor}"]`)).toBeNull();
    expect(t.query<HTMLInputElement>('[data-approximate]')!.checked).toBe(false);

    await t.click('[data-approximate]');
    expect(t.app.appSettings.approximatePositions.value).toBe(true);
    await t.until(() => t.query(`mc-map-marker[data-key="${sensor}"]`), 5000, 'estimated marker');
    const marker = t.query<McMapMarker>(`mc-map-marker[data-key="${sensor}"]`)!;
    await marker.updateComplete;
    expect(marker.approximate).toBe(true);
    expect(marker.hasAttribute('approximate')).toBe(true);
    expect(marker.shadowRoot!.querySelector('.glyph')?.textContent).toBe('?');
    expect(marker.description).toContain('approximate position near Hilltop Repeater');
    expect(haversineMeters({ lat: marker.lat, lon: marker.lon }, { lat: 47.62, lon: -122.35 })).toBeLessThan(1500);

    marker.shadowRoot!.querySelector('button')!.click();
    await t.until(() => t.query('[data-card]'), 2000, 'card');
    expect(t.query('#card-title')!.textContent).toBe('Weather Station');
    expect(t.query('[data-field="approximate"]')!.textContent!.replace(/\s+/g, ' ').trim()).toMatch(/^Approximate: near Hilltop Repeater, last heard .+/);

    // "Show on map" from the node page while the setting is on
    location.hash = `#/node/${sensor}`;
    await t.click('[data-action="show-on-map"]');
    await t.until(() => location.hash === `#/map/node/${sensor}` && t.query('#card-title')?.textContent === 'Weather Station', 5000, 'focused estimate');

    // off again: the marker and the node page link disappear
    t.app.appSettings.setApproximatePositions(false);
    await t.until(() => !t.query(`mc-map-marker[data-key="${sensor}"]`), 3000, 'estimate hidden');
    location.hash = `#/node/${sensor}`;
    await t.until(() => t.query('[data-field="type"]'), 3000, 'node page');
    expect(t.query('[data-action="show-on-map"]')).toBeNull();
  });

  it('settings page checkbox persists the preference', async () => {
    const t = (h = createHarness());
    await t.mount();
    location.hash = '#/settings';
    await t.until(() => t.query('input[name="approximatePositions"]'), 3000, 'checkbox');
    const box = t.query<HTMLInputElement>('input[name="approximatePositions"]')!;
    expect(box.closest('label')!.textContent).toContain('Approximate positions of nodes without a location (from the repeaters they were last heard through)');
    await t.click('input[name="approximatePositions"]');
    expect(t.app.appSettings.approximatePositions.value).toBe(true);
  });
});
