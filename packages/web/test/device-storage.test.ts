import { afterEach, describe, expect, it } from 'vitest';
import '../src/mc-app.js';
import { createHarness, type Harness } from '../src/testing/harness.js';
import { formatBytes } from '../src/format.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

function packetCount(t: Harness, key: string): number | null {
  const text = t.query(`.storage li[data-device="${key}"] [data-field="packet-count"]`)?.textContent;
  return text == null ? null : Number(text.replace(/\D/g, ''));
}

describe('device page: stored data', () => {
  it('lists the connected radio with its stored packet count and approximate size', async () => {
    const t = (h = createHarness());
    await t.mount();
    await t.connectEmulator('/device');
    const key = t.app.connection.pubKey.value!;
    await t.until(() => packetCount(t, key) !== null, 5000, 'packet count');
    const row = t.query(`.storage li[data-device="${key}"]`)!;
    expect(row.classList.contains('current')).toBe(true);
    expect(row.textContent).toContain('Emulator');
    expect(t.query(`.storage li[data-device="${key}"] [data-field="db-size"]`)!.textContent).toMatch(/≈ \d/);

    // more packets show up after Refresh
    const store = t.app.connection.store.value!;
    await store.packets.append({ direction: 'rx', bytes: new Uint8Array(40), ts: t.clock.now() });
    const stored = await store.packets.count();
    await t.click('[data-action="refresh-storage"]');
    await t.until(() => packetCount(t, key) === stored, 5000, 'refreshed packet count');
  });

  it('still lists known radios when disconnected', async () => {
    const t = (h = createHarness());
    await t.mount();
    await t.connectEmulator('/device');
    const key = t.app.connection.pubKey.value!;
    await t.click('[data-action="disconnect"]');
    // the app routes away from /device while disconnected; render the page element directly
    await t.until(() => location.hash === '#/' && t.query('mc-connect-page'), 3000, 'connect page');
    const page = document.createElement('mc-device-page');
    page.app = t.app;
    document.body.append(page);
    try {
      const row = (): Element | null | undefined => page.shadowRoot?.querySelector(`.storage li[data-device="${key}"]`);
      await t.until(() => row()?.querySelector('[data-field="packet-count"]'), 5000, 'packet count while disconnected');
      expect(page.shadowRoot!.textContent).toContain('No radio connected');
      expect(row()!.classList.contains('current')).toBe(false);
    } finally {
      page.remove();
    }
  });
});

describe('formatBytes', () => {
  it('uses B / KB / MB with one decimal below 10', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1.3 MB');
    expect(formatBytes(42 * 1024 * 1024)).toBe('42 MB');
  });
});
