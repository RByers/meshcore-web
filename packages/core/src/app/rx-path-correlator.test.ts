import { describe, expect, it } from 'vitest';
import { buildPacket } from '../packet/packet.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import { buildAdvertPayload } from '../packet/payloads.js';
import { scenarioIdentity } from '../emulator/scenarios.js';
import { toHex } from '../util/bytes.js';
import { RxPathCorrelator } from './rx-path-correlator.js';

let id = 0;
function rec(bytes: Uint8Array, ts: number, hash = `h${++id}`, snr?: number) {
  return { direction: 'rx' as const, format: 'packet' as const, bytes, ts, hash, ...(snr !== undefined ? { snr } : {}) };
}

describe('RxPathCorrelator', () => {
  it('reports zero-hop adverts with SNR as direct hearings, and caps its memory', async () => {
    const c = new RxPathCorrelator({ capacity: 2 });
    const alice = scenarioIdentity('alice');
    const payload = await buildAdvertPayload({ keys: { publicKey: alice.publicKey, seed: alice.seed }, timestamp: 1, appData: { nodeType: 1, name: 'Alice' } });
    const zeroHop = buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.ADVERT, payload });
    const relayed = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, path: Uint8Array.of(9), payload });
    expect(c.observe(rec(zeroHop, 50, 'a', 7.25))).toEqual({ key: toHex(alice.publicKey), snr: 7.25, ts: 50 });
    expect(c.observe(rec(relayed, 60, 'b', 3))).toBeNull();
    expect(c.observe(rec(zeroHop, 70, 'c'))).toBeNull(); // no SNR
    expect(c.observe({ ...rec(zeroHop, 80, 'd', 1), direction: 'tx' })).toBeNull();
    expect(c.size).toBe(2);
  });
});
