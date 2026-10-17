import { afterEach, describe, expect, it } from 'vitest';
import { radioDbName } from '@meshcore-web/core/store';
import '../src/mc-app.js';
import { createHarness, type Harness } from '../src/testing/harness.js';
import { formatBytes } from '../src/format.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const row = (_t: Harness, key: string): string => `li.device[data-pubkey="${key}"]`;
const removeBtn = (t: Harness, key: string): string => `${row(t, key)} [data-action="remove-device"]`;

function packetCount(t: Harness, key: string): number | null {
  const text = t.query(`${row(t, key)} [data-field="packet-count"]`)?.textContent;
  return text == null ? null : Number(text.replace(/\D/g, ''));
}

async function dbNames(t: Harness): Promise<Array<string | undefined>> {
  return (await t.indexedDB.databases()).map((d) => d.name);
}

/** Connects the emulator once, disconnects, and returns its pubkey with the connect page showing it. */
async function knownRadio(t: Harness): Promise<string> {
  await t.mount();
  await t.connectEmulator('/');
  const key = t.app.connection.pubKey.value!;
  await t.click('[data-action="disconnect-current"]');
  await t.until(() => t.app.connection.phase.value === 'disconnected', 3000, 'disconnected');
  await t.until(() => packetCount(t, key) !== null && !t.app.storage.loading.value, 5000, 'known radio with stats');
  return key;
}

describe('connect page: stored data per radio', () => {
  it('shows each known radio’s packet count and approximate size, and the total', async () => {
    const t = (h = createHarness());
    await t.mount();
    await t.connectEmulator('/');
    const key = t.app.connection.pubKey.value!;
    // listed under the current connection too, without Reconnect
    await t.until(() => packetCount(t, key) !== null, 5000, 'packet count while connected');
    expect(t.query(row(t, key))!.hasAttribute('data-current')).toBe(true);
    expect(t.queryAll('[data-reconnect]')).toEqual([]);

    const store = t.app.connection.store.value!;
    await store.packets.append({ direction: 'rx', bytes: new Uint8Array(40), ts: t.clock.now() });
    const stored = await store.packets.count();
    await t.click('[data-action="refresh-storage"]');
    await t.until(() => packetCount(t, key) === stored, 5000, 'recounted packets');
    const bytes = t.app.storage.byDevice.value[key]!.stats!.approxBytes;
    expect(t.query(`${row(t, key)} [data-field="db-size"]`)!.textContent).toBe(`≈ ${formatBytes(bytes)}`);
    expect(t.query('[data-field="storage-total"]')!.textContent).toContain(`≈ ${formatBytes(bytes)} stored`);
  });

  it('removes a radio and its database on the second click only', async () => {
    const t = (h = createHarness());
    const key = await knownRadio(t);
    expect(await dbNames(t)).toContain(radioDbName(key));

    await t.click(removeBtn(t, key));
    const btn = t.query(removeBtn(t, key))!;
    expect(btn.hasAttribute('data-armed')).toBe(true);
    expect(btn.textContent).toContain('Confirm remove');
    expect(t.app.devices.value.map((d) => d.pubKey)).toContain(key);

    await t.click(removeBtn(t, key));
    await t.until(() => t.query(row(t, key)) === null, 5000, 'row removed');
    expect(t.app.devices.value).toEqual([]);
    expect(await dbNames(t)).not.toContain(radioDbName(key));
    expect(t.app.storage.byDevice.value[key]).toBeUndefined();
  });

  it('removes the connected radio: disconnects, then deletes its database', async () => {
    const t = (h = createHarness());
    await t.mount();
    await t.connectEmulator('/');
    const key = t.app.connection.pubKey.value!;
    await t.click(removeBtn(t, key));
    await t.click(removeBtn(t, key));
    await t.until(() => t.app.devices.value.length === 0, 5000, 'radio forgotten');
    expect(t.app.connection.connected.value).toBe(false);
    expect(await dbNames(t)).not.toContain(radioDbName(key));
    await t.until(() => t.query('[data-connect="emulator"]') && !t.query(row(t, key)), 3000, 'connect options, no row');
  });

  it('clicking elsewhere, or another row’s Remove, disarms without removing', async () => {
    const t = (h = createHarness());
    const key = await knownRadio(t);
    // a second known radio (record only)
    const other = 'ab'.repeat(32);
    const repo = (await t.app.devicesRepo())!;
    await repo.recordConnection({ pubKey: other, name: 'Other', transport: 'serial' });
    await t.app.refreshDevices();
    await t.until(() => t.query(removeBtn(t, other)), 3000, 'second row');

    await t.click(removeBtn(t, key));
    expect(t.query(removeBtn(t, key))!.hasAttribute('data-armed')).toBe(true);
    // a click elsewhere on the page disarms
    await t.click('h2');
    expect(t.query(removeBtn(t, key))!.hasAttribute('data-armed')).toBe(false);

    // arming one row, then the other row's Remove: arms the other, the first is not removed
    await t.click(removeBtn(t, key));
    await t.click(removeBtn(t, other));
    expect(t.query(removeBtn(t, key))!.hasAttribute('data-armed')).toBe(false);
    expect(t.query(removeBtn(t, other))!.hasAttribute('data-armed')).toBe(true);
    expect(t.app.devices.value.map((d) => d.pubKey).sort()).toEqual([key, other].sort());
    expect(await dbNames(t)).toContain(radioDbName(key));

    // the first row's next click only re-arms it
    await t.click(removeBtn(t, key));
    expect(t.query(removeBtn(t, key))!.hasAttribute('data-armed')).toBe(true);
    expect(t.app.devices.value).toHaveLength(2);
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
