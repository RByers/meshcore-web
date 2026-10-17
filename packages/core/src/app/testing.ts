/**
 * Shared fixture for AppModel-level tests: an `AppModel` on a fast-timing `basicScenario()`
 * emulator with fake IndexedDB and in-memory preferences, torn down (app disposed, every pending
 * timer cleared) when the test finishes. One {@link SkippableClock} drives the emulator, the
 * virtual mesh and every app model, so timeout paths are reached with `elapse(ms)` instead of
 * waiting real time. Test-only (excluded from the build).
 */

import { expect, onTestFinished, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { SkippableClock, type Clock, type TimerHandle } from '../util/clock.js';
import { FAST_TIMING, type BasicScenario, type BasicScenarioOptions } from '../emulator/scenarios.js';
import type { CompanionClient } from '../client/companion-client.js';
import type { RadioStore } from '../store/radio-store.js';
import { toHex } from '../util/bytes.js';
import { AppModel, createEmulatorTransportFactory, type AppModelOptions } from './app-model.js';
import { memoryPreferences, type PreferencesStore } from './connection.js';

export interface TestAppOptions {
  /** Scenario options (merged over `{ timing: FAST_TIMING }`; the clock is always the fixture's). */
  scenario?: Omit<BasicScenarioOptions, 'clock'>;
  /** Extra AppModel options (override the fixture's defaults). */
  app?: AppModelOptions;
}

/**
 * DM retry shape for tests: two attempts, no back-off, no late-ACK grace. The ACK timeout is the
 * client's default (`estTimeoutMs` + grace); tests reach it with {@link ConnectedApp.missAck}, never by waiting.
 */
export const FAST_RETRY = { maxAttempts: 2, retryDelayMs: (): number => 0, lateAckGraceMs: 0 };

interface AppTimer {
  ms: number;
  due: number;
}

/**
 * The app's view of the shared clock: the same time and timers, plus a record of the app's own
 * pending timers (the emulator and mesh use the clock directly), so a test can wait for a
 * timeout to be armed before elapsing it.
 */
function recordingClock(clock: SkippableClock): Clock & { pending: Map<TimerHandle, AppTimer> } {
  const pending = new Map<TimerHandle, AppTimer>();
  return {
    pending,
    now: () => clock.now(),
    setTimeout(fn, ms) {
      const timer = { ms, due: clock.now() + Math.max(0, ms) };
      const h = clock.setTimeout(() => {
        pending.delete(h);
        fn();
      }, ms);
      pending.set(h, timer);
      return h;
    },
    clearTimeout(h) {
      pending.delete(h);
      clock.clearTimeout(h);
    },
  };
}

export type EmulatorFactory = ReturnType<typeof createEmulatorTransportFactory>;

export interface TestApp {
  app: AppModel;
  /** The emulator transport factory (`emulator.scenario()` is the scenario). */
  emulator: EmulatorFactory;
  prefs: PreferencesStore;
  /** The one clock shared by the emulator, the virtual mesh and the app. */
  clock: SkippableClock;
  /**
   * Jumps `ms` ahead, synchronously firing every timer that falls due (ACK / request timeouts,
   * cooldowns, polls), then lets their effects (promise chains, IndexedDB writes) run.
   * Arm the timer first: observe the state just before the timeout, then elapse.
   */
  elapse(ms: number): Promise<void>;
  /**
   * Waits until the app has a pending timer of exactly `ms` (or whose duration `ms` matches), then
   * elapses to its due time. Use it for timeouts / cooldowns / polls whose arming is asynchronous.
   */
  elapsePending(ms: number | ((ms: number) => boolean)): Promise<void>;
}

/** An AppModel (not connected) on a fast emulator; disposed, with its timers cleared, when the test finishes. */
export function testApp(opts: TestAppOptions = {}): TestApp {
  const clock = new SkippableClock();
  const appClock = recordingClock(clock);
  const emulator = createEmulatorTransportFactory({ timing: FAST_TIMING, ...opts.scenario, clock });
  const prefs = memoryPreferences();
  const app = new AppModel({
    indexedDB: new IDBFactory(),
    keyRange: IDBKeyRange,
    createEmulatorTransport: emulator,
    preferences: prefs,
    clock: appClock,
    ...opts.app,
  });
  onTestFinished(async () => {
    await app.dispose();
    clock.clearAll();
  });
  const elapse = async (ms: number): Promise<void> => {
    clock.skip(ms);
    await new Promise<void>((r) => setTimeout(r, 0));
  };
  const elapsePending = async (ms: number | ((ms: number) => boolean)): Promise<void> => {
    const match = typeof ms === 'number' ? (x: number) => x === ms : ms;
    let due = 0;
    // vi.waitFor polls on macrotasks, so a timer armed in a microtask continuation is seen
    await vi.waitFor(() => {
      const hits = [...appClock.pending.values()].filter((p) => match(p.ms));
      expect(hits.length, 'a matching app timer is pending').toBeGreaterThan(0);
      due = Math.min(...hits.map((p) => p.due));
    });
    await elapse(Math.max(0, due - clock.now()));
  };
  return { app, emulator, prefs: opts.app?.preferences ?? prefs, clock, elapse, elapsePending };
}

export type ScenarioKeys = Record<keyof BasicScenario['keys'], string>;

export interface ConnectedApp extends TestApp {
  scenario: BasicScenario;
  store: RadioStore;
  client: CompanionClient;
  /** Scenario public keys as hex. */
  keys: ScenarioKeys;
  /**
   * Lets the pending DM attempt go unacknowledged: waits until the client has armed its ACK
   * timeout (`est_timeout` from RESP_SENT + the default 1 s grace), then elapses exactly to it.
   * Call once per attempt.
   */
  missAck(): Promise<void>;
  /**
   * Lets the pending remote request (login, status, CLI, …) go unanswered: as {@link missAck},
   * for its `est_timeout` + the default 3 s remote grace.
   */
  missResponse(): Promise<void>;
}

/** CompanionClient defaults (`RetryOptions.ackGraceMs`, `CompanionClientOptions.remoteTimeoutGraceMs`). */
const ACK_GRACE_MS = 1000;
const REMOTE_GRACE_MS = 3000;

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
  const client = app.connection.client.value!;
  // est_timeout of every RESP_SENT: the client arms est_timeout + grace for the ACK / response
  const est = new Set<number>();
  client.events.on('frame', (e) => {
    if (e.frame?.kind === 'sent') est.add(e.frame.estTimeoutMs);
  });
  const miss = (graceMs: number) => (): Promise<void> => t.elapsePending((ms) => est.has(ms - graceMs));
  return { ...t, scenario, store: app.connection.store.value!, client, keys, missAck: miss(ACK_GRACE_MS), missResponse: miss(REMOTE_GRACE_MS) };
}
