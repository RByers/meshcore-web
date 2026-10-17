import { afterEach, describe, expect, it } from 'vitest';
import { toHex } from '@meshcore-web/core/util/bytes';
import { channelKeyForPsk, type MessageStatus } from '@meshcore-web/core/store';
import { publicChannelSecret, scenarioKey } from '@meshcore-web/core/emulator';
import '../src/mc-app.js';
import '../src/pages/messaging/index.js';
import { createHarness, type Harness, type HarnessOptions } from '../src/testing/harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** A realistic ACK timeout; the retry test elapses it on the harness clock instead of waiting. */
const ACK_TIMEOUT_MS = 3000;
const TWO_TRIES = { maxAttempts: 2, ackTimeoutMs: ACK_TIMEOUT_MS, retryDelayMs: () => 0, lateAckGraceMs: 0 };

/** Mounts, connects via the Emulator and waits for the initial sync to be persisted. */
async function connected(opts: HarnessOptions = {}, prepare?: (t: Harness) => void): Promise<Harness> {
  const t = (h = createHarness(opts));
  prepare?.(t);
  await t.mount();
  await t.click('[data-connect="emulator"]');
  await t.until(() => t.app.connection.phase.value === 'connected', 5000, 'connected');
  await t.app.connection.capture!.idle();
  return t;
}

function keys(t: Harness) {
  const k = t.emulatorScenario().keys;
  return { alice: toHex(k.alice), bob: toHex(k.bob), room: toHex(k.room), repeater: toHex(k.repeater) };
}

describe('messages overview', () => {
  it('is the landing page after connect, listing DMs and channels with unread badges', async () => {
    const t = await connected();
    await t.until(() => location.hash === '#/messages', 3000, 'landing on /messages');
    await t.until(() => t.queryAll('[data-conv]').length === 4, 5000, 'conversations');
    const k = keys(t);
    const alice = t.query(`[data-conv="contact:${k.alice}"]`)!;
    expect(alice.textContent).toContain('Hi! Are you on the mesh today?');
    expect(alice.querySelector('.badge')?.getAttribute('data-unread')).toBe('1');
    expect(t.text()).toContain('Dave: Good morning everyone');
    await t.until(() => t.query('nav a[data-path="/messages"] .count')?.textContent === '3', 3000, 'nav badge');
    expect(t.query('nav a[data-path="/device"]')).not.toBeNull();
  });
});

describe('contacts page', () => {
  it('lists the scenario contacts with types, paths and unread, and filters / searches', async () => {
    const t = await connected();
    await t.go('/contacts', 'mc-contacts-page');
    await t.until(() => t.queryAll('[data-contact]').length === 6, 5000, 'contacts');
    const types = Object.fromEntries(t.queryAll('[data-contact]').map((li) => [li.querySelector('.name')!.textContent, li.dataset['type']]));
    expect(types).toEqual({
      Alice: 'chat',
      Bob: 'chat',
      Carol: 'chat',
      'Hilltop Repeater': 'repeater',
      'Town Square': 'room',
      'Weather Station': 'sensor',
    });
    const k = keys(t);
    const alice = t.query(`[data-contact="${k.alice}"]`)!;
    expect(alice.querySelector('[data-field="meta"]')!.textContent).toContain('1 hop');
    expect(alice.querySelector('[data-field="meta"]')!.textContent).toContain('SNR 6.5 dB');
    expect(alice.querySelector('.badge')!.getAttribute('data-unread')).toBe('1');
    expect(t.query(`[data-contact="${k.repeater}"] [data-field="meta"]`)!.textContent).toContain('direct');
    expect(t.query(`[data-contact="${k.bob}"] [data-field="meta"]`)!.textContent).toContain('flood');
    expect(t.query<HTMLAnchorElement>(`[data-contact="${k.alice}"] a`)!.getAttribute('href')).toBe(`#/chat/${k.alice}`);
    expect(t.query<HTMLAnchorElement>(`[data-contact="${k.repeater}"] a`)!.getAttribute('href')).toBe(`#/node/${k.repeater}`);

    await t.fill('[data-field="filter"]', 'repeater');
    await t.until(() => t.queryAll('[data-contact]').length === 1, 2000, 'filtered');
    await t.fill('[data-field="filter"]', 'all');
    await t.fill('[data-field="search"]', 'car');
    await t.until(() => t.queryAll('[data-contact]').length === 1, 2000, 'searched');
    expect(t.query('[data-contact] .name')!.textContent).toBe('Carol');
  });

  it('adds a contact by public key via the dialog and removes one via the menu', async () => {
    const t = await connected();
    await t.go('/contacts', '[data-contact]');
    await t.click('[data-action="add-contact"]');
    expect(t.query<HTMLDialogElement>('#add-dialog')!.open).toBe(true);
    const dave = scenarioKey('dave');
    await t.fill('[data-field="share"]', toHex(dave));
    await t.fill('[data-field="add-name"]', 'Dave');
    await t.click('[data-action="add-submit"]');
    await t.until(() => t.query(`[data-contact="${toHex(dave)}"]`), 5000, 'Dave row');
    await t.until(() => !t.query<HTMLDialogElement>('#add-dialog')!.open, 3000, 'dialog closed');
    expect(t.emulatorScenario().emulator.getContact(dave)?.name).toBe('Dave');

    const k = keys(t);
    await t.click(`[data-menu="${k.bob}"]`);
    expect(t.query(`#menu-${k.bob}`)!.matches(':popover-open')).toBe(true);
    await t.click(`#menu-${k.bob} [data-action="remove"]`);
    await t.until(() => t.query<HTMLDialogElement>('#remove-dialog')?.open, 2000, 'confirm');
    await t.click('[data-action="remove-confirm"]');
    await t.until(() => !t.query(`[data-contact="${k.bob}"]`), 5000, 'Bob removed');
    expect(t.emulatorScenario().emulator.getContact(t.emulatorScenario().keys.bob)).toBeUndefined();
  });

  it('toggles a favourite with the star and lists favourites first', async () => {
    const t = await connected();
    const k = keys(t);
    await t.go('/contacts', '[data-contact]');
    await t.fill('[data-field="sort"]', 'name');
    const order = () => t.queryAll('[data-contact]').map((li) => li.dataset['contact']);
    const star = (key: string) => t.query(`[data-contact="${key}"] [data-action="favourite"]`)!;
    await t.until(() => order()[0] === k.alice, 3000, 'Alice (favourite) first');
    expect(star(k.alice).getAttribute('aria-pressed')).toBe('true');
    expect(star(k.bob).getAttribute('aria-pressed')).toBe('false');

    await t.click(`[data-contact="${k.bob}"] [data-action="favourite"]`);
    await t.until(() => star(k.bob).getAttribute('aria-pressed') === 'true', 3000, 'Bob starred');
    expect(order().slice(0, 2)).toEqual([k.alice, k.bob]);

    await t.click(`[data-contact="${k.alice}"] [data-action="favourite"]`);
    await t.until(() => star(k.alice).getAttribute('aria-pressed') === 'false', 3000, 'Alice unstarred');
    expect(order()[0]).toBe(k.bob);
  });

  it('shows a node summary for repeaters', async () => {
    const t = await connected();
    const k = keys(t);
    await t.go(`/node/${k.repeater}`, '[data-field="header"]');
    const page = t.query('mc-node-admin-page')!.shadowRoot!;
    expect(page.querySelector('[data-field="name"]')!.textContent).toBe('Hilltop Repeater');
    expect(page.querySelector('[data-field="path"]')!.textContent!.toLowerCase()).toContain('direct');
  });
});

describe('direct chat', () => {
  it('sends "ping" to Alice: pending → sent → delivered, and "pong" arrives', async () => {
    const t = await connected();
    const k = keys(t);
    await t.go('/contacts', `[data-contact="${k.alice}"] a`);
    await t.click(`[data-contact="${k.alice}"] a`);
    await t.until(() => location.hash === `#/chat/${k.alice}` && t.query('mc-chat-page')?.shadowRoot?.querySelector('[data-field="composer"]'), 3000, 'chat page');
    // the chat loads its contact + history from IndexedDB after the page renders
    await expect.poll(() => t.query('[data-field="title"]')?.textContent, { timeout: 3000 }).toBe('Alice');
    await expect.poll(() => t.queryAll('.msg [data-field="text"]').map((e) => e.textContent), { timeout: 3000 }).toContain('Hi! Are you on the mesh today?');

    const statuses: MessageStatus[] = [];
    t.app.connection.store.value!.events.on('message', (e) => {
      if (e.type !== 'delete' && e.record.direction === 'out') statuses.push(e.record.status);
    });
    await t.fill('[data-field="composer"]', 'ping');
    expect(t.query('[data-field="bytes"]')!.textContent).toContain('156 / 160');
    await t.click('[data-action="send"]');
    await t.until(() => t.query('.msg[data-dir="out"]'), 3000, 'outgoing bubble');
    expect(t.query<HTMLTextAreaElement>('[data-field="composer"]')!.value).toBe('');
    await t.until(() => t.query('.msg[data-dir="out"][data-status="delivered"]'), 8000, 'delivered');
    expect(statuses[0]).toBe('pending');
    expect(statuses).toContain('sent');
    expect(statuses.at(-1)).toBe('delivered');
    expect(t.query('.msg[data-dir="out"] [data-field="rtt"]')).not.toBeNull();
    await t.until(() => t.queryAll('.msg[data-dir="in"] [data-field="text"]').some((e) => e.textContent === 'pong'), 8000, 'pong');
  });

  it('Enter sends, Shift+Enter does not, and the counter flags overflow', async () => {
    const t = await connected();
    const k = keys(t);
    await t.go(`/chat/${k.alice}`, '[data-field="composer"]');
    await t.fill('[data-field="composer"]', 'x'.repeat(161));
    expect(t.query('[data-field="bytes"]')!.hasAttribute('data-over')).toBe(true);
    expect(t.query<HTMLButtonElement>('[data-action="send"]')!.disabled).toBe(true);
    await t.fill('[data-field="composer"]', 'line one');
    const ta = t.query<HTMLTextAreaElement>('[data-field="composer"]')!;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, composed: true }));
    expect(t.queryAll('.msg[data-dir="out"]')).toHaveLength(0);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true }));
    await t.until(() => t.queryAll('.msg[data-dir="out"]').length === 1, 3000, 'sent by Enter');
  });

  it('replies with "@[name] text" and shows the quote', async () => {
    const t = await connected();
    const k = keys(t);
    await t.go(`/chat/${k.alice}`, '.msg[data-dir="in"] [data-action="reply"]');
    await t.click('.msg[data-dir="in"] [data-action="reply"]');
    await t.until(() => t.query('[data-field="reply-banner"]'), 2000, 'reply banner');
    expect(t.query('[data-field="bytes"]')!.textContent).toContain(`/ ${160 - '@[Alice] '.length}`);
    await t.fill('[data-field="composer"]', 'yes!');
    await t.click('[data-action="send"]');
    await t.until(() => t.query('.msg[data-dir="out"] [data-field="quote"]'), 3000, 'quoted reply');
    expect(t.query('.msg[data-dir="out"] [data-field="quote"]')!.textContent).toContain('Alice: Hi! Are you on the mesh today?');
    expect(t.query('.msg[data-dir="out"] [data-field="text"]')!.textContent).toBe('yes!');
    expect(t.query('[data-field="reply-banner"]')).toBeNull();
  });

  it('shows a failed message with retry when the peer never ACKs, and retry delivers', async () => {
    const t = await connected({ app: { messaging: { retry: TWO_TRIES } } }, (x) => {
      x.emulatorScenario().nodes.bob.config.ackPolicy = 'never';
    });
    const k = keys(t);
    await t.go(`/chat/${k.bob}`, '[data-field="composer"]');
    const statuses: MessageStatus[] = [];
    t.app.connection.store.value!.events.on('message', (e) => {
      if (e.type !== 'delete' && e.record.direction === 'out') statuses.push(e.record.status);
    });
    await t.fill('[data-field="composer"]', 'anyone there?');
    await t.click('[data-action="send"]');
    // 'sent' is stored after the client armed the attempt's ACK timer; elapse it for each attempt
    const out = '.msg[data-dir="out"]';
    await t.until(() => t.query(`${out}[data-status="sent"]`) && !t.query(`${out} [data-field="attempt"]`), 3000, 'attempt 1 sent');
    await t.elapse(ACK_TIMEOUT_MS);
    await t.until(() => t.query(`${out}[data-status="sent"] [data-field="attempt"]`)?.textContent === 'attempt 2', 3000, 'attempt 2 sent');
    expect(t.query(`${out}[data-status="failed"]`)).toBeNull();
    await t.elapse(ACK_TIMEOUT_MS);
    await t.until(() => t.query(`${out}[data-status="failed"]`), 3000, 'failed');
    expect(t.query(`${out} [data-field="attempt"]`)!.textContent).toBe('attempt 2');
    // (consecutive repeats collapsed: the stored record is re-written with each attempt's details)
    expect(statuses.filter((x, i) => x !== statuses[i - 1])).toEqual(['pending', 'sent', 'pending', 'sent', 'failed']);
    t.emulatorScenario().nodes.bob.config.ackPolicy = 'auto';
    statuses.length = 0;
    await t.click(`${out} [data-action="retry"]`);
    await t.until(() => t.query(`${out}[data-status="delivered"]`), 3000, 'delivered after retry');
    expect(t.query('[data-action="retry"]')).toBeNull();
    expect(statuses[0]).toBe('pending');
    expect(statuses).toContain('sent');
    expect(statuses.at(-1)).toBe('delivered');
  });
});

describe('channels', () => {
  it('lists Public and #test, opens Public, shows senders and sends a message', async () => {
    const t = await connected();
    await t.go('/channels', '[data-channel]');
    const names = t.queryAll('[data-channel] .name').map((e) => e.textContent);
    expect(names).toEqual(['Public', '#test']);
    const pub = await channelKeyForPsk(publicChannelSecret());
    expect(t.query(`[data-channel="${pub}"]`)!.dataset['kind']).toBe('public');
    expect(t.query(`[data-channel="${pub}"] .badge`)!.getAttribute('data-unread')).toBe('1');

    await t.click(`[data-channel="${pub}"] a`);
    await t.until(() => location.hash === `#/channel/${pub}` && t.query('[data-field="sender"]'), 3000, 'channel chat');
    expect(t.query('[data-field="sender"]')!.textContent).toBe('Dave');
    expect(t.query('[data-field="bytes"]')!.textContent).toContain(`/ ${160 - 'Emulator: '.length}`);
    await t.until(() => t.app.unread.totals.value.channels === 0, 3000, 'channel read');

    await t.fill('[data-field="composer"]', 'hello mesh');
    await t.click('[data-action="send"]');
    await t.until(() => t.query('.msg[data-dir="out"][data-status="sent"]'), 5000, 'sent');
    const alice = t.emulatorScenario().nodes.alice;
    await t.until(() => alice.channelMessages.some((m) => m.text === 'Emulator: hello mesh'), 5000, 'heard by Alice');

    t.emulatorScenario().nodes.bob.sendChannelMessage('Public', 'welcome!');
    await t.until(() => t.queryAll('.msg[data-dir="in"] [data-field="sender"]').some((e) => e.textContent === 'Bob'), 5000, 'Bob in channel');
  });

  it('adds a hashtag channel via the dialog: on the device and in the list', async () => {
    const t = await connected();
    await t.go('/channels', '[data-channel]');
    await t.click('[data-action="add-channel"]');
    expect(t.query<HTMLDialogElement>('#channel-dialog')!.open).toBe(true);
    await t.fill('[data-field="channel-name"]', '#web');
    await t.click('[data-action="channel-submit"]');
    await t.until(() => t.queryAll('[data-channel] .name').some((e) => e.textContent === '#web'), 5000, '#web row');
    await t.until(() => !t.query<HTMLDialogElement>('#channel-dialog')!.open, 3000, 'dialog closed');
    const slot = t.emulatorScenario().emulator.channels[2]!;
    expect(slot.name).toBe('#web');
    expect(slot.secret.some((b) => b !== 0)).toBe(true);

    // a bad key keeps the dialog open with an error
    await t.click('[data-action="add-channel"]');
    await t.fill('[data-field="channel-name"]', 'Team');
    await t.fill('[data-field="channel-psk"]', 'nope');
    await t.click('[data-action="channel-submit"]');
    await t.until(() => t.query('#channel-dialog [role="alert"]'), 3000, 'error');
    expect(t.query('#channel-dialog [role="alert"]')!.textContent).toContain('16 bytes');
  });

  it('mutes and deletes a channel from its menu', async () => {
    const t = await connected();
    await t.go('/channels', '[data-channel]');
    const pub = await channelKeyForPsk(publicChannelSecret());
    await t.click(`[data-menu="${pub}"]`);
    await t.click(`#menu-${pub} [data-action="mute"]`);
    await t.until(() => t.query(`[data-channel="${pub}"][data-muted]`), 3000, 'muted');
    expect(t.query(`[data-channel="${pub}"] .badge`)!.hasAttribute('data-muted')).toBe(true);

    const rows = t.queryAll('[data-channel]');
    const test = rows[1]!.dataset['channel']!;
    await t.click(`[data-menu="${test}"]`);
    await t.click(`#menu-${test} [data-action="delete"]`);
    await t.until(() => t.query<HTMLDialogElement>('#delete-dialog')?.open, 2000, 'confirm');
    await t.click('[data-action="delete-confirm"]');
    await t.until(() => !t.query(`[data-channel="${test}"]`), 5000, 'deleted');
    expect(t.emulatorScenario().emulator.channels[1]!.name).toBe('');
  });
});

describe('unread and persistence', () => {
  it('bumps the unread badge on an incoming message and clears it when the chat opens', async () => {
    const t = await connected();
    const k = keys(t);
    await t.go('/contacts', `[data-contact="${k.bob}"]`);
    expect(t.query(`[data-contact="${k.bob}"] .badge`)).toBeNull();
    const s = t.emulatorScenario();
    s.emulator.injectContactMessage(s.keys.bob, 'are you around?');
    await t.until(() => t.query(`[data-contact="${k.bob}"] .badge`)?.getAttribute('data-unread') === '1', 5000, 'Bob unread');
    await t.until(() => t.query('nav a[data-path="/contacts"] .count')?.textContent === '3', 3000, 'nav count');

    await t.click(`[data-contact="${k.bob}"] a`);
    await t.until(() => t.text().includes('are you around?'), 3000, 'message shown');
    await t.until(() => t.query('nav a[data-path="/contacts"] .count')?.textContent === '2', 3000, 'nav count cleared');
    // while the chat is open new messages are read immediately
    s.emulator.injectContactMessage(s.keys.bob, 'hello?');
    await t.until(() => t.text().includes('hello?'), 5000, 'second message');
    await t.go('/contacts', `[data-contact="${k.bob}"]`);
    await t.until(() => !t.query(`[data-contact="${k.bob}"] .badge`), 3000, 'no badge');
  });

  it('keeps messages and their status across a reload', async () => {
    const t = await connected();
    const k = keys(t);
    await t.go(`/chat/${k.alice}`, '[data-field="composer"]');
    await t.fill('[data-field="composer"]', 'ping');
    await t.click('[data-action="send"]');
    await t.until(() => t.query('.msg[data-dir="out"][data-status="delivered"]'), 8000, 'delivered');
    await t.until(() => t.queryAll('.msg[data-dir="in"] [data-field="text"]').some((e) => e.textContent === 'pong'), 8000, 'pong');
    await t.app.connection.capture!.idle();

    await t.reload();
    await t.click('[data-connect="emulator"]');
    await t.until(() => t.app.connection.phase.value === 'connected', 5000, 'reconnected');
    await t.go(`/chat/${k.alice}`, '.msg[data-dir="out"]');
    const texts = t.queryAll('.msg [data-field="text"]').map((e) => e.textContent);
    expect(texts).toEqual(['Hi! Are you on the mesh today?', 'ping', 'pong']);
    expect(t.query('.msg[data-dir="out"]')!.dataset['status']).toBe('delivered');
  });
});
