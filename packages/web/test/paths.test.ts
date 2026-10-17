/** Issue #2: clickable "N hops" labels open the path view (list of hops + route on a map). */
import { afterEach, describe, expect, it } from 'vitest';
import { concatBytes, toHex } from '@meshcore-web/core/util/bytes';
import { channelKeyForPsk } from '@meshcore-web/core/store';
import { publicChannelSecret } from '@meshcore-web/core/emulator';
import { PayloadType, RouteType, buildPacket, channelHash } from '@meshcore-web/core/packet';
import '../src/mc-app.js';
import type { McHopsLink, McPathDialog } from '../src/components/path-dialog.js';
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

function dialog(t: Harness): McPathDialog {
  return t.query<McPathDialog>('mc-path-dialog')!;
}

function stops(t: Harness): { role: string; position: string; label: string; hash: string | undefined }[] {
  return t.queryAll('[data-path-list] li[data-stop]').map((li) => ({
    role: li.dataset['role']!,
    position: li.dataset['position']!,
    label: li.querySelector('[data-field="label"]')!.textContent!.trim(),
    hash: li.dataset['hash'],
  }));
}

async function openedPath(t: Harness, linkSelector: string): Promise<void> {
  await t.until(() => t.query(linkSelector), 5000, linkSelector);
  t.query<McHopsLink>(linkSelector)!.shadowRoot!.querySelector('button')!.click();
  try {
    await t.until(() => t.query<HTMLDialogElement>('[data-path-dialog]')?.open && t.query('[data-path-list]'), 5000, 'path dialog');
  } catch (e) {
    throw new Error(`${String(e)}: ${t.query<HTMLDialogElement>('[data-path-dialog]')?.open} ${t.query('[data-path-dialog]')?.textContent}`);
  }
}

describe('path view (issue #2)', () => {
  it('a contact path: list of hops plus the route on a map', async () => {
    const { t, alice, repeater } = await connected();
    location.hash = `#/chat/${alice}`;
    await openedPath(t, '[data-field="subtitle"] mc-hops-link');
    expect(dialog(t).spec?.hashes).toEqual([repeater.slice(0, 2)]);
    expect(stops(t)).toEqual([
      { role: 'from', position: 'known', label: 'Emulator (you)', hash: undefined },
      { role: 'hop', position: 'known', label: 'Hilltop Repeater', hash: repeater.slice(0, 2) },
      { role: 'to', position: 'known', label: 'Alice', hash: undefined },
    ]);
    const map = dialog(t).shadowRoot!.querySelector<McTileMap>('mc-tile-map')!;
    await t.until(() => map.size.width > 0 && map.shadowRoot!.querySelectorAll('path[data-line]').length === 2, 3000, 'polyline');
    const markers = [...map.querySelectorAll<McMapMarker>('mc-map-marker[data-stop]')];
    expect(markers.map((m) => [m.label, m.approximate, m.glyph])).toEqual([
      ['Emulator (you)', false, ''],
      ['Hilltop Repeater', false, '1'],
      ['Alice', false, ''],
    ]);
    expect(map.shadowRoot!.querySelector('path[data-dashed]')).toBeNull();
    // every stop is inside the fitted view
    for (const m of markers) {
      const p = map.project(m.lat, m.lon);
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(map.size.width);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(map.size.height);
    }
    await t.click('[data-action="close-path"]');
    await t.until(() => !t.query<HTMLDialogElement>('[data-path-dialog]')!.open, 2000, 'closed');
  });

  it('a channel message: hop count only, then hops from the logged packet with an estimated position', async () => {
    const { t, repeater } = await connected();
    const pub = await channelKeyForPsk(publicChannelSecret());
    location.hash = `#/channel/${pub}`;
    const link = '.msg[data-dir="in"] [data-field="route"] mc-hops-link';
    await openedPath(t, link);
    expect(t.query('[data-path-list]')!.textContent).toContain('2 repeaters, not recorded');
    expect(t.query('[data-field="path-note"]')!.textContent).toContain('only the hop count');
    expect(stops(t).map((s) => s.label)).toEqual(['Dave', 'Emulator (you)']);
    await t.click('[data-action="close-path"]');

    // log the GRP_TXT that carried Dave's message: via the repeater and an unknown 0x99
    const store = t.app.connection.store.peek()!;
    const msg = (await store.messages.list(pub)).items.find((m) => m.senderName === 'Dave')!;
    const bytes = buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.GRP_TXT,
      path: Uint8Array.of(parseInt(repeater.slice(0, 2), 16), 0x99),
      payload: concatBytes(Uint8Array.of(await channelHash(publicChannelSecret())), new Uint8Array(19)),
    });
    await store.packets.append({ direction: 'rx', bytes, ts: msg.receivedAt - 500, source: 'logRxData' });

    await openedPath(t, link);
    await t.until(() => stops(t).length === 4, 3000, 'hops from the packet');
    // with the "approximate positions" setting off, stops without a location stay off the map
    expect(t.app.appSettings.approximatePositions.peek()).toBe(false);
    expect(stops(t).map((s) => s.position)).toEqual(['none', 'known', 'none', 'known']);
    let map = dialog(t).shadowRoot!.querySelector<McTileMap>('mc-tile-map')!;
    await t.until(() => map.shadowRoot!.querySelectorAll('path[data-line]').length === 1, 3000, 'known leg only');
    expect(map.querySelectorAll('mc-map-marker[data-stop]').length).toBe(2);
    expect(map.querySelector<McMapMarker>('mc-map-marker[approximate]')).toBeNull();
    expect(t.query('[data-field="unplaced"]')!.textContent).toContain('2 stops have no known location');
    expect(t.text()).not.toContain('estimated positions');

    // the path view's checkbox turns the setting on
    const box = t.query<HTMLInputElement>('[data-path-dialog] [data-approximate]')!;
    expect(box.checked).toBe(false);
    box.click();
    expect(t.app.appSettings.approximatePositions.peek()).toBe(true);
    await t.until(() => stops(t)[2]?.position === 'interpolated', 3000, 'estimated positions');
    expect(stops(t)).toEqual([
      { role: 'from', position: 'extrapolated', label: 'Dave', hash: undefined },
      { role: 'hop', position: 'known', label: 'Hilltop Repeater', hash: repeater.slice(0, 2) },
      { role: 'hop', position: 'interpolated', label: '99', hash: '99' },
      { role: 'to', position: 'known', label: 'Emulator (you)', hash: undefined },
    ]);
    map = dialog(t).shadowRoot!.querySelector<McTileMap>('mc-tile-map')!;
    await t.until(() => map.shadowRoot!.querySelectorAll('path[data-line]').length === 3, 3000, 'polyline');
    const unknown = map.querySelector<McMapMarker>('mc-map-marker[data-stop="2"]')!;
    expect(unknown.approximate).toBe(true);
    expect(unknown.shadowRoot!.querySelector('.glyph')!.textContent).toBe('?');
    // dashed legs touch the estimated stops (Dave → repeater, repeater → 99, 99 → self)
    expect(map.shadowRoot!.querySelectorAll('path[data-dashed]').length).toBe(3);
    expect(t.text()).toContain('estimated positions');
    expect(t.query('[data-field="unplaced"]')).toBeNull();
  });

  it('packet log rows: the path cell opens the path view without opening the packet', async () => {
    const { t, repeater } = await connected('/packets');
    const store = t.app.connection.store.peek()!;
    const bytes = buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.TXT_MSG,
      path: Uint8Array.of(parseInt(repeater.slice(0, 2), 16)),
      payload: concatBytes(Uint8Array.of(0x01, 0xee), new Uint8Array(18)),
    });
    const rec = await store.packets.append({ direction: 'rx', bytes, source: 'logRxData' });
    const link = `tr[data-packet-id="${rec.id}"] [data-field="path"] mc-hops-link`;
    await t.until(() => t.query(link), 5000, 'packet row');
    const before = location.hash;
    await openedPath(t, link);
    expect(location.hash).toBe(before);
    expect(stops(t).map((s) => [s.role, s.label])).toEqual([
      ['from', 'ee'],
      ['hop', 'Hilltop Repeater'],
      ['to', 'Emulator (you)'],
    ]);
    expect(t.query('[data-path-dialog] h2')!.textContent).toContain(`TXT_MSG packet #${rec.id}`);
  });
});
