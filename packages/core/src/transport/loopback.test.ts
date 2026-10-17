import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../util/bytes.js';
import { Deferred } from '../util/deferred.js';
import { ManualClock } from '../util/clock.js';
import { LoopbackTransport, createLoopbackPair } from './loopback.js';
import type { FrameTransport, TransportState } from './transport.js';

function collect(t: FrameTransport): string[] {
  const out: string[] = [];
  t.events.on('frame', (f) => out.push(toHex(f)));
  return out;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createLoopbackPair', () => {
  it('connects, delivers frames both ways asynchronously and in order', async () => {
    const [a, b] = createLoopbackPair();
    const states: TransportState[] = [];
    a.events.on('state', (s) => states.push(s));
    await a.connect();
    await b.connect();
    expect(a.state).toBe('connected');
    expect(states).toEqual(['connecting', 'connected']);
    const atB = collect(b);
    const atA = collect(a);
    const sends = [a.send(fromHex('01')), a.send(fromHex('0203')), b.send(fromHex('ff'))];
    expect(atB).toEqual([]); // not delivered synchronously
    await Promise.all(sends);
    await flush();
    expect(atB).toEqual(['01', '0203']);
    expect(atA).toEqual(['ff']);
  });

  it('copies frames so later mutation by the sender has no effect', async () => {
    const [a, b] = createLoopbackPair();
    await a.connect();
    await b.connect();
    const got = collect(b);
    const f = fromHex('0102');
    await a.send(f);
    f[0] = 9;
    await flush();
    expect(got).toEqual(['0102']);
  });

  it('honours latencyMs', async () => {
    const clock = new ManualClock();
    const [a, b] = createLoopbackPair({ latencyMs: 50, clock });
    await a.connect();
    await b.connect();
    const got = collect(b);
    await a.send(fromHex('01'));
    await a.send(fromHex('02'));
    clock.advance(49);
    expect(got).toEqual([]);
    clock.advance(1);
    expect(got).toEqual(['01', '02']);
  });

  it('rejects send when disconnected or the frame is empty / too large', async () => {
    const [a, b] = createLoopbackPair();
    await expect(a.send(fromHex('01'))).rejects.toThrow(/not connected/);
    await a.connect();
    await b.connect();
    await expect(a.send(new Uint8Array(0))).rejects.toThrow(/empty/);
    await expect(a.send(new Uint8Array(177))).rejects.toThrow(/exceeds/);
    await expect(a.send(new Uint8Array(176))).resolves.toBeUndefined();
  });

  it('drops frames to a disconnected peer, including in-flight ones', async () => {
    const [a, b] = createLoopbackPair();
    await a.connect();
    await b.connect();
    const got = collect(b);
    void a.send(fromHex('01')); // in flight when b disconnects
    void b.disconnect();
    await flush();
    await a.send(fromHex('02'));
    await flush();
    expect(got).toEqual([]);
    expect(b.state).toBe('disconnected');
    await b.connect();
    await a.send(fromHex('03'));
    await flush();
    expect(got).toEqual(['03']);
  });
});

describe('LoopbackTransport', () => {
  it('routes host frames to the handler and replies back', async () => {
    const t = new LoopbackTransport((frame, device) => {
      device.send(Uint8Array.of(0x80 | frame[0]!));
    });
    const got = collect(t);
    await t.connect();
    await t.send(fromHex('01'));
    await t.send(fromHex('02'));
    await flush();
    expect(got).toEqual(['81', '82']);
    expect(t.info).toEqual({ kind: 'loopback', name: 'Loopback' });
  });

  it('supports unsolicited pushes and async handlers', async () => {
    const gate = new Deferred<void>();
    const replied = new Deferred<void>();
    const t = new LoopbackTransport(async (_frame, device) => {
      await gate.promise; // the handler finishes asynchronously, after send() has returned
      device.send(fromHex('00'));
      replied.resolve();
    });
    const got = collect(t);
    await t.connect();
    t.pushFromDevice(fromHex('83'));
    await t.send(fromHex('16'));
    gate.resolve();
    await replied.promise;
    await flush();
    expect(got).toEqual(['83', '00']);
  });

  it('reports handler errors on the error event', async () => {
    const t = new LoopbackTransport(() => {
      throw new Error('handler bug');
    });
    const errors: string[] = [];
    t.events.on('error', (e) => errors.push(e.message));
    await t.connect();
    await t.send(fromHex('01'));
    await flush();
    expect(errors).toEqual(['handler bug']);
  });

  it('disconnect stops delivery and emits state', async () => {
    const t = new LoopbackTransport((_f, d) => d.send(fromHex('aa')));
    const states: TransportState[] = [];
    t.events.on('state', (s) => states.push(s));
    const got = collect(t);
    await t.connect();
    await t.send(fromHex('01'));
    await t.disconnect();
    await flush();
    expect(got).toEqual([]);
    expect(states).toEqual(['connecting', 'connected', 'disconnected']);
  });
});
