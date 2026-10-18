/** The Stats tab of /packets (docs/packet-stats.md §3). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { buildPacket, encodeAdvertAppData, packetTypeNameDescription, PayloadType, RouteType } from '@meshcore-web/core/packet';
import { concatBytes, toHex } from '@meshcore-web/core/util/bytes';
import '../src/mc-app.js';
import '../src/pages/packets/index.js';
import { smazEncodeIfSmaller } from '@meshcore-web/core/util/smaz';
import { createHarness, type Harness } from '../src/testing/harness.js';
import type { McTileMap } from '../src/components/tile-map.js';
import { timelinePalette, timelineSeries, type McPacketStats } from '../src/pages/packets/packet-stats.js';
import { toDatetimeLocal } from '../src/pages/packets/inspection.js';

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
    const legendTitle = (key: string) =>
      inChart(el, 'dots', 'mc-dot-plot', '[data-legend] li').find((li) => li.dataset['legendKey'] === key)?.title;
    expect(legendTitle('ADVERT')).toBe(packetTypeNameDescription('ADVERT'));
    expect(legendTitle('ADVERT')).toBeTruthy();

    select(t.query('[data-select="y"]')!, 'rssi');
    await settle(t, el);
    expect(yLabel()).toBe('RSSI (dBm)');

    select(t.query('[data-select="color"]')!, 'source');
    await settle(t, el);
    const alice = t.app.contacts.contacts.value.find((c) => c.name === 'Alice')!;
    expect(legend()).not.toContain('ADVERT');
    expect(legend()).toContain(alice.key);
    // sources are not packet types: no type description tooltip
    expect(legendTitle(alice.key)).toBe('');
  });

  it('packet and route type breakdown legends explain each type on hover', async () => {
    const { el } = await openStats();
    const title = (label: string, key: string) =>
      inChart(el, 'utilization', `mc-breakdown[label="${label}"]`, '[data-legend] li').find((li) => li.dataset['legendKey'] === key)?.title;
    expect(title('Packet type', 'GRP_TXT')).toBe(packetTypeNameDescription('GRP_TXT'));
    expect(title('Packet type', 'GRP_TXT')).toBeTruthy();
    expect(title('Route type', 'FLOOD')).toBe(packetTypeNameDescription('FLOOD'));
    expect(title('Direction', 'Received') ?? '').toBe('');
  });

  it('a date preset narrows the packets counted', async () => {
    const { t, el } = await openStats();
    // one packet logged two hours ago: inside "All", outside "Last hour"
    const store = t.app.connection.store.value!;
    const old = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ACK, path: new Uint8Array(0), payload: new Uint8Array(4).fill(7) });
    const oldTs = t.clock.now() - 2 * 3_600_000;
    await store.packets.append({ direction: 'rx', bytes: old, ts: oldTs, source: 'logRxData', snr: 4, rssi: -95 });
    // other emulator traffic may still be landing, so check the old packet itself rather than comparing two totals
    const stats = t.app.packetStats;
    const hasOld = () => stats.points.value.some((p) => p.ts === oldTs);
    await t.until(hasOld, 3000, 'old packet counted');
    await settle(t, el);
    expect(Number(tileValue(t, 'packets'))).toBe(stats.summary.value.packets);

    await t.click('[data-preset="1h"]');
    await t.until(() => stats.range.value.from !== null, 3000, 'range set');
    await settle(t, el);
    expect(hasOld()).toBe(false);
    expect(stats.points.value.length).toBeGreaterThan(0);
    expect(Number(tileValue(t, 'packets'))).toBe(stats.summary.value.packets);
  });
});

describe('packet rate series', () => {
  it('keeps the 8 biggest series and sums the rest with Other', () => {
    const keys = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'Other'];
    const bins = [0, 1].map((i) => ({ t: i * 60_000, series: Object.fromEntries(keys.map((k, j) => [k, 20 - j + i])) }));
    const s = timelineSeries({ binMs: 60_000, bins, series: keys });
    expect(s.map((x) => x.key)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'Other']);
    // I (12) + J (11) + Other (10), +1 each in the second bin.
    expect(s[8]!.points.map((p) => p.v)).toEqual([33, 36]);
    expect(timelinePalette(s).legend.map((l) => l.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'Other']);
  });

  it('adds no Other line when everything fits', () => {
    const s = timelineSeries({ binMs: 60_000, bins: [{ t: 0, series: { DMs: 2, ACKs: 1 } }], series: ['DMs', 'ACKs'] });
    expect(s.map((x) => x.key)).toEqual(['DMs', 'ACKs']);
  });
});

describe('/packets Stats drill-down filters', () => {
  /** The keyed bar (role=button hit rect) whose accessible name starts with `label`. */
  function bar(el: McPacketStats, section: string, label: string): Element {
    const hit = inChart(el, section, 'mc-bar-chart', 'rect[role="button"]').find((r) => r.getAttribute('aria-label')!.startsWith(`${label}:`));
    if (!hit) throw new Error(`no ${label} bar in ${section}`);
    return hit;
  }

  function chips(t: Harness): string[] {
    return t.queryAll('[data-chip]').map((c) => c.textContent!.replace('×', '').replace(/\s+/g, ' ').trim());
  }

  it('clicking a source bar filters every chart to that source; chips remove it, Clear filters clears all', async () => {
    const { t, el } = await openStats();
    expect(t.query('[data-filterbar]')).toBeNull();

    bar(el, 'sources', 'Alice').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await t.until(() => t.query('[data-filterbar]'), 3000, 'filter bar');
    await settle(t, el);
    expect(t.app.packetStats.filters.value.map((f) => f.field)).toEqual(['source']);
    expect(chips(t)).toEqual(['Source: Alice']);
    // live traffic may still be landing: compare with the model's current counts, not the snapshot
    const stats = t.app.packetStats;
    await t.until(() => Number(tileValue(t, 'packets')) === stats.summary.value.packets, 3000, 'filtered tile');
    const filtered = Number(tileValue(t, 'packets'));
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(stats.unfilteredCount.value);
    expect(stats.points.value.every((p) => p.source?.label === 'Alice')).toBe(true);
    await settle(t, el);
    expect(t.query('[data-field="filter-count"]')!.textContent).toBe(`Showing ${stats.summary.value.packets} of ${stats.unfilteredCount.value} packets`);
    // the sources chart now shows only Alice, marked as the active filter
    const hits = inChart(el, 'sources', 'mc-bar-chart', 'rect[role="button"]');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.getAttribute('aria-pressed')).toBe('true');

    // a breakdown segment adds a second filter (AND)
    const typeChart = el.shadowRoot!.querySelector('mc-breakdown[data-breakdown="type"]')!;
    typeChart.shadowRoot!.querySelector<HTMLElement>('[data-mark="segment"][data-key="ADVERT"]')!.click();
    await settle(t, el);
    // the type drill-down is the packet log's own type filter, so its chip comes first
    expect(chips(t)).toEqual(['Type: ADVERT', 'Source: Alice']);

    // × on the source chip leaves the type filter
    await t.click('[data-remove-filter="source"]');
    await settle(t, el);
    expect(chips(t)).toEqual(['Type: ADVERT']);
    expect(Number(tileValue(t, 'packets'))).toBe(t.app.packetStats.summary.value.packets);

    await t.click('[data-action="clear-filters"]');
    await settle(t, el);
    expect(t.app.packetStats.filters.value).toEqual([]);
    expect(t.query('[data-filterbar]')).toBeNull();
    expect(Number(tileValue(t, 'packets'))).toBe(t.app.packetStats.unfilteredCount.value);
  });

  it('breakdown legend buttons are focusable and toggle the filter; direction chips say Received', async () => {
    const { t, el } = await openStats();
    const dir = el.shadowRoot!.querySelector('mc-breakdown[data-breakdown="direction"]')!;
    const btn = (): HTMLButtonElement => dir.shadowRoot!.querySelector<HTMLButtonElement>('[data-legend] button[data-key="in"]')!;
    btn().focus();
    expect(dir.shadowRoot!.activeElement).toBe(btn());
    btn().click();
    await settle(t, el);
    expect(chips(t)).toEqual(['Direction: Received']);
    expect(btn().getAttribute('aria-pressed')).toBe('true');
    // clicking the active value again removes the filter
    btn().click();
    await settle(t, el);
    expect(t.query('[data-filterbar]')).toBeNull();
  });

  it('a hop-count bar filters from the keyboard', async () => {
    const { t, el } = await openStats();
    const hit = inChart(el, 'hops', 'mc-bar-chart', 'rect[role="button"]')[0]!;
    const key = hit.getAttribute('data-key')!;
    hit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(t, el);
    expect(t.app.packetStats.filters.value).toEqual([expect.objectContaining({ field: 'hops', value: key })]);
    expect(chips(t)[0]).toMatch(/^Hops: /);
  });

  it('shows an empty state but keeps the filter bar when nothing matches', async () => {
    const { t, el } = await openStats();
    t.app.packetStats.addFilter({ field: 'hops', value: '99', label: '99' });
    await settle(t, el);
    expect(t.query('[data-empty="filtered"]')!.textContent).toContain('No packets match these filters');
    expect(t.query('[data-filterbar]')).not.toBeNull();
    expect(t.query('[data-tiles]')).toBeNull();
    await t.click('[data-action="clear-filters"]');
    await settle(t, el);
    expect(t.query('[data-empty="filtered"]')).toBeNull();
    expect(t.query('[data-tiles]')).not.toBeNull();
  });
});

describe('/packets filters shared by the Packets and Stats tabs', () => {
  function chips(t: Harness): string[] {
    return t.queryAll('[data-chip]').map((c) => c.textContent!.replace('×', '').replace(/\s+/g, ' ').trim());
  }

  it('a Stats drill-down filters the Packets tab, where its chip removes it from both', async () => {
    const { t, el } = await openStats();
    const stats = t.app.packetStats;
    const hit = inChart(el, 'sources', 'mc-bar-chart', 'rect[role="button"]').find((r) => r.getAttribute('aria-label')!.startsWith('Alice:'))!;
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await t.until(() => t.query('[data-filterbar]'), 3000, 'filter bar');

    await t.click('[data-tab="packets"]');
    // the log has reloaded with the drill-down (its query waits for the stats load)
    const log = t.app.packetLog.packets;
    await t.until(() => !log.loading.value, 3000, 'packet log reloaded');
    await log.settled();
    const rowIds = () => t.queryAll('tr[data-packet-id]').map((r) => Number(r.dataset['packetId']));
    await t.until(() => rowIds().length > 0 && rowIds().join() === log.rows.value.map((r) => r.id).join(), 3000, 'filtered rows rendered');
    // only Alice's packets: every row is one of the stats points (all from Alice)
    const ids = new Set(stats.points.value.map((p) => p.id));
    expect(stats.points.value.every((p) => p.source?.label === 'Alice')).toBe(true);
    expect(rowIds().every((id) => ids.has(id))).toBe(true);
    expect(t.query('tr[data-type="GRP_TXT"]')).toBeNull();
    expect(t.query('[data-filter="drill-source"]')!.textContent).toContain('Source: Alice');
    expect(t.query('[data-action="clear-filters"]')).not.toBeNull();

    await t.click('[data-filter="drill-source"] [data-action="remove-chip"]');
    await t.until(() => t.query('tr[data-type="GRP_TXT"]'), 3000, "Bob's packet again");
    expect(t.query('[data-filter="drill-source"]')).toBeNull();
    expect(stats.filters.value).toEqual([]);

    await t.click('[data-tab="stats"]');
    await t.until(() => t.query('[data-tiles]'), 3000, 'stats tiles');
    expect(t.query('[data-filterbar]')).toBeNull();
  });

  it('a Packets-tab filter narrows the Stats tab and shows as a chip there', async () => {
    const { t } = await openStats();
    const stats = t.app.packetStats;
    await t.click('[data-tab="packets"]');
    await t.fill('input[data-filter="text"]', 'hello from bob');
    await t.until(() => t.app.packetLog.packets.filter.value.text === 'hello from bob', 3000, 'text filter');

    await t.click('[data-tab="stats"]');
    await t.until(() => t.query('[data-filterbar]'), 3000, 'filter bar');
    expect(chips(t)).toEqual(['Text: hello from bob']);
    await t.until(() => stats.points.value.length > 0 && stats.points.value.every((p) => p.typeName === 'GRP_TXT'), 3000, 'only matching points');
    expect(stats.points.value.length).toBeLessThan(stats.unfilteredCount.value);
    await t.until(
      () => t.query('[data-field="filter-count"]')?.textContent === `Showing ${stats.points.value.length} of ${stats.unfilteredCount.value} packets`,
      3000,
      'filter count',
    );

    // Clear filters on Stats clears the Packets tab's text too
    await t.click('[data-action="clear-filters"]');
    await t.until(() => t.query('[data-filterbar]') === null, 3000, 'no filter bar');
    expect(t.app.packetLog.packets.filter.value).toEqual({});
  });

  it("a Stats date preset is the Packets tab's From; Reset there clears it", async () => {
    const { t } = await openStats();
    const stats = t.app.packetStats;
    await t.click('[data-preset="1h"]');
    await t.until(() => stats.range.value.from !== null, 3000, 'range set');
    const from = stats.range.value.from!;
    // the range is not a chip
    expect(t.query('[data-filterbar]')).toBeNull();

    await t.click('[data-tab="packets"]');
    await t.until(() => t.query<HTMLInputElement>('input[data-filter="from"]'), 3000, 'from input');
    expect(t.query<HTMLInputElement>('input[data-filter="from"]')!.value).toBe(toDatetimeLocal(from));
    await t.click('[data-action="clear-filters"]');
    await t.until(() => stats.range.value.from === null, 3000, 'range cleared');
    await t.until(() => t.query<HTMLInputElement>('input[data-filter="from"]')!.value === '', 3000, 'from input cleared');
  });
});

describe('/packets Stats text compression', () => {
  const COMPRESSIBLE = 'this is the message that should compress well';

  /** openStats plus one SMAZ-compressed channel text from bob (and his plain "hello from bob"). */
  async function openWithCompressed(): Promise<{ t: Harness; el: McPacketStats }> {
    const r = await openStats();
    const { t, el } = r;
    const envelope = smazEncodeIfSmaller(COMPRESSIBLE);
    expect(envelope.startsWith('s:')).toBe(true);
    t.emulatorScenario().nodes.bob.sendChannelMessage('Public', envelope);
    await t.app.connection.capture!.idle();
    await t.until(() => t.app.packetStats.compression.value.smaz > 0, 5000, 'compressed text counted');
    await settle(t, el);
    return r;
  }

  function segments(el: McPacketStats, id: string): Record<string, string> {
    const b = el.shadowRoot!.querySelector(`mc-breakdown[data-breakdown="compression-${id}"]`);
    if (!b) return {};
    return Object.fromEntries([...b.shadowRoot!.querySelectorAll<HTMLElement>('[data-legend] li')].map((li) => [li.dataset['legendKey']!, li.querySelector('.share')!.textContent!.trim()]));
  }

  it('renders compressed / plain counts, the savings summary and per-category rows', async () => {
    const { t, el } = await openWithCompressed();
    const c = t.app.packetStats.compression.value;
    expect(c.smaz).toBeGreaterThanOrEqual(1);
    expect(c.plain).toBeGreaterThanOrEqual(1);
    expect(c.byCategory.channel.smaz).toBe(c.smaz);
    expect(c.bytesSaved).toBeGreaterThan(0);

    const section = el.shadowRoot!.querySelector('[data-section="compression"]')!;
    expect(section.querySelector('h3')!.textContent).toBe('Text compression');
    // the section sits between network utilisation and hop count
    const order = [...el.shadowRoot!.querySelectorAll('[data-section]')].map((s) => s.getAttribute('data-section'));
    expect(order.indexOf('compression')).toBe(order.indexOf('utilization') + 1);
    expect(order.indexOf('hops')).toBe(order.indexOf('compression') + 1);

    const summary = section.querySelector('[data-field="compression-summary"]')!.textContent!;
    expect(summary).toContain('of decrypted text messages compressed');
    expect(summary).toContain(`${c.bytesSaved} B saved`);
    expect(summary).toContain(`across ${c.smaz} compressed message`);
    expect(summary).toMatch(/1 sender using compression/);

    expect(Object.keys(segments(el, 'all'))).toEqual(expect.arrayContaining(['Compressed', 'Plain']));
    expect(Object.keys(segments(el, 'channel'))).toEqual(expect.arrayContaining(['Compressed', 'Plain']));
    expect(Object.keys(segments(el, 'in'))).toContain('Compressed');
    // a legend entry's tooltip explains "Not decrypted" (only present when some text had no key)
    const b = section.querySelector('mc-breakdown[data-breakdown="compression-all"]')!;
    const nd = [...b.shadowRoot!.querySelectorAll<HTMLElement>('[data-legend] li')].find((li) => li.dataset['legendKey'] === 'Not decrypted');
    if (nd) expect(nd.title).toContain('no key');
  });

  it('clicking the Compressed segment filters to compressed texts', async () => {
    const { t, el } = await openWithCompressed();
    const stats = t.app.packetStats;
    const b = el.shadowRoot!.querySelector('mc-breakdown[data-breakdown="compression-all"]')!;
    b.shadowRoot!.querySelector<HTMLElement>('[data-mark="segment"][data-key="smaz"]')!.click();
    await t.until(() => t.query('[data-filterbar]'), 3000, 'filter bar');
    await settle(t, el);
    expect(t.queryAll('[data-chip]').map((c) => c.textContent!.replace('×', '').replace(/\s+/g, ' ').trim())).toEqual(['Compression: Compressed']);
    await t.until(() => Number(tileValue(t, 'packets')) === stats.summary.value.packets, 3000, 'filtered tile');
    expect(stats.points.value.length).toBeGreaterThan(0);
    expect(stats.points.value.every((p) => p.compression === 'smaz')).toBe(true);
    expect(stats.points.value.length).toBeLessThan(stats.unfilteredCount.value);
    await settle(t, el);
    const seg = el.shadowRoot!.querySelector('mc-breakdown[data-breakdown="compression-all"]')!.shadowRoot!.querySelector('[data-legend] button[data-key="smaz"]')!;
    expect(seg.getAttribute('aria-pressed')).toBe('true');
    // clicking again removes it
    (seg as HTMLElement).click();
    await settle(t, el);
    expect(t.query('[data-filterbar]')).toBeNull();
  });

  it('shows a one-line empty state when no text messages are shown', async () => {
    const { t, el } = await openStats();
    t.app.packetStats.addFilter({ field: 'type', value: 'ADVERT', label: 'ADVERT' });
    await settle(t, el);
    expect(t.query('[data-empty="compression"]')!.textContent).toContain('No text messages');
    expect(el.shadowRoot!.querySelector('mc-breakdown[data-breakdown^="compression-"]')).toBeNull();
  });

  it('the dot plot can be coloured by compression', async () => {
    const { t, el } = await openWithCompressed();
    select(t.query('[data-select="color"]')!, 'compression');
    await settle(t, el);
    await t.until(() => inChart(el, 'dots', 'mc-dot-plot', '[data-legend] li').length > 0, 3000, 'legend');
    const keys = inChart(el, 'dots', 'mc-dot-plot', '[data-legend] li').map((li) => li.dataset['legendKey']);
    expect(keys).toEqual(expect.arrayContaining(['smaz', 'plain']));
  });
});

describe('/packets Stats packet paths map', () => {
  afterEach(() => localStorage.clear());

  /** A flood ADVERT from `key` (mesh-packet-format.md §1 envelope, §3.5 payload; signature zeros). */
  function advert(key: Uint8Array, name: string, path: number[]): Uint8Array {
    const payload = concatBytes(key, new Uint8Array(4), new Uint8Array(64), encodeAdvertAppData({ nodeType: 1, name }));
    return buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, path: Uint8Array.from(path), payload });
  }

  function within(root: Element | null | undefined, selector: string): Element[] {
    return root?.shadowRoot ? [...root.shadowRoot.querySelectorAll(selector)] : [];
  }

  /**
   * Logs (directly, so the emulator's repeater adds no relayed copies) Alice's adverts once direct,
   * twice via Hilltop and once via unknown hop 55 then Hilltop, and one of Bob's (no location) via
   * Hilltop; then opens the Stats tab. Alice, Hilltop and this radio have locations.
   */
  async function openWithPaths(): Promise<{ t: Harness; el: McPacketStats; hill: string; self: string; alice: string }> {
    const t = (h = createHarness());
    await t.mount();
    await t.connectEmulator('/packets');
    await t.until(() => t.query('[data-tab="stats"]'), 3000, 'stats tab');
    await t.app.connection.capture!.idle();
    const s = t.emulatorScenario();
    const hill = s.keys.repeater[0]!;
    const store = t.app.connection.store.value!;
    const now = t.clock.now();
    const rx = (bytes: Uint8Array, dt: number) => store.packets.append({ direction: 'rx', source: 'logRxData', bytes, ts: now + dt, snr: 4, rssi: -100 });
    await rx(advert(s.keys.alice, 'Alice', []), 0);
    await rx(advert(s.keys.alice, 'Alice', [hill]), 1);
    await rx(advert(s.keys.alice, 'Alice', [hill]), 2);
    await rx(advert(s.keys.alice, 'Alice', [0x55, hill]), 3);
    await rx(advert(s.keys.bob, 'Bob', [hill]), 4);
    await t.app.packetStats.settled();
    await t.until(() => t.app.packetStats.routes.value.reduce((n, r) => n + r.count, 0) === 5, 5000, 'routes');
    await t.click('[data-tab="stats"]');
    await t.until(() => t.query('mc-packet-stats'), 3000, 'stats element');
    const el = t.query<McPacketStats>('mc-packet-stats')!;
    await settle(t, el);
    return { t, el, hill: toHex(s.keys.repeater), self: toHex(s.keys.self), alice: toHex(s.keys.alice) };
  }

  const lineWidths = (map: Element | null) => within(map, 'path[data-line]').map((p) => parseFloat((p as SVGPathElement).style.strokeWidth));
  const markerSize = (m: Element) => parseFloat((m as HTMLElement).style.getPropertyValue('--marker-size'));

  it('draws each hop as thick as its packet count, with dots sized by use; filters narrow it; hides again', async () => {
    const { t, el, hill, self, alice } = await openWithPaths();
    const card = el.shadowRoot!.querySelector('[data-section="paths"]')!;
    expect(card.querySelector('h3')!.textContent).toBe('Packet paths');
    // hidden by default: a summary line
    const button = card.querySelector<HTMLButtonElement>('[data-action="paths-map"]')!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.textContent!.trim()).toBe('Map');
    expect(card.querySelector('mc-tile-map')).toBeNull();
    expect(card.querySelector('[data-field="paths-summary"]')!.textContent).toMatch(/5 packets with a known route, 4\s+distinct paths/);

    // estimates off: hop 55 and Bob (no location) are left off. Hilltop–me 4 (busiest), Alice–Hilltop
    // 3 (one skipping 55), Alice–me 1
    expect(t.app.appSettings.approximatePositions.peek()).toBe(false);
    await t.click('[data-section="paths"] [data-action="paths-map"]');
    await el.updateComplete;
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent!.trim()).toBe('Hide map');
    expect(card.querySelector('[data-field="paths-summary"]')).toBeNull();
    const map = t.query('[data-field="paths-map"]');
    expect(map).not.toBeNull();
    await t.until(() => within(map, 'path[data-line]').length === 3, 3000, 'paths map lines');
    expect(lineWidths(map).map((w) => w.toFixed(2)).sort()).toEqual(['10.50', '14.00', '3.50']);
    const busiest = within(map, 'path[data-line]').find((p) => (p as SVGPathElement).style.strokeWidth === '14px')!;
    expect(busiest.getAttribute('data-line')).toContain(hill);
    expect(busiest.getAttribute('data-line')).toContain(self);

    // one marker per placed node, with its packet count; this radio is the 'self' kind
    const markers = () => [...card.querySelectorAll<HTMLElement>('mc-map-marker')];
    const marker = (id: string) => markers().find((m) => m.dataset['stop'] === id)!;
    expect(markers()).toHaveLength(3);
    expect(marker(self).dataset['count']).toBe('5');
    expect(marker(self).getAttribute('kind')).toBe('self');
    expect(marker(hill).dataset['count']).toBe('4');
    expect(marker(hill).getAttribute('kind')).toBe('repeater');
    expect(marker(alice).dataset['count']).toBe('4');
    // dot size ∝ √use: the busiest is 2rem, the rest smaller but at least 1.1rem
    expect(markerSize(marker(self))).toBe(2);
    expect(markerSize(marker(hill))).toBeLessThan(2);
    expect(markerSize(marker(hill))).toBeGreaterThan(1.1);
    const note = card.querySelector('[data-field="paths-map-note"]')!.textContent!;
    expect(note).toMatch(/5 packets.*busiest: 4/s);
    expect(note).toMatch(/2 packets came over hops with no known location/);

    // a drill-down filter narrows the map: 1-hop packets only (Alice ×2 and Bob via Hilltop)
    t.app.packetStats.addFilter({ field: 'hops', value: '1', label: '1 hop' });
    await settle(t, el);
    await t.until(() => within(t.query('[data-field="paths-map"]'), 'path[data-line]').length === 2, 3000, 'filtered lines');
    expect(lineWidths(t.query('[data-field="paths-map"]')).map((w) => w.toFixed(2)).sort()).toEqual(['14.00', '9.33']);
    expect(marker(self).dataset['count']).toBe('3');
    t.app.packetStats.clearFilters();
    await settle(t, el);

    // estimates on: 55 is placed between Alice and Hilltop, on dashed lines
    const box = card.querySelector<HTMLInputElement>('[data-approximate]')!;
    box.click();
    await el.updateComplete;
    expect(t.app.appSettings.approximatePositions.peek()).toBe(true);
    await t.until(() => within(t.query('[data-field="paths-map"]'), 'path[data-dashed]').length > 0, 3000, 'dashed lines');
    expect(Math.max(...lineWidths(t.query('[data-field="paths-map"]')))).toBe(14);

    // a live packet over nodes already on the map keeps the user's pan / zoom (no re-fit)
    const tileMap = t.query<McTileMap>('[data-field="paths-map"]')!;
    let fits = 0;
    const fit = tileMap.fitBounds.bind(tileMap);
    tileMap.fitBounds = (...a: Parameters<McTileMap['fitBounds']>) => {
      fits++;
      fit(...a);
    };
    const hillByte = t.emulatorScenario().keys.repeater[0]!;
    await t.app.connection.store.value!.packets.append({ direction: 'rx', source: 'logRxData', bytes: advert(t.emulatorScenario().keys.alice, 'Alice', [hillByte]), ts: t.clock.now() + 5, snr: 4, rssi: -100 });
    await t.until(() => marker(self)?.dataset['count'] === '6', 5000, 'live packet drawn');
    await settle(t, el);
    expect(fits).toBe(0);

    // Hide map returns to the summary
    await t.click('[data-section="paths"] [data-action="paths-map"]');
    await el.updateComplete;
    expect(card.querySelector('mc-tile-map')).toBeNull();
    expect(card.querySelector('[data-field="paths-summary"]')).not.toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });
});
