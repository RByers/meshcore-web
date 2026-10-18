/** Contact notes: edited on the contact info page, shown after the contact's name everywhere. */
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
});

async function connected(): Promise<Harness> {
  const t = (h = createHarness());
  await t.mount();
  await t.connectEmulator();
  await t.app.connection.capture!.idle();
  return t;
}

const NOTE = 'met at the club';

function noteIn(t: Harness, selector: string): string | undefined {
  return t.query(`${selector} [data-field="contact-note"]`)?.textContent ?? undefined;
}

async function saveNote(t: Harness, key: string, text: string): Promise<void> {
  await t.go(`/node/${key}`, '[data-section="note"] [data-field="note-input"]');
  await t.fill('[data-field="note-input"]', text);
  await t.click('[data-action="save-note"]');
}

describe('contact notes', () => {
  it('saves a note on the node page and shows it after the name in lists, chat and channel senders', async () => {
    const t = await connected();
    const s = t.emulatorScenario();
    const carol = toHex(s.keys.carol);

    await saveNote(t, carol, `  ${NOTE} `);
    await t.until(() => t.app.contacts.noteFor(carol) === NOTE, 3000, 'note stored (trimmed)');
    await t.until(() => noteIn(t, '[data-field="header"]') === NOTE, 3000, 'header note');
    expect(t.query('[data-field="name"]')!.textContent).toBe('Carol');
    expect(t.query<HTMLInputElement>('[data-field="note-input"]')!.value).toBe(NOTE);
    expect(t.app.contacts.view(carol)?.note).toBe(NOTE);

    // contacts list row
    await t.go('/contacts', `[data-contact="${carol}"]`);
    await t.until(() => noteIn(t, `[data-contact="${carol}"] .name`) === NOTE, 3000, 'contacts row note');

    // a DM conversation in /messages and the Messages tab header
    s.nodes.carol.sendText(s.keys.self, 'hi there');
    await t.until(() => t.app.conversations.items.value.some((c) => c.convType === 'contact' && c.key === carol), 5000, 'conversation');
    await t.go('/messages', `[data-conv="contact:${carol}"]`);
    await t.until(() => noteIn(t, `[data-conv="contact:${carol}"] .name`) === NOTE, 3000, 'conversation note');
    await t.go(`/node/${carol}/messages`, '[data-field="composer"]');
    await t.until(() => noteIn(t, '[data-field="header"]') === NOTE, 3000, 'chat header note');
    expect(t.query('[data-field="header"] [data-field="name"]')!.textContent).toBe('Carol');

    // a channel message from her
    const pub = await channelKeyForPsk(publicChannelSecret());
    await t.go(`/channel/${pub}`, '[data-field="sender"]');
    s.nodes.carol.sendChannelMessage('Public', 'hello from carol');
    const sender = (): HTMLElement | undefined =>
      t.queryAll('.msg').find((li) => li.querySelector('[data-field="text"]')?.textContent === 'hello from carol')?.querySelector<HTMLElement>('[data-sender="contact"]') ?? undefined;
    await t.until(() => sender()?.querySelector('[data-field="contact-note"]')?.textContent === NOTE, 5000, 'sender note');
  });

  it('survives a reload and clears with an empty note', async () => {
    const t = await connected();
    const s = t.emulatorScenario();
    const alice = toHex(s.keys.alice);

    await saveNote(t, alice, NOTE);
    await t.until(() => t.app.contacts.noteFor(alice) === NOTE, 3000, 'note stored');

    await t.reload();
    await t.connectEmulator();
    await t.go(`/node/${alice}`, '[data-section="note"] [data-field="note-input"]');
    await t.until(() => noteIn(t, '[data-field="header"]') === NOTE, 5000, 'note after reload');
    expect(t.query<HTMLInputElement>('[data-field="note-input"]')!.value).toBe(NOTE);

    await t.fill('[data-field="note-input"]', '   ');
    await t.click('[data-action="save-note"]');
    await t.until(() => t.app.contacts.noteFor(alice) === '', 3000, 'note cleared');
    await t.until(() => !t.query('[data-field="header"] [data-field="contact-note"]'), 3000, 'header note gone');
    await t.go('/contacts', `[data-contact="${alice}"]`);
    expect(t.query(`[data-contact="${alice}"] [data-field="contact-note"]`)).toBeNull();
    expect(t.query(`[data-contact="${alice}"] .name`)!.textContent).toBe('Alice');
  });
});
