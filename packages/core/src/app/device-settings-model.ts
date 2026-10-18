/**
 * Device settings of the connected radio (Phase 11): read-only views derived from SELF_INFO /
 * DEVICE_INFO plus values fetched on demand (tuning, custom vars, auto-add, stats, device time…),
 * and validated actions that convert UI units (MHz, kHz, degrees, hex) to the wire units of
 * docs/companion-protocol.md and refresh SELF_INFO afterwards.
 *
 * Unit conventions (§2.2): SELF_INFO carries freq in kHz and bandwidth in Hz; the model exposes
 * MHz / kHz. TX power is a signed dBm in -9..MAX_LORA_TX_POWER (§4 cmd 12).
 *
 * Actions throw {@link SettingsValidationError} for bad input (nothing is sent) and pass device
 * errors (`DeviceError`) through; the UI reports both.
 */

import type { CompanionClient } from '../client/companion-client.js';
import { DeviceError } from '../client/errors.js';
import type { OtherParams } from '../client/types.js';
import { AutoAddFlag, MANUAL_ADD_CONTACTS_BIT, type TelemetryModes } from '../protocol/constants.js';
import type { BattAndStorage, CustomVar, DeviceInfo, RepeatFreqRange, SelfInfo, Stats } from '../protocol/types.js';
import { regionKey } from '../packet/packet.js';
import { fromHex, toHex, utf8Encode } from '../util/bytes.js';
import type { Clock } from '../util/clock.js';
import type { ConnectionModel } from './connection.js';
import { batch, computed, effect, signal, type ReadonlySignal } from './signal.js';
import { normalizeRegionName, validateRegionName } from './regions-model.js';

export interface RadioParamsView {
  freqMhz: number;
  bwKhz: number;
  sf: number;
  cr: number;
  txPowerDbm: number;
}

export interface RadioParamsInput {
  freqMhz: number;
  bwKhz: number;
  sf: number;
  cr: number;
  /** Client repeat (fw v9+). Default: keep the device's current setting (DEVICE_INFO[80]). */
  clientRepeat?: boolean;
}

/** SET_RADIO_PARAMS guard (§4 cmd 11): 150000 ≤ kHz ≤ 2500000, 7000 ≤ Hz ≤ 500000, SF 5..12, CR 5..8. */
export const RADIO_LIMITS = {
  freqMhz: { min: 150, max: 2500 },
  bwKhz: { min: 7, max: 500 },
  sf: { min: 5, max: 12 },
  cr: { min: 5, max: 8 },
  /** §2.2 / §4 cmd 12: tx power -9..MAX_LORA_TX_POWER. */
  txPowerMinDbm: -9,
} as const;

/** `MyMesh::begin` sanitising (MyMesh.cpp L985-988): rx_delay_base 0..20, airtime_factor 0..9. */
export const TUNING_LIMITS = { rxDelayBase: { min: 0, max: 20 }, airtimeFactor: { min: 0, max: 9 } } as const;

/** Node name: SET_ADVERT_NAME truncates to 31 bytes (§4 cmd 8); the CLI rejects these chars. */
export const MAX_NAME_BYTES = 31;
const BAD_NAME_CHARS = /[[\]\\:,?*]/;

export class SettingsValidationError extends Error {
  override readonly name = 'SettingsValidationError';
  constructor(
    /** The offending field (matches the input names used by the UI). */
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(field: string, message: string): never {
  throw new SettingsValidationError(field, message);
}

function requireFinite(field: string, v: number, label: string): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(field, `${label} must be a number`);
}

function requireIntRange(field: string, v: number, min: number, max: number, label: string): void {
  requireFinite(field, v, label);
  if (!Number.isInteger(v) || v < min || v > max) fail(field, `${label} must be a whole number from ${min} to ${max}`);
}

/** Validates a node name; returns it trimmed. */
export function validateName(name: string): string {
  const n = name.trim();
  if (!n) fail('name', 'Name must not be empty');
  if (utf8Encode(n).length > MAX_NAME_BYTES) fail('name', `Name must be at most ${MAX_NAME_BYTES} bytes`);
  if (BAD_NAME_CHARS.test(n)) fail('name', 'Name must not contain [ ] \\ : , ? *');
  return n;
}

/** Validates degrees (§4 cmd 14: |lat| ≤ 90, |lon| ≤ 180). */
export function validateLocation(lat: number, lon: number): { lat: number; lon: number } {
  requireFinite('lat', lat, 'Latitude');
  requireFinite('lon', lon, 'Longitude');
  if (Math.abs(lat) > 90) fail('lat', 'Latitude must be between -90 and 90');
  if (Math.abs(lon) > 180) fail('lon', 'Longitude must be between -180 and 180');
  // the wire carries micro-degrees
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

/** Validates radio params and converts them to wire units (kHz / Hz). */
export function radioParamsToWire(p: RadioParamsInput): { freqKhz: number; bwHz: number; sf: number; cr: number } {
  requireFinite('freq', p.freqMhz, 'Frequency');
  const freqKhz = Math.round(p.freqMhz * 1000);
  if (freqKhz < RADIO_LIMITS.freqMhz.min * 1000 || freqKhz > RADIO_LIMITS.freqMhz.max * 1000) {
    fail('freq', `Frequency must be between ${RADIO_LIMITS.freqMhz.min} and ${RADIO_LIMITS.freqMhz.max} MHz`);
  }
  requireFinite('bw', p.bwKhz, 'Bandwidth');
  const bwHz = Math.round(p.bwKhz * 1000);
  if (bwHz < RADIO_LIMITS.bwKhz.min * 1000 || bwHz > RADIO_LIMITS.bwKhz.max * 1000) {
    fail('bw', `Bandwidth must be between ${RADIO_LIMITS.bwKhz.min} and ${RADIO_LIMITS.bwKhz.max} kHz`);
  }
  requireIntRange('sf', p.sf, RADIO_LIMITS.sf.min, RADIO_LIMITS.sf.max, 'Spreading factor');
  requireIntRange('cr', p.cr, RADIO_LIMITS.cr.min, RADIO_LIMITS.cr.max, 'Coding rate');
  return { freqKhz, bwHz, sf: p.sf, cr: p.cr };
}

/** Wire SELF_INFO radio fields → UI units. */
export function radioParamsFromSelfInfo(si: SelfInfo): RadioParamsView {
  return { freqMhz: si.radioFreqKhz / 1000, bwKhz: si.radioBwHz / 1000, sf: si.radioSf, cr: si.radioCr, txPowerDbm: si.txPowerDbm };
}

/** SET_DEVICE_PIN (§4 cmd 37): 0 (default / none) or 6 digits 100000..999999. */
export function validatePin(pin: number): number {
  requireFinite('pin', pin, 'PIN');
  if (!(pin === 0 || (Number.isInteger(pin) && pin >= 100000 && pin <= 999999))) fail('pin', 'PIN must be 0 or a 6-digit number (100000-999999)');
  return pin;
}

/** SET_CUSTOM_VAR sends ASCII "name:value" (§4 cmd 41); GET returns "name:value,…". */
export function validateCustomVar(name: string, value: string): { name: string; value: string } {
  const n = name.trim();
  if (!n) fail('varName', 'Name must not be empty');
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x20-\x7e]*$/;
  if (!ascii.test(n) || /[:,]/.test(n)) fail('varName', 'Name must be printable ASCII without ":" or ","');
  if (!ascii.test(value) || value.includes(',')) fail('varValue', 'Value must be printable ASCII without ","');
  if (n.length + 1 + value.length < 3) fail('varValue', 'Value must not be empty');
  return { name: n, value };
}

/** 64-byte expanded Ed25519 private key as 128 hex chars (§9). */
export function parsePrivateKeyHex(hex: string): Uint8Array {
  const h = hex.replace(/\s+/g, '').toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(h)) fail('privateKey', 'Private key must be 128 hex characters (64 bytes)');
  return fromHex(h);
}

export interface OtherParamsView {
  manualAdd: boolean;
  /** Raw SELF_INFO[47] byte (other bits preserved when toggling manual add). */
  manualAddRaw: number;
  telemetryModes: TelemetryModes;
  advertLocPolicy: number;
  multiAcks: number;
}

export interface OtherParamsInput {
  manualAdd?: boolean;
  /** Each mode: 0 deny, 1 per-contact flags, 2 allow all (§2.2 SELF_INFO[46]). */
  telemetryModes?: TelemetryModes;
  /** 0 none, 1 share. */
  advertLocPolicy?: number;
  /** Extra ACK transmissions (v7+). */
  multiAcks?: number;
}

export interface AutoAddView {
  /** Raw SET_AUTOADD_CONFIG bits. */
  config: number;
  maxHops: number;
  chat: boolean;
  repeater: boolean;
  room: boolean;
  sensor: boolean;
  overwriteOldest: boolean;
}

export interface AutoAddInput {
  chat: boolean;
  repeater: boolean;
  room: boolean;
  sensor: boolean;
  overwriteOldest: boolean;
  /** 0..64 (firmware clamps to 64). */
  maxHops?: number;
}

export function autoAddFromConfig(config: number, maxHops: number): AutoAddView {
  return {
    config,
    maxHops,
    chat: (config & AutoAddFlag.CHAT) !== 0,
    repeater: (config & AutoAddFlag.REPEATER) !== 0,
    room: (config & AutoAddFlag.ROOM) !== 0,
    sensor: (config & AutoAddFlag.SENSOR) !== 0,
    overwriteOldest: (config & AutoAddFlag.OVERWRITE_OLDEST) !== 0,
  };
}

export function autoAddToConfig(a: Omit<AutoAddInput, 'maxHops'>): number {
  return (
    (a.overwriteOldest ? AutoAddFlag.OVERWRITE_OLDEST : 0) |
    (a.chat ? AutoAddFlag.CHAT : 0) |
    (a.repeater ? AutoAddFlag.REPEATER : 0) |
    (a.room ? AutoAddFlag.ROOM : 0) |
    (a.sensor ? AutoAddFlag.SENSOR : 0)
  );
}

export interface TuningView {
  rxDelayBase: number;
  airtimeFactor: number;
}

export interface StatsView {
  core: Extract<Stats, { type: 'core' }> | null;
  radio: Extract<Stats, { type: 'radio' }> | null;
  packets: Extract<Stats, { type: 'packets' }> | null;
  /** Host epoch ms of the refresh. */
  at: number;
}

export interface DeviceTimeView {
  deviceSecs: number;
  hostSecs: number;
  /** device − host (positive: the device is ahead). */
  driftSecs: number;
  /** Host epoch ms of the reading. */
  at: number;
}

export type TimeSyncResult =
  | { status: 'inSync'; driftSecs: number }
  | { status: 'set'; driftSecs: number }
  /** The device clock is ahead: SET_DEVICE_TIME refuses to go backwards (§4 cmd 6). */
  | { status: 'deviceAhead'; driftSecs: number };

export interface FloodScopeView {
  name: string;
  keyHex: string;
}

/** Current geographic position in degrees (the browser passes navigator.geolocation). */
export type GeolocationProvider = () => Promise<{ lat: number; lon: number }>;

export interface DeviceSettingsDeps {
  geolocation?: GeolocationProvider;
  /** Whether an exported private key is also saved to the radio's store (app setting). */
  storePrivateKey?: () => boolean;
  /** Minimum time between self adverts sent from the UI. Default 10 s. */
  advertCooldownMs?: number;
  /** Host time + timers for cooldowns, stats polling and timestamps. Default: the connection's clock. */
  clock?: Clock;
}

export type SettingsAction =
  | 'name'
  | 'location'
  | 'radio'
  | 'txPower'
  | 'otherParams'
  | 'tuning'
  | 'time'
  | 'advert'
  | 'battery'
  | 'stats'
  | 'customVar'
  | 'autoAdd'
  | 'pin'
  | 'floodScope'
  | 'privateKey'
  | 'reboot'
  | 'factoryReset'
  | 'load';

/** Settings key under which an exported private key is kept (only with the app setting on). */
export const PRIVATE_KEY_SETTING = 'device.privateKeyHex';

export const DEFAULT_TIME_SYNC_THRESHOLD_SECS = 2;

export class DeviceSettingsModel {
  readonly #deps: DeviceSettingsDeps;
  readonly #clock: Clock;

  readonly #busy = signal<ReadonlySet<SettingsAction>>(new Set());
  readonly #stats = signal<StatsView | null>(null);
  readonly #time = signal<DeviceTimeView | null>(null);
  readonly #tuning = signal<TuningView | null>(null);
  readonly #customVars = signal<readonly CustomVar[] | null>(null);
  readonly #autoAdd = signal<AutoAddView | null>(null);
  readonly #repeatFreqs = signal<readonly RepeatFreqRange[] | null>(null);
  readonly #floodScope = signal<FloodScopeView | null | undefined>(undefined);
  readonly #pin = signal<number | null>(null);
  readonly #advertCooldownUntil = signal(0);
  readonly #lastAdvert = signal<{ mode: 'flood' | 'zeroHop'; at: number } | null>(null);

  /** Actions in progress (saving indicators). */
  readonly busy: ReadonlySignal<ReadonlySet<SettingsAction>> = this.#busy.readonly;
  readonly stats: ReadonlySignal<StatsView | null> = this.#stats.readonly;
  readonly deviceTime: ReadonlySignal<DeviceTimeView | null> = this.#time.readonly;
  readonly tuning: ReadonlySignal<TuningView | null> = this.#tuning.readonly;
  /** null until loaded (or unsupported). */
  readonly customVars: ReadonlySignal<readonly CustomVar[] | null> = this.#customVars.readonly;
  readonly autoAdd: ReadonlySignal<AutoAddView | null> = this.#autoAdd.readonly;
  /** Frequencies where client repeat is allowed (GET_ALLOWED_REPEAT_FREQ). */
  readonly allowedRepeatFreqs: ReadonlySignal<readonly RepeatFreqRange[] | null> = this.#repeatFreqs.readonly;
  /** undefined = not loaded / unsupported, null = none set. */
  readonly defaultFloodScope: ReadonlySignal<FloodScopeView | null | undefined> = this.#floodScope.readonly;
  /** BLE PIN (DEVICE_INFO[4..7], updated after setPin; takes effect on reboot). */
  readonly pin: ReadonlySignal<number | null> = this.#pin.readonly;
  /** Host epoch ms until which sendAdvert is refused. */
  readonly advertCooldownUntil: ReadonlySignal<number> = this.#advertCooldownUntil.readonly;
  readonly lastAdvert: ReadonlySignal<{ mode: 'flood' | 'zeroHop'; at: number } | null> = this.#lastAdvert.readonly;

  readonly selfInfo: ReadonlySignal<SelfInfo | null>;
  readonly deviceInfo: ReadonlySignal<DeviceInfo | null>;
  readonly battery: ReadonlySignal<BattAndStorage | null>;
  readonly radioParams: ReadonlySignal<RadioParamsView | null>;
  readonly name: ReadonlySignal<string | null>;
  /** Degrees; null when disconnected. lat = lon = 0 means "not set". */
  readonly location: ReadonlySignal<{ lat: number; lon: number } | null>;
  readonly txPower: ReadonlySignal<{ dbm: number; minDbm: number; maxDbm: number } | null>;
  readonly otherParams: ReadonlySignal<OtherParamsView | null>;
  readonly manualAdd: ReadonlySignal<boolean | null>;
  /** DEVICE_INFO[80] (fw v9+); undefined when the firmware does not report it. */
  readonly clientRepeat: ReadonlySignal<boolean | undefined>;
  readonly firmwareVerCode: ReadonlySignal<number | null>;
  readonly canGeolocate: boolean;

  #offs: Array<() => void> = [];
  #pollTimer: unknown;
  #pollers = 0;
  #cooldownTimer: unknown;

  constructor(
    private readonly connection: ConnectionModel,
    deps: DeviceSettingsDeps = {},
  ) {
    this.#deps = deps;
    this.#clock = deps.clock ?? connection.clock;
    this.canGeolocate = deps.geolocation !== undefined;
    this.selfInfo = computed(() => this.connection.selfInfo.value);
    this.deviceInfo = computed(() => this.connection.deviceInfo.value);
    this.battery = computed(() => this.connection.battery.value);
    this.radioParams = computed((): RadioParamsView | null => {
      const si = this.connection.selfInfo.value;
      return si ? radioParamsFromSelfInfo(si) : null;
    });
    this.name = computed(() => this.connection.selfInfo.value?.name ?? null);
    this.location = computed(() => {
      const si = this.connection.selfInfo.value;
      return si ? { lat: si.lat, lon: si.lon } : null;
    });
    this.txPower = computed(() => {
      const si = this.connection.selfInfo.value;
      return si ? { dbm: si.txPowerDbm, minDbm: RADIO_LIMITS.txPowerMinDbm, maxDbm: si.maxTxPowerDbm } : null;
    });
    this.otherParams = computed((): OtherParamsView | null => {
      const si = this.connection.selfInfo.value;
      if (!si) return null;
      return {
        manualAdd: (si.manualAddContacts & MANUAL_ADD_CONTACTS_BIT) !== 0,
        manualAddRaw: si.manualAddContacts,
        telemetryModes: si.telemetryModes,
        advertLocPolicy: si.advertLocPolicy,
        multiAcks: si.multiAcks,
      };
    });
    this.manualAdd = computed(() => this.otherParams.value?.manualAdd ?? null);
    this.clientRepeat = computed(() => this.connection.deviceInfo.value?.clientRepeat);
    this.firmwareVerCode = computed(() => this.connection.deviceInfo.value?.firmwareVerCode ?? null);

    // per-connection state is cleared when the client goes away
    let lastClient: CompanionClient | null = null;
    this.#offs.push(
      effect(() => {
        const client = this.connection.client.value;
        if (client === lastClient) return;
        lastClient = client;
        batch(() => {
          this.#stats.value = null;
          this.#time.value = null;
          this.#tuning.value = null;
          this.#customVars.value = null;
          this.#autoAdd.value = null;
          this.#repeatFreqs.value = null;
          this.#floodScope.value = undefined;
          this.#pin.value = this.connection.deviceInfo.peek()?.blePin ?? null;
          this.#lastAdvert.value = null;
        });
      }),
    );
  }

  #now(): number {
    return this.#clock.now();
  }

  #client(): CompanionClient {
    const c = this.connection.client.peek();
    if (!c?.connected) throw new Error('Not connected');
    return c;
  }

  async #run<T>(action: SettingsAction, fn: (client: CompanionClient) => Promise<T>): Promise<T> {
    const client = this.#client();
    this.#busy.value = new Set([...this.#busy.peek(), action]);
    try {
      return await fn(client);
    } finally {
      const next = new Set(this.#busy.peek());
      next.delete(action);
      this.#busy.value = next;
    }
  }

  isBusy(action: SettingsAction): boolean {
    return this.#busy.value.has(action);
  }

  /** Re-reads SELF_INFO (connection.selfInfo follows) and battery. */
  async refresh(): Promise<void> {
    await this.connection.client.peek()?.refreshSelfInfo();
    await this.connection.refreshBattery();
  }

  async #refreshSelf(client: CompanionClient): Promise<void> {
    // optimistic values were already applied by the client; confirm with the device
    await client.refreshSelfInfo().catch(() => undefined);
  }

  /**
   * Loads everything not in SELF_INFO. Each read tolerates old firmware (ERR / DISABLED leaves
   * the view null / undefined).
   */
  async loadAll(): Promise<void> {
    await this.#run('load', async (client) => {
      const soft = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof DeviceError) return undefined;
          throw err;
        }
      };
      const tuning = await soft(() => client.getTuningParams());
      if (tuning) this.#tuning.value = tuning;
      const vars = await soft(() => client.getCustomVars());
      if (vars) this.#customVars.value = vars;
      const aa = await soft(() => client.getAutoAddConfig());
      if (aa) this.#autoAdd.value = autoAddFromConfig(aa.config, aa.maxHops);
      const freqs = await soft(() => client.getAllowedRepeatFreq());
      if (freqs) this.#repeatFreqs.value = freqs;
      const scope = await soft(() => client.getDefaultFloodScope());
      if (scope !== undefined) this.#floodScope.value = scope ? { name: scope.name, keyHex: toHex(scope.key) } : null;
      await soft(() => this.#readTime(client));
    });
    await this.refreshBattery();
    await this.refreshStats();
  }

  // ---- identity ----

  async setName(name: string): Promise<void> {
    const n = validateName(name);
    await this.#run('name', async (client) => {
      await client.setAdvertName(n);
      await this.#refreshSelf(client);
    });
  }

  /** Degrees. */
  async setLocation(lat: number, lon: number): Promise<void> {
    const loc = validateLocation(lat, lon);
    await this.#run('location', async (client) => {
      await client.setAdvertLatLon(loc.lat, loc.lon);
      await this.#refreshSelf(client);
    });
  }

  /** Asks the injected geolocation provider for the current position (does not save it). */
  async currentPosition(): Promise<{ lat: number; lon: number }> {
    const geo = this.#deps.geolocation;
    if (!geo) throw new Error('Geolocation is not available');
    const pos = await geo();
    return validateLocation(pos.lat, pos.lon);
  }

  /** Geolocates and saves the position to the device. */
  async useCurrentLocation(): Promise<{ lat: number; lon: number }> {
    const pos = await this.currentPosition();
    await this.setLocation(pos.lat, pos.lon);
    return pos;
  }

  // ---- radio ----

  /** Whether client repeat is allowed at `freqMhz` (null when the list is not loaded). */
  repeatAllowedAt(freqMhz: number): boolean | null {
    const ranges = this.#repeatFreqs.peek();
    if (!ranges) return null;
    const f = Math.round(freqMhz * 1000);
    return ranges.some((r) => f >= r.lowerKhz && f <= r.upperKhz);
  }

  /**
   * SET_RADIO_PARAMS. Applied immediately by the device: other nodes on the old settings can no
   * longer be heard. The repeat byte is always sent (omitting it turns repeat OFF, §4 cmd 11);
   * by default the device's current client-repeat setting is kept.
   */
  async setRadioParams(p: RadioParamsInput): Promise<void> {
    const wire = radioParamsToWire(p);
    const repeat = p.clientRepeat ?? this.connection.deviceInfo.peek()?.clientRepeat ?? false;
    if (repeat) {
      const ok = this.repeatAllowedAt(wire.freqKhz / 1000);
      if (ok === false) fail('freq', 'Client repeat is only allowed on the off-grid frequencies');
    }
    await this.#run('radio', async (client) => {
      await client.setRadioParams({ ...wire, clientRepeat: repeat });
      await this.#refreshSelf(client);
    });
  }

  async setTxPower(dbm: number): Promise<void> {
    const max = this.connection.selfInfo.peek()?.maxTxPowerDbm ?? 30;
    requireIntRange('txPower', dbm, RADIO_LIMITS.txPowerMinDbm, max, 'TX power (dBm)');
    await this.#run('txPower', async (client) => {
      await client.setTxPower(dbm);
      await this.#refreshSelf(client);
    });
  }

  // ---- other params / contacts policy ----

  async setOtherParams(p: OtherParamsInput): Promise<void> {
    const cur = this.otherParams.peek();
    const patch: Partial<OtherParams> = {};
    if (p.manualAdd !== undefined) {
      const raw = cur?.manualAddRaw ?? 0;
      patch.manualAddContacts = p.manualAdd ? raw | MANUAL_ADD_CONTACTS_BIT : raw & ~MANUAL_ADD_CONTACTS_BIT;
    }
    if (p.telemetryModes) {
      const m = p.telemetryModes;
      requireIntRange('telemetryBase', m.base, 0, 2, 'Telemetry mode');
      requireIntRange('telemetryLocation', m.location, 0, 2, 'Telemetry mode');
      requireIntRange('telemetryEnvironment', m.environment, 0, 2, 'Telemetry mode');
      patch.telemetryModes = { base: m.base, location: m.location, environment: m.environment };
    }
    if (p.advertLocPolicy !== undefined) {
      requireIntRange('advertLocPolicy', p.advertLocPolicy, 0, 1, 'Advert location policy');
      patch.advertLocPolicy = p.advertLocPolicy;
    }
    if (p.multiAcks !== undefined) {
      requireIntRange('multiAcks', p.multiAcks, 0, 255, 'Extra ACKs');
      patch.multiAcks = p.multiAcks;
    }
    await this.#run('otherParams', async (client) => {
      await client.setOtherParams(patch);
      await this.#refreshSelf(client);
    });
  }

  setManualAdd(manual: boolean): Promise<void> {
    return this.setOtherParams({ manualAdd: manual });
  }

  async setAutoAdd(a: AutoAddInput): Promise<void> {
    if (a.maxHops !== undefined) requireIntRange('maxHops', a.maxHops, 0, 64, 'Max hops');
    const config = autoAddToConfig(a);
    await this.#run('autoAdd', async (client) => {
      await client.setAutoAddConfig(config, a.maxHops);
      const back = await client.getAutoAddConfig().catch(() => ({ config, maxHops: a.maxHops ?? this.#autoAdd.peek()?.maxHops ?? 0 }));
      this.#autoAdd.value = autoAddFromConfig(back.config, back.maxHops);
    });
  }

  // ---- tuning ----

  async refreshTuning(): Promise<TuningView> {
    return this.#run('tuning', async (client) => {
      const t = await client.getTuningParams();
      this.#tuning.value = t;
      return t;
    });
  }

  async setTuning(t: TuningView): Promise<void> {
    requireFinite('rxDelayBase', t.rxDelayBase, 'RX delay base');
    requireFinite('airtimeFactor', t.airtimeFactor, 'Airtime factor');
    const { rxDelayBase: rl, airtimeFactor: al } = TUNING_LIMITS;
    if (t.rxDelayBase < rl.min || t.rxDelayBase > rl.max) fail('rxDelayBase', `RX delay base must be between ${rl.min} and ${rl.max}`);
    if (t.airtimeFactor < al.min || t.airtimeFactor > al.max) fail('airtimeFactor', `Airtime factor must be between ${al.min} and ${al.max}`);
    // the wire carries value × 1000 as u32 (§4 cmd 21)
    const rx = Math.round(t.rxDelayBase * 1000) / 1000;
    const af = Math.round(t.airtimeFactor * 1000) / 1000;
    await this.#run('tuning', async (client) => {
      await client.setTuningParams(rx, af);
      this.#tuning.value = await client.getTuningParams().catch(() => ({ rxDelayBase: rx, airtimeFactor: af }));
    });
  }

  // ---- time ----

  async #readTime(client: CompanionClient): Promise<DeviceTimeView> {
    const deviceSecs = await client.getDeviceTime();
    const at = this.#now();
    const hostSecs = Math.floor(at / 1000);
    const view = { deviceSecs, hostSecs, driftSecs: deviceSecs - hostSecs, at };
    this.#time.value = view;
    return view;
  }

  async refreshDeviceTime(): Promise<DeviceTimeView> {
    return this.#run('time', (client) => this.#readTime(client));
  }

  /**
   * Sets the device clock to the host clock unless they are within `thresholdSecs`. A device
   * that is ahead cannot be set back (SET_DEVICE_TIME → ERR ILLEGAL_ARG, §4 cmd 6).
   */
  async syncTime(thresholdSecs = DEFAULT_TIME_SYNC_THRESHOLD_SECS): Promise<TimeSyncResult> {
    return this.#run('time', async (client) => {
      const t = await this.#readTime(client);
      if (Math.abs(t.driftSecs) <= thresholdSecs) return { status: 'inSync', driftSecs: t.driftSecs };
      if (t.driftSecs > 0) return { status: 'deviceAhead', driftSecs: t.driftSecs };
      try {
        await client.setDeviceTime(Math.floor(this.#now() / 1000));
      } catch (err) {
        if (err instanceof DeviceError) return { status: 'deviceAhead', driftSecs: t.driftSecs };
        throw err;
      }
      await this.#readTime(client);
      return { status: 'set', driftSecs: t.driftSecs };
    });
  }

  // ---- advert ----

  /** Remaining cooldown in ms (0 = can send). */
  advertCooldownRemaining(now = this.#now()): number {
    return Math.max(0, this.#advertCooldownUntil.peek() - now);
  }

  /** SEND_SELF_ADVERT; flood adverts use the default flood scope (§4 cmd 7). */
  async sendAdvert(mode: 'flood' | 'zeroHop'): Promise<void> {
    const wait = this.advertCooldownRemaining();
    if (wait > 0) fail('advert', `Wait ${Math.ceil(wait / 1000)} s before sending another advert`);
    await this.#run('advert', async (client) => {
      await client.sendSelfAdvert(mode);
      const now = this.#now();
      const ms = this.#deps.advertCooldownMs ?? 10_000;
      this.#lastAdvert.value = { mode, at: now };
      this.#advertCooldownUntil.value = now + ms;
      if (this.#cooldownTimer !== undefined) this.#clock.clearTimeout(this.#cooldownTimer);
      // re-notify when the cooldown ends so the UI re-enables its buttons
      this.#cooldownTimer = ms > 0 ? this.#clock.setTimeout(() => (this.#advertCooldownUntil.value = 0), ms) : undefined;
    });
  }

  // ---- battery / stats ----

  refreshBattery(): Promise<BattAndStorage | null> {
    return this.connection.refreshBattery();
  }

  /** GET_STATS core / radio / packets (fw v8+; older firmware leaves the parts null). */
  async refreshStats(): Promise<StatsView | null> {
    const client = this.connection.client.peek();
    if (!client?.connected) return null;
    return this.#run('stats', async (c) => {
      const get = <K extends StatsKind>(type: K): Promise<Extract<Stats, { type: K }> | null> => getStatsSoft(c, type);
      const view: StatsView = { core: await get('core'), radio: await get('radio'), packets: await get('packets'), at: this.#now() };
      this.#stats.value = view;
      return view;
    });
  }

  /**
   * GET_STATS radio on its own (the noise-floor sampler, app/noise-floor.ts): null when not
   * connected or the firmware refuses it (ERR, fw < v8). Leaves `stats` and the busy flags alone;
   * other errors (timeout, disconnect) reject.
   */
  async readRadioStats(): Promise<Extract<Stats, { type: 'radio' }> | null> {
    const client = this.connection.client.peek();
    if (!client?.connected) return null;
    return getStatsSoft(client, 'radio');
  }

  /**
   * Refreshes stats and battery every `intervalMs` while the returned stop function has not been
   * called (the device page calls this while it is shown). Nested callers share one timer.
   */
  pollStats(intervalMs = 5000): () => void {
    this.#pollers++;
    const tick = (): void => {
      this.#pollTimer = this.#clock.setTimeout(() => {
        void Promise.all([this.refreshStats(), this.refreshBattery()])
          .catch(() => undefined)
          .finally(() => {
            if (this.#pollers > 0 && this.#pollTimer !== undefined) tick();
          });
      }, intervalMs);
    };
    if (this.#pollers === 1) tick();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.#pollers--;
      if (this.#pollers === 0 && this.#pollTimer !== undefined) {
        this.#clock.clearTimeout(this.#pollTimer);
        this.#pollTimer = undefined;
      }
    };
  }

  // ---- custom vars ----

  async refreshCustomVars(): Promise<readonly CustomVar[]> {
    return this.#run('customVar', async (client) => {
      const v = await client.getCustomVars();
      this.#customVars.value = v;
      return v;
    });
  }

  /** SET_CUSTOM_VAR (the device only accepts names it already reports, ERR ILLEGAL_ARG otherwise). */
  async setCustomVar(name: string, value: string): Promise<void> {
    const v = validateCustomVar(name, value);
    await this.#run('customVar', async (client) => {
      await client.setCustomVar(v.name, v.value);
      this.#customVars.value = await client.getCustomVars().catch(() =>
        (this.#customVars.peek() ?? []).map((x) => (x.name === v.name ? { name: v.name, value: v.value } : x)),
      );
    });
  }

  // ---- PIN / flood scope ----

  /** SET_DEVICE_PIN; takes effect after a reboot. 0 = default. */
  async setPin(pin: number): Promise<void> {
    const p = validatePin(pin);
    await this.#run('pin', async (client) => {
      await client.setDevicePin(p);
      this.#pin.value = p;
    });
  }

  /**
   * GET_DEFAULT_FLOOD_SCOPE into {@link defaultFloodScope} (also done by {@link loadAll}). Old
   * firmware without the command leaves it undefined; never rejects.
   */
  async loadDefaultFloodScope(): Promise<void> {
    const client = this.connection.client.peek();
    if (!client?.connected) return;
    try {
      const scope = await client.getDefaultFloodScope();
      if (this.connection.client.peek() === client) this.#floodScope.value = scope ? { name: scope.name, keyHex: toHex(scope.key) } : null;
    } catch {
      // ERR (unsupported) or link loss: unknown
    }
  }

  /**
   * SET_DEFAULT_FLOOD_SCOPE (persisted). The key is the public hashtag region key
   * SHA256("#name")[0..16] (mesh-packet-format.md §1.2). Empty name / null clears it.
   */
  async setDefaultFloodScope(name: string | null): Promise<void> {
    const n = normalizeRegionName(name ?? '');
    if (n) {
      const err = validateRegionName(n);
      if (err) fail('floodScope', err);
    }
    const key = n ? await regionKey(n) : undefined;
    await this.#run('floodScope', async (client) => {
      await client.setDefaultFloodScope(n && key ? { name: n, key } : undefined);
      const back = await client.getDefaultFloodScope().catch(() => (n && key ? { name: n, key } : null));
      this.#floodScope.value = back ? { name: back.name, keyHex: toHex(back.key) } : null;
    });
  }

  // ---- keys ----

  /**
   * EXPORT_PRIVATE_KEY: the 64-byte expanded key as hex. Anyone holding it can impersonate this
   * radio. Saved to the radio's store only if the app setting allows it.
   */
  async exportPrivateKey(): Promise<string> {
    return this.#run('privateKey', async (client) => {
      const hex = toHex(await client.exportPrivateKey());
      if (this.#deps.storePrivateKey?.()) await this.connection.store.peek()?.settings.set(PRIVATE_KEY_SETTING, hex);
      return hex;
    });
  }

  /**
   * IMPORT_PRIVATE_KEY: replaces the radio's identity (the public key is re-derived and contacts
   * are reloaded). The app disconnects afterwards because its data is keyed by the public key.
   */
  async importPrivateKey(hex: string): Promise<void> {
    const key = parsePrivateKeyHex(hex);
    await this.#run('privateKey', async (client) => {
      await client.importPrivateKey(key);
    });
    await this.connection.disconnect();
  }

  // ---- reboot / reset ----

  /** REBOOT: no reply; the link drops and the connection goes to 'disconnected'. */
  async reboot(): Promise<void> {
    await this.#run('reboot', async (client) => {
      this.connection.expectDisconnect('Radio is rebooting. Reconnect when it is back.');
      await client.reboot();
    });
  }

  /**
   * FACTORY_RESET: erases identity, contacts, channels and settings, then reboots. `confirm`
   * must be the literal 'reset' (the UI's second confirmation step).
   */
  async factoryReset(confirm: string): Promise<void> {
    if (confirm !== 'reset') fail('factoryReset', 'Type "reset" to confirm');
    await this.#run('factoryReset', async (client) => {
      this.connection.expectDisconnect('Radio was reset to factory defaults and is rebooting.');
      await client.factoryReset();
    });
  }

  dispose(): void {
    for (const off of this.#offs.splice(0)) off();
    if (this.#pollTimer !== undefined) this.#clock.clearTimeout(this.#pollTimer);
    if (this.#cooldownTimer !== undefined) this.#clock.clearTimeout(this.#cooldownTimer);
    this.#pollTimer = undefined;
    this.#cooldownTimer = undefined;
    this.#pollers = 0;
  }
}

type StatsKind = 'core' | 'radio' | 'packets';

/** GET_STATS `type`; null when the firmware answers ERR (unsupported) or with another type. */
async function getStatsSoft<K extends StatsKind>(client: CompanionClient, type: K): Promise<Extract<Stats, { type: K }> | null> {
  try {
    const s = await client.getStats(type);
    return s.type === type ? (s as Extract<Stats, { type: K }>) : null;
  } catch (err) {
    if (err instanceof DeviceError) return null;
    throw err;
  }
}
