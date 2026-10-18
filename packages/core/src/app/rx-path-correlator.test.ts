import { describe, expect, it } from 'vitest';
import { buildPacket } from '../packet/packet.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import { buildAdvertPayload } from '../packet/payloads.js';
import { encodePathLen } from '../protocol/constants.js';
import { scenarioIdentity } from '../emulator/scenarios.js';
import { toHex } from '../util/bytes.js';
import { RxPathCorrelator } from './rx-path-correlator.js';

/** mesh-packet-format.md §3.2: TXT_MSG payload = dest_hash(1) src_hash(1) mac(2) ciphertext. */
function txt(dest: number, src: number, path: number[], route: RouteType = RouteType.FLOOD): Uint8Array {
  return buildPacket({ routeType: route, payloadType: PayloadType.TXT_MSG, path: Uint8Array.from(path), payload: Uint8Array.of(dest, src, 0xaa, 0xbb, ...new Array<number>(16).fill(7)) });
}

/** §3.6: GRP_TXT payload = channel_hash(1) mac(2) ciphertext. */
function grp(channel: number, path: number[], filler = 1): Uint8Array {
  return buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.GRP_TXT, path: Uint8Array.from(path), payload: Uint8Array.of(channel, 0xaa, 0xbb, ...new Array<number>(16).fill(filler)) });
}

let id = 0;
function rec(bytes: Uint8Array, ts: number, hash = `h${++id}`, snr?: number) {
  return { direction: 'rx' as const, format: 'packet' as const, bytes, ts, hash, ...(snr !== undefined ? { snr } : {}) };
}

describe('RxPathCorrelator', () => {
  it('matches a DM to the earliest unclaimed TXT_MSG flood packet from the sender with the same path_len', () => {
    const c = new RxPathCorrelator();
    c.observe(rec(txt(0x11, 0x22, [0x99]), 1000)); // different path_len
    c.observe(rec(txt(0x11, 0x33, [0xa1, 0xb2]), 1100)); // other sender
    c.observe(rec(txt(0x11, 0x22, [0xa1, 0xb2]), 1200, 'dup'));
    c.observe(rec(txt(0x11, 0x22, [0xa1, 0xc3]), 1300, 'dup')); // re-heard copy, same packet hash
    c.observe(rec(txt(0x11, 0x22, [0xd4, 0xe5]), 1400));
    const q = { pathLen: encodePathLen(2), senderHash: 0x22, selfHash: 0x11, now: 2000 };
    expect([...c.claimContactMessage(q)!]).toEqual([0xa1, 0xb2]);
    // the copy was claimed with it; the next message gets the next packet
    expect([...c.claimContactMessage(q)!]).toEqual([0xd4, 0xe5]);
    expect(c.claimContactMessage(q)).toBeUndefined();
    expect(c.claimContactMessage({ ...q, selfHash: 0x12 })).toBeUndefined();
  });

  it('claims a copy re-heard after its packet was claimed, so the next message gets its own path', () => {
    const c = new RxPathCorrelator();
    const q = { pathLen: encodePathLen(2), channelHash: 0x06 };
    c.observe(rec(grp(0x06, [0xa1, 0xb2]), 1000, 'first'));
    expect([...c.claimChannelMessage({ ...q, now: 1100 })!]).toEqual([0xa1, 0xb2]);
    c.observe(rec(grp(0x06, [0xc3, 0xd4]), 1200, 'first')); // late copy of the first message
    c.observe(rec(grp(0x06, [0xe5, 0xf6], 2), 1300, 'second'));
    expect([...c.claimChannelMessage({ ...q, now: 1400 })!]).toEqual([0xe5, 0xf6]);
    expect(c.claimChannelMessage({ ...q, now: 1500 })).toBeUndefined();
  });

  it('never matches zero-hop or direct-routed (0xFF) messages, or stale packets', () => {
    const c = new RxPathCorrelator({ maxAgeMs: 1000 });
    c.observe(rec(txt(0x11, 0x22, []), 0));
    c.observe(rec(txt(0x11, 0x22, [], RouteType.DIRECT), 0));
    c.observe(rec(txt(0x11, 0x22, [0x01]), 0));
    expect(c.claimContactMessage({ pathLen: 0, senderHash: 0x22, now: 10 })).toBeUndefined();
    expect(c.claimContactMessage({ pathLen: 0xff, senderHash: 0x22, now: 10 })).toBeUndefined();
    expect(c.claimContactMessage({ pathLen: encodePathLen(1), senderHash: 0x22, now: 5000 })).toBeUndefined();
    expect([...c.claimContactMessage({ pathLen: encodePathLen(1), senderHash: 0x22, now: 500 })!]).toEqual([1]);
  });

  it('matches channel messages by channel hash', () => {
    const c = new RxPathCorrelator();
    c.observe(rec(grp(0x05, [0x0a]), 1));
    c.observe(rec(grp(0x06, [0x0b], 2), 2));
    expect([...c.claimChannelMessage({ pathLen: encodePathLen(1), channelHash: 0x06, now: 3 })!]).toEqual([0x0b]);
    expect(c.claimChannelMessage({ pathLen: encodePathLen(1), channelHash: 0x06, now: 3 })).toBeUndefined();
  });

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

  it('claimChannelPacket returns the packet (transport codes included), zero-hop floods too', () => {
    const c = new RxPathCorrelator();
    const payload = Uint8Array.of(0x06, 0xaa, 0xbb, ...new Array<number>(16).fill(3));
    // §1.2: TRANSPORT_FLOOD = [header][code0 u16][code1 u16][path_len][path][payload]
    c.observe(rec(buildPacket({ routeType: RouteType.TRANSPORT_FLOOD, payloadType: PayloadType.GRP_TXT, transportCodes: [0x1234, 0], payload }), 1000, 'z'));
    c.observe(rec(buildPacket({ routeType: RouteType.TRANSPORT_FLOOD, payloadType: PayloadType.GRP_TXT, transportCodes: [0x4321, 0], path: Uint8Array.of(0xa1), payload: payload.map((b, i) => (i === 3 ? 9 : b)) }), 1100, 'r'));
    // the path-only API still ignores zero-hop messages
    expect(c.claimChannelMessage({ pathLen: 0, channelHash: 0x06, now: 1200 })).toBeUndefined();
    const zero = c.claimChannelPacket({ pathLen: 0, channelHash: 0x06, now: 1200 })!;
    expect(zero.path).toBeUndefined();
    expect(zero.packet.transportCodes).toEqual([0x1234, 0]);
    expect(c.claimChannelPacket({ pathLen: 0, channelHash: 0x06, now: 1200 })).toBeUndefined();
    const relayed = c.claimChannelPacket({ pathLen: encodePathLen(1), channelHash: 0x06, now: 1200 })!;
    expect([...relayed.path!]).toEqual([0xa1]);
    expect(relayed.packet.routeType).toBe(RouteType.TRANSPORT_FLOOD);
    expect(relayed.packet.transportCodes).toEqual([0x4321, 0]);
  });
});
