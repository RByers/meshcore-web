/** SMAZ compression (MeshCore Open compatible, feature-inventory.md §2.4a) in the chat UI. */
import { afterEach, describe, expect, it } from 'vitest';
import { toHex } from '@meshcore-web/core/util/bytes';
import { smazEncodeIfSmaller } from '@meshcore-web/core/util/smaz';
import { channelKeyForPsk } from '@meshcore-web/core/store';
import { publicChannelSecret } from '@meshcore-web/core/emulator';
import '../src/mc-app.js';
import '../src/pages/messaging/index.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function connected(): Promise<Harness> {
  const t = (h = createHarness());
  await t.mount();
  await t.click('[data-connect="emulator"]');
  await t.until(() => t.app.connection.phase.value === 'connected', 5000, 'connected');
  await t.app.connection.capture!.idle();
  return t;
}

async function go(t: Harness, path: string, selector: string): Promise<void> {
  location.hash = `#${path}`;
  await t.until(() => t.query(selector), 5000, selector);
}

const LONG = 'the weather is fine here, meet at the station at ten';

describe('SMAZ compression', () => {
  it('DM: shows a compressed incoming message decoded, and the toggle compresses what is sent', async () => {
    const t = await connected();
    const s = t.emulatorScenario();
    const alice = toHex(s.keys.alice);
    await go(t, `/chat/${alice}`, '[data-field="composer"]');
    await t.until(() => !t.query<HTMLInputElement>('[data-action="smaz"]')!.disabled, 3000, 'toggle enabled');
    expect(t.query<HTMLInputElement>('[data-action="smaz"]')!.checked).toBe(false);

    const env = smazEncodeIfSmaller(LONG);
    s.nodes.alice.sendText(s.keys.self, env);
    await t.until(() => t.queryAll('.msg[data-dir="in"] [data-field="text"]').some((e) => e.textContent === LONG), 5000, 'decoded incoming');
    expect(t.text()).not.toContain(env);
    expect(t.query('.msg[data-dir="in"] [data-field="smaz"]')).not.toBeNull();

    await t.click('[data-action="smaz"]');
    await t.until(() => t.app.contacts.find(alice)?.smaz === true, 3000, 'setting stored');
    await t.until(() => t.query<HTMLInputElement>('[data-action="smaz"]')!.checked, 3000, 'toggle on');

    await t.fill('[data-field="composer"]', LONG);
    await t.until(() => t.query('[data-field="bytes"]')!.textContent!.includes(`${160 - env.length} / 160 bytes left (compressed)`), 3000, 'compressed budget');
    await t.click('[data-action="send"]');
    await t.until(() => t.query('.msg[data-dir="out"][data-status="delivered"]'), 8000, 'delivered');
    expect(t.query('.msg[data-dir="out"] [data-field="text"]')!.textContent).toBe(LONG);
    expect(t.query('.msg[data-dir="out"] [data-field="smaz"]')).not.toBeNull();
    // what went over the air is the MeshCore Open envelope
    expect(s.nodes.alice.inbox.at(-1)?.text).toBe(env);
  });

  it('channel: the edit dialog toggles compression; sent text is "name: s:…" on air', async () => {
    const t = await connected();
    const s = t.emulatorScenario();
    const pub = await channelKeyForPsk(publicChannelSecret());
    await go(t, '/channels', `[data-channel="${pub}"]`);
    await t.click(`[data-menu="${pub}"]`);
    await t.click(`#menu-${pub} [data-action="edit"]`);
    await t.until(() => t.query<HTMLDialogElement>('#channel-dialog')!.open, 3000, 'dialog open');
    expect(t.query<HTMLInputElement>('[data-field="channel-smaz"]')!.checked).toBe(false);
    await t.click('[data-field="channel-smaz"]');
    await t.click('[data-action="channel-submit"]');
    await t.until(() => t.app.channels.find(pub)?.smaz === true, 5000, 'setting stored');
    await t.until(() => t.query(`[data-channel="${pub}"] [data-field="smaz"]`), 3000, 'SMAZ marker in list');

    // reopening the dialog shows the stored setting
    await t.until(() => !t.query<HTMLDialogElement>('#channel-dialog')!.open, 3000, 'dialog closed');
    await t.click(`[data-menu="${pub}"]`);
    await t.click(`#menu-${pub} [data-action="edit"]`);
    await t.until(() => t.query<HTMLInputElement>('[data-field="channel-smaz"]')!.checked, 3000, 'checked on reopen');
    t.query<HTMLDialogElement>('#channel-dialog')!.close();

    await go(t, `/channel/${pub}`, '[data-field="composer"]');
    await t.until(() => t.query<HTMLInputElement>('[data-action="smaz"]')!.checked, 3000, 'toggle on in chat');
    await t.fill('[data-field="composer"]', LONG);
    await t.click('[data-action="send"]');
    await t.until(() => t.query('.msg[data-dir="out"][data-status="sent"]'), 5000, 'sent');
    const env = smazEncodeIfSmaller(LONG);
    await t.until(() => s.nodes.alice.channelMessages.some((m) => m.text === `Emulator: ${env}`), 5000, 'heard by Alice');

    s.nodes.bob.sendChannelMessage('Public', env);
    await t.until(
      () => t.queryAll('.msg[data-dir="in"]').some((li) => li.querySelector('[data-field="sender"]')?.textContent === 'Bob' && li.querySelector('[data-field="text"]')?.textContent === LONG),
      5000,
      'decoded channel message from Bob',
    );
  });
});
