/**
 * Regions of TRANSPORT_FLOOD packets (docs/mesh-packet-format.md §1.2): identified by testing the
 * known region keys against transport_code[0], in the packet summary, the annotator, the packet
 * log (rows, filter, chips, search), the statistics, and on received channel messages.
 */

import { describe, expect, it, vi } from 'vitest';
import { PayloadType, RouteType } from '../packet/constants.js';
import { buildPacket } from '../packet/packet.js';
import { annotatePacket } from '../packet/annotate.js';
import { buildGrpTxtPlaintext } from '../packet/payloads.js';
import { UNKNOWN_REGION, matchRegionCode, packetRegion } from '../packet/regions.js';
import { channelHashSync, transportCodeSync } from '../emulator/crypto-sync.js';
import { envelope, groupPayload } from '../emulator/mesh-packets.js';
import { publicChannelSecret } from '../emulator/scenarios.js';
import { channelKeyForPsk } from '../store/channels.js';
import type { PacketRecord } from '../store/schema.js';
import { packetFilterChips, withoutChip } from './packet-log-model.js';
import { viewPacket } from './packet-summary.js';
import { statsFiltersOf, withStatsFilter, withoutStatsFilter } from './packet-stats-model.js';
import { regionKeySync } from './regions-model.js';
import { connectedApp } from './testing.js';

const EAST = regionKeySync('east');
const WEST = regionKeySync('west');
const KEYS = new Map([
  ['east', EAST],
  ['west', WEST],
]);

const PSK = publicChannelSecret();
const HASH = channelHashSync(PSK);

/** A GRP_TXT on Public; `key` = region key → TRANSPORT_FLOOD (§1.2), else FLOOD. `hops` relays appended. */
function grpTxt(text: string, key: Uint8Array | null, hops: number[] = []): Uint8Array {
  const payload = groupPayload(HASH, PSK, buildGrpTxtPlaintext({ timestamp: 1_700_000_000, senderName: 'Bob', text }));
  const raw = envelope(PayloadType.GRP_TXT, payload, { path: null, scopeKey: key });
  if (!hops.length) return raw;
  // [header][codes?][path_len][path][payload]: rebuild with the relays' hashes
  const scoped = key !== null;
  return buildPacket({
    routeType: scoped ? RouteType.TRANSPORT_FLOOD : RouteType.FLOOD,
    payloadType: PayloadType.GRP_TXT,
    ...(scoped ? { transportCodes: [transportCodeSync(key, PayloadType.GRP_TXT, payload), 0] as const } : {}),
    path: Uint8Array.from(hops),
    payload,
  });
}

function rec(bytes: Uint8Array, id = 1): PacketRecord {
  return { id, ts: 1000, direction: 'rx', format: 'packet', bytes, routeType: bytes[0]! & 3, payloadType: (bytes[0]! >> 2) & 0x0f, pathLen: 0, hash: `h${id}`, source: 'logRxData' };
}

describe('matchRegionCode / packetRegion', () => {
  it('names the known region whose key gives transport_code[0]', () => {
    const raw = grpTxt('hi', EAST);
    // bytes 1..2 = transport_code[0] u16 LE (§1.2)
    const code = raw[1]! | (raw[2]! << 8);
    const payload = raw.subarray(6);
    expect(code).toBe(transportCodeSync(EAST, PayloadType.GRP_TXT, payload));
    expect(matchRegionCode(KEYS, code, PayloadType.GRP_TXT, payload)).toBe('east');
    expect(matchRegionCode(new Map([['west', WEST]]), code, PayloadType.GRP_TXT, payload)).toBeNull();
    // two names, one key: still unique
    expect(matchRegionCode(new Map([['east', EAST], ['alias', EAST]]), code, PayloadType.GRP_TXT, payload)).toBe('east');
  });

  it('is ambiguous (null) when two distinct keys give the code', () => {
    // find a second key colliding on 16 bits for this payload
    const payload = Uint8Array.of(HASH, 1, 2, 3);
    const code = transportCodeSync(EAST, PayloadType.GRP_TXT, payload);
    let other: Uint8Array | null = null;
    for (let i = 0; i < 400_000 && !other; i++) {
      const k = regionKeySync(`r${i}`);
      if (transportCodeSync(k, PayloadType.GRP_TXT, payload) === code) other = k;
    }
    expect(other).not.toBeNull();
    expect(matchRegionCode(new Map([['east', EAST], ['twin', other!]]), code, PayloadType.GRP_TXT, payload)).toBeNull();
  });

  it('only TRANSPORT_FLOOD packets have a region; no keys → unknown', () => {
    const p = { payloadType: PayloadType.GRP_TXT, payload: Uint8Array.of(1), transportCodes: [5, 0] as const };
    expect(packetRegion({ ...p, routeType: RouteType.TRANSPORT_DIRECT }, KEYS)).toBeUndefined();
    expect(packetRegion({ ...p, routeType: RouteType.FLOOD, transportCodes: undefined }, KEYS)).toBeUndefined();
    expect(packetRegion({ ...p, routeType: RouteType.TRANSPORT_FLOOD }, undefined)).toBe(UNKNOWN_REGION);
  });
});

describe('viewPacket region', () => {
  it('known region, unknown region, no region keys, unscoped', () => {
    const scoped = rec(grpTxt('hi', EAST));
    expect(viewPacket(scoped, { nodes: [], channels: [], regions: KEYS }).region).toBe('east');
    expect(viewPacket(scoped, { nodes: [], channels: [], regions: KEYS }).transportCodes?.[1]).toBe(0);
    expect(viewPacket(rec(grpTxt('hi', regionKeySync('north'))), { nodes: [], channels: [], regions: KEYS }).region).toBe(UNKNOWN_REGION);
    expect(viewPacket(scoped).region).toBe(UNKNOWN_REGION);
    expect(viewPacket(rec(grpTxt('hi', null))).region).toBeUndefined();
  });
});

describe('annotatePacket transport codes', () => {
  it('names the region with region keys; says unknown when none match; unchanged without keys', async () => {
    const raw = grpTxt('hi', EAST);
    const code = (a: Awaited<ReturnType<typeof annotatePacket>>) => {
      const tc = a.children!.find((n) => n.name === 'transport codes')!;
      return { tc: tc.meaning, c0: tc.children![0]!.meaning };
    };
    expect(code(await annotatePacket(raw, { keys: { regions: KEYS } }))).toEqual({ tc: 'region "#east"', c0: 'region "#east"' });
    const unknown = 'unknown region (not in saved list)';
    expect(code(await annotatePacket(raw, { keys: { regions: new Map([['west', WEST]]) } }))).toEqual({ tc: unknown, c0: unknown });
    expect(code(await annotatePacket(raw))).toEqual({ tc: 'region scope codes (need region keys to verify)', c0: 'region code' });
  });
});

describe('packet filter and stats filter: region', () => {
  it('chip, removal and the drill-down mapping', () => {
    expect(packetFilterChips({ region: 'east' })).toEqual([{ key: 'region', name: 'Region', value: '#east', label: 'Region: #east' }]);
    expect(packetFilterChips({ region: UNKNOWN_REGION })[0]!.value).toBe('unknown region');
    expect(withoutChip({ region: 'east', text: 'x' }, 'region')).toEqual({ text: 'x' });
    const f = withStatsFilter({}, { field: 'region', value: 'east', label: '#east' });
    expect(f).toEqual({ region: 'east' });
    expect(statsFiltersOf(f)).toEqual([{ field: 'region', value: 'east', label: '#east' }]);
    expect(withoutStatsFilter(f, 'region')).toEqual({});
  });
});

describe('packet log, statistics and messages: regions from the saved list', () => {
  async function setup() {
    const t = await connectedApp();
    t.app.regions.add('east');
    const emu = t.scenario.emulator;
    const chKey = await channelKeyForPsk(PSK);
    return { t, emu, chKey };
  }

  it('rows, filter, search and stats show the region; they follow the saved list', async () => {
    const { t, emu } = await setup();
    const log = t.app.packetLog;
    const stats = t.app.packetStats;
    emu.injectRxPacket(grpTxt('scoped east', EAST, [0x51]));
    emu.injectRxPacket(grpTxt('scoped west', WEST, [0x52]));
    emu.injectRxPacket(grpTxt('plain', null, [0x53]));
    const regionsOf = () =>
      log.packets.rows.value
        .filter((r) => r.typeName === 'GRP_TXT')
        .map((r) => r.region ?? '-')
        .sort();
    await vi.waitFor(async () => {
      await t.app.connection.capture!.idle();
      await log.settled();
      expect(regionsOf()).toEqual(['-', '?', 'east']);
    });

    await log.packets.setFilter({ region: 'east' });
    await log.settled();
    expect(log.packets.rows.value.map((r) => r.region)).toEqual(['east']);
    await log.packets.setFilter({ region: UNKNOWN_REGION }, { replace: true });
    await log.settled();
    expect(log.packets.rows.value.map((r) => r.summary)).toEqual(['GRP_TXT Public: "Bob: scoped west"']);
    await log.packets.setFilter({ text: '#east' }, { replace: true });
    await log.settled();
    expect(log.packets.rows.value.map((r) => r.summary)).toEqual(['GRP_TXT Public: "Bob: scoped east"']);
    await log.packets.setFilter({}, { replace: true });

    await stats.settled();
    const by = () => Object.fromEntries(stats.utilization.value.byRegion.map((b) => [b.name, b.count]));
    expect(by()).toEqual({ east: 1, [UNKNOWN_REGION]: 1 });
    await stats.addFilter({ field: 'region', value: 'east', label: '#east' });
    expect(stats.points.value.map((p) => p.region)).toEqual(['east']);
    await log.packets.setFilter({}, { replace: true });

    // saving "west" re-identifies the logged packets
    t.app.regions.add('west');
    expect(by()).toEqual({ east: 1, west: 1 });
    await vi.waitFor(async () => {
      await log.settled();
      expect(regionsOf()).toEqual(['-', 'east', 'west']);
    });
    const west = log.packets.rows.value.find((r) => r.region === 'west')!;
    const insp = await log.inspect(west.id);
    expect(insp!.view.region).toBe('west');
    expect(insp!.annotation.children!.find((n) => n.name === 'transport codes')!.meaning).toBe('region "#west"');
  });

  it('a received channel message records the region it arrived in (relayed and zero hop)', async () => {
    const { t, emu, chKey } = await setup();
    const store = t.app.connection.store.value!;
    emu.injectRxPacket(grpTxt('relayed in east', EAST, [0x61, 0x62]));
    emu.injectRxPacket(grpTxt('zero hop in east', EAST));
    emu.injectRxPacket(grpTxt('in north', regionKeySync('north'), [0x63]));
    emu.injectRxPacket(grpTxt('unscoped', null, [0x64]));
    const msgs = await vi.waitFor(async () => {
      await t.app.connection.capture!.idle();
      const items = (await store.messages.list(chKey)).items.filter((m) => m.direction === 'in');
      expect(items.map((m) => m.text)).toEqual(expect.arrayContaining(['relayed in east', 'zero hop in east', 'in north', 'unscoped']));
      return items;
    });
    const by = (text: string) => msgs.find((m) => m.text === text)!;
    expect(by('relayed in east').region).toBe('east');
    expect([...by('relayed in east').path!]).toEqual([0x61, 0x62]);
    expect(by('zero hop in east').region).toBe('east');
    expect(by('zero hop in east').path).toBeUndefined();
    expect(by('in north').region).toBeUndefined();
    expect(by('unscoped').region).toBeUndefined();
  });
});
