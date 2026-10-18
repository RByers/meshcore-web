import { describe, expect, it, vi } from 'vitest';
import { concatBytes, toHex, u32le, utf8Encode } from '../util/bytes.js';
import { regionKey } from '../packet/packet.js';
import { PayloadType } from '../packet/constants.js';
import { PATH_LEN_UNKNOWN } from '../protocol/constants.js';
import { RemoteTimeoutError } from '../client/errors.js';
import { transportCodeSync } from '../emulator/crypto-sync.js';
import { memoryPreferences } from './connection.js';
import {
  PREF_REGIONS,
  normalizeRegionName,
  parseRegionsReply,
  regionKeySync,
  regionsRequestData,
  reverseHops,
  validateRegionName,
} from './regions-model.js';
import { connectedApp, testApp } from './testing.js';

describe('region helpers', () => {
  it('normalises and validates names (lowercase letters, digits, "-", ≤ 30 bytes)', () => {
    expect(normalizeRegionName('  #east ')).toBe('east');
    expect(validateRegionName('east-2')).toBeNull();
    expect(validateRegionName('')).toMatch(/empty/);
    expect(validateRegionName('East')).toMatch(/lowercase/);
    expect(validateRegionName('$priv')).toMatch(/lowercase/);
    expect(validateRegionName('a'.repeat(30))).toBeNull();
    expect(validateRegionName('a'.repeat(31))).toMatch(/30 bytes/);
  });

  it('region key is SHA256("#name")[0..16] (mesh-packet-format.md §1.2), sync = async', async () => {
    // pinned vector: sha256("#east")
    expect(toHex(regionKeySync('east'))).toBe('1874f86a783c53a023ac9117b63842b9');
    expect(toHex(regionKeySync('#east'))).toBe('1874f86a783c53a023ac9117b63842b9');
    expect(toHex(regionKeySync('test'))).toBe(toHex(await regionKey('test')));
  });

  it('parseRegionsReply: [now u32][names joined by ","] (§3.8, RegionMap::exportNamesTo)', () => {
    const data = concatBytes(u32le(0x6650_0000), utf8Encode('*,east,west-1,$priv,Bad,east,'));
    expect(parseRegionsReply(data)).toEqual(['east', 'west-1']);
    expect(parseRegionsReply(concatBytes(u32le(1), utf8Encode('*')))).toEqual([]);
    expect(parseRegionsReply(u32le(1))).toEqual([]);
    expect(parseRegionsReply(new Uint8Array(0))).toEqual([]);
    // a NUL terminator ends the list
    expect(parseRegionsReply(concatBytes(u32le(1), utf8Encode('north'), Uint8Array.of(0, 0x41)))).toEqual(['north']);
  });

  it('request data: [0x01][reply_path_len][reply_path] (§3.8)', () => {
    expect(toHex(regionsRequestData(0))).toBe('0100');
    expect(toHex(regionsRequestData(0x42, Uint8Array.of(0xaa, 0xbb, 0xcc, 0xdd)))).toBe('0142aabbccdd');
    expect(toHex(reverseHops(Uint8Array.of(1, 2, 3), 1))).toBe('030201');
    expect(toHex(reverseHops(Uint8Array.of(1, 2, 3, 4), 2))).toBe('03040102');
  });
});

describe('RegionsModel: saved list', () => {
  it('adds (sorted, deduped, "#" stripped), persists, removes', () => {
    const prefs = memoryPreferences({ [PREF_REGIONS]: JSON.stringify(['west', 'BAD', 'east']) });
    const { app } = testApp({ app: { preferences: prefs } });
    const r = app.regions;
    expect(r.names.value).toEqual(['east', 'west']);
    expect(r.add('#north')).toBe(true);
    expect(r.add('north')).toBe(false);
    expect(() => r.add('No Way')).toThrow(/lowercase/);
    expect(r.addAll(['south', 'east', '*', 'south', '#up'])).toBe(2);
    expect(r.names.value).toEqual(['east', 'north', 'south', 'up', 'west']);
    expect(JSON.parse(prefs.getItem(PREF_REGIONS)!)).toEqual(['east', 'north', 'south', 'up', 'west']);
    expect(toHex(r.keys.value.get('north')!)).toBe(toHex(regionKeySync('north')));
    void r.remove('north');
    expect(r.names.value).not.toContain('north');
    expect(r.keys.value.has('north')).toBe(false);
  });

  it('tolerates a corrupt preference', () => {
    const { app } = testApp({ app: { preferences: memoryPreferences({ [PREF_REGIONS]: '{nope' }) } });
    expect(app.regions.names.value).toEqual([]);
  });

  it('resolveCode: the unique saved region whose key gives the code; ambiguous → null', () => {
    const { app } = testApp();
    const r = app.regions;
    r.addAll(['east', 'west']);
    const payload = utf8Encode('some payload');
    const east = transportCodeSync(regionKeySync('east'), PayloadType.GRP_TXT, payload);
    const west = transportCodeSync(regionKeySync('west'), PayloadType.GRP_TXT, payload);
    expect(r.resolveCode(east, PayloadType.GRP_TXT, payload)).toBe('east');
    expect(r.resolveCode(west, PayloadType.GRP_TXT, payload)).toBe('west');
    // pinned collision: east and west give the same code (44505) for this GRP_TXT payload
    const clash = utf8Encode('payload 57565');
    expect(transportCodeSync(regionKeySync('east'), PayloadType.GRP_TXT, clash)).toBe(44505);
    expect(transportCodeSync(regionKeySync('west'), PayloadType.GRP_TXT, clash)).toBe(44505);
    expect(r.resolveCode(44505, PayloadType.GRP_TXT, clash)).toBeNull();
    r.remove('west');
    expect(r.resolveCode(44505, PayloadType.GRP_TXT, clash)).toBe('east');
    const unknown = [2, 3, 4].find((c) => c !== east)!;
    expect(r.resolveCode(unknown, PayloadType.GRP_TXT, payload)).toBeNull();
  });
});

describe('RegionsModel: radio default and channels', () => {
  it('loads the radio default scope on connect and includes its stored key', async () => {
    const t = await connectedApp();
    await t.client.setDefaultFloodScope({ name: 'home', key: await regionKey('home') });
    const r = t.app.regions;
    await vi.waitFor(() => expect(r.radioDefault.value?.name).toBe('home'));
    expect(toHex(r.keys.value.get('home')!)).toBe(toHex(regionKeySync('home')));
    expect(r.names.value).toEqual([]);
  });

  it('remove() clears channels scoped to that region', async () => {
    const t = await connectedApp();
    const ch = (await t.store.channels.list()).find((c) => c.deviceIndex !== null)!;
    t.app.regions.add('east');
    await t.store.channels.update(ch.key, { region: 'east' });
    await t.app.regions.remove('east');
    expect((await t.store.channels.get(ch.key))!.region).toBeUndefined();
  });
});

describe('RegionsModel: fetch from repeaters (anon request 0x01)', () => {
  it('asks a repeater with a known path directly and parses its names', async () => {
    const t = await connectedApp();
    t.scenario.nodes.repeater.remote.config.regions = ['*', 'east', 'west', '$secret'];
    const before = t.client.findContact(t.scenario.keys.repeater)!;
    expect(before.outPathLen).toBe(0);
    const names = await t.app.regions.fetchFromRepeater(t.keys.repeater);
    expect(names).toEqual(['east', 'west']);
    // not added automatically
    expect(t.app.regions.names.value).toEqual([]);
    const req = t.scenario.nodes.repeater.remote.requests.find((x) => x.kind === 'anon')!;
    expect(toHex(req.data).slice(0, 4)).toBe('0100'); // + cipher block padding
    expect(t.client.findContact(t.scenario.keys.repeater)!.outPathLen).toBe(0);
  });

  it('a repeater without a path is asked zero-hop and its path is reset afterwards', async () => {
    const t = await connectedApp();
    t.scenario.nodes.repeater.remote.config.regions = ['north'];
    await t.client.resetPath(t.scenario.keys.repeater);
    const sent: string[] = [];
    t.client.events.on('frame', (e) => {
      if (e.direction === 'out' && e.command) sent.push(e.command);
    });
    expect(await t.app.regions.fetchFromRepeater(t.keys.repeater)).toEqual(['north']);
    expect(sent).toEqual(expect.arrayContaining(['addUpdateContact', 'sendAnonReq', 'resetPath']));
    expect(sent.indexOf('addUpdateContact')).toBeLessThan(sent.indexOf('sendAnonReq'));
    expect(sent.lastIndexOf('resetPath')).toBeGreaterThan(sent.indexOf('sendAnonReq'));
    expect(t.client.findContact(t.scenario.keys.repeater)!.outPathLen).toBe(PATH_LEN_UNKNOWN);
  });

  it('the temporary zero-hop path does not join the path history', async () => {
    const t = await connectedApp();
    t.scenario.nodes.repeater.remote.config.regions = ['north'];
    const paths = t.app.contactPaths;
    await paths.setPath(t.keys.repeater, 'flood');
    await paths.forget(t.keys.repeater, '0:'); // the scenario's repeater started zero-hop
    await paths.idle();
    const before = (await t.store.contacts.get(t.keys.repeater))!.pathHistory ?? [];
    expect(before.some((e) => e.pathLen === 0)).toBe(false);
    expect(await t.app.regions.fetchFromRepeater(t.keys.repeater)).toEqual(['north']);
    await paths.idle();
    const rec = (await t.store.contacts.get(t.keys.repeater))!;
    expect(rec.outPathLen & 0xff).toBe(PATH_LEN_UNKNOWN);
    expect((rec.pathHistory ?? []).some((e) => e.pathLen === 0)).toBe(false);
    // a path the device really learns afterwards is still recorded
    await paths.setPath(t.keys.repeater, []);
    await paths.idle();
    expect((await t.store.contacts.get(t.keys.repeater))!.pathHistory?.some((e) => e.pathLen === 0)).toBe(true);
  });

  it('a flood-routed regions request is ignored (repeaters answer it only direct)', async () => {
    const t = await connectedApp();
    await t.client.resetPath(t.scenario.keys.repeater);
    const p = t.client.anonRequest(t.scenario.keys.repeater, regionsRequestData(0));
    const caught = p.catch((e: unknown) => e);
    await t.missResponse();
    expect(await caught).toBeInstanceOf(RemoteTimeoutError);
    expect(t.scenario.nodes.repeater.remote.requests.some((x) => x.kind === 'anon')).toBe(true);
  });

  it('fetchFromRepeaters asks every repeater contact and reports progress', async () => {
    const t = await connectedApp();
    t.scenario.nodes.repeater.remote.config.regions = ['*', 'west', 'east'];
    const progress: Array<[number, number]> = [];
    const res = await t.app.regions.fetchFromRepeaters({ onProgress: (d, n) => progress.push([d, n]) });
    expect(res).toEqual({ regions: ['east', 'west'], asked: 1, answered: 1 });
    expect(progress).toEqual([[1, 1]]);
    expect(t.app.regions.addAll(res.regions)).toBe(2);
  });

  it('an aborted fetch rejects and still restores the path', async () => {
    const t = await connectedApp();
    await t.client.resetPath(t.scenario.keys.repeater);
    t.scenario.nodes.repeater.remote.config.online = false;
    let sent = false;
    t.client.events.on('frame', (e) => {
      if (e.frame?.kind === 'sent') sent = true;
    });
    const ac = new AbortController();
    const p = t.app.regions.fetchFromRepeater(t.keys.repeater, { signal: ac.signal });
    const caught = p.catch((e: unknown) => e);
    await vi.waitFor(() => expect(sent).toBe(true));
    ac.abort();
    expect(await caught).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(t.client.findContact(t.scenario.keys.repeater)!.outPathLen).toBe(PATH_LEN_UNKNOWN));
    await t.missResponse(); // let the abandoned request time out
  });
});
