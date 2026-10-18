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

const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

async function openPath(): Promise<{ t: Harness; bob: string; repeaterHop: string; room: string }> {
  const t = (h = createHarness());
  await t.mount();
  const k = t.emulatorScenario().keys;
  const bob = toHex(k.bob);
  await t.connectEmulator(`/node/${bob}/path`);
  await t.app.connection.capture!.idle();
  await t.until(() => t.query('[data-field="current-path"]')?.textContent?.includes('flood'), 5000, 'path page');
  return { t, bob, repeaterHop: toHex(k.repeater.subarray(0, 1)), room: toHex(k.room) };
}

describe('node page Path tab', () => {
  it('builds a path from the repeater list, sets it, and lists it under previously used paths', async () => {
    const { t, bob, repeaterHop, room } = await openPath();
    expect(t.query('[data-field="no-history"]')).not.toBeNull();
    expect(t.query<HTMLButtonElement>('[data-action="use-flood"]')!.disabled).toBe(true);
    // repeaters and rooms are candidates; search narrows them
    await t.until(() => t.queryAll('[data-candidate]').length === 2, 3000, 'candidates');
    await t.fill('[data-field="path-search"]', 'hill');
    await t.until(() => t.queryAll('[data-candidate]').length === 1, 3000, 'filtered');
    await t.click('[data-candidate] [data-action="add-hop"]');
    await t.fill('[data-field="path-search"]', '');
    await t.until(() => t.query(`[data-candidate="${room}"]`), 3000, 'room');
    t.query(`[data-candidate="${room}"] [data-action="add-hop"]`)!.click();
    await t.until(() => t.queryAll('[data-draft-hop]').length === 2, 3000, 'two hops');
    // reorder, then drop the room again
    t.query('[data-draft-hop="1"] [data-action="hop-up"]')!.click();
    await t.until(() => t.query('[data-draft-hop="0"]')?.textContent?.includes('Town Square'), 3000, 'reordered');
    t.query('[data-draft-hop="0"] [data-action="hop-remove"]')!.click();
    await t.until(() => t.queryAll('[data-draft-hop]').length === 1, 3000, 'one hop');

    await t.click('[data-action="apply-path"]');
    await t.until(() => t.query('[data-field="current-path"]')?.textContent?.includes('Hilltop Repeater'), 5000, 'current path');
    const rec = await t.app.connection.store.value!.contacts.get(bob);
    expect(toHex(rec!.outPath)).toBe(repeaterHop);
    await t.until(() => t.query(`[data-history="1:${repeaterHop}"]`), 3000, 'history row');
    expect(t.query(`[data-history="1:${repeaterHop}"]`)!.hasAttribute('data-current')).toBe(true);

    // send a DM over it: the row counts the delivery
    await t.app.chat('contact', bob).send('over the hill');
    await t.until(() => t.query(`[data-history="1:${repeaterHop}"] [data-field="stats"]`)?.textContent?.includes('1/1 delivered'), 8000, 'stats');

    // flood, then "Use" the remembered path again
    await t.click('[data-action="use-flood"]');
    await t.until(() => t.query('[data-field="current-path"]')?.textContent?.includes('flood'), 5000, 'flood');
    await t.until(() => t.query(`[data-history="1:${repeaterHop}"] [data-action="use-path"]`), 3000, 'use button');
    await t.click(`[data-history="1:${repeaterHop}"] [data-action="use-path"]`);
    await t.until(() => t.query('[data-field="current-path"]')?.textContent?.includes('Hilltop Repeater'), 5000, 'reused');
  });

  it('adds hops by tapping repeaters on the map', async () => {
    const { t } = await openPath();
    t.app.map.setTileUrl(GIF);
    await t.click('[data-mode="map"]');
    await t.until(() => t.query('[data-field="path-map"] mc-map-marker[data-key]'), 3000, 'map markers');
    t.query<HTMLElement>('[data-field="path-map"] mc-map-marker[data-key]')!.click();
    await t.until(() => t.queryAll('[data-draft-hop]').length === 1, 3000, 'hop from map');
    expect(t.query('[data-draft-hop="0"]')!.textContent).toContain('Hilltop Repeater');
  });
});
