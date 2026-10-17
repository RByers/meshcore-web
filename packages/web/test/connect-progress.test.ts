import { afterEach, describe, expect, it } from 'vitest';
import { TypedEmitter } from '@meshcore-web/core/util/events';
import type { FrameTransport, TransportEvents } from '@meshcore-web/core/transport';
import '../src/mc-app.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** Response codes (docs/companion-protocol.md §5): CONTACT 0x03, DEVICE_INFO 0x0D. */
const RESP_CONTACT = 0x03;
const RESP_DEVICE_INFO = 0x0d;

/**
 * Holds device→host serial frames from the first one `hold(code)` matches (and every frame after
 * it, so order is kept) until `release()`, which delivers them and arms the next predicate.
 */
function gateSerial(t: Harness, hold: (code: number) => boolean) {
  const port = t.serial.port;
  const deliver = port.deliverToHost.bind(port);
  let pred: ((code: number) => boolean) | null = hold;
  let held: Uint8Array[] | null = null;
  port.deliverToHost = (bytes: Uint8Array) => {
    // serial frame: marker, u16 length, payload (code first)
    if (held) held.push(bytes);
    else if (pred?.(bytes[3] ?? -1)) held = [bytes];
    else deliver(bytes);
  };
  return {
    get holding() {
      return held !== null;
    },
    release(next: ((code: number) => boolean) | null = null) {
      const q = held ?? [];
      held = null;
      pred = next;
      for (const b of q) deliver(b);
    },
  };
}

const bar = (t: Harness) => t.query('[data-field="connect-progress"]')?.shadowRoot?.querySelector<HTMLElement>('[role="progressbar"]') ?? null;
const valueNow = (t: Harness) => Number(bar(t)?.getAttribute('aria-valuenow'));

describe('connect progress', () => {
  it('shows the step and a filling bar while handshaking, then finishes and goes away', async () => {
    const t = (h = createHarness());
    await t.mount();
    const gate = gateSerial(t, (code) => code === RESP_DEVICE_INFO);
    await t.click('[data-connect="serial"]');

    // paused waiting for DEVICE_INFO
    await t.until(() => gate.holding && t.query('[data-field="chip-label"]')?.textContent === 'Querying device', 5000, 'device query step');
    await t.until(() => bar(t) && t.query('[data-field="connect-step"]')?.textContent === 'Querying device', 3000, 'progress UI');
    const b = bar(t)!;
    expect(b.getAttribute('aria-label')).toBe('Connection progress');
    expect(b.getAttribute('aria-valuetext')).toContain('Querying device');
    const atQuery = valueNow(t);
    expect(atQuery).toBeGreaterThan(0);
    expect(atQuery).toBeLessThan(50);
    expect(t.query('.chip .spinner')).not.toBeNull();
    expect(t.query('.chip .dot')).toBeNull();
    expect(t.query('[data-field="connect-percent"]')?.textContent).toBe(`${atQuery}%`);
    expect(t.query('[data-section="connect-progress"] mc-progress-bar')).not.toBeNull();

    // let it run to the second contact, then pause mid-sync
    let contacts = 0;
    gate.release((code) => code === RESP_CONTACT && ++contacts === 2);
    await t.until(() => gate.holding, 5000, 'second contact held');
    await t.until(() => /^Syncing contacts \(1\/\d+\)$/.test(t.query('[data-field="chip-label"]')?.textContent ?? ''), 3000, 'contacts (1/n)');
    expect(t.query('[data-field="connect-step"]')?.textContent).toMatch(/^Syncing contacts \(1\/\d+\)$/);
    expect(valueNow(t)).toBeGreaterThan(atQuery);

    gate.release();
    await t.until(() => t.app.connection.phase.value === 'connected', 5000, 'connected');
    expect(t.query('.chip .spinner')).toBeNull();
    expect(t.query('[data-field="chip-label"]')?.textContent).toBe('Connected');
    // the top bar finishes at 100% (if it was still rendered) and is then removed
    const finishing = t.query('[data-field="connect-progress"]');
    if (finishing) expect(valueNow(t)).toBe(100);
    await t.until(() => !t.query('[data-field="connect-progress"]'), 3000, 'bar removed');
  });

  it('removes the bar after a failed connect', async () => {
    let fail: (e: Error) => void = () => undefined;
    const broken = (): FrameTransport => ({
      kind: 'serial',
      state: 'disconnected',
      info: { kind: 'serial', name: 'broken' },
      events: new TypedEmitter<TransportEvents>(),
      connect: () => new Promise<void>((_, reject) => (fail = reject)),
      disconnect: () => Promise.resolve(),
      send: () => Promise.reject(new Error('closed')),
    });
    const t = (h = createHarness({ app: { createSerialTransport: broken } }));
    await t.mount();
    await t.click('[data-connect="serial"]');
    await t.until(() => bar(t), 3000, 'bar while opening');
    expect(valueNow(t)).toBe(0);
    expect(t.query('[data-field="chip-label"]')?.textContent).toBe('Opening connection');
    fail(new Error('Failed to open serial port.'));
    await t.until(() => t.app.connection.phase.value === 'error', 3000, 'error');
    await t.until(() => !t.query('[data-field="connect-progress"]') && !t.query('[data-section="connect-progress"]'), 3000, 'bar gone');
    expect(t.query('.chip .dot')).not.toBeNull();
  });
});
