/** Issue #12: message senders link to the contact info page. */
import { afterEach, describe, expect, it } from 'vitest';
import { toHex } from '@meshcore-web/core/util/bytes';
import { channelKeyForPsk } from '@meshcore-web/core/store';
import { publicChannelSecret, scenarioKey } from '@meshcore-web/core/emulator';
import '../src/mc-app.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function connected(): Promise<Harness> {
  const t = (h = createHarness());
  await t.mount();
  await t.connectEmulator();
  await t.app.connection.capture!.idle();
  return t;
}

function msgWith(t: Harness, text: string): HTMLElement | undefined {
  return t.queryAll('.msg').find((li) => li.querySelector('[data-field="text"]')?.textContent === text);
}

/** A field of the contact info page. */
function info(t: Harness, field: string): HTMLElement | null {
  return t.query('mc-contact-info-page')?.shadowRoot?.querySelector<HTMLElement>(`[data-field="${field}"]`) ?? null;
}

describe('channel senders', () => {
  it('links a known sender to their contact info and leaves unknown senders as text', async () => {
    const t = await connected();
    const s = t.emulatorScenario();
    const pub = await channelKeyForPsk(publicChannelSecret());
    await t.go(`/channel/${pub}`, '[data-field="sender"]');
    // history sender "Dave" is not a contact
    const dave = t.query('[data-sender]')!;
    expect(dave.textContent).toBe('Dave');
    expect(dave.dataset['sender']).toBe('unknown');
    expect(dave.tagName).toBe('SPAN');

    s.nodes.carol.sendChannelMessage('Public', 'hello from carol');
    await t.until(() => msgWith(t, 'hello from carol'), 5000, 'Carol message');
    const link = msgWith(t, 'hello from carol')!.querySelector<HTMLAnchorElement>('a[data-field="sender"]')!;
    expect(link.textContent).toBe('Carol');
    expect(link.getAttribute('href')).toBe(`#/contact/${toHex(s.keys.carol)}`);
    link.click();
    await t.until(() => info(t, 'name'), 5000, 'contact info');
    expect(info(t, 'name')!.textContent).toBe('Carol');
    expect(info(t, 'key')!.textContent).toBe(toHex(s.keys.carol));
    expect(info(t, 'direct-signal')!.textContent).toContain('not heard directly');
  });

  it('sends an ambiguous sender name to the contact list searched by that name', async () => {
    const t = await connected();
    const s = t.emulatorScenario();
    await t.app.contacts.add(toHex(scenarioKey('bob2')), { name: 'Bob' });
    const pub = await channelKeyForPsk(publicChannelSecret());
    await t.go(`/channel/${pub}`, '[data-field="sender"]');
    s.nodes.bob.sendChannelMessage('Public', 'which bob?');
    await t.until(() => msgWith(t, 'which bob?'), 5000, 'Bob message');
    const btn = msgWith(t, 'which bob?')!.querySelector<HTMLButtonElement>('button[data-field="sender"]')!;
    expect(btn.dataset['sender']).toBe('search');
    btn.click();
    await t.until(() => location.hash === '#/contacts' && t.queryAll('[data-contact]').length === 2, 5000, 'filtered contacts');
    expect(t.queryAll('[data-contact] .name').map((e) => e.textContent)).toEqual(['Bob', 'Bob']);
    expect(t.query<HTMLInputElement>('[data-field="search"]')!.value).toBe('Bob');
  });
});

describe('DM header', () => {
  it('links the contact name to contact info, which shows the direct signal', async () => {
    const t = await connected();
    const s = t.emulatorScenario();
    const bob = toHex(s.keys.bob);
    await t.go(`/chat/${bob}`, '[data-field="title"] a');
    s.nodes.bob.sendText(s.keys.self, 'right here');
    await t.until(() => msgWith(t, 'right here'), 5000, 'Bob DM');
    const title = t.query<HTMLAnchorElement>('[data-field="title"] a')!;
    expect(title.textContent).toBe('Bob');
    expect(title.getAttribute('href')).toBe(`#/contact/${bob}`);
    title.click();
    await t.until(() => info(t, 'direct-signal')?.textContent?.includes('8 dB'), 5000, 'contact info');
    expect(info(t, 'direct-signal')!.textContent).toMatch(/8 dB\s*\(just now\)/);
    expect(t.query('mc-contact-info-page')!.shadowRoot!.querySelector('[data-action="message"]')!.getAttribute('href')).toBe(`#/chat/${bob}`);
  });

  it('offers contact info from the contacts list menu', async () => {
    const t = await connected();
    const rep = toHex(t.emulatorScenario().keys.repeater);
    await t.go('/contacts', `[data-menu="${rep}"]`);
    expect(t.query(`#menu-${rep} [data-action="info"]`)!.getAttribute('href')).toBe(`#/contact/${rep}`);
  });
});
