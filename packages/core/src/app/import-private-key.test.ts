/** DeviceSettingsModel.importPrivateKey success path (the reject path is in device-settings-model.test.ts). */

import { describe, expect, it } from 'vitest';
import { bytesEqual, toHex } from '../util/bytes.js';
import { scenarioIdentity } from '../emulator/scenarios.js';
import { testApp } from './testing.js';

describe('DeviceSettingsModel.importPrivateKey', () => {
  it('replaces the identity on the radio, then disconnects cleanly; reconnecting opens the new identity', async () => {
    const { app, emulator } = testApp();
    expect(await app.connection.connect('emulator')).toBe(true);
    await app.connection.capture!.idle();
    const emu = emulator.scenario().emulator;
    const oldPub = toHex(emu.publicKey);
    const next = scenarioIdentity('imported');
    expect(next.privateKey).toHaveLength(64);

    const out: string[] = [];
    app.connection.client.value!.events.on('frame', (f) => {
      if (f.direction === 'out') out.push(toHex(f.bytes));
    });
    const disc = new Promise<{ error?: Error }>((r) => app.connection.events.on('disconnected', r));
    // mixed case and surrounding whitespace are accepted
    await app.deviceSettings.importPrivateKey(`  ${toHex(next.privateKey).toUpperCase()} `);

    // CMD_IMPORT_PRIVATE_KEY (0x18) + 64-byte expanded key (companion-protocol.md §4)
    expect(out).toContain('18' + toHex(next.privateKey));
    expect(bytesEqual(emu.privateKey, next.privateKey)).toBe(true);
    expect(bytesEqual(emu.publicKey, next.publicKey)).toBe(true);
    expect(await disc).toEqual({});
    expect(app.connection.phase.value).toBe('disconnected');
    expect(app.connection.error.value).toBeNull();
    expect(app.connection.store.value).toBeNull();
    expect(app.notifications.toasts.value.filter((t) => t.kind === 'error')).toEqual([]);

    expect(await app.connection.connect('emulator')).toBe(true);
    expect(app.connection.pubKey.value).toBe(toHex(next.publicKey));
    expect(app.connection.pubKey.value).not.toBe(oldPub);
  });
});
