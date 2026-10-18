import { describe, expect, it, vi } from 'vitest';
import { toHex } from '../util/bytes.js';
import { ManualClock } from '../util/clock.js';
import { NOISE_FLOOR_FIRST_DELAY_MS, NOISE_FLOOR_INTERVAL_MS, NoiseFloorSampler, type RadioStats } from './noise-floor.js';
import { connectedApp } from './testing.js';

const radio = (noiseFloorDbm: number): RadioStats => ({ type: 'radio', noiseFloorDbm, lastRssiDbm: -80, lastSnr: 2.5, txAirSecs: 0, rxAirSecs: 0 });

/** A promise with its resolve / reject exposed. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('NoiseFloorSampler (AppModel.noiseFloor)', () => {
  it('samples GET_STATS radio soon after connect, then every minute, into the store', async () => {
    const t = await connectedApp({ scenario: { radioStats: { noiseFloorDbm: -109 } } });
    const out: string[] = [];
    t.client.events.on('frame', (f) => {
      if (f.direction === 'out') out.push(toHex(f.bytes));
    });
    expect(t.app.noiseFloor.polling).toBe(true);
    expect(t.app.noiseFloor.supported.value).toBeNull();

    await t.elapsePending(NOISE_FLOOR_FIRST_DELAY_MS);
    await vi.waitFor(async () => expect(await t.store.noiseFloor.count()).toBe(1));
    const first = (await t.store.noiseFloor.range())[0]!;
    expect(first).toEqual({ t: first.t, noiseFloorDbm: -109, lastRssiDbm: expect.any(Number), lastSnr: expect.any(Number) });
    // §4 cmd 56: GET_STATS, [1]=1 radio — and nothing else
    expect(out).toEqual(['3801']);
    expect(t.app.noiseFloor.supported.value).toBe(true);

    await t.elapsePending(NOISE_FLOOR_INTERVAL_MS);
    await vi.waitFor(async () => expect(await t.store.noiseFloor.count()).toBe(2));
    const [a, b] = await t.store.noiseFloor.range();
    expect(b!.t - a!.t).toBe(NOISE_FLOOR_INTERVAL_MS);
    expect(t.app.notifications.toasts.value).toEqual([]);

    await t.app.connection.disconnect();
    expect(t.app.noiseFloor.polling).toBe(false);
    expect(t.app.noiseFloor.supported.value).toBeNull();
  });

  it('stays quiet on firmware without GET_STATS (fw < v8): one try, then no more polling, no toast', async () => {
    const t = await connectedApp({ scenario: { firmware: { verCode: 7 } } });
    await t.elapsePending(NOISE_FLOOR_FIRST_DELAY_MS);
    await vi.waitFor(() => expect(t.app.noiseFloor.supported.value).toBe(false));
    expect(t.app.noiseFloor.polling).toBe(false);
    expect(await t.store.noiseFloor.count()).toBe(0);
    expect(t.app.notifications.toasts.value).toEqual([]);
  });

  it('does not stack requests, skips failures, and restarts on reconnect', async () => {
    const t = await connectedApp({ app: { noiseFloorSampling: false } });
    expect(t.app.noiseFloor.polling).toBe(false);
    const clock = new ManualClock(t.clock.now());
    const calls: Array<ReturnType<typeof deferred<RadioStats | null>>> = [];
    const sampler = new NoiseFloorSampler(t.app.connection, {
      clock,
      read: () => {
        const d = deferred<RadioStats | null>();
        calls.push(d);
        return d.promise;
      },
    });
    try {
      sampler.start();
      expect(sampler.polling).toBe(true);
      clock.advance(NOISE_FLOOR_FIRST_DELAY_MS - 1);
      expect(calls).toHaveLength(0);
      clock.advance(1);
      expect(calls).toHaveLength(1);
      // still outstanding a minute later: that tick is skipped
      clock.advance(NOISE_FLOOR_INTERVAL_MS);
      expect(calls).toHaveLength(1);
      expect(await sampler.sampleNow()).toBeNull();
      calls[0]!.resolve(radio(-111));
      await vi.waitFor(async () => expect(await t.store.noiseFloor.count()).toBe(1));

      // a failed request (timeout, …) is skipped; the next tick tries again
      clock.advance(NOISE_FLOOR_INTERVAL_MS);
      expect(calls).toHaveLength(2);
      calls[1]!.reject(new Error('timeout'));
      await sampler.idle();
      clock.advance(NOISE_FLOOR_INTERVAL_MS);
      expect(calls).toHaveLength(3);
      calls[2]!.resolve(radio(-104));
      await vi.waitFor(async () => expect(await t.store.noiseFloor.count()).toBe(2));
      expect((await t.store.noiseFloor.range()).map((s) => s.noiseFloorDbm)).toEqual([-111, -104]);
      expect(sampler.supported.value).toBe(true);

      await t.app.connection.disconnect();
      expect(sampler.polling).toBe(false);
      clock.advance(10 * NOISE_FLOOR_INTERVAL_MS);
      expect(calls).toHaveLength(3);

      expect(await t.app.connection.connect('emulator')).toBe(true);
      await vi.waitFor(() => expect(sampler.polling).toBe(true));
      clock.advance(NOISE_FLOOR_FIRST_DELAY_MS);
      expect(calls).toHaveLength(4);
      // null = the firmware refused: polling stops for this connection
      calls[3]!.resolve(null);
      await vi.waitFor(() => expect(sampler.supported.value).toBe(false));
      expect(sampler.polling).toBe(false);
      clock.advance(10 * NOISE_FLOOR_INTERVAL_MS);
      expect(calls).toHaveLength(4);
    } finally {
      sampler.dispose();
    }
  });
});
