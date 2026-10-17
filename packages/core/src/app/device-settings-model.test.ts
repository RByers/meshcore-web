import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { regionKey } from '../packet/packet.js';
import { toHex } from '../util/bytes.js';
import { AppModel, createEmulatorTransportFactory, type AppModelOptions } from './app-model.js';
import type { BasicScenarioOptions } from '../emulator/scenarios.js';
import { memoryPreferences } from './connection.js';
import {
  DeviceSettingsModel,
  PRIVATE_KEY_SETTING,
  SettingsValidationError,
  autoAddFromConfig,
  autoAddToConfig,
  parsePrivateKeyHex,
  radioParamsToWire,
  validateLocation,
  validateName,
  validatePin,
  type DeviceSettingsTimers,
} from './device-settings-model.js';
import { RADIO_PRESETS, findRadioPreset } from './radio-presets.js';
import { PREF_APPROXIMATE_POSITIONS, PREF_PACKET_RETENTION_DAYS, PREF_PATH_NAMES, PREF_THEME, AppSettingsModel } from './app-settings-model.js';

const apps: AppModel[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
});

/** Hex with spaces removed (layouts written as in docs/companion-protocol.md §4). */
const h = (s: string): string => s.replace(/\s+/g, '');

async function connected(scenario: BasicScenarioOptions = {}, over: AppModelOptions = {}) {
  const emulatorFactory = createEmulatorTransportFactory(scenario);
  const prefs = memoryPreferences();
  const app = new AppModel({
    indexedDB: new IDBFactory(),
    keyRange: IDBKeyRange,
    createEmulatorTransport: emulatorFactory,
    preferences: prefs,
    ...over,
  });
  apps.push(app);
  expect(await app.connection.connect('emulator')).toBe(true);
  await app.connection.capture!.idle();
  const emu = emulatorFactory.scenario().emulator;
  const client = app.connection.client.value!;
  const out: string[] = [];
  client.events.on('frame', (f) => {
    if (f.direction === 'out') out.push(toHex(f.bytes));
  });
  return { app, emu, client, out, prefs, model: app.deviceSettings, scenario: emulatorFactory.scenario() };
}

async function rejectsValidation(p: Promise<unknown>, field: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SettingsValidationError);
  expect((err as SettingsValidationError).field).toBe(field);
}

describe('pure validation and unit conversion', () => {
  it('converts radio params MHz/kHz to wire kHz/Hz (§2.2) and validates SET_RADIO_PARAMS guards (§4 cmd 11)', () => {
    expect(radioParamsToWire({ freqMhz: 869.525, bwKhz: 250, sf: 11, cr: 5 })).toEqual({ freqKhz: 869525, bwHz: 250000, sf: 11, cr: 5 });
    expect(radioParamsToWire({ freqMhz: 910.525, bwKhz: 62.5, sf: 7, cr: 5 })).toEqual({ freqKhz: 910525, bwHz: 62500, sf: 7, cr: 5 });
    expect(radioParamsToWire({ freqMhz: 433, bwKhz: 7.8, sf: 12, cr: 8 }).bwHz).toBe(7800);
    expect(() => radioParamsToWire({ freqMhz: 149.9, bwKhz: 250, sf: 11, cr: 5 })).toThrow(/Frequency/);
    expect(() => radioParamsToWire({ freqMhz: 2500.001, bwKhz: 250, sf: 11, cr: 5 })).toThrow(/Frequency/);
    expect(() => radioParamsToWire({ freqMhz: 869.5, bwKhz: 6.9, sf: 11, cr: 5 })).toThrow(/Bandwidth/);
    expect(() => radioParamsToWire({ freqMhz: 869.5, bwKhz: 501, sf: 11, cr: 5 })).toThrow(/Bandwidth/);
    expect(() => radioParamsToWire({ freqMhz: 869.5, bwKhz: 250, sf: 4, cr: 5 })).toThrow(/Spreading/);
    expect(() => radioParamsToWire({ freqMhz: 869.5, bwKhz: 250, sf: 11.5, cr: 5 })).toThrow(/Spreading/);
    expect(() => radioParamsToWire({ freqMhz: 869.5, bwKhz: 250, sf: 11, cr: 9 })).toThrow(/Coding/);
    expect(() => radioParamsToWire({ freqMhz: Number.NaN, bwKhz: 250, sf: 11, cr: 5 })).toThrow(SettingsValidationError);
  });

  it('presets include the EU and US defaults and are all valid', () => {
    const eu = RADIO_PRESETS.find((p) => p.id === 'eu-long')!;
    expect(eu).toMatchObject({ freqMhz: 869.525, bwKhz: 250, sf: 11, cr: 5 });
    const us = RADIO_PRESETS.find((p) => p.id === 'us')!;
    expect(us).toMatchObject({ freqMhz: 910.525, bwKhz: 62.5, sf: 7, cr: 5 });
    for (const p of RADIO_PRESETS) expect(() => radioParamsToWire(p)).not.toThrow();
    expect(findRadioPreset({ freqMhz: 910.525, bwKhz: 62.5, sf: 7, cr: 5 })?.id).toBe('us');
    expect(findRadioPreset({ freqMhz: 910.5, bwKhz: 62.5, sf: 7, cr: 5 })).toBeUndefined();
    expect(RADIO_PRESETS.filter((p) => p.clientRepeat).map((p) => p.freqMhz)).toEqual([433, 869.495, 918]);
  });

  it('validates names, locations, PINs, keys and auto-add bits', () => {
    expect(validateName('  Base  ')).toBe('Base');
    expect(() => validateName('')).toThrow(SettingsValidationError);
    expect(() => validateName('x'.repeat(32))).toThrow(/31 bytes/);
    expect(() => validateName('é'.repeat(16))).toThrow(/31 bytes/); // 32 bytes UTF-8
    expect(() => validateName('a:b')).toThrow(SettingsValidationError);
    expect(validateLocation(47.1234567, -122.5)).toEqual({ lat: 47.123457, lon: -122.5 });
    expect(() => validateLocation(91, 0)).toThrow(/Latitude/);
    expect(() => validateLocation(0, -180.1)).toThrow(/Longitude/);
    expect(validatePin(0)).toBe(0);
    expect(validatePin(123456)).toBe(123456);
    expect(() => validatePin(12345)).toThrow(SettingsValidationError);
    expect(() => validatePin(1000000)).toThrow(SettingsValidationError);
    expect(() => parsePrivateKeyHex('abcd')).toThrow(/128 hex/);
    expect(parsePrivateKeyHex('ab'.repeat(64)).length).toBe(64);
    // §7.3 bits: overwrite 0x01, chat 0x02, repeater 0x04, room 0x08, sensor 0x10
    expect(autoAddToConfig({ chat: true, repeater: false, room: true, sensor: false, overwriteOldest: true })).toBe(0x0b);
    expect(autoAddFromConfig(0x14, 3)).toMatchObject({ chat: false, repeater: true, room: false, sensor: true, overwriteOldest: false, maxHops: 3 });
  });
});

describe('DeviceSettingsModel against the emulator', () => {
  it('derives views from SELF_INFO in UI units', async () => {
    const { model, emu } = await connected({ radio: { freqKhz: 910525, bwHz: 62500, sf: 7, cr: 5, txPowerDbm: 20, maxTxPowerDbm: 22 } });
    expect(model.radioParams.value).toEqual({ freqMhz: 910.525, bwKhz: 62.5, sf: 7, cr: 5, txPowerDbm: 20 });
    expect(model.txPower.value).toEqual({ dbm: 20, minDbm: -9, maxDbm: 22 });
    expect(model.name.value).toBe(emu.prefs.name);
    expect(model.otherParams.value?.manualAdd).toBe(false);
  });

  it('setName sends SET_ADVERT_NAME and refreshes self info', async () => {
    const { model, emu, out, app } = await connected();
    await model.setName('Base Camp');
    // §4 cmd 8: [0]=0x08, [1..]=name UTF-8
    expect(out).toContain('08' + toHex(new TextEncoder().encode('Base Camp')));
    expect(out).toContain('01' + out.find((f) => f.startsWith('01'))!.slice(2)); // APP_START refresh
    expect(emu.prefs.name).toBe('Base Camp');
    expect(app.connection.selfInfo.value?.name).toBe('Base Camp');
    out.length = 0;
    await rejectsValidation(model.setName(''), 'name');
    await rejectsValidation(model.setName('x'.repeat(40)), 'name');
    expect(out).toEqual([]); // nothing sent
  });

  it('setLocation sends lat/lon × 1e6 (§4 cmd 14) and uses the injected geolocation', async () => {
    const geolocation = vi.fn(() => Promise.resolve({ lat: 51.5, lon: -0.125 }));
    const { model, emu, out } = await connected({}, { geolocation });
    await model.setLocation(47.5, -122.25);
    // 47500000 = 0x02d4cae0, -122250000 = 0xf8b69cf0 (i32 LE)
    expect(out).toContain(h('0e e0cad402 f09cb6f8'));
    expect(emu.prefs.latE6).toBe(47_500_000);
    expect(model.location.value).toEqual({ lat: 47.5, lon: -122.25 });
    expect(model.canGeolocate).toBe(true);
    expect(await model.useCurrentLocation()).toEqual({ lat: 51.5, lon: -0.125 });
    expect(emu.prefs.lonE6).toBe(-125_000);
    await rejectsValidation(model.setLocation(95, 0), 'lat');
  });

  it('setRadioParams applies the EU preset with the exact wire layout and keeps client repeat', async () => {
    const { model, emu, out } = await connected({ radio: { freqKhz: 910525, bwHz: 62500, sf: 7, cr: 5 } });
    const eu = RADIO_PRESETS.find((p) => p.id === 'eu-long')!;
    await model.setRadioParams(eu);
    // §4 cmd 11: freq kHz u32, bw Hz u32, sf, cr, repeat (always sent)
    expect(out).toContain(h('0b 95440d00 90d00300 0b 05 00'));
    expect(emu.prefs.radio).toMatchObject({ freqKhz: 869525, bwHz: 250000, sf: 11, cr: 5, clientRepeat: false });
    expect(model.radioParams.value).toMatchObject({ freqMhz: 869.525, bwKhz: 250, sf: 11, cr: 5 });
    out.length = 0;
    await rejectsValidation(model.setRadioParams({ freqMhz: 100, bwKhz: 250, sf: 11, cr: 5 }), 'freq');
    await rejectsValidation(model.setRadioParams({ freqMhz: 869.525, bwKhz: 250, sf: 13, cr: 5 }), 'sf');
    expect(out).toEqual([]);
  });

  it('client repeat is validated against GET_ALLOWED_REPEAT_FREQ', async () => {
    const { model, emu } = await connected();
    await model.loadAll();
    expect(model.allowedRepeatFreqs.value?.length).toBeGreaterThan(0);
    expect(model.repeatAllowedAt(869.495)).toBe(true);
    await rejectsValidation(model.setRadioParams({ freqMhz: 869.525, bwKhz: 250, sf: 11, cr: 5, clientRepeat: true }), 'freq');
    const off = RADIO_PRESETS.find((p) => p.id === 'offgrid-869')!;
    await model.setRadioParams({ ...off, clientRepeat: true });
    expect(emu.prefs.radio).toMatchObject({ freqKhz: 869495, clientRepeat: true });
  });

  it('setTxPower validates against the device max (§4 cmd 12, signed)', async () => {
    const { model, emu, out } = await connected({ radio: { maxTxPowerDbm: 22, txPowerDbm: 20 } });
    await model.setTxPower(10);
    expect(out).toContain('0c0a');
    await model.setTxPower(-9);
    expect(out).toContain('0cf7');
    expect(emu.prefs.radio.txPowerDbm).toBe(-9);
    expect(model.txPower.value?.dbm).toBe(-9);
    await rejectsValidation(model.setTxPower(23), 'txPower');
    await rejectsValidation(model.setTxPower(-10), 'txPower');
    await rejectsValidation(model.setTxPower(10.5), 'txPower');
  });

  it('setOtherParams / setManualAdd send full SET_OTHER_PARAMS frames (§4 cmd 38)', async () => {
    const { model, emu, out } = await connected();
    await model.setManualAdd(true);
    expect(out.filter((f) => f.startsWith('26'))).toEqual([h('26 01 00 00 00')]);
    expect(emu.prefs.manualAddContacts).toBe(1);
    expect(model.manualAdd.value).toBe(true);
    out.length = 0;
    await model.setOtherParams({ telemetryModes: { base: 2, location: 1, environment: 0 }, advertLocPolicy: 1, multiAcks: 1 });
    // telemetry byte: env<<4 | loc<<2 | base = 0x06
    expect(out.filter((f) => f.startsWith('26'))).toEqual([h('26 01 06 01 01')]);
    expect(model.otherParams.value).toMatchObject({ manualAdd: true, advertLocPolicy: 1, multiAcks: 1, telemetryModes: { base: 2, location: 1, environment: 0 } });
    await rejectsValidation(model.setOtherParams({ telemetryModes: { base: 3, location: 0, environment: 0 } }), 'telemetryBase');
    await rejectsValidation(model.setOtherParams({ advertLocPolicy: 2 }), 'advertLocPolicy');
  });

  it('auto-add config (§4 cmds 58/59)', async () => {
    const { model, emu, out } = await connected();
    await model.setAutoAdd({ chat: true, repeater: true, room: false, sensor: false, overwriteOldest: true, maxHops: 3 });
    expect(out).toContain(h('3a 07 03'));
    expect(emu.prefs.autoAddConfig).toBe(0x07);
    expect(model.autoAdd.value).toMatchObject({ chat: true, repeater: true, overwriteOldest: true, maxHops: 3 });
    await rejectsValidation(model.setAutoAdd({ chat: true, repeater: true, room: false, sensor: false, overwriteOldest: false, maxHops: 65 }), 'maxHops');
  });

  it('tuning params are sent × 1000 (§4 cmd 21) and range checked', async () => {
    const { model, emu, out } = await connected();
    await model.setTuning({ rxDelayBase: 5, airtimeFactor: 1.5 });
    // 5000 = 0x1388, 1500 = 0x05dc
    expect(out).toContain(h('15 88130000 dc050000'));
    expect(emu.prefs.rxDelayBaseMilli).toBe(5000);
    expect(model.tuning.value).toEqual({ rxDelayBase: 5, airtimeFactor: 1.5 });
    await rejectsValidation(model.setTuning({ rxDelayBase: 21, airtimeFactor: 1 }), 'rxDelayBase');
    await rejectsValidation(model.setTuning({ rxDelayBase: 0, airtimeFactor: -1 }), 'airtimeFactor');
  });

  it('syncTime sets a lagging clock and skips when within the threshold', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { model, emu, out } = await connected({ rtcEpochSecs: now - 3600 }, { clientOptions: { timeSync: 'never' } });
    const r = await model.syncTime();
    expect(r.status).toBe('set');
    expect(r.driftSecs).toBeLessThan(-3500);
    expect(out.some((f) => f.startsWith('06'))).toBe(true); // SET_DEVICE_TIME
    expect(Math.abs(emu.rtcSecs - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
    expect(Math.abs(model.deviceTime.value!.driftSecs)).toBeLessThanOrEqual(2);
    out.length = 0;
    const again = await model.syncTime(5);
    expect(again.status).toBe('inSync');
    expect(out.some((f) => f.startsWith('06'))).toBe(false);
    expect(out).toContain('05'); // GET_DEVICE_TIME
  });

  it('syncTime reports a device clock ahead of the host (it cannot go backwards)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { model, out } = await connected({ rtcEpochSecs: now + 3600 }, { clientOptions: { timeSync: 'never' } });
    const r = await model.syncTime();
    expect(r.status).toBe('deviceAhead');
    expect(out.some((f) => f.startsWith('06'))).toBe(false);
  });

  it('sendAdvert transmits flood / zero-hop adverts with a cooldown', async () => {
    let now = 1_000_000;
    const { app, emu, out } = await connected();
    const model = new DeviceSettingsModel(app.connection, { now: () => now, advertCooldownMs: 5000 });
    try {
      await model.sendAdvert('flood');
      expect(out).toContain('0701');
      await vi.waitFor(() => expect(emu.airLog.some((e) => e.type === 'advert' && e.flood)).toBe(true));
      await rejectsValidation(model.sendAdvert('zeroHop'), 'advert');
      expect(model.advertCooldownRemaining()).toBe(5000);
      now += 5000;
      await model.sendAdvert('zeroHop');
      expect(out.filter((f) => f.startsWith('07'))).toEqual(['0701', '0700']);
      await vi.waitFor(() => expect(emu.airLog.some((e) => e.type === 'advert' && !e.flood)).toBe(true));
      expect(model.lastAdvert.value?.mode).toBe('zeroHop');
    } finally {
      model.dispose();
    }
  });

  it('refreshStats reads core / radio / packets; pollStats refreshes periodically until stopped', async () => {
    const { app, out } = await connected();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const fake: DeviceSettingsTimers = {
      setTimeout: (fn, ms) => timers.push({ fn, ms }) - 1,
      clearTimeout: () => undefined,
    };
    const model = new DeviceSettingsModel(app.connection, { timers: fake });
    try {
      const s = await model.refreshStats();
      expect(s?.core?.uptimeSecs).toBeGreaterThanOrEqual(0);
      expect(s?.radio?.noiseFloorDbm).toBeTypeOf('number');
      expect(s?.packets?.sent).toBeTypeOf('number');
      // §4 cmd 56: [1]=stats_type
      expect(out).toEqual(expect.arrayContaining(['3800', '3801', '3802']));
      out.length = 0;
      const stop = model.pollStats(1000);
      expect(timers).toHaveLength(1);
      expect(timers[0]!.ms).toBe(1000);
      timers[0]!.fn();
      await vi.waitFor(() => expect(out.filter((f) => f.startsWith('38'))).toHaveLength(3));
      await vi.waitFor(() => expect(timers).toHaveLength(2)); // rescheduled
      stop();
      timers[1]!.fn(); // a tick racing with stop still runs once…
      await vi.waitFor(() => expect(out.filter((f) => f.startsWith('38'))).toHaveLength(6));
      await new Promise((r) => setTimeout(r, 10));
      expect(timers).toHaveLength(2); // …but does not reschedule
    } finally {
      model.dispose();
    }
  });

  it('custom vars, PIN and default flood scope', async () => {
    const { model, emu, out } = await connected({ customVars: { gps: '0' } });
    await model.loadAll();
    expect(model.customVars.value).toEqual([{ name: 'gps', value: '0' }]);
    await model.setCustomVar('gps', '1');
    expect(out).toContain('29' + toHex(new TextEncoder().encode('gps:1')));
    expect(emu.customVars['gps']).toBe('1');
    expect(model.customVars.value).toEqual([{ name: 'gps', value: '1' }]);
    await rejectsValidation(model.setCustomVar('a,b', '1'), 'varName');

    await model.setPin(123456);
    expect(out).toContain(h('25 40e20100'));
    expect(emu.prefs.blePin).toBe(123456);
    expect(model.pin.value).toBe(123456);
    await rejectsValidation(model.setPin(42), 'pin');

    expect(model.defaultFloodScope.value).toBeNull();
    await model.setDefaultFloodScope('#test-region');
    expect(emu.prefs.defaultScope?.name).toBe('test-region');
    expect(toHex(emu.prefs.defaultScope!.key)).toBe(toHex(await regionKey('test-region')));
    expect(model.defaultFloodScope.value?.name).toBe('test-region');
    await rejectsValidation(model.setDefaultFloodScope('Bad Name'), 'floodScope');
    await model.setDefaultFloodScope(null);
    expect(emu.prefs.defaultScope).toBeNull();
  });

  it('exportPrivateKey returns hex; it is stored only when the app setting allows it', async () => {
    const { app, model, emu } = await connected();
    const store = app.connection.store.value!;
    const hex = await model.exportPrivateKey();
    expect(hex).toBe(toHex(emu.privateKey));
    expect(await store.settings.get(PRIVATE_KEY_SETTING)).toBeUndefined();
    await app.appSettings.setStorePrivateKey(true);
    await model.exportPrivateKey();
    expect(await store.settings.get(PRIVATE_KEY_SETTING)).toBe(hex);
    await app.appSettings.setStorePrivateKey(false);
    expect(await store.settings.get(PRIVATE_KEY_SETTING)).toBeUndefined();
    await rejectsValidation(model.importPrivateKey('nothex'), 'privateKey');
  });

  it('reboot leads to the disconnected phase without an error', async () => {
    const { app, model } = await connected();
    const disc = new Promise<{ error?: Error }>((r) => app.connection.events.on('disconnected', r));
    await model.reboot();
    expect(await disc).toEqual({});
    await vi.waitFor(() => expect(app.connection.phase.value).toBe('disconnected'));
    expect(app.connection.error.value).toBeNull();
    expect(app.notifications.toasts.value.some((t) => t.kind === 'info' && /rebooting/i.test(t.message))).toBe(true);
    expect(app.notifications.toasts.value.some((t) => t.kind === 'error')).toBe(false);
  });

  it('factoryReset needs the literal confirmation and wipes the device', async () => {
    const { app, model, emu, out } = await connected();
    await model.setName('Keep Me');
    await rejectsValidation(model.factoryReset('yes'), 'factoryReset');
    expect(out.some((f) => f.startsWith('33'))).toBe(false);
    await model.factoryReset('reset');
    expect(out).toContain('33' + toHex(new TextEncoder().encode('reset')));
    await vi.waitFor(() => expect(app.connection.phase.value).toBe('disconnected'));
    expect(emu.prefs.name).not.toBe('Keep Me');
  });

  it('actions reject while disconnected', async () => {
    const { app, model } = await connected();
    await app.connection.disconnect();
    await expect(model.setName('X')).rejects.toThrow(/Not connected/);
    expect(model.stats.value).toBeNull();
  });
});

describe('AppSettingsModel', () => {
  it('persists theme / time format and applies packet retention', async () => {
    const { app, prefs } = await connected();
    const s = app.appSettings;
    expect(s.theme.value).toBe('system');
    s.setTheme('dark');
    expect(prefs.getItem(PREF_THEME)).toBe('dark');
    s.setTimeFormat('24h');
    expect(s.formatTime(Date.UTC(2026, 0, 1, 15, 4))).toMatch(/\d{2}:04/);
    expect(s.storePrivateKey.value).toBe(false);
    expect(s.pathNames.value).toBe(false);
    s.setPathNames(true);
    expect(prefs.getItem(PREF_PATH_NAMES)).toBe('true');
    expect(s.approximatePositions.value).toBe(false);
    s.setApproximatePositions(true);
    expect(prefs.getItem(PREF_APPROXIMATE_POSITIONS)).toBe('true');

    const store = app.connection.store.value!;
    const old = Date.now() - 40 * 86_400_000;
    await store.packets.append({ ts: old, direction: 'rx', bytes: Uint8Array.of(0x11, 0x00, 1, 2, 3, 4) });
    await store.packets.append({ ts: Date.now(), direction: 'rx', bytes: Uint8Array.of(0x11, 0x00, 1, 2, 3, 4) });
    const before = (await store.packets.query({ limit: 1000 })).items.length;
    expect(await s.setPacketRetentionDays(30)).toBeGreaterThanOrEqual(1);
    expect((await store.packets.query({ limit: 1000 })).items.length).toBe(before - 1);
    expect(prefs.getItem(PREF_PACKET_RETENTION_DAYS)).toBe('30');
    await expect(s.setPacketRetentionDays(0)).rejects.toThrow(RangeError);

    // a fresh model reads the stored preferences
    const again = new AppSettingsModel(prefs, app.connection);
    expect(again.theme.value).toBe('dark');
    expect(again.timeFormat.value).toBe('24h');
    expect(again.packetRetentionDays.value).toBe(30);
    expect(again.pathNames.value).toBe(true);
    expect(again.approximatePositions.value).toBe(true);
    again.dispose();
  });
});
