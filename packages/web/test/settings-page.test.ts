import { afterEach, describe, expect, it } from 'vitest';
import { toHex } from '@meshcore-web/core/util/bytes';
import { SkippableClock } from '@meshcore-web/core/util/clock';
import '../src/mc-app.js';
import { createHarness, type Harness, type HarnessOptions } from '../src/testing/harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  delete document.documentElement.dataset['theme'];
  document.documentElement.style.colorScheme = '';
});

async function openSettings(opts: HarnessOptions = {}): Promise<Harness> {
  const t = (h = createHarness(opts));
  await t.mount();
  await t.connectEmulator('/settings');
  await t.until(() => t.query('[data-section="identity"]'), 5000, 'settings page');
  // wait for loadAll (tuning, stats…) to finish
  await t.until(() => t.query('[data-field="stats"]'), 5000, 'stats');
  return t;
}

function setValue(t: Harness, selector: string, value: string): void {
  const el = t.query<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
  if (!el) throw new Error(`no ${selector}`);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

async function confirmDialog(t: Harness): Promise<void> {
  await t.until(() => t.query<HTMLDialogElement>('dialog[data-dialog-root]')?.open, 2000, 'dialog');
  await t.click('[data-dialog="confirm"]');
}

describe('settings page', () => {
  it('shows app settings without a radio', async () => {
    const t = (h = createHarness());
    await t.mount();
    location.hash = '#/settings';
    await t.until(() => t.query('mc-settings-page'), 2000, 'settings page');
    await t.until(() => t.query('[data-section="app"]'));
    expect(t.query('[data-section="no-radio"]')).not.toBeNull();
    expect(t.query('[data-section="radio"]')).toBeNull();
  });

  it('the Frames tab setting is off by default and the checkbox turns it on', async () => {
    const t = (h = createHarness());
    await t.mount();
    location.hash = '#/settings';
    await t.until(() => t.query('input[name="showFrames"]'), 2000, 'showFrames checkbox');
    const box = t.query<HTMLInputElement>('input[name="showFrames"]')!;
    expect(box.checked).toBe(false);
    expect(box.closest('label')!.textContent).toContain('Show the Frames tab on the Packets page');
    await t.click('input[name="showFrames"]');
    expect(t.app.appSettings.showFrames.value).toBe(true);
    await t.click('input[name="showFrames"]');
    expect(t.app.appSettings.showFrames.value).toBe(false);
  });

  it('changing the name updates the emulator and the header', async () => {
    const t = await openSettings();
    setValue(t, '[data-form="name"] input[name="name"]', 'Base Camp');
    await t.click('[data-action="save-name"]');
    const emu = t.emulatorScenario().emulator;
    await t.until(() => emu.prefs.name === 'Base Camp', 3000, 'emulator name');
    await t.until(() => t.query('.chip')!.textContent!.includes('Base Camp'), 3000, 'header');
    await t.until(() => t.text().includes('Name saved'), 2000, 'toast');
  });

  it('shows inline validation errors without sending', async () => {
    const t = await openSettings();
    setValue(t, '[data-form="name"] input[name="name"]', '');
    await t.click('[data-action="save-name"]');
    await t.until(() => t.query('[data-error="name"]'), 2000, 'error');
    expect(t.query('[data-form="name"] input[name="name"]')!.getAttribute('aria-invalid')).toBe('true');
    expect(t.emulatorScenario().emulator.prefs.name).toBe('Emulator');

    setValue(t, '[data-form="location"] input[name="lat"]', '123');
    await t.click('[data-action="save-location"]');
    await t.until(() => t.query('[data-error="lat"]'), 2000, 'lat error');
  });

  it('applying a radio preset updates the emulator radio params after confirmation', async () => {
    const t = await openSettings();
    setValue(t, '[data-form="radio"] select[name="preset"]', 'us');
    await t.el!.updateComplete;
    await t.until(() => t.query<HTMLInputElement>('[data-form="radio"] input[name="freq"]')!.value === '910.525', 2000, 'preset fills fields');
    await t.click('[data-action="apply-radio"]');
    await confirmDialog(t);
    const emu = t.emulatorScenario().emulator;
    await t.until(() => emu.prefs.radio.freqKhz === 910525, 3000, 'emulator radio');
    expect(emu.prefs.radio).toMatchObject({ freqKhz: 910525, bwHz: 62500, sf: 7, cr: 5 });
    await t.until(() => t.text().includes('Radio settings applied'), 2000, 'toast');
  });

  it('cancelling the radio confirmation sends nothing', async () => {
    const t = await openSettings();
    const before = { ...t.emulatorScenario().emulator.prefs.radio };
    setValue(t, '[data-form="radio"] select[name="preset"]', 'eu-narrow');
    await t.click('[data-action="apply-radio"]');
    await t.until(() => t.query<HTMLDialogElement>('dialog[data-dialog-root]')?.open, 2000, 'dialog');
    await t.click('[data-dialog="cancel"]');
    await t.until(() => !t.query<HTMLDialogElement>('dialog[data-dialog-root]')!.open, 2000, 'closed');
    expect(t.emulatorScenario().emulator.prefs.radio).toEqual(before);
  });

  it('send advert puts an advert on the air and starts a 10 s cooldown', async () => {
    const t = await openSettings();
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

  it('time sync button sets a lagging device clock', async () => {
    const clock = new SkippableClock();
    const now = Math.floor(clock.now() / 1000);
    const t = await openSettings({ clock, scenario: { rtcEpochSecs: now - 3600 }, app: { clientOptions: { timeSync: 'never' } } });
    await t.until(() => t.query('[data-field="time-drift"]')!.textContent!.includes('behind'), 3000, 'drift shown');
    await t.click('[data-action="sync-time"]');
    const emu = t.emulatorScenario().emulator;
    await t.until(() => Math.abs(emu.rtcSecs - Math.floor(t.app.clock.now() / 1000)) <= 2, 3000, 'clock set');
    await t.until(() => t.text().includes('Device clock set'), 2000, 'toast');
  });

  it('export private key shows the hex key after confirmation', async () => {
    const t = await openSettings();
    t.query<HTMLDetailsElement>('[data-details="private-key"]')!.open = true;
    expect(t.query('[data-field="private-key"]')).toBeNull();
    await t.click('[data-action="export-key"]');
    await confirmDialog(t);
    await t.until(() => t.query('[data-field="private-key"]'), 3000, 'key shown');
    expect(t.query('[data-field="private-key"]')!.textContent!.trim()).toBe(toHex(t.emulatorScenario().emulator.privateKey));
  });

  it('reboot returns the app to the connect page', async () => {
    const t = await openSettings();
    await t.click('[data-action="reboot"]');
    await confirmDialog(t);
    await t.until(() => t.app.connection.phase.value === 'disconnected', 5000, 'disconnected');
    await t.until(() => location.hash === '#/' && t.query('mc-connect-page'), 3000, 'connect page');
    expect(t.text()).toContain('rebooting');
  });

  it('factory reset needs two confirmations including typing "reset"', async () => {
    const t = await openSettings();
    const emu = t.emulatorScenario().emulator;
    const key = toHex(emu.publicKey);
    await t.click('[data-action="factory-reset"]');
    await confirmDialog(t);
    await t.until(() => t.query('[data-dialog="confirm-text"]'), 2000, 'second step');
    expect(t.query<HTMLButtonElement>('[data-dialog="confirm"]')!.disabled).toBe(true);
    setValue(t, '[data-dialog="confirm-text"]', 'reset');
    await t.until(() => !t.query<HTMLButtonElement>('[data-dialog="confirm"]')!.disabled, 2000, 'enabled');
    await t.click('[data-dialog="confirm"]');
    await t.until(() => t.app.connection.phase.value === 'disconnected', 5000, 'disconnected');
    expect(toHex(emu.publicKey)).not.toBe(key);
  });

  it('theme toggle sets data-theme on the root element', async () => {
    const t = (h = createHarness());
    await t.mount();
    expect(document.documentElement.dataset['theme']).toBe('system');
    location.hash = '#/settings';
    await t.until(() => t.query('[data-section="app"]'), 2000, 'app section');
    const dark = t.query<HTMLInputElement>('input[name="theme"][value="dark"]')!;
    dark.click();
    await t.until(() => document.documentElement.dataset['theme'] === 'dark', 2000, 'dark');
    expect(getComputedStyle(t.el!).colorScheme).toBe('dark');
    t.query<HTMLInputElement>('input[name="theme"][value="light"]')!.click();
    await t.until(() => document.documentElement.dataset['theme'] === 'light', 2000, 'light');
    expect(getComputedStyle(t.el!).colorScheme).toBe('light');
  });
});
