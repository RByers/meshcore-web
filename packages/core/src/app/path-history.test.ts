import { describe, expect, it, vi } from 'vitest';
import { PATH_LEN_UNKNOWN, encodePathLen } from '../protocol/constants.js';
import { RouteType } from '../packet/constants.js';
import { parsePacket } from '../packet/packet.js';
import type { PathHistoryEntry } from '../store/schema.js';
import { toHex } from '../util/bytes.js';
import type { AppModelOptions } from './app-model.js';
import { FAST_RETRY, connectedApp } from './testing.js';
import { FAST_TIMING } from '../emulator/scenarios.js';
import { MAX_PATH_HISTORY, encodeHops, pathCandidates, pathId, resolvePathHops, updateHistory, type PathCandidate } from './path-history.js';

async function connected(over: AppModelOptions = {}) {
  const t = await connectedApp({ app: over });
  const { app, scenario, keys, store } = t;
  await vi.waitFor(() => expect(app.contacts.contacts.value).toHaveLength(6));
  return { t, app, s: scenario, bob: keys.bob, repeater: keys.repeater, store };
}

const cand = (name: string, key: number[]): PathCandidate => ({
  key: toHex(Uint8Array.from(key)),
  name,
  kind: 'repeater',
  pubKey: Uint8Array.from(key),
  prefix: toHex(Uint8Array.from(key)),
  lat: 0,
  lon: 0,
  hasLocation: false,
});

describe('path helpers', () => {
  it('encodes hop lists as out_path_len / out_path (path_len bits 6-7 = hash size - 1, bits 0-5 = hops; mesh-packet-format.md §1.3)', () => {
    expect(encodeHops([Uint8Array.of(0xa1), Uint8Array.of(0xb2)])).toEqual({ pathLen: 0x02, path: Uint8Array.of(0xa1, 0xb2) });
    expect(encodeHops([Uint8Array.of(0xa1, 0xa2), Uint8Array.of(0xb1, 0xb2)])).toEqual({ pathLen: 0x42, path: Uint8Array.of(0xa1, 0xa2, 0xb1, 0xb2) });
    expect(encodeHops([])).toEqual({ pathLen: 0x00, path: new Uint8Array(0) });
    expect(() => encodeHops([Uint8Array.of(1), Uint8Array.of(1, 2)])).toThrow(/same hash size/);
    expect(() => encodeHops(Array.from({ length: 65 }, () => Uint8Array.of(1)))).toThrow(/64 bytes/);
    expect(pathId(0xff, Uint8Array.of(1))).toBe('flood');
    expect(pathId(0x42, Uint8Array.of(0xa1, 0xa2, 0xb1, 0xb2, 0xff))).toBe('66:a1a2b1b2');
  });

  it('resolves hops to repeater names by public key prefix', () => {
    const cs = [cand('Hill', [0xa1, 0x10]), cand('Valley', [0xb2, 0x20]), cand('Vale', [0xb2, 0x30])];
    expect(resolvePathHops(PATH_LEN_UNKNOWN, new Uint8Array(0), cs).label).toBe('flood');
    expect(resolvePathHops(0, new Uint8Array(0), cs).label).toBe('direct');
    const r = resolvePathHops(encodePathLen(3), Uint8Array.of(0xa1, 0xb2, 0xc3), cs);
    expect(r.kind).toBe('hops');
    expect(r.hops.map((h) => h.label)).toEqual(['Hill', 'Valley | Vale', 'c3']);
    expect(r.label).toBe('Hill → Valley | Vale → c3');
    expect(resolvePathHops(encodePathLen(1, 2), Uint8Array.of(0xb2, 0x30), cs).label).toBe('Vale');
  });

  it('keeps the history newest first and capped', () => {
    let h: PathHistoryEntry[] = [];
    for (let i = 0; i < MAX_PATH_HISTORY + 5; i++) h = updateHistory(h, 1, Uint8Array.of(i), (e) => ({ ...e, lastUsed: i }), { touch: true });
    expect(h).toHaveLength(MAX_PATH_HISTORY);
    expect(h[0]!.path).toEqual(Uint8Array.of(MAX_PATH_HISTORY + 4));
    // without touch an existing entry keeps its place
    const again = updateHistory(h, 1, Uint8Array.of(10), (e) => ({ ...e, attempts: 9 }));
    expect(again.findIndex((e) => e.attempts === 9)).toBe(h.findIndex((e) => e.path[0] === 10));
  });

  it('lists repeaters and room servers as candidates', () => {
    expect(pathCandidates([]).length).toBe(0);
  });
});

describe('ContactPathsModel', () => {
  it('lists the repeaters (with locations) as candidates', async () => {
    const { app, repeater } = await connected();
    const cands = app.contactPaths.candidatesFor('00');
    expect(cands.map((c) => c.name)).toEqual(['Hilltop Repeater', 'Town Square']);
    expect(cands[0]).toMatchObject({ key: repeater, kind: 'repeater', prefix: repeater.slice(0, 12), hasLocation: true, lat: 47.62 });
    expect(app.contactPaths.candidatesFor(repeater).map((c) => c.name)).toEqual(['Town Square']);
  });

  it('setPath updates the device contact and the next DM goes out over that path; flood resets it', async () => {
    const { app, s, bob, store } = await connected();
    const hop = s.keys.repeater.slice(0, 1);
    await app.contactPaths.setPath(bob, [hop]);
    const rec = (await store.contacts.get(bob))!;
    expect(rec.outPathLen).toBe(encodePathLen(1));
    expect(rec.outPath).toEqual(hop);
    expect(app.contactPaths.current(bob)?.label).toBe('Hilltop Repeater');
    expect(app.contacts.view(bob)?.path.label).toBe('1 hop');
    // the device's own record changed too
    const dev = await app.connection.client.peek()!.getContactByKey(s.keys.bob);
    expect(dev?.outPathLen).toBe(encodePathLen(1));

    const chat = app.chat('contact', bob);
    await chat.settled();
    const done = await (await chat.send('via the hill')).done;
    expect(done.status).toBe('delivered');
    const tx = s.emulator.airLog.filter((e) => e.type === 'txtMsg').at(-1)!;
    const p = parsePacket((tx as unknown as { raw: Uint8Array }).raw);
    expect(p.routeType).toBe(RouteType.DIRECT);
    expect(p.path).toEqual(hop);

    await app.contactPaths.idle();
    await vi.waitFor(() => expect(app.contactPaths.history(bob)[0]).toMatchObject({ id: '1:' + toHex(hop), current: true }));
    const e = app.contactPaths.history(bob)[0]!.entry;
    expect(e).toMatchObject({ attempts: 1, successes: 1, failures: 0, lastResult: 'success' });
    expect(e.roundTripMs).toBeGreaterThanOrEqual(FAST_TIMING.ackDelayMs); // the shared clock times the emulated ACK delay

    await app.contactPaths.setPath(bob, 'flood');
    expect((await store.contacts.get(bob))!.outPathLen).toBe(PATH_LEN_UNKNOWN);
    await vi.waitFor(() => expect(app.contactPaths.history(bob).find((h) => h.current)?.id).toBe('flood'));
  });

  it('records failures on timeout (per path used, including the flood fallback) and success on retry', async () => {
    const { t, app, s, bob } = await connected({ messaging: { retry: FAST_RETRY } });
    const hop = s.keys.repeater.slice(0, 1);
    await app.contactPaths.setPath(bob, [hop]);
    s.nodes.bob.config.ackPolicy = 'never';
    const chat = app.chat('contact', bob);
    await chat.settled();
    const h = await chat.send('anyone?');
    await t.missAck(); // attempt 0, direct via the repeater
    await t.missAck(); // attempt 1, the flood fallback
    const failed = await h.done;
    expect(failed.status).toBe('failed');
    const routes = s.emulator.airLog.filter((e) => e.type === 'txtMsg').map((e) => parsePacket((e as unknown as { raw: Uint8Array }).raw).routeType);
    expect(routes.slice(-2)).toEqual([RouteType.DIRECT, RouteType.FLOOD]);
    await app.contactPaths.idle();
    await vi.waitFor(() => expect(app.contactPaths.history(bob).find((h) => h.id === 'flood')?.entry.failures).toBe(1));
    const byId = () => new Map(app.contactPaths.history(bob).map((h) => [h.id, h.entry]));
    expect(byId().get(`1:${toHex(hop)}`)).toMatchObject({ attempts: 1, successes: 0, failures: 1, lastResult: 'failure' });
    expect(byId().get('flood')).toMatchObject({ attempts: 1, successes: 0, failures: 1 });

    s.nodes.bob.config.ackPolicy = 'auto';
    const ok = await (await chat.retry(failed.id)).done;
    expect(ok.status).toBe('delivered');
    await app.contactPaths.idle();
    // the path was reset by the first send's fallback, so the retry floods
    await vi.waitFor(() => expect(byId().get('flood')).toMatchObject({ attempts: 2, successes: 1, failures: 1, lastResult: 'success' }));
    // the flood ACK taught the device a path back: it is remembered as observed
    await vi.waitFor(() => expect(app.contactPaths.history(bob).some((h) => h.entry.observed)).toBe(true));

    // history survives a device re-sync (merged with local fields)
    await app.contacts.refresh();
    expect(byId().get('flood')?.successes).toBe(1);
    await app.contactPaths.forget(bob, 'flood');
    await vi.waitFor(() => expect(byId().has('flood')).toBe(false));
  });
});
