/** Emoji reactions (MeshCore Open compatible, feature-inventory.md §2.4b) in the chat UI. */
import { afterEach, describe, expect, it } from 'vitest';
import { toHex } from '@meshcore-web/core/util/bytes';
import { computeReactionHash } from '@meshcore-web/core/app';
import { channelKeyForPsk } from '@meshcore-web/core/store';
import { FAST_TIMING, publicChannelSecret } from '@meshcore-web/core/emulator';
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

const picker = (t: Harness) => t.query<HTMLDialogElement>('#reaction-picker');

describe('emoji reactions', () => {
  it('DM: the picker reacts to an incoming message; chips show pending then done; incoming reactions attach', async () => {
    const t = await connected();
    const s = t.emulatorScenario();
    const alice = toHex(s.keys.alice);
    await t.go(`/chat/${alice}`, '.msg[data-dir="in"]');

    // only incoming messages offer the react button
    const incoming = t.query('.msg[data-dir="in"]')!;
    expect(incoming.querySelector('[data-action="react"]')).not.toBeNull();
    await t.click('.msg[data-dir="in"] [data-action="react"]');
    await t.until(() => picker(t)?.open, 3000, 'picker open');
    expect(t.queryAll('[data-field="quick-emojis"] [data-emoji]').map((b) => b.dataset['emoji'])).toEqual(['👍', '❤️', '😂', '🎉', '👏', '🔥']);
    await t.click('[data-tab="hearts"]');
    await t.until(() => t.query('[data-field="emoji-grid"] [data-emoji="💜"]'), 3000, 'hearts tab');
    s.nodes.alice.config.ackDelayMs = 300; // keep the reaction pending long enough to observe the chip
    await t.click('[data-field="emoji-grid"] [data-emoji="💜"]');
    expect(picker(t)!.open).toBe(false);
    await t.until(() => t.query('.msg[data-dir="in"] [data-field="reaction"][data-emoji="💜"][data-state="pending"]'), 3000, 'pending chip');
    expect(getComputedStyle(t.query('[data-field="reaction"][data-state="pending"]')!).opacity).toBe('0.5');
    await t.until(() => t.query('.msg[data-dir="in"] [data-field="reaction"][data-emoji="💜"][data-state="done"]'), 8000, 'delivered chip');
    const m = t.app.chat('contact', alice).messages.value.find((x) => x.direction === 'in')!;
    expect(s.nodes.alice.inbox.at(-1)?.text).toBe(`r:${computeReactionHash(m.timestamp, null, m.text)}:6c`); // 💜 = 6 + 64 + 33 + 5 = 0x6c

    // right-click opens the picker too
    t.query('.msg[data-dir="in"] .bubble')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true }));
    await t.until(() => picker(t)?.open, 3000, 'picker open via contextmenu');
    picker(t)!.close();

    // Alice reacts to our message: a chip with a tooltip naming her, and no "r:" bubble
    s.nodes.alice.config.ackDelayMs = FAST_TIMING.ackDelayMs;
    await t.fill('[data-field="composer"]', 'Lunch at noon?');
    await t.click('[data-action="send"]');
    await t.until(() => t.query('.msg[data-dir="out"][data-status="delivered"]'), 8000, 'delivered');
    expect(t.query('.msg[data-dir="out"] [data-action="react"]')).toBeNull();
    const out = t.app.chat('contact', alice).messages.value.find((x) => x.direction === 'out')!;
    s.nodes.alice.sendText(s.keys.self, `r:${computeReactionHash(out.timestamp, null, out.text)}:00`);
    s.nodes.alice.sendText(s.keys.self, `r:${computeReactionHash(out.timestamp, null, out.text)}:00`); // duplicate: counted once
    await t.until(() => t.query('.msg[data-dir="out"] [data-field="reaction"][data-emoji="👍"]'), 5000, 'incoming reaction chip');
    const chip = t.query('.msg[data-dir="out"] [data-field="reaction"][data-emoji="👍"]')!;
    expect(chip.title).toBe('👍 Alice');
    expect(chip.querySelector('.count')).toBeNull();
    expect(t.queryAll('[data-field="text"]').some((e) => e.textContent?.startsWith('r:'))).toBe(false);
  });

  it('channel: counts reactions from several senders and offers retry for a failed own reaction', async () => {
    const t = await connected();
    const s = t.emulatorScenario();
    const pub = await channelKeyForPsk(publicChannelSecret());
    await t.go(`/channel/${pub}`, '.msg[data-dir="in"]');
    const chat = t.app.chat('channel', pub);
    const dave = chat.messages.value[0]!;
    const hash = computeReactionHash(dave.timestamp, 'Dave', dave.text);
    s.nodes.bob.sendChannelMessage('Public', `r:${hash}:05`);
    s.nodes.carol.sendChannelMessage('Public', `r:${hash}:05`);
    await t.until(() => t.query('[data-field="reaction"][data-emoji="🔥"] .count')?.textContent === '2', 5000, 'two reactions');
    expect(t.query('[data-field="reaction"][data-emoji="🔥"]')!.title).toBe('🔥 Bob, Carol');

    // our reaction fails (stored as failed), the chip becomes a retry button
    await t.app.connection.store.value!.messages.addReaction(dave.id, { emoji: '🎉', sender: 'Emulator', own: true, status: 'failed', at: Date.now() });
    await t.until(() => t.query('[data-action="retry-reaction"][data-emoji="🎉"]'), 3000, 'retry chip');
    await t.click('[data-action="retry-reaction"][data-emoji="🎉"]');
    await t.until(() => t.query('[data-field="reaction"][data-emoji="🎉"][data-state="done"]'), 5000, 'resent');
    await t.until(() => s.nodes.alice.channelMessages.some((m) => m.text === `Emulator: r:${hash}:03`), 5000, 'heard by Alice');
  });
});
