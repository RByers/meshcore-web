/**
 * Noise-floor sampling (docs/packet-stats.md §1.8): while a radio is connected, read GET_STATS
 * radio every {@link NOISE_FLOOR_INTERVAL_MS} (the first {@link NOISE_FLOOR_FIRST_DELAY_MS} after
 * the connection is up) and store `{ t, noiseFloorDbm, lastRssiDbm, lastSnr }` in the radio's
 * `noiseFloor` store, so the Stats tab can chart it over the packet log's date range.
 *
 * Quiet by design: a firmware that refuses GET_STATS (ERR, fw < v8) stops sampling for that
 * connection, a failed / timed-out request is skipped, and nothing raises a notification. A tick
 * that finds the previous request still outstanding is skipped rather than stacking another.
 */

import type { CompanionClient } from '../client/companion-client.js';
import type { Stats } from '../protocol/types.js';
import type { RadioStore } from '../store/radio-store.js';
import type { NoiseFloorSample } from '../store/schema.js';
import type { Clock, TimerHandle } from '../util/clock.js';
import type { ConnectionModel } from './connection.js';
import { effect, signal, untracked, type ReadonlySignal } from './signal.js';

export const NOISE_FLOOR_INTERVAL_MS = 60_000;
export const NOISE_FLOOR_FIRST_DELAY_MS = 5_000;
/**
 * Charts treat samples further apart than this as a gap (the radio was not connected); three
 * intervals, so one skipped or slow poll does not break the line.
 */
export const NOISE_FLOOR_GAP_MS = 3 * NOISE_FLOOR_INTERVAL_MS;

export type RadioStats = Extract<Stats, { type: 'radio' }>;

export interface NoiseFloorSamplerDeps {
  /** GET_STATS radio: null = unsupported by the firmware (DeviceSettingsModel.readRadioStats). */
  read: () => Promise<RadioStats | null>;
  /** Default: the connection's clock. */
  clock?: Clock;
  intervalMs?: number;
  firstDelayMs?: number;
}

interface Session {
  client: CompanionClient;
  store: RadioStore;
}

export class NoiseFloorSampler {
  readonly #deps: NoiseFloorSamplerDeps;
  readonly #clock: Clock;
  readonly #supported = signal<boolean | null>(null);
  /**
   * Whether the connected radio reports its noise floor: null until the first answer (or while
   * disconnected), false once it refused GET_STATS radio (sampling then stops until reconnect).
   */
  readonly supported: ReadonlySignal<boolean | null> = this.#supported.readonly;
  #session: Session | null = null;
  #timer: TimerHandle | undefined;
  #inFlight: Promise<NoiseFloorSample | null> | null = null;
  #dispose: (() => void) | undefined;

  constructor(
    private readonly connection: ConnectionModel,
    deps: NoiseFloorSamplerDeps,
  ) {
    this.#deps = deps;
    this.#clock = deps.clock ?? connection.clock;
  }

  /** Follows the connection: sampling runs while it is connected with a store open. */
  start(): this {
    if (this.#dispose) return this;
    this.#dispose = effect(() => {
      const connected = this.connection.connected.value;
      const client = this.connection.client.value;
      const store = this.connection.store.value;
      untracked(() => {
        const cur = this.#session;
        if (connected && client && store) {
          if (cur && cur.client === client && cur.store === store) return;
          this.#stop();
          this.#session = { client, store };
          this.#supported.value = null;
          this.#schedule(this.#deps.firstDelayMs ?? NOISE_FLOOR_FIRST_DELAY_MS);
        } else if (cur) {
          this.#stop();
          this.#supported.value = null;
        }
      });
    });
    return this;
  }

  /** True while a timer is armed (tests). */
  get polling(): boolean {
    return this.#timer !== undefined;
  }

  #stop(): void {
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#session = null;
  }

  #schedule(ms: number): void {
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      if (!this.#session) return;
      this.#schedule(this.#deps.intervalMs ?? NOISE_FLOOR_INTERVAL_MS);
      void this.sampleNow();
    }, ms);
  }

  /**
   * Takes one sample now and stores it. Resolves with the sample, or null when not connected,
   * unsupported, the previous request is still outstanding, or the request failed.
   */
  sampleNow(): Promise<NoiseFloorSample | null> {
    const session = this.#session;
    if (!session || this.#supported.peek() === false || this.#inFlight) return Promise.resolve(null);
    const p = this.#sample(session).finally(() => {
      if (this.#inFlight === p) this.#inFlight = null;
    });
    this.#inFlight = p;
    return p;
  }

  /** Resolves when the outstanding request (if any) has finished. */
  async idle(): Promise<void> {
    await this.#inFlight;
  }

  async #sample(session: Session): Promise<NoiseFloorSample | null> {
    const t = this.#clock.now(); // request time: samples sit exactly one interval apart
    let stats: RadioStats | null;
    try {
      stats = await this.#deps.read();
    } catch {
      return null; // timeout / disconnect: try again next tick
    }
    if (this.#session !== session) return null;
    if (!stats) {
      this.#supported.value = false;
      if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
      this.#timer = undefined;
      return null;
    }
    this.#supported.value = true;
    const sample: NoiseFloorSample = {
      t,
      noiseFloorDbm: stats.noiseFloorDbm,
      lastRssiDbm: stats.lastRssiDbm,
      lastSnr: stats.lastSnr,
    };
    try {
      return await session.store.noiseFloor.add(sample);
    } catch {
      return null; // store closed meanwhile
    }
  }

  dispose(): void {
    this.#dispose?.();
    this.#dispose = undefined;
    this.#stop();
  }
}
