/** Contacts page selection mode: select by hand / all / not heard in a period / farther than a distance, bulk delete. */
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { toHex } from '@meshcore-web/core/util/bytes';
import { contactLastHeard, DISTANCE_PRESETS, STALE_PERIODS } from '@meshcore-web/core/app';
import '../src/mc-app.js';
import '../src/pages/messaging/index.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK_INDEX = String(STALE_PERIODS.findIndex((p) => p.label === '1 week'));
const distIndex = (label: string) => String(DISTANCE_PRESETS.findIndex((p) => p.label === label));

/**
 * Connects, then rewrites each contact's last-heard inputs relative to the harness clock so the
 * staleness of each one is known: Alice (favourite) 400 days, Bob 2 days, Carol 10 days, the
 * repeater 40 days, the sensor never; the room's advert is never heard either, but the scenario's
 * incoming room message ("Welcome to Town Square") counts as hearing from it just now.
 */
async function seeded(): Promise<{ t: Harness; k: Record<'alice' | 'bob' | 'carol' | 'repeater' | 'room' | 'sensor', string> }> {
  const t = (h = createHarness());
  await t.mount();
  await t.connectEmulator('/contacts');
  const s = t.emulatorScenario();
  const k = {
    alice: toHex(s.keys.alice),
    bob: toHex(s.keys.bob),
    carol: toHex(s.keys.carol),
    repeater: toHex(s.keys.repeater),
    room: toHex(s.keys.room),
    sensor: toHex(s.keys.sensor),
  };
  const store = t.app.connection.store.value!;
  const now = t.clock.now();
  const ago = { alice: 400 * DAY, bob: 2 * DAY, carol: 10 * DAY, repeater: 40 * DAY, room: -1, sensor: -1 };
  for (const [name, ms] of Object.entries(ago) as [keyof typeof k, number][]) {
    await store.contacts.updateLocal(k[name], { lastSeen: ms < 0 ? 0 : now - ms, directSnr: undefined, directSnrAt: undefined });
  }
  const m = t.app.contacts;
  await t.until(() => m.view(k.carol)?.lastSeen === now - 10 * DAY && m.view(k.sensor)?.lastSeen === 0, 3000, 'seeded');
  await t.until(() => t.queryAll('[data-contact]').length === 6, 5000, 'contacts listed');
  return { t, k };
}

const selectedKeys = (t: Harness) => t.queryAll<HTMLInputElement>('[data-select]').filter((c) => c.checked).map((c) => c.dataset['select']!);

describe('contacts bulk delete', () => {
  it('enters selection mode, toggles rows instead of opening them, and Esc / Cancel exit', async () => {
    const { t, k } = await seeded();
    expect(t.query('[data-select]')).toBeNull();
    await t.click('[data-action="select-mode"]');
    expect(t.queryAll('[data-select]')).toHaveLength(6);
    expect(t.query('[data-contact] a.row-link')).toBeNull();
    expect(t.query('[data-action="favourite"]')).toBeNull();

    await t.click(`[data-contact="${k.bob}"] label`);
    expect(selectedKeys(t)).toEqual([k.bob]);
    expect(location.hash).toBe('#/contacts');
    expect(t.query('[data-field="selected-count"]')!.textContent).toContain('1 selected');
    expect(t.query<HTMLButtonElement>('[data-action="bulk-delete"]')!.textContent!.trim()).toBe('Delete 1');
    await t.click(`[data-contact="${k.bob}"] label`);
    expect(selectedKeys(t)).toEqual([]);
    expect(t.query<HTMLButtonElement>('[data-action="bulk-delete"]')!.disabled).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await t.until(() => !t.query('[data-field="select-bar"]'), 2000, 'Esc exits');
    expect(t.query('[data-contact] a.row-link')).not.toBeNull();

    await t.click('[data-action="select-mode"]');
    await t.click(`[data-contact="${k.carol}"] label`);
    await t.click('[data-action="select-cancel"]');
    expect(t.query('[data-field="select-bar"]')).toBeNull();
    // re-entering starts from an empty selection
    await t.click('[data-action="select-mode"]');
    expect(selectedKeys(t)).toEqual([]);
  });

  it('shows when each contact was last heard', async () => {
    const { t, k } = await seeded();
    expect(t.query(`[data-contact="${k.sensor}"] [data-field="meta"]`)!.textContent).toContain('never heard');
    expect(t.query(`[data-contact="${k.room}"] [data-field="meta"]`)!.textContent).toContain('heard just now');
    expect(t.query(`[data-contact="${k.bob}"] [data-field="meta"]`)!.textContent).toMatch(/heard \S/);
  });

  it('selects all visible, clears, and selects the visible contacts not heard in a period skipping favourites', async () => {
    const { t, k } = await seeded();
    expect(contactLastHeard(t.app.contacts.view(k.room)!)).toBeGreaterThan(t.clock.now() - DAY);
    await t.click('[data-action="select-mode"]');

    await t.click('[data-action="select-all"]');
    expect(selectedKeys(t).sort()).toEqual(Object.values(k).sort());
    await t.click('[data-action="select-none"]');
    expect(selectedKeys(t)).toEqual([]);

    await t.click(`[data-contact="${k.bob}"] label`);
    await t.fill('[data-field="stale"]', WEEK_INDEX);
    // replaces the selection; Alice is 400 days stale but a favourite
    expect(selectedKeys(t).sort()).toEqual([k.carol, k.repeater, k.sensor].sort());
    expect(t.query('[data-field="select-note"]')!.textContent).toContain('3 not heard in 1 week · 1 favourite skipped');
    expect(t.query<HTMLSelectElement>('[data-field="stale"]')!.value).toBe('');

    // only the visible (filtered) contacts are considered
    await t.fill('[data-field="filter"]', 'chat');
    await t.until(() => t.queryAll('[data-contact]').length === 3, 2000, 'users only');
    expect(t.query('[data-field="selected-count"]')!.textContent).toContain('(2 hidden by filter)');
    await t.fill('[data-field="stale"]', WEEK_INDEX);
    expect(selectedKeys(t)).toEqual([k.carol]);
    expect(t.query('[data-field="selected-count"]')!.textContent).toContain('1 selected');
    await t.click('[data-action="select-all"]');
    expect(t.query('[data-field="selected-count"]')!.textContent).toContain('3 selected');
  });

  it('selects the visible contacts farther than a distance from us, skipping favourites and contacts without a location', async () => {
    // basicScenario: self in Seattle; Alice (favourite) ~0.4 km away, the repeater ~2 km; the rest have no location
    const { t, k } = await seeded();
    await t.click('[data-action="select-mode"]');
    expect(t.query(`[data-contact="${k.repeater}"] [data-field="meta"]`)!.textContent).toMatch(/^2\.\d km away · /);
    expect(t.query(`[data-contact="${k.bob}"] [data-field="meta"]`)!.textContent).not.toContain('away');

    await t.click(`[data-contact="${k.bob}"] label`);
    await t.fill('[data-field="far"]', distIndex('1 km'));
    // replaces the selection
    expect(selectedKeys(t)).toEqual([k.repeater]);
    expect(t.query('[data-field="select-note"]')!.textContent).toContain('1 farther than 1 km · 4 without a location skipped · 1 favourite skipped');
    expect(t.query<HTMLSelectElement>('[data-field="far"]')!.value).toBe('');

    await t.fill('[data-field="far"]', distIndex('5 km'));
    expect(selectedKeys(t)).toEqual([]);
    expect(t.query('[data-field="select-note"]')!.textContent).toContain('0 farther than 5 km');

    // only the visible (filtered) contacts are considered
    await t.fill('[data-field="filter"]', 'chat');
    await t.until(() => t.queryAll('[data-contact]').length === 3, 2000, 'users only');
    await t.fill('[data-field="far"]', distIndex('1 km'));
    expect(selectedKeys(t)).toEqual([]);
  });

  it('disables "Farther than…" when our own location is not set', async () => {
    const { t } = await seeded();
    await t.click('[data-action="select-mode"]');
    expect(t.query<HTMLSelectElement>('[data-field="far"]')!.disabled).toBe(false);
    await t.app.deviceSettings.setLocation(0, 0);
    await t.until(() => t.query<HTMLSelectElement>('[data-field="far"]')!.disabled, 3000, 'disabled without a location');
    expect(t.query('[data-field="far"]')!.getAttribute('title')).toContain('Settings › Identity');
  });

  it('deletes the selection from the list and the radio after confirming', async () => {
    const { t, k } = await seeded();
    const emu = t.emulatorScenario().emulator;
    const s = t.emulatorScenario();
    await t.click('[data-action="select-mode"]');
    await t.fill('[data-field="stale"]', WEEK_INDEX);
    await t.click('[data-action="bulk-delete"]');
    const dialog = t.query<HTMLDialogElement>('#bulk-dialog')!;
    expect(dialog.open).toBe(true);
    expect(t.query('#bulk-h')!.textContent).toContain('Delete 3 contacts?');
    expect(t.query('[data-field="bulk-names"]')!.textContent).toContain('Carol');
    expect(t.query('[data-field="bulk-names"]')!.textContent).toContain('Weather Station');

    await t.click('[data-action="bulk-confirm"]');
    await t.until(() => t.queryAll('[data-contact]').length === 3, 5000, 'three removed');
    await t.until(() => !t.query('[data-field="select-bar"]'), 3000, 'selection mode exits');
    expect(t.queryAll('[data-contact]').map((li) => li.dataset['contact']).sort()).toEqual([k.alice, k.bob, k.room].sort());
    expect(emu.getContact(s.keys.carol)).toBeUndefined();
    expect(emu.getContact(s.keys.repeater)).toBeUndefined();
    expect(emu.getContact(s.keys.sensor)).toBeUndefined();
    expect(emu.getContact(s.keys.bob)).toBeDefined();
    expect(t.text()).toContain('Deleted 3 contacts');
  });

  it('shows progress while deleting and disables the controls', async () => {
    const { t, k } = await seeded();
    const client = t.app.connection.client.value!;
    const real = client.removeContact.bind(client);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    client.removeContact = async (pk) => {
      await gate;
      return real(pk);
    };
    await t.click('[data-action="select-mode"]');
    await t.click(`[data-contact="${k.bob}"] label`);
    await t.click(`[data-contact="${k.carol}"] label`);
    await t.click('[data-action="bulk-delete"]');
    await t.click('[data-action="bulk-confirm"]');
    await t.until(() => t.query('[data-field="selected-count"]')?.textContent?.includes('Deleting 0 / 2…'), 2000, 'progress');
    expect(t.query<HTMLButtonElement>('[data-action="select-all"]')!.disabled).toBe(true);
    expect(t.query<HTMLButtonElement>('[data-action="select-cancel"]')!.disabled).toBe(true);
    expect(t.query<HTMLInputElement>(`[data-select="${k.alice}"]`)!.disabled).toBe(true);
    release();
    await t.until(() => !t.query('[data-field="select-bar"]'), 5000, 'done');
    expect(t.queryAll('[data-contact]')).toHaveLength(4);
  });

  it('fits the selection bar at phone width without horizontal scrolling', async () => {
    const { t } = await seeded();
    await page.viewport(375, 700);
    try {
      await t.click('[data-action="select-mode"]');
      await t.click('[data-action="select-all"]');
      const pageEl = t.query('mc-contacts-page')!;
      const bar = t.query('[data-field="select-bar"]')!;
      await t.until(() => pageEl.getBoundingClientRect().width <= 375, 2000, 'narrow layout');
      expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
      expect(bar.getBoundingClientRect().right).toBeLessThanOrEqual(375);
      // nothing on the page (rows, bar, controls) reaches past the viewport edge
      const past = [...pageEl.shadowRoot!.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > 375.5);
      expect(past.map((el) => el.outerHTML.slice(0, 60))).toEqual([]);
    } finally {
      await page.viewport(1280, 800);
    }
  });

  it('cancelling the confirmation leaves everything untouched', async () => {
    const { t, k } = await seeded();
    const emu = t.emulatorScenario().emulator;
    await t.click('[data-action="select-mode"]');
    await t.click('[data-action="select-all"]');
    await t.click('[data-action="bulk-delete"]');
    expect(t.query('#bulk-h')!.textContent).toContain('Delete 6 contacts?');
    expect(t.query('[data-field="bulk-names"]')!.textContent).toContain('and 1 more');
    await t.click('#bulk-dialog form > .actions > button:not([data-action])');
    await t.until(() => !t.query<HTMLDialogElement>('#bulk-dialog')!.open, 2000, 'dialog closed');
    expect(t.queryAll('[data-contact]')).toHaveLength(6);
    expect(selectedKeys(t)).toHaveLength(6);
    expect(emu.getContact(t.emulatorScenario().keys.bob)).toBeDefined();
    expect(t.app.contacts.view(k.bob)).toBeDefined();
  });
});
