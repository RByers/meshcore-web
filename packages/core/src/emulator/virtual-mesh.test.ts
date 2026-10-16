import { describe, expect, it } from 'vitest';
import { bytesEqual, concatBytes, readU32LE, toHex, utf8Encode } from '../util/bytes.js';
import { ContactType, PATH_LEN_UNKNOWN, ReqType, TxtType, encodePathLen } from '../protocol/constants.js';
import { decodeFrame } from '../protocol/decode.js';
import { encodeCommand } from '../protocol/encode.js';
import type { Command, DeviceFrame, LogRxDataPush } from '../protocol/types.js';
import { annotatePacket } from '../packet/annotate.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import { calcSharedSecret } from '../packet/crypto.js';
import { firmwareRejectReasons, parsePacket } from '../packet/packet.js';
import { decryptPayload, parseGrpTxtPlaintext, parsePayload, parseTxtMsgPlaintext, verifyAdvert, parseAdvertPayload } from '../packet/payloads.js';
import { ManualClock } from './clock.js';
import { CompanionEmulator, computeAckCode } from './companion-emulator.js';
import { basicScenario, hashtagChannelSecret, publicChannelSecret, scenarioIdentity } from './scenarios.js';
import type { BasicScenarioOptions } from './scenarios.js';
import { VirtualMesh, meshIdentityFromSeed } from './virtual-mesh.js';

const START = Date.UTC(2026, 9, 15, 12, 0, 0);
const NOW = START / 1000;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

type Kind = DeviceFrame['kind'];
type FrameOf<K extends Kind> = Extract<DeviceFrame, { kind: K }>;

/** basicScenario on a ManualClock, connected; LOG_RX_DATA pushes are collected separately. */
async function mesh(opts: BasicScenarioOptions = {}) {
  const clock = new ManualClock(START);
  const s = basicScenario({ clock, history: false, ...opts });
  const host = s.emulator.createLoopbackTransport();
  const frames: DeviceFrame[] = [];
  const logRx: LogRxDataPush[] = [];
  host.events.on('frame', (b) => {
    const f = decodeFrame(b);
    if (f.kind === 'logRxData') logRx.push(f);
    else frames.push(f);
  });
  await host.connect();
  return {
    ...s,
    clock,
    logRx,
    async send(cmd: Command): Promise<DeviceFrame[]> {
      await host.send(encodeCommand(cmd));
      await settle();
      return frames.splice(0);
    },
    async one<K extends Kind>(cmd: Command, kind: K): Promise<FrameOf<K>> {
      const fs = await this.send(cmd);
      expect(fs.map((f) => f.kind)).toEqual([kind]);
      return fs[0] as FrameOf<K>;
    },
    async advance(ms: number): Promise<DeviceFrame[]> {
      clock.advance(ms);
      await settle();
      return frames.splice(0);
    },
    async drain(): Promise<DeviceFrame[]> {
      const out: DeviceFrame[] = [];
      for (;;) {
        const [f] = await this.send({ kind: 'syncNextMessage' });
        if (!f || f.kind === 'noMoreMessages') return out;
        out.push(f);
      }
    },
  };
}

const kinds = (fs: DeviceFrame[]): string[] => fs.map((f) => f.kind);
const typeOf = (raw: Uint8Array): number => parsePacket(raw).payloadType;

describe('VirtualMesh delivery', () => {
  it('delivers to every other endpoint in range with the link SNR/RSSI; isolation and loss drop', () => {
    const clock = new ManualClock(START);
    const m = new VirtualMesh({ clock, defaultLink: { snr: 4, rssi: -90 } });
    const a = m.addNode({ type: 'chat', name: 'A', seed: 'a' });
    const b = m.addNode({ type: 'chat', name: 'B', seed: 'b' });
    const c = m.addNode({ type: 'chat', name: 'C', seed: 'c' });
    m.setLink(a, b, { snr: 9.25, rssi: -60 });
    m.isolate(a, c);
    a.advertise();
    clock.advance(0);
    expect(b.heard.map((h) => [h.snr, h.rssi, h.from])).toEqual([[9.25, -60, 'A']]);
    expect(c.heard).toEqual([]);
    expect(b.getContact(a.publicKey)).toMatchObject({ name: 'A', type: ContactType.CHAT });
    m.setLink(a, b, { loss: 1 });
    const drops: string[] = [];
    m.events.on('drop', (d) => drops.push(d.to));
    a.advertise();
    clock.advance(0);
    expect(drops).toEqual(['B']);
    expect(b.heard).toHaveLength(1);
  });

  it('airtime option delays delivery by the LoRa time on air', () => {
    const clock = new ManualClock(START);
    const m = new VirtualMesh({ clock, airtime: { sf: 7, bwHz: 125000, cr: 5 } });
    const a = m.addNode({ type: 'chat', name: 'A', seed: 'a' });
    const b = m.addNode({ type: 'chat', name: 'B', seed: 'b' });
    a.advertise();
    clock.advance(100);
    expect(b.heard).toEqual([]); // a ~130-byte advert takes > 200 ms at SF7/125 kHz
    clock.advance(500);
    expect(b.heard).toHaveLength(1);
  });

  it('repeaters re-flood once with their hash appended (dedupe by packet hash) and respect max hops', () => {
    const clock = new ManualClock(START);
    const m = new VirtualMesh({ clock });
    const a = m.addNode({ type: 'chat', name: 'A', seed: 'a' });
    const r1 = m.addNode({ type: 'repeater', name: 'R1', seed: 'r1' });
    const r2 = m.addNode({ type: 'repeater', name: 'R2', seed: 'r2' });
    const z = m.addNode({ type: 'chat', name: 'Z', seed: 'z' });
    // chain A - R1 - R2 - Z
    m.isolate(a, r2);
    m.isolate(a, z);
    m.isolate(r1, z);
    a.advertise();
    clock.advance(1000);
    const atZ = z.heard.map((h) => parsePacket(h.packet));
    expect(atZ).toHaveLength(1);
    expect(toHex(atZ[0]!.path)).toBe(toHex(concatBytes(r1.publicKey.subarray(0, 1), r2.publicKey.subarray(0, 1))));
    expect(r1.counters.floodDups).toBe(1); // R2's re-flood came back to R1
    expect(m.log.filter((p) => p.from === 'R1')).toHaveLength(1);
    expect(z.getContact(a.publicKey)?.name).toBe('A');

    const m2 = new VirtualMesh({ clock });
    const b = m2.addNode({ type: 'chat', name: 'B', seed: 'b' });
    const rr = m2.addNode({ type: 'repeater', name: 'RR', seed: 'rr', maxFloodHops: 0 });
    b.advertise();
    clock.advance(1000);
    expect(m2.log.map((p) => p.from)).toEqual(['B']);
    expect(rr.getContact(b.publicKey)).toBeDefined();
  });

  it('meshIdentityFromSeed avoids reserved first bytes and is deterministic', () => {
    const k1 = meshIdentityFromSeed('x');
    expect(meshIdentityFromSeed('x').publicKey).toEqual(k1.publicKey);
    expect([0x00, 0xff]).not.toContain(k1.publicKey[0]);
  });
});

describe('companion on the mesh (basicScenario)', () => {
  it('every packet on the air parses, passes the firmware rules and annotates without errors', async () => {
    const s = await mesh();
    await s.send({ kind: 'sendSelfAdvert', flood: true });
    await s.send({ kind: 'sendTxtMsg', recipient: s.keys.alice, text: 'ping', timestamp: NOW });
    await s.advance(2000);
    await s.send({ kind: 'sendTxtMsg', recipient: s.keys.carol, text: 'hi carol', timestamp: NOW + 1 });
    await s.advance(2000);
    await s.send({ kind: 'sendChannelTxtMsg', channelIdx: 1, text: 'test channel', timestamp: NOW + 2 });
    await s.send({ kind: 'sendLogin', pubKey: s.keys.room, password: '' });
    await s.advance(2000);
    await s.send({ kind: 'sendStatusReq', pubKey: s.keys.repeater });
    await s.advance(2000);
    await s.send({ kind: 'sendTelemetryReq', pubKey: s.keys.sensor });
    await s.advance(2000);
    await s.send({ kind: 'sendTracePath', tag: 7, authCode: 0, path: s.keys.repeater.slice(0, 1) });
    await s.advance(2000);
    s.nodes.bob.sendChannelMessage('Public', 'hello from bob');
    s.nodes.carol.advertise();
    await s.advance(2000);

    const types = new Set(s.mesh.log.map((p) => typeOf(p.packet)));
    for (const t of ['ADVERT', 'TXT_MSG', 'ACK', 'PATH', 'GRP_TXT', 'ANON_REQ', 'REQ', 'RESPONSE', 'TRACE'] as const) {
      expect(types, t).toContain(PayloadType[t]);
    }
    const ids = ['self', 'alice', 'bob', 'carol', 'repeater', 'room', 'sensor'].map(scenarioIdentity);
    for (const { packet } of s.mesh.log) {
      const p = parsePacket(packet);
      expect(firmwareRejectReasons(p)).toEqual([]);
      const ann = await annotatePacket(packet, {
        keys: {
          channelPsks: [publicChannelSecret(), hashtagChannelSecret('#test')],
          self: { publicKey: ids[0]!.publicKey, privateKey: ids[0]!.privateKey },
          contacts: ids.slice(1).map((i) => i.publicKey),
        },
      });
      expect(ann.errors, toHex(packet)).toEqual([]);
    }
  });

  it('adverts carry real Ed25519 signatures; a heard advert updates the contact, a forged one is ignored', async () => {
    const s = await mesh();
    await s.send({ kind: 'sendSelfAdvert', flood: true });
    const own = s.emulator.airLog.at(-1)!;
    expect(own.type).toBe('advert');
    expect(await verifyAdvert(parseAdvertPayload(parsePacket(own.raw!).payload))).toBe(true);
    s.clock.advance(2000);
    s.nodes.bob.config.name = 'Bobby';
    s.nodes.bob.remote.config.name = 'Bobby';
    s.nodes.bob.advertise();
    const fs = await s.advance(1000);
    expect(fs).toContainEqual({ kind: 'advert', code: 0x80, pubKey: s.keys.bob });
    expect(s.emulator.getContact(s.keys.bob)?.name).toBe('Bobby');
    const bobAd = s.mesh.log.filter((p) => p.from === 'bob').at(-1)!.packet;
    expect(await verifyAdvert(parseAdvertPayload(parsePacket(bobAd).payload))).toBe(true);
    // the stored advert (EXPORT_CONTACT) is the heard one, re-headered as FLOOD, and still verifies
    const exp = await s.one({ kind: 'exportContact', pubKey: s.keys.bob }, 'exportContact');
    expect(await verifyAdvert(parseAdvertPayload(parsePacket(exp.packet).payload))).toBe(true);

    // tamper with the name: signature fails → no push, contact unchanged
    const forged = bobAd.slice();
    forged[forged.length - 1] = forged.at(-1)! ^ 0x01;
    s.emulator.injectRxPacket(forged);
    expect(await s.advance(0)).toEqual([]);
    expect(s.emulator.getContact(s.keys.bob)?.name).toBe('Bobby');
  });

  it('a DM decrypts at the peer, and the peer ACK yields SEND_CONFIRMED with the SENT ack code', async () => {
    const s = await mesh();
    const sent = await s.one({ kind: 'sendTxtMsg', recipient: s.keys.alice, text: 'ping', timestamp: NOW }, 'sent');
    expect(sent.tag).toBe(computeAckCode(NOW, 0, utf8Encode('ping'), s.keys.self));
    expect(sent.flood).toBe(false); // stored path via the repeater
    const raw = s.emulator.airLog.at(-1)!.raw!;
    const p = parsePacket(raw);
    expect(p.routeType).toBe(RouteType.DIRECT);
    expect(toHex(p.path)).toBe(toHex(s.keys.repeater.slice(0, 1)));
    // decrypt with Alice's private key, independently of the emulator (async packet/ API)
    const env = parsePayload(PayloadType.TXT_MSG, p.payload);
    if (env.kind !== 'txtMsg') throw new Error('txtMsg expected');
    expect([env.destHash, env.srcHash]).toEqual([s.keys.alice[0], s.keys.self[0]]);
    const pt = await decryptPayload(env, await calcSharedSecret(scenarioIdentity('alice').privateKey, s.keys.self));
    expect(parseTxtMsgPlaintext(pt!)).toMatchObject({ timestamp: NOW, text: 'ping', txtType: TxtType.PLAIN, attempt: 0 });

    const fs = await s.advance(2000);
    expect(kinds(fs)).toEqual(['sendConfirmed', 'msgWaiting']);
    expect(fs[0]).toMatchObject({ ackCode: sent.tag });
    expect(s.nodes.alice.inbox.map((m) => [m.text, m.pathLen])).toEqual([['ping', PATH_LEN_UNKNOWN]]); // arrived DIRECT
    // Alice's ACK went back along her stored path via the repeater
    const ack = s.mesh.log.find((x) => x.from === 'alice' && typeOf(x.packet) === PayloadType.ACK)!;
    expect(readU32LE(parsePacket(ack.packet).payload, 0)).toBe(sent.tag);
    const [reply] = await s.drain();
    expect(reply).toMatchObject({ kind: 'contactMsg', text: 'pong', senderPrefix: s.keys.alice.slice(0, 6) });
    expect(s.nodes.alice.acked).toHaveLength(1); // the companion ACKed the pong
  });

  it('flood DM to Carol (out of direct range): 1-hop path via the repeater, PATH_UPDATED, then SEND_CONFIRMED', async () => {
    const s = await mesh();
    const sent = await s.one({ kind: 'sendTxtMsg', recipient: s.keys.carol, text: 'hello carol', timestamp: NOW }, 'sent');
    expect(sent.flood).toBe(true);
    const fs = await s.advance(2000);
    expect(kinds(fs)).toEqual(['pathUpdated', 'sendConfirmed']);
    expect(fs[1]).toMatchObject({ ackCode: sent.tag });
    expect(s.nodes.carol.inbox[0]).toMatchObject({ text: 'hello carol', pathLen: encodePathLen(1) });
    const c = s.emulator.getContact(s.keys.carol)!;
    expect(c.outPathLen).toBe(encodePathLen(1));
    expect(c.outPath).toEqual(s.keys.repeater.slice(0, 1));
    // the reciprocal (DIRECT) PATH taught Carol the way back too
    expect(s.nodes.carol.getContact(s.keys.self)?.outPath).toEqual(s.keys.repeater.slice(0, 1));
    // the next send is direct
    expect((await s.one({ kind: 'sendTxtMsg', recipient: s.keys.carol, text: 'again', timestamp: NOW + 1 }, 'sent')).flood).toBe(false);
    expect(kinds(await s.advance(2000))).toEqual(['sendConfirmed']);
  });

  it('a message from Carol arrives through the repeater with a 1-hop flood path; the ACK goes back in a PATH', async () => {
    const s = await mesh();
    s.nodes.carol.setPath(s.keys.self, null); // unknown → flood
    const ack = s.nodes.carol.sendText(s.keys.self, 'hi via hilltop');
    expect(kinds(await s.advance(1000))).toEqual(['msgWaiting', 'pathUpdated']);
    const [m] = await s.drain();
    expect(m).toMatchObject({ kind: 'contactMsg', text: 'hi via hilltop', route: { receivedVia: 'flood', hops: 1, pathLen: 1 } });
    expect(s.nodes.carol.acked).toEqual([ack]);
    // the reciprocal PATH from Carol gave the companion its out path to Carol
    expect(s.emulator.getContact(s.keys.carol)?.outPath).toEqual(s.keys.repeater.slice(0, 1));
  });

  it('channel round trip: the companion message decrypts with the PSK at the nodes; a node message reaches the companion', async () => {
    const s = await mesh();
    await s.one({ kind: 'sendChannelTxtMsg', channelIdx: 1, text: 'anyone on #test?', timestamp: NOW }, 'ok');
    await s.advance(1000);
    for (const n of [s.nodes.alice, s.nodes.bob, s.nodes.carol]) {
      expect(n.channelMessages).toEqual([{ channel: '#test', text: 'Emulator: anyone on #test?', senderName: 'Emulator', message: 'anyone on #test?', timestamp: NOW, pathLen: n === s.nodes.carol ? 1 : 0 }]);
    }
    const raw = s.emulator.airLog.at(-1)!.raw!;
    const env = parsePayload(PayloadType.GRP_TXT, parsePacket(raw).payload);
    if (env.kind !== 'grpTxt') throw new Error('grpTxt expected');
    const pt = await decryptPayload(env, hashtagChannelSecret('#test'));
    expect(parseGrpTxtPlaintext(pt!)).toMatchObject({ senderName: 'Emulator', message: 'anyone on #test?' });

    s.nodes.carol.sendChannelMessage('Public', 'morning from the valley');
    await s.advance(1000);
    const [ch] = await s.drain();
    expect(ch).toMatchObject({ kind: 'channelMsg', channelIdx: 0, text: 'Carol: morning from the valley', route: { hops: 1 } });
  });

  it('login, status, telemetry, binary and CLI requests are answered over the air', async () => {
    const s = await mesh();
    await s.send({ kind: 'sendLogin', pubKey: s.keys.repeater, password: 'password' });
    expect(await s.advance(1000)).toMatchObject([{ kind: 'loginSuccess', isAdmin: true, aclPermissions: 3 }]);
    // room: no stored path → flood login; the reply comes in a PATH (path learned first)
    await s.send({ kind: 'sendLogin', pubKey: s.keys.room, password: '' });
    expect(await s.advance(1000)).toMatchObject([{ kind: 'pathUpdated', pubKey: s.keys.room }, { kind: 'loginSuccess', adminFlag: 2 }]);
    await s.send({ kind: 'sendStatusReq', pubKey: s.keys.repeater });
    const [st] = (await s.advance(1000)) as [FrameOf<'statusResponse'>];
    expect(st.kind).toBe('statusResponse');
    expect(st.raw.length).toBe(60); // 56-byte RepeaterStats, zero-padded by AES (§3.2)
    await s.send({ kind: 'sendTelemetryReq', pubKey: s.keys.sensor });
    const [tel] = await s.advance(1000);
    expect(tel).toMatchObject({ kind: 'telemetryResponse', pubKeyPrefix: s.keys.sensor.slice(0, 6) });
    await s.send({ kind: 'sendBinaryReq', pubKey: s.keys.repeater, data: Uint8Array.of(ReqType.GET_OWNER_INFO) });
    const [bin] = (await s.advance(1000)) as [FrameOf<'binaryResponse'>];
    expect(new TextDecoder().decode(bin.data).replace(/\0+$/, '')).toBe('v1.18.0\nHilltop Repeater\nEmulated repeater');
    await s.send({ kind: 'sendTxtMsg', recipient: s.keys.repeater, text: 'get name', timestamp: 1, txtType: TxtType.CLI_COMMAND });
    expect(kinds(await s.advance(1000))).toEqual(['msgWaiting']);
    expect((await s.drain())[0]).toMatchObject({ txtType: TxtType.CLI_DATA, text: '> Hilltop Repeater' });
    expect(s.nodes.repeater.remote.requests.map((r) => r.kind)).toEqual(['login', 'status', 'binary']);
  });

  it('repeater and room answer CLI_DATA commands the same as CLI_COMMAND (CLI_DATA reply, unique timestamp)', async () => {
    const s = await mesh();
    await s.send({ kind: 'sendLogin', pubKey: s.keys.repeater, password: 'password' });
    await s.advance(1000);
    await s.drain();
    // sender timestamp equal to the device RTC now: the reply must still differ from it
    const next = NOW;
    await s.send({ kind: 'sendTxtMsg', recipient: s.keys.repeater, text: 'get name', timestamp: next, txtType: TxtType.CLI_DATA });
    await s.advance(1000);
    const [reply] = await s.drain();
    expect(reply).toMatchObject({ txtType: TxtType.CLI_DATA, text: '> Hilltop Repeater' });
    expect((reply as { senderTimestamp: number }).senderTimestamp).not.toBe(next);
    expect(s.nodes.repeater.remote.messages.map((m) => m.txtType)).toEqual([TxtType.CLI_DATA]);

    // the room server answers the same way
    await s.send({ kind: 'sendLogin', pubKey: s.keys.room, password: '' });
    await s.advance(1000);
    await s.drain();
    await s.send({ kind: 'sendTxtMsg', recipient: s.keys.room, text: 'ver', timestamp: 5, txtType: TxtType.CLI_DATA });
    await s.advance(1000);
    expect((await s.drain())[0]).toMatchObject({ txtType: TxtType.CLI_DATA });
  });

  it('wrong passwords get no answer; path discovery reports both paths without touching the contact', async () => {
    const s = await mesh();
    await s.send({ kind: 'sendLogin', pubKey: s.keys.repeater, password: 'nope' });
    expect(await s.advance(5000)).toEqual([]);
    await s.send({ kind: 'sendPathDiscoveryReq', pubKey: s.keys.sensor });
    const [d] = await s.advance(2000);
    expect(d).toMatchObject({ kind: 'pathDiscoveryResponse', outPathLen: 1, outPath: s.keys.repeater.slice(0, 1), inPathLen: 1, inPath: s.keys.repeater.slice(0, 1) });
    expect(s.emulator.getContact(s.keys.sensor)?.outPath).toEqual(s.keys.repeater.slice(0, 1));
  });

  it('trace through repeaters returns the SNR each hop heard, plus the final SNR', async () => {
    const clock = new ManualClock(START);
    const m = new VirtualMesh({ clock });
    const r1 = m.addNode({ type: 'repeater', name: 'R1', seed: 'trace r1' });
    const r2 = m.addNode({ type: 'repeater', name: 'R2', seed: 'trace r2' });
    const emu = new CompanionEmulator({ clock, seed: 5, mesh: m });
    m.isolate('self', 'R2');
    m.setLink('self', 'R1', { snr: 6.5 }, { symmetric: false });
    m.setLink('R1', 'self', { snr: -3.25 }, { symmetric: false });
    m.setLink('R1', 'R2', { snr: 10.75 });
    const out: DeviceFrame[] = [];
    emu.onFrame((f) => out.push(decodeFrame(f)));
    const hashes = Uint8Array.of(r1.publicKey[0]!, r2.publicKey[0]!, r1.publicKey[0]!);
    emu.handleFrame(encodeCommand({ kind: 'sendTracePath', tag: 0xfeed, authCode: 9, path: hashes }));
    expect(out.map((f) => f.kind)).toEqual(['sent']);
    clock.advance(1000);
    const trace = out.filter((f) => f.kind === 'traceData');
    expect(trace).toMatchObject([{ tag: 0xfeed, authCode: 9, pathLen: 3, snrs: [6.5, 10.75, 10.75], finalSnr: -3.25 }]);
    // the hops appended their SNR (×4) to the path field
    const last = m.log.at(-1)!;
    expect([...parsePacket(last.packet).path]).toEqual([26, 43, 43]);
  });

  it('LOG_RX_DATA carries the exact packet bytes heard, with the link SNR / RSSI', async () => {
    const s = await mesh();
    s.mesh.setLink('bob', 'self', { snr: -7.5, rssi: -110 }, { symmetric: false });
    s.nodes.bob.advertise();
    await s.advance(500);
    const fromBob = s.mesh.log.filter((p) => p.from === 'bob');
    expect(s.logRx[0]).toEqual({ kind: 'logRxData', code: 0x88, snr: -7.5, rssi: -110, packet: fromBob[0]!.packet });
    // the repeater's re-flood (path = its hash) is heard and logged too, then dropped as a duplicate
    const reflood = s.mesh.log.find((p) => p.from === 'repeater')!.packet;
    expect(s.logRx.map((f) => toHex(f.packet))).toContain(toHex(reflood));
    expect(parsePacket(reflood).path).toEqual(s.keys.repeater.slice(0, 1));
    const stats = await s.one({ kind: 'getStats', statsType: 2 }, 'stats');
    expect(stats.stats).toMatchObject({ recvFlood: 1 });
  });

  it('inject* stays off the air but still records the real ACK packet', async () => {
    const s = await mesh();
    s.emulator.injectContactMessage(s.keys.alice, 'injected', { senderTimestamp: NOW - 5 });
    const ev = s.emulator.airLog.at(-1)!;
    expect(ev).toMatchObject({ type: 'ack', to: s.keys.alice });
    const ack = ev.type === 'ack' ? ev.ackCode : undefined;
    expect(ack).toBe(computeAckCode(NOW - 5, 0, utf8Encode('injected'), s.keys.alice));
    expect(readU32LE(parsePacket(ev.raw!).payload, 0)).toBe(ack);
    expect(s.mesh.log).toEqual([]);
  });

  it('identity: a seed or an imported expanded key derive the real public key', async () => {
    const id = scenarioIdentity('importable');
    const emu = new CompanionEmulator({ clock: new ManualClock(START), identity: { seed: id.seed } });
    expect(emu.publicKey).toEqual(id.publicKey);
    expect(emu.privateKey).toEqual(id.privateKey);
    const other = new CompanionEmulator({ clock: new ManualClock(START), seed: 2 });
    const out: DeviceFrame[] = [];
    other.onFrame((f) => out.push(decodeFrame(f)));
    other.handleFrame(encodeCommand({ kind: 'importPrivateKey', privateKey: id.privateKey }));
    expect(out.map((f) => f.kind)).toEqual(['ok']);
    expect(bytesEqual(other.publicKey, id.publicKey)).toBe(true);
  });
});
