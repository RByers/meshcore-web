import type { FrameTransport, TransportState } from '@meshcore-web/core/transport';
import { toHex } from '@meshcore-web/core/util/bytes';

export interface FrameCollector {
  /** Frames received so far, as hex. */
  readonly hex: string[];
  /** Resolves once at least `n` frames have arrived (rejects after `timeoutMs`). */
  count(n: number, timeoutMs?: number): Promise<void>;
}

/** Collects `frame` events and lets a test await a frame count instead of polling. */
export function collectFrames(t: FrameTransport): FrameCollector {
  const hex: string[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  t.events.on('frame', (f) => {
    hex.push(toHex(f));
    for (const w of waiters.splice(0)) {
      if (hex.length >= w.n) w.resolve();
      else waiters.push(w);
    }
  });
  return {
    hex,
    count: (n, timeoutMs = 2000) =>
      hex.length >= n
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out waiting for ${n} frames (got ${hex.length})`)), timeoutMs);
            waiters.push({ n, resolve: () => (clearTimeout(timer), resolve()) });
          }),
  };
}

/** Resolves when the transport reaches `state` (immediately if it already has). */
export function stateReached(t: FrameTransport, state: TransportState, timeoutMs = 2000): Promise<void> {
  if (t.state === state) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => (off(), reject(new Error(`timed out waiting for state ${state} (now ${t.state})`))), timeoutMs);
    const off = t.events.on('state', (s) => {
      if (s === state) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}
