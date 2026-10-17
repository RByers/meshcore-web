/** Issue #3: "Show path as node names" setting. */
import { afterEach, describe, expect, it } from 'vitest';
import { toHex } from '@meshcore-web/core/util/bytes';
import { channelKeyForPsk } from '@meshcore-web/core/store';
import { publicChannelSecret } from '@meshcore-web/core/emulator';
import '../src/mc-app.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  localStorage.clear();
});

async function connected(): Promise<Harness> {
  const t = (h = createHarness());
  await t.mount();
  await t.connectEmulator();
  await t.app.connection.capture!.idle();
  return t;
}

async function go(t: Harness, path: string, selector: string): Promise<void> {
  location.hash = `#${path}`;
  await t.until(() => t.query(selector), 5000, selector);
}

function msgWith(t: Harness, text: string): HTMLElement | undefined {
  return t.queryAll('.msg').find((li) => li.querySelector('[data-field="text"]')?.textContent === text);
}

describe('path as node names', () => {
  it('renders a relayed message path as the repeater name when enabled', async () => {
    const t = await connected();
    const pub = await channelKeyForPsk(publicChannelSecret());
    await go(t, `/channel/${pub}`, '[data-field="sender"]');
    t.emulatorScenario().nodes.carol.sendChannelMessage('Public', 'via the hill');
    await t.until(() => msgWith(t, 'via the hill'), 5000, 'Carol message');
    const path = () => msgWith(t, 'via the hill')!.querySelector('[data-field="path"]')!;
    expect(path().textContent).toBe('1 hop');
    // the hop names are in the tooltip either way
    expect(msgWith(t, 'via the hill')!.querySelector('[data-field="signal"]')!.getAttribute('title')).toMatch(/^[0-9a-f]{2}: Hilltop Repeater\n/);
    t.app.appSettings.setPathNames(true);
    await t.until(() => path().textContent === 'Hilltop Repeater', 3000, 'path names');
    t.app.appSettings.setPathNames(false);
    await t.until(() => path().textContent === '1 hop', 3000, 'hop count again');
  });

  it('is a Settings toggle that applies to the contacts list and contact info', async () => {
    const t = await connected();
    const alice = toHex(t.emulatorScenario().keys.alice);
    await go(t, '/contacts', `[data-contact="${alice}"]`);
    expect(t.query(`[data-contact="${alice}"] [data-field="meta"]`)!.textContent).toContain('1 hop');
    await go(t, '/settings', 'input[name="pathNames"]');
    const box = t.query<HTMLInputElement>('input[name="pathNames"]')!;
    expect(box.checked).toBe(false);
    box.click();
    expect(t.app.appSettings.pathNames.value).toBe(true);
    await go(t, '/contacts', `[data-contact="${alice}"]`);
    expect(t.query(`[data-contact="${alice}"] [data-field="meta"]`)!.textContent).toContain('Hilltop Repeater');
    await go(t, `/contact/${alice}`, 'mc-contact-info-page');
    await t.until(() => t.query('mc-contact-info-page')!.shadowRoot!.querySelector('[data-field="path"]'), 3000, 'info path');
    const path = t.query('mc-contact-info-page')!.shadowRoot!.querySelector('[data-field="path"]')!;
    expect(path.textContent).toBe('Hilltop Repeater');
    expect(path.getAttribute('title')).toMatch(/^[0-9a-f]{2}: Hilltop Repeater$/);
  });
});
