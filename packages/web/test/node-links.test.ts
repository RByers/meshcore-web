/**
 * Clickable nodes in displayed paths (known contacts → their node page; unknown / ambiguous hop
 * hashes → the node page of the bare hash), the node Info tab's "Packets from this node" link
 * (packet log filtered by source node) and its packet activity chart.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { concatBytes, toHex } from '@meshcore-web/core/util/bytes';
import { channelKeyForPsk } from '@meshcore-web/core/store';
import { publicChannelSecret } from '@meshcore-web/core/emulator';
import { PayloadType, RouteType, buildPacket } from '@meshcore-web/core/packet';
import { ContactType } from '@meshcore-web/core/protocol';
import '../src/mc-app.js';
import type { McHopsLink } from '../src/components/path-dialog.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  localStorage.clear();
});

async function connected(path?: string): Promise<{ t: Harness; alice: string; repeater: string }> {
  const t = (h = createHarness());
  await t.mount();
  t.app.map.setTileUrl(GIF);
  await t.connectEmulator(path);
  await t.app.connection.capture!.idle();
  const k = t.emulatorScenario().keys;
  return { t, alice: toHex(k.alice), repeater: toHex(k.repeater) };
}

async function go(t: Harness, path: string, selector: string): Promise<void> {
  location.hash = `#${path}`;
  await t.until(() => t.query(selector), 5000, selector);
}

function msgWith(t: Harness, text: string): HTMLElement | undefined {
  return t.queryAll('.msg').find((li) => li.querySelector('[data-field="text"]')?.textContent === text);
}

/** A node page Info tab field. */
function info(t: Harness, selector: string): HTMLElement | null {
  return t.query('mc-node-info')?.shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
}

/** A node page header field. */
function header(t: Harness, selector: string): HTMLElement | null {
  return t.query('mc-node-page')?.shadowRoot?.querySelector<HTMLElement>(`[data-field="header"] ${selector}`) ?? null;
}

/** A first key byte (hex) no stored contact (nor this radio) starts with. */
function unusedByte(t: Harness): string {
  const used = new Set([...t.app.contacts.views.value.map((v) => v.key.slice(0, 2)), toHex(t.emulatorScenario().keys.self).slice(0, 2)]);
  for (let b = 0; b < 256; b++) {
    const hex = b.toString(16).padStart(2, '0');
    if (!used.has(hex)) return hex;
  }
  throw new Error('no unused byte');
}

describe('path nodes link to node pages', () => {
  it('message path names link to the repeater; the compass opens the path view, whose stops link too', async () => {
    const { t, repeater } = await connected();
    t.app.appSettings.setPathNames(true);
    const pub = await channelKeyForPsk(publicChannelSecret());
    await go(t, `/channel/${pub}`, '[data-field="sender"]');
    t.emulatorScenario().nodes.carol.sendChannelMessage('Public', 'via the hill');
    await t.until(() => msgWith(t, 'via the hill')?.querySelector('[data-node-link]'), 5000, 'hop link');
    const path = msgWith(t, 'via the hill')!.querySelector('[data-field="path"]')!;
    expect(path.textContent).toBe('Hilltop Repeater');
    const link = path.querySelector<HTMLAnchorElement>(`a[data-node-link="${repeater}"]`)!;
    expect(link.getAttribute('href')).toBe(`#/node/${repeater}`);

    // the path view is still one click away
    path.querySelector<McHopsLink>('mc-hops-link[icon]')!.shadowRoot!.querySelector('button')!.click();
    await t.until(() => t.query<HTMLDialogElement>('[data-path-dialog]')?.open && t.query('[data-path-list]'), 5000, 'path dialog');
    const stop = t.query<HTMLAnchorElement>(`[data-path-list] li[data-role="hop"] a[data-node-link="${repeater}"]`)!;
    expect(stop.textContent).toBe('Hilltop Repeater');
    stop.click();
    await t.until(() => location.hash === `#/node/${repeater}` && !t.query<HTMLDialogElement>('[data-path-dialog]')!.open, 5000, 'node page');
    await t.until(() => header(t, '[data-field="name"]')?.textContent === 'Hilltop Repeater' && info(t, '[data-field="key"]')?.textContent === repeater, 5000, 'repeater info');
  });

  it("the node page's own path links its hops", async () => {
    const { t, alice, repeater } = await connected();
    t.app.appSettings.setPathNames(true);
    await go(t, `/node/${alice}`, 'mc-node-info');
    await t.until(() => info(t, `[data-field="path"] a[data-node-link="${repeater}"]`), 5000, 'path link');
    expect(info(t, '[data-field="path"]')!.textContent).toBe('Hilltop Repeater');
  });

  it('packet log path hops link to the contact without opening the packet', async () => {
    const { t, repeater } = await connected('/packets');
    const store = t.app.connection.store.peek()!;
    const bytes = buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.TXT_MSG,
      path: Uint8Array.of(parseInt(repeater.slice(0, 2), 16)),
      payload: concatBytes(Uint8Array.of(0x01, 0xee), new Uint8Array(18)),
    });
    const rec = await store.packets.append({ direction: 'rx', bytes, source: 'logRxData' });
    const sel = `tr[data-packet-id="${rec.id}"] [data-field="path"] a[data-node-link="${repeater}"]`;
    await t.until(() => t.query(sel), 5000, 'hop link');
    expect(t.query(`tr[data-packet-id="${rec.id}"] [data-field="path"]`)!.textContent!.replace(/\s+/g, ' ').trim()).toBe(`${repeater.slice(0, 2)} (1)`);
    t.query<HTMLAnchorElement>(sel)!.click();
    await t.until(() => location.hash === `#/node/${repeater}`, 5000, 'node page');
    expect(t.query('mc-packet-inspector')).toBeNull();
  });

  it('packet log hops with an unknown or ambiguous hash link to the node page of the hash', async () => {
    const { t, repeater } = await connected('/packets');
    const rep = repeater.slice(0, 2);
    // a second repeater sharing the repeater's hash makes that hop ambiguous
    const twin = rep + 'ab'.repeat(31);
    await t.app.contacts.add(twin, { name: 'Twin', type: ContactType.REPEATER });
    await t.until(() => t.app.contacts.views.value.filter((v) => v.key.startsWith(rep)).length === 2, 5000, 'twin stored');
    const free = unusedByte(t);
    const store = t.app.connection.store.peek()!;
    const bytes = buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.TXT_MSG,
      path: Uint8Array.of(parseInt(free, 16), parseInt(rep, 16)),
      payload: concatBytes(Uint8Array.of(0x01, 0xee), new Uint8Array(18)),
    });
    const rec = await store.packets.append({ direction: 'rx', bytes, source: 'logRxData' });
    const row = `tr[data-packet-id="${rec.id}"] [data-field="path"]`;
    await t.until(() => t.query(`${row} a[data-hash-link="${rep}"]`), 5000, 'hop links');
    const unknown = t.query<HTMLAnchorElement>(`${row} a[data-hash-link="${free}"]`)!;
    expect(unknown.getAttribute('href')).toBe(`#/node/${free}`);
    expect(t.query<HTMLAnchorElement>(`${row} a[data-hash-link="${rep}"]`)!.getAttribute('href')).toBe(`#/node/${rep}`);
    expect(t.query(`${row} a[data-node-link]`)).toBeNull();

    // the unknown hash: its node page says nothing is known, without opening the packet
    unknown.click();
    await t.until(() => location.hash === `#/node/${free}` && info(t, '[data-field="unknown"]'), 5000, 'unknown hash page');
    expect(t.query('mc-packet-inspector')).toBeNull();
    expect(info(t, '[data-field="key"]')!.textContent).toBe(free);

    // the ambiguous hash: its node page lists both contacts
    await go(t, `/node/${rep}`, '[data-field="candidates"]');
    expect(t.queryAll<HTMLAnchorElement>('[data-candidate]').map((a) => a.dataset['candidate']).sort()).toEqual([repeater, twin].sort());
  });

  it('an ambiguous hop in a message path and in the path view links to the node page of its hash', async () => {
    const { t, repeater } = await connected();
    t.app.appSettings.setPathNames(true);
    const rep = repeater.slice(0, 2);
    await t.app.contacts.add(rep + 'ab'.repeat(31), { name: 'Twin', type: ContactType.REPEATER });
    await t.until(() => t.app.contacts.views.value.filter((v) => v.key.startsWith(rep)).length === 2, 5000, 'twin stored');
    const pub = await channelKeyForPsk(publicChannelSecret());
    await go(t, `/channel/${pub}`, '[data-field="sender"]');
    t.emulatorScenario().nodes.carol.sendChannelMessage('Public', 'which hill?');
    await t.until(() => msgWith(t, 'which hill?')?.querySelector('[data-hash-link]'), 5000, 'hash link');
    const path = msgWith(t, 'which hill?')!.querySelector('[data-field="path"]')!;
    expect(path.querySelector('[data-node-link]')).toBeNull();
    expect(path.querySelector<HTMLAnchorElement>(`a[data-hash-link="${rep}"]`)!.getAttribute('href')).toBe(`#/node/${rep}`);

    path.querySelector<McHopsLink>('mc-hops-link[icon]')!.shadowRoot!.querySelector('button')!.click();
    await t.until(() => t.query<HTMLDialogElement>('[data-path-dialog]')?.open && t.query('[data-path-list]'), 5000, 'path dialog');
    const stop = t.query<HTMLAnchorElement>(`[data-path-list] li[data-role="hop"] a[data-field="label"][data-hash-link="${rep}"]`)!;
    expect(t.query('[data-path-list] li[data-role="hop"] [data-field="candidates"]')!.textContent).toContain('2 known nodes');
    stop.click();
    await t.until(() => location.hash === `#/node/${rep}` && !t.query<HTMLDialogElement>('[data-path-dialog]')!.open, 5000, 'hash page');
    await t.until(() => t.queryAll('[data-candidate]').length === 2, 5000, 'candidates');
  });
});

describe('node page packets', () => {
  it('links to the packet log filtered to the packets the node originated', async () => {
    const { t, alice } = await connected();
    const store = t.app.connection.store.peek()!;
    t.emulatorScenario().nodes.alice.advertise();
    await vi.waitFor(async () => expect(await store.packets.count({ src: alice })).toBeGreaterThan(0), { timeout: 5000 });
    await go(t, `/node/${alice}`, 'mc-node-info');
    await t.until(() => info(t, 'a[data-action="node-packets"]'), 5000, 'packets link');
    expect(info(t, 'a[data-action="node-packets"]')!.getAttribute('href')).toBe(`#/packets/node/${alice}`);
    info(t, 'a[data-action="node-packets"]')!.click();

    await t.until(() => t.query('[data-filter="src"]') && t.queryAll('tr[data-packet-id]').length > 0, 5000, 'filtered log');
    expect(t.query('[data-filter="src"]')!.textContent).toContain('Alice');
    expect(t.app.packetLog.packets.filter.value).toEqual({ src: alice });
    const expected = await store.packets.count({ src: alice });
    await t.until(() => t.queryAll('tr[data-packet-id]').length === expected, 5000, 'only alice packets');
    expect(t.query('a[data-path="/packets"]')!.getAttribute('aria-current')).toBe('page');

    await t.click('[data-action="clear-src"]');
    await t.until(() => location.hash === '#/packets' && !t.query('[data-filter="src"]'), 5000, 'filter cleared');
    expect(t.app.packetLog.packets.filter.value.src).toBeUndefined();
  });

  it('charts the packets heard from the node over time and follows new packets', async () => {
    const { t, alice } = await connected();
    const store = t.app.connection.store.peek()!;
    t.emulatorScenario().nodes.alice.advertise();
    await vi.waitFor(async () => expect(await store.packets.count({ src: alice })).toBeGreaterThan(0), { timeout: 5000 });
    await go(t, `/node/${alice}`, 'mc-node-info');
    const chart = () => info(t, 'mc-activity-chart');
    const bars = () => [...(chart()?.shadowRoot?.querySelectorAll<HTMLElement>('[data-bar]') ?? [])];
    await t.until(() => bars().length === 28, 5000, '7-day chart');
    const total = () => bars().reduce((n, b) => n + Number(b.dataset['count']), 0);
    const logged = await store.packets.count({ src: alice });
    await t.until(() => total() === logged, 5000, 'chart total');
    expect(bars().at(-1)!.dataset['count']).toBe(String(logged));
    expect(info(t, '[data-field="activity-summary"]')!.textContent).toContain(`${logged} packet`);

    // hover tooltip
    bars().at(-1)!.dispatchEvent(new PointerEvent('pointerenter'));
    await t.until(() => chart()!.shadowRoot!.querySelector('[data-field="tooltip"]'), 2000, 'tooltip');
    expect(chart()!.shadowRoot!.querySelector('[data-field="tooltip"]')!.textContent).toContain(`${logged} packet`);

    // range switch
    info(t, 'button[data-range="24h"]')!.click();
    await t.until(() => bars().length === 24 && total() === logged, 5000, '24h chart');

    // a new packet from Alice shows up live
    t.emulatorScenario().nodes.alice.sendText(t.emulatorScenario().keys.self, 'ping');
    await vi.waitFor(async () => expect(await store.packets.count({ src: alice })).toBeGreaterThan(logged), { timeout: 5000 });
    const now = await store.packets.count({ src: alice });
    await t.until(() => total() === now, 5000, 'chart updated');
    expect(info(t, '[data-field="activity-hash-note"]')!.textContent).toContain(alice.slice(0, 2));
  });

  it('shows an empty state for a node with no packets', async () => {
    const { t } = await connected();
    const bob = toHex(t.emulatorScenario().keys.bob);
    await go(t, `/node/${bob}`, 'mc-node-info');
    await t.until(() => info(t, '[data-field="activity-empty"]'), 5000, 'empty state');
    expect(info(t, '[data-field="activity-empty"]')!.textContent).toContain('7 days');
  });
});
