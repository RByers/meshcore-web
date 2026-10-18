import { afterEach, describe, expect, it } from 'vitest';
import '../src/mc-app.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function openDevice(): Promise<Harness> {
  const t = (h = createHarness());
  await t.mount();
  await t.connectEmulator('/device');
  await t.until(() => t.query('[data-section="advert"]'), 5000, 'device page');
  return t;
}

describe('device page', () => {
  it('shows device statistics and refreshes them on request', async () => {
    const t = await openDevice();
    await t.until(() => t.query('[data-field="stats"]')?.textContent?.includes('Uptime'), 5000, 'stats');
    const first = t.app.deviceSettings.stats.value!.at;
    await t.elapse(1_000);
    await t.click('[data-action="refresh-stats"]');
    await t.until(() => t.app.deviceSettings.stats.value!.at > first, 3000, 'stats refreshed');
  });

  it('polls statistics every 5 s while shown', async () => {
    const t = await openDevice();
    await t.until(() => t.app.deviceSettings.stats.value, 5000, 'stats');
    const first = t.app.deviceSettings.stats.value!.at;
    await t.elapse(5_000);
    await t.until(() => t.app.deviceSettings.stats.value!.at > first, 3000, 'polled');
  });

  it('send advert puts an advert on the air and starts a 10 s cooldown', async () => {
    const t = await openDevice();
    const emu = t.emulatorScenario().emulator;
    const before = emu.airLog.filter((e) => e.type === 'advert').length;
    await t.click('[data-action="advert-flood"]');
    await t.until(() => emu.airLog.filter((e) => e.type === 'advert' && e.flood).length > 0 && emu.airLog.filter((e) => e.type === 'advert').length > before, 3000, 'advert');
    await t.until(() => t.query('[data-field="advert-cooldown"]'), 2000, 'cooldown');
    expect(t.query<HTMLButtonElement>('[data-action="advert-zero-hop"]')!.disabled).toBe(true);
    await t.elapse(9_000);
    expect(t.query('[data-field="advert-cooldown"]')).not.toBeNull();
    await t.elapse(1_000);
    await t.until(() => !t.query('[data-field="advert-cooldown"]'), 2000, 'cooldown over');
    expect(t.query<HTMLButtonElement>('[data-action="advert-zero-hop"]')!.disabled).toBe(false);
  });

});
