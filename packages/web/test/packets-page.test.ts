import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
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

    await t.click('[data-action="close-inspector"]');
    await t.until(() => !t.query('aside mc-packet-inspector'), 2000, 'closed');
  });

  it('frames tab shows the handshake frames and inspects them', async () => {
    const t = await openLog();
    await t.click('[data-tab="frames"]');
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

  it('clear asks for confirmation and empties the log', async () => {
    const t = await openLog();
    await traffic(t);
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
  });
});
