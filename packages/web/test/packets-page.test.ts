import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { AnnotationNode } from '@meshcore-web/core/packet';
import { toHex } from '@meshcore-web/core/util/bytes';
import { PayloadType, RouteType, buildPacket } from '@meshcore-web/core/packet';
import '../src/mc-app.js';
import '../src/pages/packets/index.js';
import { createHarness, type Harness } from '../src/testing/harness.js';
import type { ExportEventDetail } from '../src/pages/packets/packets-page.js';
import type { McPacketInspector } from '../src/pages/packets/packet-inspector.js';

let h: Harness | undefined;

beforeEach(async () => {
  await page.viewport(1400, 900);
});

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  await page.viewport(1280, 800);
});

/** Connects the in-page emulator and opens the packet log. */
async function openLog(): Promise<Harness> {
  const t = (h = createHarness());
  await t.mount();
  await t.connectEmulator('/packets');
  await t.until(() => t.query('[data-tab="packets"]'), 3000, 'packets page');
  await t.click('[data-tab="packets"]'); // the page opens on Stats
  return t;
}

/** Air traffic from the scenario: Alice adverts, Bob posts on Public. */
async function traffic(t: Harness): Promise<void> {
  const s = t.emulatorScenario();
  s.nodes.alice.advertise();
  s.nodes.bob.sendChannelMessage('Public', 'hello from bob');
  await t.until(
    () => t.query('tr[data-type="ADVERT"]') && t.query('tr[data-type="GRP_TXT"]'),
    5000,
    'ADVERT and GRP_TXT rows',
  );
}

describe('/packets page', () => {
  it('opens on the Stats tab, listed first, then the List tab', async () => {
    const t = (h = createHarness());
    await t.mount();
    await t.connectEmulator('/packets');
    await t.until(() => t.query('mc-packet-stats'), 3000, 'stats tab');
    const tabs = t.queryAll('[role="tab"]');
    expect(tabs.map((b) => b.dataset['tab'])).toEqual(['stats', 'packets']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]!.textContent!.trim()).toBe('List');
    expect(t.query('table[data-table="packets"]')).toBeNull();
  });

  it('lists over-the-air packets live with decoded summaries', async () => {
    const t = await openLog();
    expect(t.query('mc-packets-page')).not.toBeNull();
    await traffic(t);
    const grp = t.query('tr[data-type="GRP_TXT"]')!;
    expect(grp.textContent).toContain('GRP_TXT Public: "Bob: hello from bob"');
    expect(grp.textContent).toContain('FLOOD');
    expect(grp.textContent).toContain('8 dB / -70');
    const advert = t.query('tr[data-type="ADVERT"]')!;
    expect(advert.textContent).toContain('"Alice" (chat)');
    expect(t.query('[data-field="counts"]')!.textContent).toMatch(/^\d+ packets$/);
  });

  it('keeps every row one line tall: a long summary is cut off, not wrapped', async () => {
    await page.viewport(900, 800); // narrow table: the summary column has little room
    const t = await openLog();
    const s = t.emulatorScenario();
    s.nodes.bob.sendChannelMessage('Public', 'short');
    s.nodes.bob.sendChannelMessage('Public', 'a long message that would wrap '.repeat(4));
    const row = (text: string): HTMLElement | undefined =>
      t.queryAll<HTMLElement>('tr[data-type="GRP_TXT"]').find((r) => r.textContent?.includes(text));
    await t.until(() => row('short') && row('would wrap'), 5000, 'short and long GRP_TXT rows');
    const long = row('would wrap');
    const short = row('short');
    expect(long!.offsetHeight).toBe(short!.offsetHeight);
    const cell = long!.querySelector<HTMLElement>('td.summary')!;
    expect(cell.scrollWidth).toBeGreaterThan(cell.clientWidth); // truncated
    expect(cell.title).toContain('a long message that would wrap');
  });

  it('filters by payload type', async () => {
    const t = await openLog();
    await traffic(t);
    await t.click('[data-filter="types"]');
    await t.click('input[data-type="ADVERT"]');
    await t.until(() => {
      const rows = t.queryAll('tr[data-packet-id]');
      return rows.length > 0 && rows.every((r) => r.dataset['type'] === 'ADVERT');
    }, 3000, 'only adverts');
    expect(t.query('[data-field="counts"]')!.textContent).toMatch(/^\d+ of \d+ packets$/);
    expect(t.query('[data-filter="types"]')!.textContent).toContain('(1)');
    await t.click('[data-action="clear-filters"]');
    await t.until(() => t.query('tr[data-type="GRP_TXT"]'), 3000, 'all types again');
  });

  it('opens the inspector in a side panel; hovering a field highlights its bytes and clicking a byte selects a field', async () => {
    const t = await openLog();
    await traffic(t);
    // more GRP_TXT rows (repeats) may still arrive and re-order the list: track this row by id
    const id = t.query('tr[data-type="GRP_TXT"]')!.dataset['packetId']!;
    await t.click(`tr[data-packet-id="${id}"]`);
    await t.until(() => t.query('[data-byte="0"]'), 3000, 'inspector');
    const insp = t.query<McPacketInspector>('aside mc-packet-inspector')!;
    expect(t.query(`tr[data-packet-id="${id}"]`)!.getAttribute('aria-selected')).toBe('true');
    expect(insp.shadowRoot!.textContent).toContain('Packet hash');
    // decrypted section is marked
    const text = t.query('.node.decrypted[data-name="text"]');
    expect(text?.textContent).toContain('"Bob: hello from bob"');

    // hover the header field → byte 0 highlighted, byte 1 not
    t.query('[data-name="header"]')!.dispatchEvent(new MouseEvent('mouseenter'));
    await insp.updateComplete;
    expect(t.query('[data-byte="0"]')!.classList.contains('hl')).toBe(true);
    expect(t.query('[data-ascii="0"]')!.classList.contains('hl')).toBe(true);
    expect(t.query('[data-byte="1"]')!.classList.contains('hl')).toBe(false);
    // header bit fields are drawn as bit diagrams
    expect(t.queryAll('.bitdiagram').length).toBeGreaterThanOrEqual(3);
    // decrypted flags byte (PLAIN, attempt 0 → 0x00): its bit diagram shows the plaintext bits,
    // not the ciphertext byte at the same offset
    const txtType = t.query('.node.decrypted[data-name="txt_type"] .bitdiagram')!;
    expect([...txtType.querySelectorAll('span.on')].map((b) => b.textContent).join('')).toBe('000000');

    // hovering a byte highlights the deepest field covering it
    t.query('[data-byte="1"]')!.dispatchEvent(new MouseEvent('mouseenter'));
    await insp.updateComplete;
    expect(t.query('.node.hl')!.dataset['name']).toBe('path_len');

    // click the last byte → the deepest node (decrypted plaintext / ciphertext) is selected
    const n = insp.bytes.length;
    t.query<HTMLElement>(`[data-byte="${n - 1}"]`)!.click();
    await insp.updateComplete;
    const sel = t.query('.node.sel')!;
    expect(sel).not.toBeNull();
    expect(t.query(`[data-byte="${n - 1}"]`)!.classList.contains('sel')).toBe(true);

    // click a tree node → its bytes are selected
    t.query<HTMLElement>('[data-name="channel_hash"]')!.click();
    await insp.updateComplete;
    const sels = t.queryAll('.bytes span.sel').map((s) => Number(s.dataset['byte']));
    expect(sels).toHaveLength(1);
    expect(t.query('[data-name="channel_hash"]')!.classList.contains('sel')).toBe(true);

    // the inspector belongs to the packets tab: hidden on the frames tab, back on return
    t.app.appSettings.setShowFrames(true);
    await t.click('[data-tab="frames"]');
    await t.until(() => !t.query('aside mc-packet-inspector'), 2000, 'hidden on frames tab');
    await t.click('[data-tab="packets"]');
    await t.until(() => t.query('aside mc-packet-inspector'), 2000, 'shown again on packets tab');

    await t.click('[data-action="close-inspector"]');
    await t.until(() => !t.query('aside mc-packet-inspector'), 2000, 'closed');
  });

  it('keeps the visible rows still when live tail adds a packet above them', async () => {
    await page.viewport(1400, 500);
    const t = await openLog();
    const bob = t.emulatorScenario().nodes.bob;
    for (let i = 0; i < 20; i++) bob.sendChannelMessage('Public', `filler ${i}`);
    await t.until(() => t.queryAll('tr[data-type="GRP_TXT"]').length >= 20, 5000, '20 GRP_TXT rows');
    await t.app.packetLog.packets.settled();

    // scroll so the list's top is out of view and pick the row at the top of the viewport
    const rows = t.queryAll('tr[data-packet-id]');
    rows[8]!.scrollIntoView({ block: 'start', behavior: 'instant' });
    const anchor = rows.find((r) => r.getBoundingClientRect().bottom > 0)!;
    const top = anchor.getBoundingClientRect().top;
    const before = rows.length;

    // the new row and the scroll fix must land in the same microtask: when the insertion is
    // observed (a later microtask, before any frame) the anchor row is already back in place
    const atInsert: number[] = [];
    const tbody = t.query('table[data-table="packets"] tbody')!;
    const mo = new MutationObserver(() => atInsert.push(anchor.getBoundingClientRect().top));
    mo.observe(tbody, { childList: true });
    bob.sendChannelMessage('Public', 'new one on top');
    await t.until(() => t.query('tr[data-packet-id]')!.textContent!.includes('new one on top'), 5000, 'new row on top');
    mo.disconnect();

    expect(t.queryAll('tr[data-packet-id]').length).toBeGreaterThan(before);
    expect(atInsert.length).toBeGreaterThan(0);
    for (const y of atInsert) expect(y).toBeCloseTo(top, 0);
    expect(anchor.getBoundingClientRect().top).toBeCloseTo(top, 0);
  });

  it('loads older rows as the end of the list scrolls into view (no pager buttons)', async () => {
    await page.viewport(1400, 600);
    const t = await openLog();
    const bob = t.emulatorScenario().nodes.bob;
    const log = t.app.packetLog.packets;
    for (let i = 0; i < 110; i++) bob.sendChannelMessage('Public', `filler ${i}`);
    await t.until(() => log.total.value >= 110, 10000, '110 packets logged');
    await log.settled();
    // live tail keeps the newest page (100 rows) and leaves the rest to load on scroll
    await t.until(() => t.queryAll('tr[data-packet-id]').length === log.pageSize && t.query('[data-load-more]'), 3000, 'first page + sentinel');
    expect(t.query('[data-action="next"]')).toBeNull();
    expect(t.query('[data-action="prev"]')).toBeNull();
    expect(t.query('[data-field="page"]')).toBeNull();

    t.query('[data-load-more]')!.scrollIntoView({ block: 'end', behavior: 'instant' });
    await t.until(() => t.queryAll('tr[data-packet-id]').length === log.total.value, 5000, 'all rows loaded');
    expect(t.query('[data-load-more]')).toBeNull();
    const ids = t.queryAll('tr[data-packet-id]').map((r) => Number(r.dataset['packetId']));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('at the top of the list new packets push the rows down', async () => {
    await page.viewport(1400, 500);
    const t = await openLog();
    await traffic(t);
    await t.app.packetLog.packets.settled();
    window.scrollTo({ top: 0, behavior: 'instant' });
    const first = t.query('tr[data-packet-id]')!;
    const top = first.getBoundingClientRect().top;
    t.emulatorScenario().nodes.bob.sendChannelMessage('Public', 'pushes down');
    await t.until(() => t.query('tr[data-packet-id]')!.textContent!.includes('pushes down'), 5000, 'new row on top');
    expect(window.scrollY).toBe(0);
    expect(first.getBoundingClientRect().top).toBeGreaterThan(top);
  });

  it('hovering or focusing a field shows a tooltip with its protocol description', async () => {
    const t = await openLog();
    await traffic(t);
    const id = t.query('tr[data-type="GRP_TXT"]')!.dataset['packetId']!;
    await t.click(`tr[data-packet-id="${id}"]`);
    await t.until(() => t.query('[data-byte="0"]'), 3000, 'inspector');
    const insp = t.query<McPacketInspector>('aside mc-packet-inspector')!;
    const tip = (): HTMLElement => insp.shadowRoot!.querySelector<HTMLElement>('[data-tooltip]')!;
    const open = (): boolean => tip().matches(':popover-open');

    // tree row
    const header = t.query('[data-name="header"]')!;
    header.dispatchEvent(new MouseEvent('mouseenter'));
    await insp.updateComplete;
    expect(open()).toBe(true);
    expect(tip().textContent).toContain('header');
    expect(tip().textContent).toContain('route type (bits 0-1), payload type (bits 2-5)');
    expect(header.getAttribute('aria-describedby')).toBe('tip');
    // placed next to the hovered row
    const hr = header.getBoundingClientRect();
    const tr = tip().getBoundingClientRect();
    expect(Math.abs(tr.top - hr.bottom) < 20 || Math.abs(tr.bottom - hr.top) < 20).toBe(true);

    // leaving hides it (after a short grace period)
    header.dispatchEvent(new MouseEvent('mouseleave'));
    await t.until(() => !open(), 2000, 'tooltip hidden');

    // decrypted field: description of the plaintext layout
    t.query('.node.decrypted[data-name="text"]')!.dispatchEvent(new MouseEvent('mouseenter'));
    await insp.updateComplete;
    expect(tip().textContent).toContain('not authenticated');

    // hovering a byte describes the deepest field covering it; Escape dismisses
    t.query('[data-byte="1"]')!.dispatchEvent(new MouseEvent('mouseenter'));
    await insp.updateComplete;
    expect(tip().textContent).toContain('path_len');
    expect(tip().textContent).toContain('bits 6-7 = hash size − 1');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await insp.updateComplete;
    expect(open()).toBe(false);

    // keyboard focus shows it too
    t.query<HTMLElement>('[data-name="channel_hash"]')!.focus();
    await insp.updateComplete;
    expect(open()).toBe(true);
    expect(tip().textContent).toContain('SHA256(channel PSK)');

    // frames: the code byte explains what the command is for
    t.app.appSettings.setShowFrames(true);
    await t.click('[data-tab="frames"]');
    await t.until(() => t.query('tr[data-name="APP_START"]'), 3000, 'frames');
    await t.click('tr[data-name="APP_START"]');
    await t.until(() => t.query('[data-name="app name"]'), 3000, 'frame inspector');
    const finsp = t.query<McPacketInspector>('aside mc-packet-inspector')!;
    t.query('[data-name="code"]')!.dispatchEvent(new MouseEvent('mouseenter'));
    await finsp.updateComplete;
    expect(finsp.shadowRoot!.querySelector('[data-tooltip]')!.textContent).toContain('APP_START: Starts the app session');
  });

  it('hovering a value shows what that specific value means', async () => {
    const t = await openLog();
    await traffic(t);
    const id = t.query('tr[data-type="GRP_TXT"]')!.dataset['packetId']!;
    await t.click(`tr[data-packet-id="${id}"]`);
    await t.until(() => t.query('[data-byte="0"]'), 3000, 'inspector');
    const insp = t.query<McPacketInspector>('aside mc-packet-inspector')!;
    const tip = (): HTMLElement => insp.shadowRoot!.querySelector<HTMLElement>('[data-tooltip]')!;
    const find = (name: string): AnnotationNode => {
      const walk = (n: AnnotationNode): AnnotationNode | undefined => (n.name === name ? n : (n.children ?? []).map(walk).find(Boolean));
      return walk(insp.annotation!)!;
    };
    const rt = find('route type');
    expect(rt.meaning).toBe('FLOOD');
    const valueText = rt.valueDescription!.split('\n\n')[0]!;
    const fieldText = rt.description!.split('\n\n')[0]!;
    expect(valueText).not.toBe(fieldText);

    const row = t.query('[data-name="route type"]')!;
    const name = row.querySelector('.name')!;
    const value = row.querySelector<HTMLElement>('.value')!;
    const meaning = row.querySelector('.meaning')!;
    // describable values get the dotted underline, as described names do
    expect(getComputedStyle(value).textDecorationStyle).toBe('dotted');
    expect(value.tabIndex).toBe(0);

    // the name shows the general field card, anchored to the row
    await userEvent.hover(name);
    await t.until(() => tip().matches(':popover-open') && tip().textContent!.includes(fieldText), 2000, 'field card');
    expect(tip().textContent).not.toContain(valueText);
    expect(row.getAttribute('aria-describedby')).toBe('tip');

    // the value (or its meaning) shows the FLOOD card, anchored to the value
    await userEvent.hover(value);
    await t.until(() => tip().textContent!.includes(valueText), 2000, 'value card');
    expect(tip().querySelector('.tip-head')!.textContent).toContain('route type = FLOOD');
    expect(tip().textContent).not.toContain(fieldText);
    expect(value.getAttribute('aria-describedby')).toBe('tip');
    expect(row.hasAttribute('aria-describedby')).toBe(false);
    // aligned with the value (or shifted left to fit the viewport), clear of the meaning line below it
    const vr = value.getBoundingClientRect();
    const mr = meaning.getBoundingClientRect();
    const tr = tip().getBoundingClientRect();
    expect(tr.left).toBeLessThanOrEqual(vr.left + 1);
    expect(tr.right).toBeGreaterThan(vr.left);
    expect(Math.abs(tr.top - mr.bottom) < 20 || Math.abs(tr.bottom - vr.top) < 20).toBe(true);
    await userEvent.hover(meaning);
    await insp.updateComplete;
    expect(tip().textContent).toContain(valueText);

    // back onto the name switches to the field card
    await userEvent.hover(name);
    await t.until(() => tip().textContent!.includes(fieldText), 2000, 'field card again');
    expect(value.hasAttribute('aria-describedby')).toBe(false);

    // a field without a valueDescription falls back to its field card on the value
    const ch = find('channel_hash');
    expect(ch.valueDescription).toBeUndefined();
    const chRow = t.query('[data-name="channel_hash"]')!;
    const chValue = chRow.querySelector<HTMLElement>('.value')!;
    expect(chValue.hasAttribute('tabindex')).toBe(false);
    await userEvent.hover(chValue);
    await t.until(() => tip().textContent!.includes('SHA256(channel PSK)'), 2000, 'channel_hash field card');
    expect(chRow.getAttribute('aria-describedby')).toBe('tip');

    // keyboard: the row shows the field card, the focusable value its value card; Enter still selects
    row.focus();
    await t.until(() => tip().textContent!.includes(fieldText), 2000, 'focused row');
    value.focus();
    await t.until(() => tip().textContent!.includes(valueText), 2000, 'focused value');
    value.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    await insp.updateComplete;
    expect(row.classList.contains('sel')).toBe(true);

    // hovering a byte still shows the field card
    t.query('[data-byte="0"]')!.dispatchEvent(new MouseEvent('mouseenter'));
    await t.until(() => tip().textContent!.includes('route type (bits 0-1)'), 2000, 'byte card');
  });

  it('frames tab shows the handshake frames and inspects them', async () => {
    const t = await openLog();
    t.app.appSettings.setShowFrames(true);
    await t.click('[data-tab="frames"]');
    // the shared packet filter does not apply to frames: only the frame filters show
    await t.until(() => t.query('mc-packet-filters')?.hidden, 2000, 'packet filters hidden');
    expect(t.query('select[data-filter="frame-direction"]')).not.toBeNull();
    await t.until(() => t.query('tr[data-name="SELF_INFO"]'), 3000, 'frames');
    for (const name of ['DEVICE_QUERY', 'DEVICE_INFO', 'APP_START', 'SELF_INFO']) expect(t.query(`tr[data-name="${name}"]`), name).not.toBeNull();
    expect(t.query('tr[data-name="SELF_INFO"]')!.textContent).toContain('"Emulator"');
    await t.click('tr[data-name="APP_START"]');
    await t.until(() => t.query('[data-name="app name"]'), 3000, 'frame inspector');
    expect(t.query('[data-name="app name"]')!.textContent).toContain('meshcore-web');
    // filter by code
    const sel = t.query<HTMLSelectElement>('select[data-filter="code"]')!;
    sel.value = String(0x16);
    sel.dispatchEvent(new Event('change'));
    await t.until(() => {
      const rows = t.queryAll('tr[data-frame-id]');
      return rows.length > 0 && rows.every((r) => r.dataset['name'] === 'DEVICE_QUERY');
    }, 3000, 'only DEVICE_QUERY');
  });

  it('hides the Frames tab unless the showFrames setting is on, falling back to Stats when it is turned off', async () => {
    const t = await openLog();
    expect(t.app.appSettings.showFrames.value).toBe(false);
    expect(t.queryAll('[role="tab"]').map((b) => b.dataset['tab'])).toEqual(['stats', 'packets']);
    t.app.appSettings.setShowFrames(true);
    await t.until(() => t.query('[data-tab="frames"]'), 2000, 'frames tab');
    expect(t.queryAll('[role="tab"]').map((b) => b.dataset['tab'])).toEqual(['stats', 'packets', 'frames']);
    await t.click('[data-tab="frames"]');
    await t.until(() => t.query('tr[data-frame-id]'), 3000, 'frames');
    t.app.appSettings.setShowFrames(false);
    await t.until(() => !t.query('[data-tab="frames"]'), 2000, 'frames tab gone');
    expect(t.query('[data-tab="stats"]')!.getAttribute('aria-selected')).toBe('true');
    expect(t.query('mc-packet-stats')).not.toBeNull();
    expect(t.query('mc-packet-filters')!.hidden).toBe(false);
  });

  it('the top filter area stays mounted with its values across Packets ⇄ Stats', async () => {
    const t = await openLog();
    await traffic(t);
    const filters = t.query('mc-packet-filters')!;
    await t.fill('select[data-filter="direction"]', 'rx');
    await t.fill('input[data-filter="node"]', 'abcd');
    await t.click('[data-tab="stats"]');
    await t.until(() => t.query('mc-packet-stats'), 2000, 'stats tab');
    expect(t.query('mc-packet-filters')).toBe(filters);
    expect(t.query<HTMLSelectElement>('select[data-filter="direction"]')!.value).toBe('rx');
    expect(t.query<HTMLInputElement>('input[data-filter="node"]')!.value).toBe('abcd');
    // the bin size lives in the Stats panel, the date range in the top area
    const bin = t.query('mc-packet-stats')!.shadowRoot!.querySelector('mc-stats-range')!;
    expect(bin.getAttribute('parts')).toBe('bin');
    expect(bin.shadowRoot!.querySelector('select[data-bin]')).not.toBeNull();
    expect(bin.shadowRoot!.querySelector('input[data-range="from"]')).toBeNull();
    expect(t.queryAll('input[data-range="from"]')).toHaveLength(1);
    expect(t.query('mc-stats-range[parts="range"]')).not.toBeNull();
    await t.click('[data-tab="packets"]');
    await t.until(() => t.query('table[data-table="packets"]'), 2000, 'packets tab');
    expect(t.query('mc-packet-filters')).toBe(filters);
    expect(t.query<HTMLInputElement>('input[data-filter="node"]')!.value).toBe('abcd');
  });

  it('a range preset in the top area narrows both the Packets rows and the Stats count', async () => {
    const t = await openLog();
    await traffic(t);
    // one packet logged three hours ago: inside "All", outside "Last hour"
    const store = t.app.connection.store.value!;
    const bytes = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ACK, path: new Uint8Array(0), payload: new Uint8Array(4).fill(7) });
    const old = (await store.packets.append({ direction: 'rx', source: 'logRxData', bytes, ts: t.clock.now() - 3 * 3_600_000, snr: 4, rssi: -95 })).id;
    const stats = t.app.packetStats;
    const statsHasOld = () => stats.points.value.some((p) => p.id === old);
    await t.until(() => t.query(`tr[data-packet-id="${old}"]`) && statsHasOld(), 3000, 'old packet listed and counted');

    await t.click('[data-preset="1h"]');
    await t.until(() => !t.query(`tr[data-packet-id="${old}"]`) && t.query('tr[data-packet-id]'), 3000, 'old packet filtered out');
    expect(t.query('[data-preset="1h"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(t.query<HTMLInputElement>('input[data-range="from"]')!.value).not.toBe('');
    await stats.settled();
    expect(statsHasOld()).toBe(false);
    await t.click('[data-tab="stats"]');
    await t.until(() => t.query('mc-stat-tile[data-tile="packets"]'), 3000, 'stats tiles');
    expect(t.query('[data-preset="1h"]')!.getAttribute('aria-pressed')).toBe('true');

    // Reset clears the range too
    await t.click('[data-action="clear-filters"]');
    await t.until(() => t.query('[data-preset="all"]')!.getAttribute('aria-pressed') === 'true', 2000, 'All again');
    await t.until(statsHasOld, 3000, 'old packet counted again');
  });

  it('export produces a JSON packet log', async () => {
    const t = await openLog();
    await traffic(t);
    const got = new Promise<ExportEventDetail>((resolve) =>
      t.el!.addEventListener('mc-export', (e) => resolve((e as CustomEvent<ExportEventDetail>).detail), { once: true }),
    );
    await t.click('[data-action="export"]');
    const { filename, text } = await got;
    expect(filename).toMatch(/^meshcore-packets-.*\.json$/);
    const data = JSON.parse(text) as { format: string; count: number; items: Array<{ bytes: string; payloadType: number }> };
    expect(data.format).toBe('meshcore-web/packets');
    expect(data.count).toBeGreaterThanOrEqual(2);
    expect(data.items[0]!.bytes).toMatch(/^[0-9a-f]+$/);
  });

  it('shows sent (tx) packets next to received ones, filters by direction and inspects a tx entry', async () => {
    const t = await openLog();
    await traffic(t);
    const client = t.app.connection.client.value!;
    await client.sendSelfAdvert('flood');
    await client.sendChannelMessage(0, 'sent from the web');
    await t.until(() => t.query('tr[data-type="GRP_TXT"] td[data-dir="tx"]'), 3000, 'tx GRP_TXT row');
    const txRow = t.query('tr[data-type="GRP_TXT"] td[data-dir="tx"]')!.closest('tr')!;
    expect(txRow.textContent).toContain('↑ tx');
    expect(txRow.textContent).toContain('GRP_TXT Public: "sent from the web"');
    expect(txRow.textContent).toContain('—'); // no on-air bytes
    expect(t.query('td[data-dir="rx"]')!.textContent).toContain('↓ rx');

    await t.fill('select[data-filter="direction"]', 'tx');
    await t.until(() => {
      const dirs = t.queryAll('td[data-dir]').map((d) => d.dataset['dir']);
      return dirs.length >= 2 && dirs.every((d) => d === 'tx');
    }, 3000, 'only tx rows');
    await t.fill('select[data-filter="direction"]', 'rx');
    await t.until(() => {
      const dirs = t.queryAll('td[data-dir]').map((d) => d.dataset['dir']);
      return dirs.length > 0 && dirs.every((d) => d === 'rx');
    }, 3000, 'only rx rows');
    await t.fill('select[data-filter="direction"]', '');
    await t.until(() => t.query('td[data-dir="tx"]') && t.query('td[data-dir="rx"]'), 3000, 'both directions');

    const id = t.query('tr[data-type="GRP_TXT"] td[data-dir="tx"]')!.closest('tr')!.dataset['packetId']!;
    await t.click(`tr[data-packet-id="${id}"]`);
    await t.until(() => t.query('aside mc-packet-inspector'), 3000, 'inspector');
    await t.until(() => t.text().includes('sent by the radio at this app'), 3000, 'tx direction in inspector');
    expect(t.text()).toContain('does not report it back');
  });

  it('marks the send outcome of tx rows and shows it in the inspector', async () => {
    const t = await openLog();
    const alice = toHex(t.emulatorScenario().keys.alice);
    const dm = t.app.chat('contact', alice);
    await dm.settled();
    expect((await (await dm.send('ping from the log')).done).status).toBe('delivered');
    // the row updates in place: pending → sent → confirmed with the round trip
    await t.until(() => t.query('tr[data-type="TXT_MSG"] [data-send-status="confirmed"]'), 5000, 'confirmed DM row');
    const mark = t.query('tr[data-type="TXT_MSG"] [data-send-status="confirmed"]')!;
    expect(mark.textContent).toMatch(/^✓✓ \d+(\.\d)? m?s$/);
    expect(mark.getAttribute('title')).toContain('Delivered: ACK received');

    // the radio rejects a DM to an unknown contact
    const client = t.app.connection.client.value!;
    await expect(client.sendTextMessage(new Uint8Array(32).fill(9), 'nobody home')).rejects.toThrow();
    await t.until(() => t.query('[data-send-status="failed"]'), 3000, 'failed row');
    expect(t.query('[data-send-status="failed"]')!.textContent).toBe('✗ NOT_FOUND');

    const id = mark.closest('tr')!.dataset['packetId']!;
    await t.click(`tr[data-packet-id="${id}"]`);
    await t.until(() => t.query('[data-section="send"]'), 3000, 'send section');
    const field = (k: string): string => t.query(`[data-section="send"] [data-send="${k}"]`)?.textContent ?? '';
    expect(field('Status')).toContain('Delivered');
    expect(field('Route')).toBe('direct');
    expect(field('ACK tag')).toMatch(/^0x[0-9a-f]{8}$/);
    expect(field('Est. timeout')).toMatch(/s$/);
    expect(field('Response')).toMatch(/^after /);
    expect(field('Confirmed')).toContain('round trip');
    expect(t.query('[data-section="send"] [data-send="Error"]')).toBeNull();

    const failedId = t.query('[data-send-status="failed"]')!.closest('tr')!.dataset['packetId']!;
    await t.click(`tr[data-packet-id="${failedId}"]`);
    await t.until(() => field('Error') !== '', 3000, 'error field');
    expect(field('Error')).toBe('NOT_FOUND (code 2)');
    expect(field('Status')).toContain('Failed');
  });

  it('clear asks for confirmation and empties the log', async () => {
    const t = await openLog();
    await traffic(t);
    // the repeater re-broadcasts both packets; let those copies land first so none arrive after the clear
    await t.until(() => t.queryAll('tr[data-packet-id]').length >= 4, 5000, 'repeated copies');
    await t.app.connection.capture!.idle();
    await t.click('[data-action="clear"]');
    await t.click('[data-action="confirm-clear"]');
    await t.until(() => t.queryAll('tr[data-packet-id]').length === 0 && t.query('[data-field="counts"]')!.textContent === '0 packets', 3000, 'cleared');
  });

  it('on a narrow screen a row opens the inspector page /packets/:id', async () => {
    await page.viewport(375, 800);
    const t = await openLog();
    await traffic(t);
    const row = t.query('tr[data-type="ADVERT"]')!;
    const id = row.dataset['packetId']!;
    row.click();
    await t.until(() => location.hash === `#/packets/${id}`, 3000, 'detail route');
    await t.until(() => t.query('mc-packet-detail-page') && t.query('[data-name="public key"]'), 3000, 'detail inspector');
    expect(t.query('mc-packet-inspector')!.shadowRoot!.textContent).toContain(`Packet #${id}`);
    await t.click('[data-action="back"]');
    await t.until(() => location.hash === '#/packets' && t.query('mc-packets-page'), 3000, 'back to list');
    // back on the List tab it came from, not the default Stats
    await t.until(() => t.query('[data-tab="packets"]')?.getAttribute('aria-selected') === 'true' && t.query('table[data-table="packets"]'), 3000, 'list tab');
  });

  it('links a sent DM and its ACK both ways: list marker, Related links on the detail pages', async () => {
    await page.viewport(375, 800);
    const t = await openLog();
    const dm = t.app.chat('contact', toHex(t.emulatorScenario().keys.alice));
    await dm.settled();
    expect((await (await dm.send('ping for a reply link')).done).status).toBe('delivered');
    // the DM row gets the "answered" marker once its ACK is logged; ACK rows do not
    await t.until(() => t.query('tr[data-type="TXT_MSG"] [data-answered]'), 5000, 'answered marker');
    // (the emulator's nodes also relay DMs: the rx copies are TXT_MSG rows too, never answered)
    const marker = t.query('tr[data-type="TXT_MSG"] [data-answered]')!;
    expect(marker.getAttribute('title')).toContain('Answered');
    const dmRow = marker.closest('tr')!;
    expect(dmRow.querySelector('[data-dir]')!.getAttribute('data-dir')).toBe('tx');
    const dmId = dmRow.dataset['packetId']!;
    expect(t.query('tr[data-type="ACK"] [data-answered]')).toBeNull();

    dmRow.click();
    await t.until(() => location.hash === `#/packets/${dmId}` && t.query('[data-section="related"] a[data-related-id]'), 3000, 'DM detail with Related');
    const label = t.query('[data-section="related"] dt[data-relation="ack"]')!;
    expect(label.textContent).toBe('ACK →');
    const link = t.query<HTMLAnchorElement>('[data-section="related"] a[data-related-id]')!;
    const ackId = link.dataset['relatedId']!;
    expect(link.textContent).toBe(`#${ackId}`);
    expect(t.query('[data-section="related"] dd[data-relation="ack"]')!.textContent).toMatch(/ACK[\s\S]*\+\d+(\.\d)? m?s/);

    link.click();
    await t.until(() => location.hash === `#/packets/${ackId}` && t.query(`[data-section="related"] a[data-related-id="${dmId}"]`), 3000, 'ACK detail linking back');
    expect(t.query('mc-packet-inspector')!.shadowRoot!.textContent).toContain(`Packet #${ackId}`);
    expect(t.query('[data-section="related"] dt[data-relation="acked"]')!.textContent).toBe('← Acknowledges');
  });

  it('links a status request to its RESPONSE once the private key is stored, updating the open page and panel', async () => {
    await page.viewport(375, 800);
    const t = await openLog();
    await t.app.connection.client.value!.getStatus(t.emulatorScenario().keys.repeater);
    await t.until(() => t.query('tr[data-type="REQ"]') && t.query('tr[data-type="RESPONSE"]'), 5000, 'REQ and RESPONSE rows');
    const reqId = t.query('tr[data-type="REQ"]')!.dataset['packetId']!;
    const respId = t.query('tr[data-type="RESPONSE"]')!.dataset['packetId']!;
    expect(t.query('tr[data-type="REQ"] [data-answered]')).toBeNull(); // encrypted: no pairing without the key
    t.query('tr[data-type="REQ"]')!.click();
    await t.until(() => t.query('mc-packet-inspector')?.shadowRoot?.textContent?.includes(`Packet #${reqId}`), 3000, 'REQ detail');
    expect(t.query('[data-section="related"]')).toBeNull();

    // storing the key pairs them; the open detail page shows the Related link without navigating
    await t.app.packetLog.storeSelfKeyFromDevice();
    await t.until(() => t.query(`[data-section="related"] a[data-related-id="${respId}"]`), 3000, 'Related appears on the open page');
    expect(t.query('[data-section="related"] dt[data-relation="reply"]')!.textContent).toBe('Reply →');
    expect(location.hash).toBe(`#/packets/${reqId}`);

    // the side panel follows too: forgetting the key removes the link while it is open
    await page.viewport(1400, 900);
    await t.click('[data-action="back"]');
    await t.until(() => t.query('tr[data-type="REQ"] [data-answered]'), 3000, 'answered marker');
    t.query('tr[data-type="REQ"]')!.click();
    await t.until(() => t.query(`[data-section="related"] a[data-related-id="${respId}"]`), 3000, 'Related in the panel');
    await t.app.packetLog.setSelfPrivateKey(null);
    await t.until(() => !t.query('[data-section="related"]') && t.query('mc-packet-inspector')?.shadowRoot?.textContent?.includes(`Packet #${reqId}`), 3000, 'Related gone from the panel');
    expect(location.hash).toBe('#/packets');
  });

  it('a Related link in the side panel opens that packet in the panel', async () => {
    const t = await openLog();
    const dm = t.app.chat('contact', toHex(t.emulatorScenario().keys.alice));
    await dm.settled();
    expect((await (await dm.send('ping for the panel')).done).status).toBe('delivered');
    await t.until(() => t.query('tr[data-type="TXT_MSG"] [data-answered]'), 5000, 'answered marker');
    t.query('tr[data-type="TXT_MSG"] [data-answered]')!.closest('tr')!.click();
    await t.until(() => t.query('[data-section="related"] a[data-related-id]'), 3000, 'Related in the panel');
    const ackId = t.query('[data-section="related"] a[data-related-id]')!.dataset['relatedId']!;
    t.query<HTMLAnchorElement>('[data-section="related"] a[data-related-id]')!.click();
    await t.until(() => t.query('mc-packet-inspector')?.shadowRoot?.textContent?.includes(`Packet #${ackId}`), 3000, 'ACK in the panel');
    expect(location.hash).toBe('#/packets');
    expect(t.query('[data-section="related"] dt[data-relation="acked"]')).not.toBeNull();
  });
});
