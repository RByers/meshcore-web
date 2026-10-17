/**
 * Shared fixture for AppModel-level tests: an `AppModel` on a fast-timing `basicScenario()`
 * emulator with fake IndexedDB and in-memory preferences, torn down (app disposed, every pending
 * emulator / mesh timer cleared) when the test finishes. Test-only (excluded from the build).
 */

import { expect, onTestFinished } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { systemClock, type EmulatorClock, type TimerHandle } from '../emulator/clock.js';
import { FAST_TIMING, type BasicScenario, type BasicScenarioOptions } from '../emulator/scenarios.js';
import type { CompanionClient } from '../client/companion-client.js';
import type { RadioStore } from '../store/radio-store.js';
import { toHex } from '../util/bytes.js';
import { AppModel, createEmulatorTransportFactory, type AppModelOptions } from './app-model.js';
import { memoryPreferences, type PreferencesStore } from './connection.js';

export interface TestAppOptions {
  /** Scenario options (merged over `{ timing: FAST_TIMING }`). */
  scenario?: BasicScenarioOptions;
  /** Extra AppModel options (override the fixture's defaults). */
  app?: AppModelOptions;
}

/** Wraps `inner` and remembers pending timers so they can all be cancelled at teardown. */
function trackingClock(inner: EmulatorClock): EmulatorClock & { clearAll(): void } {
  const pending = new Set<TimerHandle>();
  return {
    now: () => inner.now(),
    setTimeout(fn, ms) {
      const h: TimerHandle = inner.setTimeout(() => {
        pending.delete(h);
        fn();
      }, ms);
      pending.add(h);
      return h;
    },
    clearTimeout(h) {
      pending.delete(h);
      inner.clearTimeout(h);
    },
    clearAll() {
      for (const h of pending) inner.clearTimeout(h);
      pending.clear();
    },
  };
}

/**
 * DM retry tuning for the real clock with fast scenario timing: two attempts, no back-off, an ACK
 * timeout ≥ 10× the scenario's ACK delay so a loaded machine cannot trip it.
 */
export const FAST_RETRY = { maxAttempts: 2, ackTimeoutMs: 100, retryDelayMs: (): number => 0, lateAckGraceMs: 0 };

export type EmulatorFactory = ReturnType<typeof createEmulatorTransportFactory>;

export interface TestApp {
  app: AppModel;
  /** The emulator transport factory (`emulator.scenario()` is the scenario). */
  emulator: EmulatorFactory;
  prefs: PreferencesStore;
}

/** An AppModel (not connected) on a fast emulator; disposed, with its timers cleared, when the test finishes. */
export function testApp(opts: TestAppOptions = {}): TestApp {
  const clock = trackingClock(opts.scenario?.clock ?? systemClock);
  const emulator = createEmulatorTransportFactory({ timing: FAST_TIMING, ...opts.scenario, clock });
  const prefs = memoryPreferences();
  const app = new AppModel({
    indexedDB: new IDBFactory(),
    keyRange: IDBKeyRange,
    createEmulatorTransport: emulator,
    preferences: prefs,
    ...opts.app,
  });
  onTestFinished(async () => {
    await app.dispose();
    clock.clearAll();
  });
  return { app, emulator, prefs: opts.app?.preferences ?? prefs };
}

export type ScenarioKeys = Record<keyof BasicScenario['keys'], string>;

export interface ConnectedApp extends TestApp {
  scenario: BasicScenario;
  store: RadioStore;
  client: CompanionClient;
  /** Scenario public keys as hex. */
  keys: ScenarioKeys;
}

/**
 * {@link testApp}, connected to the emulator, with the initial sync captured into the store and
 * the contacts model loaded.
 */
export async function connectedApp(opts: TestAppOptions = {}): Promise<ConnectedApp> {
  const t = testApp(opts);
  const { app } = t;
  expect(await app.connection.connect('emulator')).toBe(true);
  await app.connection.capture!.idle();
  await app.contacts.settled();
  const scenario = t.emulator.scenario();
  const keys = Object.fromEntries(Object.entries(scenario.keys).map(([n, v]) => [n, toHex(v)])) as ScenarioKeys;
  return { ...t, scenario, store: app.connection.store.value!, client: app.connection.client.value!, keys };
}
