/**
 * App-level (local, not sent to the radio) settings: theme, time format, packet log retention
 * whether an exported private key may be kept for decrypting DMs in the packet inspector and
 * whether paths are shown as node names, whether the map approximates unknown positions and
 * whether SMAZ compression is turned on for a contact that sends a compressed DM, and whether the
 * Packets page shows its Frames tab (host ↔ radio frames, for debugging).
 * Stored in the global PreferencesStore (localStorage in the browser).
 */

import type { RadioStore } from '../store/radio-store.js';
import type { ConnectionModel, PreferencesStore } from './connection.js';
import { PRIVATE_KEY_SETTING } from './device-settings-model.js';
import { effect, signal, type ReadonlySignal, type Signal } from './signal.js';

export type ThemePreference = 'system' | 'light' | 'dark';
export type TimeFormatPreference = 'system' | '12h' | '24h';

export const THEME_OPTIONS: readonly ThemePreference[] = ['system', 'light', 'dark'];
export const TIME_FORMAT_OPTIONS: readonly TimeFormatPreference[] = ['system', '12h', '24h'];

export const PREF_THEME = 'meshcore-web.theme';
export const PREF_TIME_FORMAT = 'meshcore-web.timeFormat';
export const PREF_PACKET_RETENTION_DAYS = 'meshcore-web.packetRetentionDays';
export const PREF_STORE_PRIVATE_KEY = 'meshcore-web.storePrivateKey';
export const PREF_PATH_NAMES = 'meshcore-web.pathNames';
export const PREF_APPROXIMATE_POSITIONS = 'meshcore-web.approximatePositions';
export const PREF_SMAZ_AUTO_ENABLE = 'meshcore-web.smazAutoEnable';
export const PREF_SHOW_FRAMES = 'meshcore-web.showFrames';

export const MAX_PACKET_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

function isTheme(v: unknown): v is ThemePreference {
  return v === 'system' || v === 'light' || v === 'dark';
}

function isRetentionDays(v: number): boolean {
  return Number.isInteger(v) && v >= 1 && v <= MAX_PACKET_RETENTION_DAYS;
}

function isTimeFormat(v: unknown): v is TimeFormatPreference {
  return v === 'system' || v === '12h' || v === '24h';
}

export class AppSettingsModel {
  readonly #theme: Signal<ThemePreference>;
  readonly #timeFormat: Signal<TimeFormatPreference>;
  readonly #retentionDays: Signal<number | null>;
  readonly #storeKey: Signal<boolean>;
  readonly #pathNames: Signal<boolean>;
  readonly #approximatePositions: Signal<boolean>;
  readonly #smazAutoEnable: Signal<boolean>;
  readonly #showFrames: Signal<boolean>;

  readonly theme: ReadonlySignal<ThemePreference>;
  readonly timeFormat: ReadonlySignal<TimeFormatPreference>;
  /**
   * Packets older than this many days are pruned from the log when a radio connects or the value
   * changes. null (the default) keeps packets forever.
   */
  readonly packetRetentionDays: ReadonlySignal<number | null>;
  /** Default off. */
  readonly storePrivateKey: ReadonlySignal<boolean>;
  /**
   * Show paths as "Alice > Bob > a3" (hop hashes resolved to known contacts) instead of "N hops"
   * (issue #3). Default off.
   */
  readonly pathNames: ReadonlySignal<boolean>;
  /**
   * Show nodes without a location on the map at an approximate position near the repeater they
   * were last heard through (issue #7, `position-estimator.ts`). Default off.
   */
  readonly approximatePositions: ReadonlySignal<boolean>;
  /**
   * Turn on SMAZ compression for a contact when they send a compressed DM, unless the user has
   * set that contact's compression explicitly (feature-inventory.md §2.4a). Default off.
   */
  readonly smazAutoEnable: ReadonlySignal<boolean>;
  /**
   * Show the Frames tab on the Packets page: every host ↔ radio frame, for debugging radio
   * communication. Frames are logged either way. Default off.
   */
  readonly showFrames: ReadonlySignal<boolean>;

  #offs: Array<() => void> = [];

  constructor(
    private readonly prefs: PreferencesStore,
    private readonly connection: ConnectionModel,
  ) {
    const theme = prefs.getItem(PREF_THEME);
    const tf = prefs.getItem(PREF_TIME_FORMAT);
    const days = Number(prefs.getItem(PREF_PACKET_RETENTION_DAYS) ?? NaN);
    this.#theme = signal<ThemePreference>(isTheme(theme) ? theme : 'system');
    this.#timeFormat = signal<TimeFormatPreference>(isTimeFormat(tf) ? tf : 'system');
    this.#retentionDays = signal(isRetentionDays(days) ? days : null);
    this.#storeKey = signal(prefs.getItem(PREF_STORE_PRIVATE_KEY) === 'true');
    this.theme = this.#theme.readonly;
    this.timeFormat = this.#timeFormat.readonly;
    this.packetRetentionDays = this.#retentionDays.readonly;
    this.storePrivateKey = this.#storeKey.readonly;
    this.#pathNames = signal(prefs.getItem(PREF_PATH_NAMES) === 'true');
    this.pathNames = this.#pathNames.readonly;
    this.#approximatePositions = signal(prefs.getItem(PREF_APPROXIMATE_POSITIONS) === 'true');
    this.approximatePositions = this.#approximatePositions.readonly;
    this.#smazAutoEnable = signal(prefs.getItem(PREF_SMAZ_AUTO_ENABLE) === 'true');
    this.smazAutoEnable = this.#smazAutoEnable.readonly;
    this.#showFrames = signal(prefs.getItem(PREF_SHOW_FRAMES) === 'true');
    this.showFrames = this.#showFrames.readonly;

    // apply a user-chosen retention whenever a radio's store opens (unlimited needs no prune)
    this.#offs.push(
      effect(() => {
        const store = this.connection.store.value;
        if (store && this.#retentionDays.peek() !== null) void this.#prune(store);
      }),
    );
  }

  setTheme(theme: ThemePreference): void {
    if (!isTheme(theme)) throw new RangeError(`unknown theme ${String(theme)}`);
    this.#theme.value = theme;
    this.prefs.setItem(PREF_THEME, theme);
  }

  setTimeFormat(fmt: TimeFormatPreference): void {
    if (!isTimeFormat(fmt)) throw new RangeError(`unknown time format ${String(fmt)}`);
    this.#timeFormat.value = fmt;
    this.prefs.setItem(PREF_TIME_FORMAT, fmt);
  }

  /**
   * 1..3650 days, or null to keep packets forever. With a limit, prunes the connected radio's
   * packet log now. Resolves to the number removed.
   */
  async setPacketRetentionDays(days: number | null): Promise<number> {
    if (days !== null && !isRetentionDays(days)) {
      throw new RangeError(`Retention must be a whole number of days from 1 to ${MAX_PACKET_RETENTION_DAYS}`);
    }
    this.#retentionDays.value = days;
    this.prefs.setItem(PREF_PACKET_RETENTION_DAYS, days === null ? 'unlimited' : String(days));
    if (days === null) return 0;
    const store = this.connection.store.peek();
    return store ? this.#prune(store) : 0;
  }

  async #prune(store: RadioStore): Promise<number> {
    const days = this.#retentionDays.peek();
    if (days === null) return 0;
    try {
      return await store.packets.prune({ maxAgeMs: days * DAY_MS });
    } catch {
      return 0; // store closed meanwhile
    }
  }

  /** Turning it off also deletes a stored key of the connected radio. */
  async setStorePrivateKey(on: boolean): Promise<void> {
    this.#storeKey.value = on;
    this.prefs.setItem(PREF_STORE_PRIVATE_KEY, on ? 'true' : 'false');
    if (!on) await this.connection.store.peek()?.settings.delete(PRIVATE_KEY_SETTING);
  }

  setPathNames(on: boolean): void {
    this.#pathNames.value = on;
    this.prefs.setItem(PREF_PATH_NAMES, on ? 'true' : 'false');
  }

  setApproximatePositions(on: boolean): void {
    this.#approximatePositions.value = on;
    this.prefs.setItem(PREF_APPROXIMATE_POSITIONS, on ? 'true' : 'false');
  }

  setSmazAutoEnable(on: boolean): void {
    this.#smazAutoEnable.value = on;
    this.prefs.setItem(PREF_SMAZ_AUTO_ENABLE, on ? 'true' : 'false');
  }

  setShowFrames(on: boolean): void {
    this.#showFrames.value = on;
    this.prefs.setItem(PREF_SHOW_FRAMES, on ? 'true' : 'false');
  }

  /** Formats epoch ms as a clock time following the time-format preference. */
  formatTime(ts: number, opts: { seconds?: boolean; date?: boolean } = {}): string {
    const fmt = this.#timeFormat.value;
    const o: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
    if (opts.seconds) o.second = '2-digit';
    if (opts.date) Object.assign(o, { year: 'numeric', month: 'short', day: 'numeric' });
    if (fmt !== 'system') o.hour12 = fmt === '12h';
    return new Date(ts).toLocaleString(undefined, o);
  }

  dispose(): void {
    for (const off of this.#offs.splice(0)) off();
  }
}
