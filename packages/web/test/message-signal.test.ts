/** Issue #11: SNR only for zero-hop messages; hop count for relayed ones; direct signal per contact. */
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

function msgWith(t: Harness, text: string): HTMLElement | undefined {
  return t.queryAll('.msg').find((li) => li.querySelector('[data-field="text"]')?.textContent === text);
}

describe('message signal', () => {
  it('shows the hop count, not the last-hop SNR, for a relayed channel message', async () => {
    const t = await connected();
    const pub = await channelKeyForPsk(publicChannelSecret());
    await t.go(`/channel/${pub}`, '[data-field="sender"]');
    // Carol is only heard via the repeater
    t.emulatorScenario().nodes.carol.sendChannelMessage('Public', 'via the hill');
    await t.until(() => msgWith(t, 'via the hill'), 5000, 'Carol message');
    const li = msgWith(t, 'via the hill')!;
    expect(li.querySelector('[data-field="path"]')!.textContent).toBe('1 hop');
    expect(li.querySelector('[data-field="snr"]')).toBeNull();
    // the raw SNR stays available in the tooltip
    expect(li.querySelector('[data-field="signal"]')!.getAttribute('title')).toContain('SNR 8 dB (last hop)');
  });

  it('shows SNR for a zero-hop DM and records it as the contact\'s direct signal', async () => {
    const t = await connected();
    const s = t.emulatorScenario();
    const bob = toHex(s.keys.bob);
    await t.go(`/node/${bob}/messages`, '[data-field="name"]');
    // Bob has no path to us and is in range: the DM floods and arrives zero hop
    s.nodes.bob.sendText(s.keys.self, 'right here');
    await t.until(() => msgWith(t, 'right here'), 5000, 'Bob DM');
    const li = msgWith(t, 'right here')!;
    expect(li.querySelector('[data-field="path"]')!.textContent).toBe('zero hop');
    expect(li.querySelector('[data-field="snr"]')!.textContent).toBe('SNR 8 dB');
    await t.until(() => t.query('[data-field="subtitle"]')?.textContent?.includes('direct SNR 8 dB'), 3000, 'subtitle');
    await t.go('/contacts', `[data-contact="${bob}"]`);
    await expect.poll(() => t.query(`[data-contact="${bob}"] [data-field="meta"]`)?.textContent, { timeout: 3000 }).toContain('direct SNR 8 dB');
    // Carol has never been heard directly
    expect(t.query(`[data-contact="${toHex(s.keys.carol)}"] [data-field="meta"]`)!.textContent).not.toContain('SNR');
  });
});
