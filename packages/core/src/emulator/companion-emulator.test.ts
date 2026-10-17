import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, readU32LE, toHex, u32le, utf8Encode } from '../util/bytes.js';
import {
  AutoAddFlag,
  ContactFlag,
  ContactType,
  ERR,
  PUSH,
  RESP,
  ReqType,
  TxtType,
  encodePathLen,
  floodTimeoutMs,
} from '../protocol/constants.js';
import { decodeFrame } from '../protocol/decode.js';
import { encodeCommand } from '../protocol/encode.js';
import type { Command, DeviceFrame } from '../protocol/types.js';
import { ManualClock } from './clock.js';
import { CompanionEmulator, computeAckCode } from './companion-emulator.js';
import { parsePacket } from '../packet/packet.js';
import { parseAdvertPayload, verifyAdvert } from '../packet/payloads.js';
import { ed25519Verify } from '../packet/crypto.js';
import type { RemoteNodeConfig } from './remote-node.js';
import type { CompanionEmulatorOptions } from './types.js';
import { settle } from '../client/testing.js'; // lets loopback microtask deliveries (both directions) complete

// ---------------------------------------------------------------------------
// Harness: the emulator behind a loopback pair, driven with encodeCommand / decodeFrame
// ---------------------------------------------------------------------------

const key = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (n * 16 + i + 1) & 0xff);
const ALICE = key(1);
const BOB = key(2);
const CAROL = key(3);
const RPT = key(4);
const ROOM = key(5);
const SENSOR = key(6);
const START = Date.UTC(2026, 9, 15, 12, 0, 0);
const NOW = Math.floor(START / 1000);
const x = (s: string): Uint8Array => fromHex(s.replace(/\s+/g, ''));

type Kind = DeviceFrame['kind'];
type FrameOf<K extends Kind> = Extract<DeviceFrame, { kind: K }>;

async function setup(opts: CompanionEmulatorOptions = {}, connect = true) {
  const clock = new ManualClock(START);
  const emu = new CompanionEmulator({ clock, seed: 7, name: 'Emu', ...opts });
  const host = emu.createLoopbackTransport();
  const raw: Uint8Array[] = [];
  host.events.on('frame', (b) => raw.push(b));
  if (connect) await host.connect();
  const take = (): DeviceFrame[] => raw.splice(0).map((b) => decodeFrame(b));
  const h = {
    emu,
    clock,
    host,
    raw,
    take,
    /** Sends a command and returns the frames received in reply (before any time passes). */
    async send(cmd: Command): Promise<DeviceFrame[]> {
      await host.send(encodeCommand(cmd));
      await settle();
      return take();
    },
    async sendRaw(bytes: Uint8Array): Promise<DeviceFrame[]> {
      await host.send(bytes);
      await settle();
      return take();
    },
    /** Sends a command that must produce exactly one frame of `kind`. */
    async one<K extends Kind>(cmd: Command, kind: K): Promise<FrameOf<K>> {
      const fs = await h.send(cmd);
      expect(fs.map((f) => f.kind)).toEqual([kind]);
      return fs[0] as FrameOf<K>;
    },
    async err(cmd: Command | Uint8Array): Promise<number> {
      const fs = cmd instanceof Uint8Array ? await h.sendRaw(cmd) : await h.send(cmd);
      expect(fs.map((f) => f.kind)).toEqual(['err']);
      return (fs[0] as FrameOf<'err'>).errCode;
    },
    async advance(ms: number): Promise<DeviceFrame[]> {
      clock.advance(ms);
      await settle();
      return take();
    },
    /** Drains the offline queue with SYNC_NEXT_MESSAGE. */
    async drain(): Promise<DeviceFrame[]> {
      await settle();
      take(); // discard MSG_WAITING pushes
      const out: DeviceFrame[] = [];
      for (let i = 0; i < 1000; i++) {
        const [f] = await h.send({ kind: 'syncNextMessage' });
        if (!f || f.kind === 'noMoreMessages') return out;
        out.push(f);
      }
      throw new Error('queue never drained');
    },
  };
  return h;
}

const kinds = (fs: DeviceFrame[]): string[] => fs.map((f) => f.kind);

/** Advert fields of a raw advert packet (via the packet/ codec). */
function advertOf(pkt: Uint8Array): Record<string, unknown> {
  const a = parseAdvertPayload(parsePacket(pkt).payload);
  const out: Record<string, unknown> = { pubKey: a.publicKey, name: a.app.name, type: a.app.nodeType };
  if (a.app.latitudeE6 !== undefined) out.latE6 = a.app.latitudeE6;
  if (a.app.longitudeE6 !== undefined) out.lonE6 = a.app.longitudeE6;
  return out;
}
const contactSeeds = [
  { pubKey: ALICE, name: 'Alice', lastMod: NOW - 300 },
  { pubKey: BOB, name: 'Bob', lastMod: NOW - 200 },
  { pubKey: CAROL, name: 'Carol', lastMod: NOW - 100, outPathLen: 0x01, outPath: x('aa') },
];

// ---------------------------------------------------------------------------

describe('handshake (§2)', () => {
  it('DEVICE_QUERY → DEVICE_INFO and sets app_target_ver', async () => {
    const h = await setup({ maxContacts: 350, maxChannels: 8, firmware: { manufacturer: 'Heltec V3' } });
    expect(h.emu.appTargetVer).toBe(0);
    const f = await h.one({ kind: 'deviceQuery', appTargetVer: 3 }, 'deviceInfo');
    expect(f.info).toEqual({
      firmwareVerCode: 14,
      maxContacts: 350,
      maxChannels: 8,
      blePin: 0,
      buildDate: '15 Oct 2026',
      manufacturer: 'Heltec V3',
      firmwareVersion: 'v1.18.0',
      clientRepeat: false,
      pathHashMode: 0,
    });
    expect(h.raw).toEqual([]);
    expect(h.emu.appTargetVer).toBe(3);
  });

  it('APP_START → SELF_INFO with identity, position, radio and name', async () => {
    const h = await setup({ lat: 47.606209, lon: -122.332071, radio: { freqKhz: 910525, bwHz: 62500, sf: 7, cr: 8, txPowerDbm: 20 } });
    const f = await h.one({ kind: 'appStart' }, 'selfInfo');
    expect(f.info).toMatchObject({
      advType: 1,
      txPowerDbm: 20,
      maxTxPowerDbm: 22,
      pubKey: h.emu.publicKey,
      lat: 47.606209,
      lon: -122.332071,
      radioFreqKhz: 910525,
      radioBwHz: 62500,
      radioSf: 7,
      radioCr: 8,
      name: 'Emu',
    });
  });

  it('APP_START shorter than 8 bytes and DEVICE_QUERY without [1] → ERR 1', async () => {
    const h = await setup();
    expect(await h.err(x('01 00 0000'))).toBe(ERR.UNSUPPORTED_CMD);
    expect(await h.err(x('16'))).toBe(ERR.UNSUPPORTED_CMD);
  });

  it('generated identity avoids reserved first bytes; provided identity is used as-is', async () => {
    const h = await setup({ identity: { publicKey: ALICE, privateKey: new Uint8Array(64).fill(9) } });
    expect(h.emu.publicKey).toEqual(ALICE);
    const g = new CompanionEmulator({ seed: 99 });
    expect(g.publicKey.length).toBe(32);
    expect([0x00, 0xff]).not.toContain(g.publicKey[0]);
  });
});

describe('offline message queue (§6.1 — MSG_WAITING only, never pushed)', () => {
  it('a received message produces only MSG_WAITING; SYNC_NEXT_MESSAGE returns it, then NO_MORE_MESSAGES', async () => {
    const h = await setup({ contacts: contactSeeds, appTargetVer: 3 });
    expect(h.emu.injectContactMessage(ALICE, 'hello', { senderTimestamp: 1700000000, snr: 7.25, pathLen: encodePathLen(2) })).toBe(true);
    await settle();
    expect(kinds(h.take())).toEqual(['msgWaiting']);
    const [m, end] = [...(await h.send({ kind: 'syncNextMessage' })), ...(await h.send({ kind: 'syncNextMessage' }))];
    expect(m).toMatchObject({
      kind: 'contactMsg',
      code: RESP.CONTACT_MSG_RECV_V3,
      snr: 7.25,
      senderPrefix: ALICE.slice(0, 6),
      route: { pathLen: 2, receivedVia: 'flood', hops: 2 },
      txtType: 0,
      senderTimestamp: 1700000000,
      text: 'hello',
    });
    expect(end?.kind).toBe('noMoreMessages');
  });

  it('FIFO order across contact and channel messages', async () => {
    const h = await setup({ contacts: contactSeeds });
    h.emu.injectContactMessage(ALICE, 'one');
    h.emu.injectChannelMessage(0, 'Dave', 'two');
    h.emu.injectContactMessage(BOB, 'three', { pathLen: 0xff });
    const got = await h.drain();
    expect(got.map((f) => (f.kind === 'contactMsg' || f.kind === 'channelMsg' ? f.text : f.kind))).toEqual(['one', 'Dave: two', 'three']);
    expect(got[2]).toMatchObject({ route: { receivedVia: 'direct', pathLen: 0xff } });
  });

  it('version gating: V1 frames until DEVICE_QUERY ≥ 3; queued frames keep their format', async () => {
    const h = await setup({ contacts: contactSeeds });
    h.emu.injectContactMessage(ALICE, 'old');
    h.emu.injectChannelMessage(0, 'Dave', 'old ch');
    await settle();
    h.take();
    await h.one({ kind: 'deviceQuery', appTargetVer: 3 }, 'deviceInfo');
    h.emu.injectContactMessage(ALICE, 'new');
    h.emu.injectChannelMessage(0, 'Dave', 'new ch');
    await h.send({ kind: 'deviceQuery', appTargetVer: 2 }); // < 3: back to V1
    h.emu.injectContactMessage(ALICE, 'v1 again');
    const got = await h.drain();
    expect(got.map((f) => f.code)).toEqual([0x07, 0x08, 0x10, 0x11, 0x07]);
    expect(got[0]).toMatchObject({ version: 1, text: 'old' });
    expect(got[0]).not.toHaveProperty('snr');
    expect(got[3]).toMatchObject({ version: 3, senderName: 'Dave', message: 'new ch' });
  });

  it('queue full: the oldest channel frame is evicted; with no channel frames the new frame is dropped but MSG_WAITING is still sent', async () => {
    const h = await setup({ contacts: contactSeeds, offlineQueueSize: 3 });
    h.emu.injectContactMessage(ALICE, 'c1');
    h.emu.injectChannelMessage(0, 'D', 'ch1');
    h.emu.injectContactMessage(ALICE, 'c2');
    h.emu.injectContactMessage(ALICE, 'c3'); // evicts ch1
    await settle();
    expect(kinds(h.take())).toEqual(['msgWaiting', 'msgWaiting', 'msgWaiting', 'msgWaiting']);
    expect(h.emu.offlineQueue.length).toBe(3);
    h.emu.injectContactMessage(ALICE, 'c4'); // no channel frame left: dropped
    await settle();
    expect(kinds(h.take())).toEqual(['msgWaiting']);
    const got = await h.drain();
    expect(got.map((f) => (f.kind === 'contactMsg' ? f.text : f.kind))).toEqual(['c1', 'c2', 'c3']);
  });

  it('channel datagrams count as channel frames for eviction', async () => {
    const h = await setup({ contacts: contactSeeds, offlineQueueSize: 2 });
    h.emu.injectChannelData(1, 0xffff, x('0102'));
    h.emu.injectContactMessage(ALICE, 'a');
    h.emu.injectContactMessage(ALICE, 'b');
    const got = await h.drain();
    expect(got.map((f) => f.kind)).toEqual(['contactMsg', 'contactMsg']);
  });

  it('messages received while disconnected are queued without MSG_WAITING', async () => {
    const h = await setup({ contacts: contactSeeds }, false);
    h.emu.injectContactMessage(ALICE, 'while away');
    await h.host.connect();
    await settle();
    expect(h.take()).toEqual([]);
    expect((await h.drain()).map((f) => f.kind)).toEqual(['contactMsg']);
  });

  it('SIGNED_PLAIN carries the 4-byte author prefix; CLI_DATA does not touch lastmod', async () => {
    const h = await setup({ contacts: contactSeeds, appTargetVer: 3 });
    h.emu.injectContactMessage(ALICE, 'post', { txtType: TxtType.SIGNED_PLAIN, authorPrefix: x('deadbeef'), senderTimestamp: 50 });
    h.emu.injectContactMessage(BOB, 'cli out', { txtType: TxtType.CLI_DATA });
    const [signed, cli] = await h.drain();
    expect(signed).toMatchObject({ txtType: 2, authorPrefix: x('deadbeef'), text: 'post' });
    expect(cli).toMatchObject({ txtType: 1, text: 'cli out' });
    expect(h.emu.getContact(ALICE)?.lastMod).toBe(NOW);
    expect(h.emu.getContact(ALICE)?.syncSince).toBe(50);
    expect(h.emu.getContact(BOB)?.lastMod).toBe(NOW - 200);
  });

  it('PLAIN messages update the sender lastmod (last heard)', async () => {
    const h = await setup({ contacts: contactSeeds });
    h.clock.advance(5000);
    h.emu.injectContactMessage(BOB, 'hi');
    expect(h.emu.getContact(BOB)?.lastMod).toBe(NOW + 5);
  });

  it('CLI_COMMAND from a contact with REMOTE_CLI is executed, not queued; otherwise queued', async () => {
    const h = await setup({ contacts: [{ pubKey: ALICE, name: 'Alice', flags: ContactFlag.REMOTE_CLI }, { pubKey: BOB, name: 'Bob' }] });
    h.emu.injectContactMessage(ALICE, 'get name', { txtType: TxtType.CLI_COMMAND });
    expect(h.emu.offlineQueue.length).toBe(0);
    expect(h.emu.airLog.at(-1)).toMatchObject({ type: 'cliReply', text: '> Emu' });
    h.emu.injectContactMessage(BOB, 'get name', { txtType: TxtType.CLI_COMMAND });
    expect(h.emu.offlineQueue.length).toBe(1);
  });

  it('messages from unknown senders are dropped; long text is truncated to the 176-byte frame', async () => {
    const h = await setup({ contacts: contactSeeds, appTargetVer: 3 });
    expect(h.emu.injectContactMessage(key(9), 'who?')).toBe(false);
    h.emu.injectContactMessage(ALICE, 'é'.repeat(100));
    const [m] = await h.drain();
    expect(h.emu.offlineQueue).toEqual([]);
    if (m?.kind !== 'contactMsg') throw new Error('expected message');
    expect(utf8Encode(m.text).length).toBe(160); // 176 − 16 header, cut on a character boundary
  });

  it('channel datagrams > 167 bytes are dropped (§6.4)', async () => {
    const h = await setup();
    expect(h.emu.injectChannelData(0, 1, new Uint8Array(168))).toBe(false);
    expect(h.emu.injectChannelData(0, 1, new Uint8Array(167))).toBe(true);
    const [d] = await h.drain();
    expect(d).toMatchObject({ kind: 'channelData', dataType: 1 });
  });
});

describe('contacts (§7)', () => {
  it('GET_CONTACTS streams CONTACTS_START(total), CONTACT×n, END_OF_CONTACTS(newest lastmod)', async () => {
    const h = await setup({ contacts: contactSeeds });
    expect(kinds(await h.send({ kind: 'getContacts' }))).toEqual(['contactsStart']);
    const fs = await h.advance(0);
    expect(kinds(fs)).toEqual(['contact', 'contact', 'contact', 'endOfContacts']);
    expect(fs.slice(0, 3).map((f) => (f as FrameOf<'contact'>).contact.name)).toEqual(['Alice', 'Bob', 'Carol']);
    expect(fs[2]).toMatchObject({ contact: { outPathLen: 1, outPath: x('aa'), lastMod: NOW - 100 } });
    expect(fs[3]).toMatchObject({ mostRecentLastMod: NOW - 100 });
  });

  it('since filter is strictly greater-than; START still reports the total; END reports the newest sent', async () => {
    const h = await setup({ contacts: contactSeeds });
    const [start] = await h.send({ kind: 'getContacts', since: NOW - 200 });
    expect(start).toMatchObject({ kind: 'contactsStart', total: 3 });
    const fs = await h.advance(0);
    expect(fs.map((f) => (f.kind === 'contact' ? f.contact.name : f.kind))).toEqual(['Carol', 'endOfContacts']);
    await h.send({ kind: 'getContacts', since: NOW - 100 });
    const none = await h.advance(0);
    expect(none).toEqual([{ kind: 'endOfContacts', code: 4, mostRecentLastMod: 0 }]);
  });

  it('GET_CONTACTS while iterating → ERR 4; other commands interleave', async () => {
    const h = await setup({ contacts: contactSeeds, contactIntervalMs: 10 });
    await h.send({ kind: 'getContacts' });
    expect(kinds(await h.advance(10))).toEqual(['contact']);
    expect(await h.err({ kind: 'getContacts' })).toBe(ERR.BAD_STATE);
    expect(kinds(await h.send({ kind: 'getDeviceTime' }))).toEqual(['currTime']);
    expect(kinds(await h.advance(30))).toEqual(['contact', 'contact', 'endOfContacts']);
    expect(h.emu.iterating).toBe(false);
  });

  it('APP_START aborts a running iteration silently (no END_OF_CONTACTS)', async () => {
    const h = await setup({ contacts: contactSeeds });
    await h.send({ kind: 'getContacts' });
    expect(kinds(await h.send({ kind: 'appStart' }))).toEqual(['selfInfo']);
    expect(await h.advance(100)).toEqual([]);
    expect(kinds(await h.send({ kind: 'getContacts' }))).toEqual(['contactsStart']); // no ERR 4
    expect(kinds(await h.advance(0))).toEqual(['contact', 'contact', 'contact', 'endOfContacts']);
  });

  it('removing a contact mid-iteration shifts the array (no skip, no repeat)', async () => {
    const h = await setup({ contacts: contactSeeds, contactIntervalMs: 10 });
    await h.send({ kind: 'getContacts' });
    expect(kinds(await h.advance(10))).toEqual(['contact']); // Alice
    await h.send({ kind: 'removeContact', pubKey: ALICE });
    const fs = await h.advance(100);
    expect(fs.map((f) => (f.kind === 'contact' ? f.contact.name : f.kind))).toEqual(['Bob', 'Carol', 'endOfContacts']);
  });

  it('GET_CONTACT_BY_KEY → CONTACT / ERR 2', async () => {
    const h = await setup({ contacts: contactSeeds });
    const f = await h.one({ kind: 'getContactByKey', pubKey: BOB }, 'contact');
    expect(f.contact).toMatchObject({ pubKey: BOB, name: 'Bob', type: 1, outPathLen: 0xff });
    expect(await h.err({ kind: 'getContactByKey', pubKey: key(9) })).toBe(ERR.NOT_FOUND);
  });

  it('ADD_UPDATE_CONTACT adds (lastmod = RTC when absent) and updates in place', async () => {
    const h = await setup({ contacts: contactSeeds });
    await h.one({ kind: 'addUpdateContact', contact: { pubKey: key(9), type: 2, flags: 1, outPathLen: 0x42, outPath: x('01020304'), name: 'New', lastAdvert: 5 } }, 'ok');
    expect(h.emu.getContact(key(9))).toMatchObject({ name: 'New', type: 2, flags: 1, outPathLen: 0x42, outPath: x('01020304'), lastMod: NOW, lat: 0 });
    await h.one({ kind: 'addUpdateContact', contact: { pubKey: BOB, type: 1, flags: 0, outPathLen: 0xff, name: 'Bobby', lastAdvert: 6, lat: 1.5, lon: 2.5, lastMod: 1234 } }, 'ok');
    expect(h.emu.getContact(BOB)).toMatchObject({ name: 'Bobby', lat: 1.5, lon: 2.5, lastMod: 1234 });
    expect(h.emu.contacts.map((c) => c.name)).toEqual(['Alice', 'Bobby', 'Carol', 'New']);
  });

  it('ADD_UPDATE_CONTACT when full → ERR 3, or overwrites the oldest non-favourite (CONTACT_DELETED) with autoadd bit 0', async () => {
    const seeds = [
      { pubKey: ALICE, name: 'Alice', lastMod: 10 },
      { pubKey: BOB, name: 'Bob', lastMod: 5, flags: ContactFlag.FAVOURITE },
    ];
    const h = await setup({ contacts: seeds, maxContacts: 2 });
    const add: Command = { kind: 'addUpdateContact', contact: { pubKey: CAROL, type: 1, flags: 0, outPathLen: 0xff, name: 'Carol', lastAdvert: 1 } };
    expect(await h.err(add)).toBe(ERR.TABLE_FULL);
    await h.one({ kind: 'setAutoAddConfig', config: AutoAddFlag.OVERWRITE_OLDEST }, 'ok');
    const fs = await h.send(add);
    expect(fs).toEqual([{ kind: 'contactDeleted', code: PUSH.CONTACT_DELETED, pubKey: ALICE }, { kind: 'ok', code: 0 }]);
    expect(h.emu.contacts.map((c) => c.name)).toEqual(['Carol', 'Bob']);
  });

  it('REMOVE_CONTACT → OK / ERR 2; RESET_PATH sets 0xFF and keeps lastmod', async () => {
    const h = await setup({ contacts: contactSeeds });
    await h.one({ kind: 'resetPath', pubKey: CAROL }, 'ok');
    expect(h.emu.getContact(CAROL)).toMatchObject({ outPathLen: 0xff, outPath: new Uint8Array(0), lastMod: NOW - 100 });
    expect(await h.err({ kind: 'resetPath', pubKey: key(9) })).toBe(ERR.NOT_FOUND);
    await h.one({ kind: 'removeContact', pubKey: BOB }, 'ok');
    expect(await h.err({ kind: 'removeContact', pubKey: BOB })).toBe(ERR.NOT_FOUND);
    expect(h.emu.contacts.length).toBe(2);
  });

  it('SHARE_CONTACT re-sends the stored advert zero-hop; ERR 2 for unknown keys', async () => {
    const h = await setup({ contacts: contactSeeds });
    await h.one({ kind: 'shareContact', pubKey: ALICE }, 'ok');
    expect(h.emu.airLog.at(-1)).toMatchObject({ type: 'shareContact', pubKey: ALICE });
    expect(await h.err({ kind: 'shareContact', pubKey: key(9) })).toBe(ERR.NOT_FOUND);
  });

  it('a contact added by the host has no stored advert: SHARE → ERR 3, EXPORT → ERR 2', async () => {
    const h = await setup();
    await h.one({ kind: 'addUpdateContact', contact: { pubKey: BOB, type: 1, flags: 0, outPathLen: 0xff, name: 'Bob', lastAdvert: 1 } }, 'ok');
    expect(await h.err({ kind: 'shareContact', pubKey: BOB })).toBe(ERR.TABLE_FULL);
    expect(await h.err({ kind: 'exportContact', pubKey: BOB })).toBe(ERR.NOT_FOUND);
    h.emu.injectAdvert({ pubKey: BOB, name: 'Bob' }); // newer than lastAdvert 1 → stored
    await settle();
    expect(kinds(h.take())).toEqual(['logRxData', 'advert']);
    await h.one({ kind: 'shareContact', pubKey: BOB }, 'ok');
  });

  it('EXPORT_CONTACT (self = flood advert 0x11) → IMPORT_CONTACT on another device adds it asynchronously', async () => {
    const a = await setup({ name: 'Device A', lat: 1, lon: 2, prefs: { advertLocPolicy: 1 } });
    const self = await a.one({ kind: 'exportContact' }, 'exportContact');
    expect(self.packet[0]).toBe(0x11);
    expect(self.packet[1]).toBe(0x00);
    expect(advertOf(self.packet)).toMatchObject({ pubKey: a.emu.publicKey, name: 'Device A', type: 1, latE6: 1e6, lonE6: 2e6 });
    expect(await verifyAdvert(parseAdvertPayload(parsePacket(self.packet).payload))).toBe(true); // real Ed25519 signature

    const b = await setup({ seed: 8 });
    await b.one({ kind: 'importContact', packet: self.packet }, 'ok');
    const later = await b.advance(0);
    expect(later).toEqual([{ kind: 'advert', code: PUSH.ADVERT, pubKey: a.emu.publicKey }]);
    expect(b.emu.getContact(a.emu.publicKey)).toMatchObject({ name: 'Device A', lat: 1, lon: 2 });
    // exported from b, the contact's stored advert is identical
    const again = await b.one({ kind: 'exportContact', pubKey: a.emu.publicKey }, 'exportContact');
    expect(toHex(again.packet)).toBe(toHex(self.packet));
    expect(await b.err({ kind: 'exportContact', pubKey: key(9) })).toBe(ERR.NOT_FOUND);
  });

  it('IMPORT_CONTACT of a non-advert packet → ERR 6', async () => {
    const h = await setup();
    expect(await h.err({ kind: 'importContact', packet: concatBytes(x('0900'), new Uint8Array(100)) })).toBe(ERR.ILLEGAL_ARG);
  });
});

describe('adverts and auto-add (§7.3)', () => {
  it('auto-add mode: a new node is added and reported with PUSH ADVERT (not NEW_ADVERT), after LOG_RX_DATA', async () => {
    const h = await setup();
    h.emu.injectAdvert({ pubKey: ALICE, name: 'Alice', type: ContactType.CHAT, lat: 10, lon: 20, snr: 5, rssi: -90 });
    await settle();
    const fs = h.take();
    expect(kinds(fs)).toEqual(['logRxData', 'advert']);
    expect(fs[0]).toMatchObject({ snr: 5, rssi: -90 });
    expect(h.emu.getContact(ALICE)).toMatchObject({ name: 'Alice', lat: 10, lon: 20, lastAdvert: NOW, outPathLen: 0xff });
  });

  it('manual mode: NEW_ADVERT with the full record and nothing stored; autoadd type bits still add', async () => {
    const h = await setup({ prefs: { manualAddContacts: 1, autoAddConfig: AutoAddFlag.REPEATER } });
    h.emu.injectAdvert({ pubKey: ALICE, name: 'Alice' });
    h.emu.injectAdvert({ pubKey: RPT, name: 'Rpt', type: ContactType.REPEATER });
    await settle();
    const fs = h.take().filter((f) => f.kind !== 'logRxData');
    expect(fs[0]).toMatchObject({ kind: 'newAdvert', contact: { pubKey: ALICE, name: 'Alice', outPathLen: 0xff, lastMod: NOW } });
    expect(fs[1]).toMatchObject({ kind: 'advert', pubKey: RPT });
    expect(h.emu.contacts.map((c) => c.name)).toEqual(['Rpt']);
  });

  it('hop limit: autoadd_max_hops N accepts only adverts with fewer than N hops', async () => {
    const h = await setup();
    await h.one({ kind: 'setAutoAddConfig', config: 0, maxHops: 2 }, 'ok');
    h.emu.injectAdvert({ pubKey: ALICE, name: 'Far', pathLen: 2, path: x('aabb') });
    h.emu.injectAdvert({ pubKey: BOB, name: 'Near', pathLen: 1, path: x('aa') });
    await settle();
    expect(kinds(h.take().filter((f) => f.kind !== 'logRxData'))).toEqual(['newAdvert', 'advert']);
    expect(h.emu.contacts.map((c) => c.name)).toEqual(['Near']);
  });

  it('contacts full: NEW_ADVERT then CONTACTS_FULL', async () => {
    const h = await setup({ contacts: [contactSeeds[0]!], maxContacts: 1 });
    h.emu.injectAdvert({ pubKey: BOB, name: 'Bob' });
    await settle();
    expect(kinds(h.take())).toEqual(['logRxData', 'newAdvert', 'contactsFull']);
  });

  it('an advert from a known contact updates it (ADVERT push); replays (timestamp ≤ stored) are ignored silently', async () => {
    const h = await setup({ contacts: [{ pubKey: ALICE, name: 'Alice', lastAdvert: NOW - 10, lastMod: NOW - 10 }] });
    h.clock.advance(2000);
    h.emu.injectAdvert({ pubKey: ALICE, name: 'Alice v2', timestamp: NOW + 1, pathLen: 1, path: x('77') });
    await settle();
    expect(kinds(h.take())).toEqual(['logRxData', 'advert']);
    expect(h.emu.getContact(ALICE)).toMatchObject({ name: 'Alice v2', lastAdvert: NOW + 1, lastMod: NOW + 2 });
    h.emu.injectAdvert({ pubKey: ALICE, name: 'Replay', timestamp: NOW + 1 });
    await settle();
    expect(kinds(h.take())).toEqual(['logRxData']);
    expect(h.emu.getContact(ALICE)?.name).toBe('Alice v2');
  });

  it('GET_ADVERT_PATH returns the recorded inbound path (7-byte prefix match) / ERR 2', async () => {
    const h = await setup();
    h.emu.injectAdvert({ pubKey: ALICE, name: 'Alice', pathLen: 0x42, path: x('a1a2b1b2') });
    await settle();
    h.take();
    const f = await h.one({ kind: 'getAdvertPath', pubKey: concatBytes(ALICE.slice(0, 7), new Uint8Array(25)) }, 'advertPath');
    expect(f).toMatchObject({ recvTimestamp: NOW, pathLen: 0x42, path: x('a1a2b1b2') });
    expect(await h.err({ kind: 'getAdvertPath', pubKey: BOB })).toBe(ERR.NOT_FOUND);
  });

  it('injectPathUpdate → PATH_UPDATED and the new out_path', async () => {
    const h = await setup({ contacts: contactSeeds });
    h.emu.injectPathUpdate(BOB, 2, x('0102'));
    await settle();
    expect(h.take()).toEqual([{ kind: 'pathUpdated', code: PUSH.PATH_UPDATED, pubKey: BOB }]);
    expect(h.emu.getContact(BOB)).toMatchObject({ outPathLen: 2, outPath: x('0102') });
  });
});

describe('SEND_TXT_MSG, SENT and SEND_CONFIRMED (§5.1, §6.5, §8, §10)', () => {
  const msg = (text: string, attempt = 0, to = BOB): Command => ({ kind: 'sendTxtMsg', recipient: to, text, timestamp: 1700000000, attempt });

  it('SENT carries the real ACK code and a flood timeout; SEND_CONFIRMED later echoes it with the round trip', async () => {
    const h = await setup({ contacts: contactSeeds });
    const sent = await h.one(msg('hello'), 'sent');
    const ack = computeAckCode(1700000000, 0, utf8Encode('hello'), h.emu.publicKey);
    expect(sent).toMatchObject({ flood: true, tag: ack });
    expect(sent.estTimeoutMs).toBeGreaterThan(floodTimeoutMs(0));
    const later = await h.advance(300);
    // flood send: the ACK comes inside a PATH packet → PATH_UPDATED first, then SEND_CONFIRMED
    expect(later).toEqual([
      { kind: 'pathUpdated', code: PUSH.PATH_UPDATED, pubKey: BOB },
      { kind: 'sendConfirmed', code: PUSH.SEND_CONFIRMED, ackCode: ack, ackBytes: u32le(ack), roundTripMs: 300 },
    ]);
    // the learned zero-hop path makes the next send direct
    const second = await h.one(msg('again'), 'sent');
    expect(second.flood).toBe(false);
  });

  it('direct timeout uses the out_path hop count', async () => {
    const h = await setup({ contacts: contactSeeds });
    const toCarol = await h.one(msg('x', 0, CAROL), 'sent');
    expect(toCarol.flood).toBe(false);
    expect(toCarol.estTimeoutMs).toBeGreaterThan(500);
    expect(toCarol.estTimeoutMs).toBeLessThan((await h.one(msg('x', 0, BOB), 'sent')).estTimeoutMs);
  });

  it('the ACK code changes with attempt & 3; each table entry confirms only once', async () => {
    const h = await setup({ contacts: contactSeeds, defaultAckPolicy: 'never' });
    const a0 = (await h.one(msg('hi', 0), 'sent')).tag;
    const a1 = (await h.one(msg('hi', 1), 'sent')).tag;
    const a4 = (await h.one(msg('hi', 4), 'sent')).tag;
    expect(a0).not.toBe(a1);
    expect(a4).toBe(a0); // attempt 4 & 3 == 0
    expect(await h.advance(10_000)).toEqual([]);
    expect(h.emu.injectAck(a1)).toBe(true);
    expect(h.emu.injectAck(a1)).toBe(false); // duplicates ignored
    await settle();
    expect(kinds(h.take())).toEqual(['sendConfirmed']);
  });

  it('ack policy { minAttempt: 2 }: earlier attempts are lost, attempt 2 is confirmed', async () => {
    const h = await setup({ contacts: contactSeeds, remoteNodes: [{ type: 'chat', pubKey: BOB, name: 'Bob', addContact: false, ackPolicy: { minAttempt: 2 }, ackDelayMs: 100 }] });
    await h.one(msg('m', 0), 'sent');
    expect(await h.advance(1000)).toEqual([]);
    await h.one(msg('m', 1), 'sent');
    expect(await h.advance(1000)).toEqual([]);
    const s2 = await h.one(msg('m', 2), 'sent');
    const fs = await h.advance(100);
    expect(fs.at(-1)).toMatchObject({ kind: 'sendConfirmed', ackCode: s2.tag, roundTripMs: 100 });
    expect(h.emu.getRemoteNode(BOB)?.messages.map((m) => m.attempt)).toEqual([0, 1, 2]);
  });

  it('the 8-slot expected-ACK table overwrites the oldest entry', async () => {
    const h = await setup({ contacts: contactSeeds, defaultAckPolicy: 'never' });
    const tags: number[] = [];
    for (let i = 0; i < 9; i++) tags.push((await h.one(msg(`m${i}`), 'sent')).tag);
    expect(h.emu.injectAck(tags[0]!)).toBe(false);
    expect(h.emu.injectAck(tags[8]!)).toBe(true);
  });

  it('ERR codes: unknown recipient 2 (even with a bad txt_type), txt_type 2 → 1, text > 160 B → 3, attempt > 3 limits text to 158', async () => {
    const h = await setup({ contacts: contactSeeds });
    expect(await h.err(msg('x', 0, key(9)))).toBe(ERR.NOT_FOUND);
    expect(await h.err({ kind: 'sendTxtMsg', recipient: key(9), text: 'x', timestamp: 1, txtType: 2 })).toBe(ERR.NOT_FOUND);
    expect(await h.err({ kind: 'sendTxtMsg', recipient: BOB, text: 'x', timestamp: 1, txtType: 2 })).toBe(ERR.UNSUPPORTED_CMD);
    expect(await h.err(msg('a'.repeat(161)))).toBe(ERR.TABLE_FULL);
    expect(await h.err(msg('a'.repeat(159), 4))).toBe(ERR.TABLE_FULL);
    expect(kinds(await h.send(msg('a'.repeat(160))))).toEqual(['sent']);
    expect(kinds(await h.send(msg('a'.repeat(158), 4)))).toEqual(['sent']);
    // len < 14 falls through to ERR 1
    expect(await h.err(encodeCommand(msg('a')).subarray(0, 13))).toBe(ERR.UNSUPPORTED_CMD);
  });

  it('CLI_COMMAND: SENT with ack 0 and the device timestamp; the repeater replies with a CLI_DATA message', async () => {
    const h = await setup({ remoteNodes: [{ type: 'repeater', pubKey: RPT, name: 'Rpt', responseDelayMs: 200 }] });
    const sent = await h.one({ kind: 'sendTxtMsg', recipient: RPT, text: 'get name', timestamp: 1, txtType: TxtType.CLI_COMMAND }, 'sent');
    expect(sent.tag).toBe(0);
    expect(h.emu.airLog.at(-1)).toMatchObject({ type: 'txtMsg', timestamp: NOW, ackCode: 0 });
    expect(kinds(await h.advance(200))).toEqual(['msgWaiting']);
    const [reply] = await h.drain();
    expect(reply).toMatchObject({ kind: 'contactMsg', txtType: TxtType.CLI_DATA, text: '> Rpt' });
  });

  it('a chat peer with autoReply answers after the ACK', async () => {
    const h = await setup({
      remoteNodes: [{ type: 'chat', pubKey: ALICE, name: 'Alice', autoReply: (t) => `echo: ${t}`, ackDelayMs: 100, responseDelayMs: 100, contact: { outPathLen: 0 } }],
    });
    await h.one(msg('ping', 0, ALICE), 'sent');
    expect(kinds(await h.advance(100))).toEqual(['sendConfirmed']);
    expect(kinds(await h.advance(100))).toEqual(['msgWaiting']);
    expect(await h.drain()).toMatchObject([{ text: 'echo: ping' }]);
  });

  it('SEND_CHANNEL_TXT_MSG → OK (not SENT); txt_type ≠ 0 → ERR 1; idx ≥ max → ERR 2', async () => {
    const h = await setup();
    await h.one({ kind: 'sendChannelTxtMsg', channelIdx: 0, text: 'hello all', timestamp: 5 }, 'ok');
    expect(h.emu.airLog.at(-1)).toMatchObject({ type: 'grpTxt', channelIdx: 0, timestamp: 5, text: 'Emu: hello all' });
    await h.one({ kind: 'sendChannelTxtMsg', channelIdx: 7, text: 'empty slot is fine', timestamp: 5 }, 'ok');
    expect(await h.err({ kind: 'sendChannelTxtMsg', channelIdx: 0, text: 'x', timestamp: 5, txtType: 1 })).toBe(ERR.UNSUPPORTED_CMD);
    expect(await h.err({ kind: 'sendChannelTxtMsg', channelIdx: 8, text: 'x', timestamp: 5 })).toBe(ERR.NOT_FOUND);
  });

  it('SEND_CHANNEL_DATA: OK; ERR 2 bad idx; ERR 6 for data_type 0, payload > 165 or len < 4', async () => {
    const h = await setup();
    await h.one({ kind: 'sendChannelData', channelIdx: 0, dataType: 0xffff, payload: x('0102') }, 'ok');
    expect(await h.err({ kind: 'sendChannelData', channelIdx: 9, dataType: 1, payload: x('01') })).toBe(ERR.NOT_FOUND);
    expect(await h.err({ kind: 'sendChannelData', channelIdx: 0, dataType: 0, payload: x('01') })).toBe(ERR.ILLEGAL_ARG);
    expect(await h.err({ kind: 'sendChannelData', channelIdx: 0, dataType: 1, payload: new Uint8Array(166) })).toBe(ERR.ILLEGAL_ARG);
    expect(await h.err(x('3e 00 ff'))).toBe(ERR.ILLEGAL_ARG);
  });
});

describe('time (§4 #5, #6)', () => {
  it('GET_DEVICE_TIME; SET_DEVICE_TIME accepts now or later, rejects going backwards with ERR 6', async () => {
    const h = await setup({ rtcEpochSecs: 1700000000 });
    expect(await h.one({ kind: 'getDeviceTime' }, 'currTime')).toMatchObject({ epochSecs: 1700000000 });
    h.clock.advance(3000);
    expect(await h.one({ kind: 'getDeviceTime' }, 'currTime')).toMatchObject({ epochSecs: 1700000003 });
    await h.one({ kind: 'setDeviceTime', epochSecs: 1700000003 }, 'ok');
    await h.one({ kind: 'setDeviceTime', epochSecs: 1800000000 }, 'ok');
    expect(await h.err({ kind: 'setDeviceTime', epochSecs: 1799999999 })).toBe(ERR.ILLEGAL_ARG);
    expect(h.emu.rtcSecs).toBe(1800000000);
    expect(await h.err(x('06 010203'))).toBe(ERR.UNSUPPORTED_CMD);
  });
});

describe('device settings (§4)', () => {
  it('SET_ADVERT_NAME (truncated to 31 bytes) and SET_ADVERT_LATLON (range-checked)', async () => {
    const h = await setup();
    await h.one({ kind: 'setAdvertName', name: 'Base Camp' }, 'ok');
    await h.sendRaw(concatBytes(x('08'), utf8Encode('x'.repeat(40))));
    await h.one({ kind: 'setAdvertLatLon', lat: -33.865143, lon: 151.2099, alt: 50 }, 'ok');
    expect(await h.err({ kind: 'setAdvertLatLon', lat: 90.5, lon: 0 })).toBe(ERR.ILLEGAL_ARG);
    expect(await h.err({ kind: 'setAdvertLatLon', lat: 0, lon: -180.000001 })).toBe(ERR.ILLEGAL_ARG);
    const s = await h.one({ kind: 'appStart' }, 'selfInfo');
    expect(s.info).toMatchObject({ name: 'x'.repeat(31), lat: -33.865143, lon: 151.2099 });
  });

  it('SET_RADIO_PARAMS validates ranges and client repeat frequencies; omitting [11] turns repeat off', async () => {
    const h = await setup();
    await h.one({ kind: 'setRadioParams', freqKhz: 869495, bwHz: 62500, sf: 8, cr: 6, clientRepeat: true }, 'ok');
    expect((await h.one({ kind: 'deviceQuery' }, 'deviceInfo')).info.clientRepeat).toBe(true);
    expect(await h.err({ kind: 'setRadioParams', freqKhz: 869525, bwHz: 62500, sf: 8, cr: 6, clientRepeat: true })).toBe(ERR.ILLEGAL_ARG);
    for (const bad of [
      { freqKhz: 149999, bwHz: 125000, sf: 9, cr: 5 },
      { freqKhz: 869525, bwHz: 6999, sf: 9, cr: 5 },
      { freqKhz: 869525, bwHz: 125000, sf: 13, cr: 5 },
      { freqKhz: 869525, bwHz: 125000, sf: 9, cr: 4 },
    ]) {
      expect(await h.err({ kind: 'setRadioParams', ...bad })).toBe(ERR.ILLEGAL_ARG);
    }
    await h.sendRaw(concatBytes(x('0b'), u32le(869525), u32le(125000), x('09 05'))); // no [11]
    expect((await h.one({ kind: 'deviceQuery' }, 'deviceInfo')).info.clientRepeat).toBe(false);
    expect((await h.one({ kind: 'appStart' }, 'selfInfo')).info).toMatchObject({ radioFreqKhz: 869525, radioBwHz: 125000, radioSf: 9, radioCr: 5 });
  });

  it('SET_RADIO_TX_POWER: -9..MAX', async () => {
    const h = await setup({ radio: { maxTxPowerDbm: 20 } });
    await h.one({ kind: 'setRadioTxPower', dbm: -9 }, 'ok');
    expect(await h.err({ kind: 'setRadioTxPower', dbm: -10 })).toBe(ERR.ILLEGAL_ARG);
    expect(await h.err({ kind: 'setRadioTxPower', dbm: 21 })).toBe(ERR.ILLEGAL_ARG);
    expect((await h.one({ kind: 'appStart' }, 'selfInfo')).info).toMatchObject({ txPowerDbm: -9, maxTxPowerDbm: 20 });
  });

  it('SET/GET_TUNING_PARAMS round trip (× 1000 on the wire)', async () => {
    const h = await setup();
    expect(await h.one({ kind: 'getTuningParams' }, 'tuningParams')).toMatchObject({ rxDelayBase: 0, airtimeFactor: 1 });
    await h.one({ kind: 'setTuningParams', rxDelayBase: 10.5, airtimeFactor: 2.25 }, 'ok');
    expect(await h.one({ kind: 'getTuningParams' }, 'tuningParams')).toMatchObject({ rxDelayBase: 10.5, airtimeFactor: 2.25 });
  });

  it('SET_OTHER_PARAMS: full frame sets all, a short frame only [1]', async () => {
    const h = await setup();
    await h.one({ kind: 'setOtherParams', manualAddContacts: 1, telemetryModes: { base: 2, location: 1, environment: 0 }, advertLocPolicy: 1, multiAcks: 2 }, 'ok');
    expect((await h.one({ kind: 'appStart' }, 'selfInfo')).info).toMatchObject({ manualAddContacts: 1, telemetryModesRaw: 0x06, advertLocPolicy: 1, multiAcks: 2 });
    await h.one({ kind: 'setOtherParams', manualAddContacts: 0 }, 'ok');
    expect((await h.one({ kind: 'appStart' }, 'selfInfo')).info).toMatchObject({ manualAddContacts: 0, telemetryModesRaw: 0x06, advertLocPolicy: 1, multiAcks: 2 });
  });

  it('SET_PATH_HASH_MODE 0..2 (else ERR 6), reported in DEVICE_INFO', async () => {
    const h = await setup();
    await h.one({ kind: 'setPathHashMode', mode: 2 }, 'ok');
    expect(await h.err(x('3d 00 03'))).toBe(ERR.ILLEGAL_ARG);
    expect((await h.one({ kind: 'deviceQuery' }, 'deviceInfo')).info.pathHashMode).toBe(2);
  });

  it('SET_DEVICE_PIN: 0 or 6 digits', async () => {
    const h = await setup();
    await h.one({ kind: 'setDevicePin', pin: 654321 }, 'ok');
    await h.one({ kind: 'setDevicePin', pin: 0 }, 'ok');
    expect(await h.err({ kind: 'setDevicePin', pin: 99999 })).toBe(ERR.ILLEGAL_ARG);
    expect(await h.err({ kind: 'setDevicePin', pin: 1000000 })).toBe(ERR.ILLEGAL_ARG);
  });

  it('GET/SET_CUSTOM_VAR: only existing settings can be set', async () => {
    const h = await setup({ customVars: { gps: '0', gps_interval: '60' } });
    await h.one({ kind: 'setCustomVar', name: 'gps', value: '1' }, 'ok');
    expect(await h.err({ kind: 'setCustomVar', name: 'nope', value: '1' })).toBe(ERR.ILLEGAL_ARG);
    const f = await h.one({ kind: 'getCustomVars' }, 'customVars');
    expect(f.raw).toBe('gps:1,gps_interval:60');
    expect(f.vars).toEqual([{ name: 'gps', value: '1' }, { name: 'gps_interval', value: '60' }]);
    const empty = await setup();
    expect((await empty.one({ kind: 'getCustomVars' }, 'customVars')).raw).toBe('');
  });

  it('SET/GET_AUTOADD_CONFIG (max hops clamped to 64) and GET_ALLOWED_REPEAT_FREQ', async () => {
    const h = await setup();
    await h.one({ kind: 'setAutoAddConfig', config: 0x1e, maxHops: 200 }, 'ok');
    expect(await h.one({ kind: 'getAutoAddConfig' }, 'autoAddConfig')).toMatchObject({ config: 0x1e, maxHops: 64 });
    await h.one({ kind: 'setAutoAddConfig', config: 0x02 }, 'ok');
    expect(await h.one({ kind: 'getAutoAddConfig' }, 'autoAddConfig')).toMatchObject({ config: 0x02, maxHops: 64 });
    expect((await h.one({ kind: 'getAllowedRepeatFreq' }, 'allowedRepeatFreq')).ranges).toEqual([
      { lowerKhz: 433000, upperKhz: 433000 },
      { lowerKhz: 869495, upperKhz: 869495 },
      { lowerKhz: 918000, upperKhz: 918000 },
    ]);
  });

  it('flood scopes: SET_FLOOD_SCOPE_KEY (session) and SET/GET_DEFAULT_FLOOD_SCOPE (persisted)', async () => {
    const h = await setup();
    const k = x('00112233445566778899aabbccddeeff');
    expect(await h.one({ kind: 'getDefaultFloodScope' }, 'defaultFloodScope')).toMatchObject({ scope: null });
    await h.one({ kind: 'setDefaultFloodScope', scope: { name: '#europe', key: k } }, 'ok');
    expect(await h.one({ kind: 'getDefaultFloodScope' }, 'defaultFloodScope')).toMatchObject({ scope: { name: '#europe', key: k } });
    await h.one({ kind: 'setDefaultFloodScope' }, 'ok');
    expect(await h.one({ kind: 'getDefaultFloodScope' }, 'defaultFloodScope')).toMatchObject({ scope: null });
    await h.one({ kind: 'setFloodScopeKey', key: k }, 'ok');
    expect(h.emu.floodScope).toEqual({ key: k, unscoped: false });
    await h.one({ kind: 'setFloodScopeKey', unscoped: true }, 'ok');
    expect(h.emu.floodScope.unscoped).toBe(true);
    await h.one({ kind: 'setFloodScopeKey' }, 'ok');
    expect(h.emu.floodScope).toEqual({ key: new Uint8Array(16), unscoped: false });
    expect(await h.err(x('36 02'))).toBe(ERR.UNSUPPORTED_CMD);
  });

  it('GET_CHANNEL works for every slot < MAX (empty = "" and zeros); SET_CHANNEL; ERR 2 / ERR 1 (256-bit)', async () => {
    const h = await setup();
    expect((await h.one({ kind: 'getChannel', index: 0 }, 'channelInfo')).channel).toEqual({
      index: 0,
      name: 'Public',
      secret: x('8b3387e9c5cdea6ac9e5edbaa115cd72'),
    });
    expect((await h.one({ kind: 'getChannel', index: 7 }, 'channelInfo')).channel).toEqual({ index: 7, name: '', secret: new Uint8Array(16) });
    expect(await h.err({ kind: 'getChannel', index: 8 })).toBe(ERR.NOT_FOUND);
    const secret = x('0102030405060708090a0b0c0d0e0f10');
    await h.one({ kind: 'setChannel', index: 3, name: '#hiking', secret }, 'ok');
    expect((await h.one({ kind: 'getChannel', index: 3 }, 'channelInfo')).channel).toEqual({ index: 3, name: '#hiking', secret });
    expect(await h.err({ kind: 'setChannel', index: 8, name: 'x', secret })).toBe(ERR.NOT_FOUND);
    expect(await h.err(concatBytes(x('20 01'), new Uint8Array(64)))).toBe(ERR.UNSUPPORTED_CMD);
  });

  it('GET_BATT_AND_STORAGE and GET_STATS (core / radio / packets; other types ERR 6)', async () => {
    const h = await setup({ contacts: contactSeeds, battery: { mv: 3999, storageUsedKb: 10, storageTotalKb: 500 } });
    expect((await h.one({ kind: 'getBattAndStorage' }, 'battAndStorage')).batt).toEqual({ batteryMv: 3999, storageUsedKb: 10, storageTotalKb: 500 });
    h.clock.advance(61_000);
    expect((await h.one({ kind: 'getStats', statsType: 0 }, 'stats')).stats).toEqual({ type: 'core', batteryMv: 3999, uptimeSecs: 61, errFlags: 0, outboundQueueLen: 0 });
    await h.send({ kind: 'sendTxtMsg', recipient: CAROL, text: 'x', timestamp: 1 });
    await h.send({ kind: 'sendSelfAdvert', flood: true });
    h.emu.injectContactMessage(ALICE, 'in', { pathLen: 0xff, snr: -3.5 });
    await settle();
    h.take();
    expect((await h.one({ kind: 'getStats', statsType: 2 }, 'stats')).stats).toMatchObject({ type: 'packets', recv: 1, sent: 2, sentFlood: 1, sentDirect: 1, recvDirect: 1, recvFlood: 0 });
    expect((await h.one({ kind: 'getStats', statsType: 1 }, 'stats')).stats).toMatchObject({ type: 'radio', noiseFloorDbm: -112, lastSnr: -3.5 });
    expect(await h.err({ kind: 'getStats', statsType: 3 })).toBe(ERR.ILLEGAL_ARG);
  });

  it('SEND_SELF_ADVERT: OK; [1]=1 floods, otherwise zero-hop; location only with advert_loc_policy', async () => {
    const h = await setup({ lat: 1, lon: 2 });
    await h.one({ kind: 'sendSelfAdvert' }, 'ok');
    await h.one({ kind: 'sendSelfAdvert', flood: true }, 'ok');
    const ads = h.emu.airLog.filter((e) => e.type === 'advert');
    expect(ads.map((e) => e.type === 'advert' && e.flood)).toEqual([false, true]);
    const first = ads[0];
    if (first?.type !== 'advert') throw new Error('advert expected');
    expect(advertOf(first.packet)).not.toHaveProperty('latE6');
    // on air: zero-hop = DIRECT path_len 0 (0x12), flood = FLOOD (0x11)
    expect(ads.map((e) => e.raw?.[0])).toEqual([0x12, 0x11]);
  });

  it('EXPORT/IMPORT_PRIVATE_KEY; importing re-derives the public key; DISABLED when compiled out', async () => {
    const h = await setup();
    const exported = await h.one({ kind: 'exportPrivateKey' }, 'privateKey');
    expect(exported.privateKey).toEqual(h.emu.privateKey);
    const before = h.emu.publicKey;
    await h.one({ kind: 'importPrivateKey', privateKey: exported.privateKey }, 'ok');
    expect(h.emu.publicKey).toEqual(before); // same key: unchanged
    const other = new Uint8Array(64).fill(0x33);
    await h.one({ kind: 'importPrivateKey', privateKey: other }, 'ok');
    expect(h.emu.publicKey).not.toEqual(before);
    expect((await h.one({ kind: 'appStart' }, 'selfInfo')).info.pubKey).toEqual(h.emu.publicKey);
    expect(await h.err({ kind: 'importPrivateKey', privateKey: new Uint8Array(64) })).toBe(ERR.ILLEGAL_ARG);

    const d = await setup({ privateKeyExport: false, privateKeyImport: false });
    expect(kinds(await d.send({ kind: 'exportPrivateKey' }))).toEqual(['disabled']);
    expect(kinds(await d.send({ kind: 'importPrivateKey', privateKey: other }))).toEqual(['disabled']);
  });

  it('SIGN_START / SIGN_DATA / SIGN_FINISH (real, deterministic Ed25519 signature) and their ERR codes', async () => {
    const h = await setup();
    expect(await h.err({ kind: 'signData', chunk: x('01') })).toBe(ERR.BAD_STATE);
    expect(await h.err({ kind: 'signFinish' })).toBe(ERR.BAD_STATE);
    expect(await h.one({ kind: 'signStart' }, 'signStart')).toMatchObject({ maxLen: 8192 });
    await h.one({ kind: 'signData', chunk: x('0102') }, 'ok');
    await h.one({ kind: 'signData', chunk: x('03') }, 'ok');
    const sig1 = await h.one({ kind: 'signFinish' }, 'signature');
    expect(sig1.signature.length).toBe(64);
    expect(await ed25519Verify(h.emu.publicKey, x('010203'), sig1.signature)).toBe(true);
    expect(await h.err({ kind: 'signFinish' })).toBe(ERR.BAD_STATE); // buffer freed
    await h.send({ kind: 'signStart' });
    await h.send({ kind: 'signData', chunk: x('010203') });
    expect((await h.one({ kind: 'signFinish' }, 'signature')).signature).toEqual(sig1.signature);
    await h.send({ kind: 'signStart' });
    for (let i = 0; i < 48; i++) await h.send({ kind: 'signData', chunk: new Uint8Array(170) }); // 8160 B
    expect(await h.err({ kind: 'signData', chunk: new Uint8Array(33) })).toBe(ERR.TABLE_FULL);
    await h.one({ kind: 'signData', chunk: new Uint8Array(32) }, 'ok'); // exactly 8192
  });

  it('RUN_CLI_COMMAND → CLI_REPLY (prefix reflected; "Unknown command")', async () => {
    const h = await setup({ firmware: { manufacturer: 'Board X' } });
    expect((await h.one({ kind: 'runCliCommand', command: 'get name' }, 'cliReply')).text).toBe('> Emu');
    expect((await h.one({ kind: 'runCliCommand', command: 'set name Peak' }, 'cliReply')).text).toBe('OK');
    expect((await h.one({ kind: 'runCliCommand', command: 'set name a:b' }, 'cliReply')).text).toBe('Error, bad chars');
    expect((await h.one({ kind: 'runCliCommand', command: '01|ver' }, 'cliReply')).text).toBe('01|v1.18.0 (Build: 15 Oct 2026)');
    expect((await h.one({ kind: 'runCliCommand', command: 'board' }, 'cliReply')).text).toBe('Board X');
    expect((await h.one({ kind: 'runCliCommand', command: 'frobnicate' }, 'cliReply')).text).toBe('Unknown command');
    expect((await h.one({ kind: 'appStart' }, 'selfInfo')).info.name).toBe('Peak');
  });

  it('raw sends: SEND_RAW_DATA, SEND_RAW_PACKET (parse-checked), SEND_CONTROL_DATA', async () => {
    const h = await setup();
    await h.one({ kind: 'sendRawData', pathLen: 1, path: x('aa'), payload: x('01020304') }, 'ok');
    expect(await h.err(x('19 ff 01020304'))).toBe(ERR.UNSUPPORTED_CMD); // flood not supported
    expect(await h.err(x('19 01 aa 010203'))).toBe(ERR.ILLEGAL_ARG);
    await h.one({ kind: 'sendRawPacket', priority: 1, packet: x('3e00 01020304') }, 'ok');
    expect(await h.err({ kind: 'sendRawPacket', priority: 1, packet: x('3e05 0102') })).toBe(ERR.ILLEGAL_ARG); // path past the end
    await h.one({ kind: 'sendControlData', payload: x('80 00 01020304') }, 'ok');
    expect(h.emu.airLog.map((e) => e.type)).toEqual(['rawData', 'rawPacket', 'controlData']);
  });

  it('HAS_CONNECTION → ERR 2 without a keep-alive connection; LOGOUT → OK', async () => {
    const h = await setup({ contacts: contactSeeds });
    expect(await h.err({ kind: 'hasConnection', pubKey: ALICE })).toBe(ERR.NOT_FOUND);
    await h.one({ kind: 'logout', pubKey: ALICE }, 'ok');
  });

  it('unknown and unassigned codes → ERR 1', async () => {
    const h = await setup();
    for (const code of [0x00, 0x2c, 0x31, 0x35, 0x43, 0xff]) expect(await h.err(Uint8Array.of(code))).toBe(ERR.UNSUPPORTED_CMD);
  });
});

describe('reboot and factory reset', () => {
  it('REBOOT: no response, the link drops, volatile state is lost, persisted state kept', async () => {
    const h = await setup({ contacts: contactSeeds, rebootDelayMs: 100 });
    await h.send({ kind: 'deviceQuery', appTargetVer: 3 });
    h.emu.injectContactMessage(ALICE, 'queued');
    await h.send({ kind: 'setAdvertName', name: 'Kept' });
    h.take();
    const states: string[] = [];
    h.host.events.on('state', (s) => states.push(s));
    expect(await h.send({ kind: 'reboot' })).toEqual([]);
    expect(states).toEqual(['disconnected']);
    expect(h.emu.offline).toBe(true);
    h.emu.handleFrame(encodeCommand({ kind: 'appStart' })); // ignored while rebooting
    await h.advance(100);
    expect(h.emu.offline).toBe(false);
    await h.host.connect();
    expect(h.emu.appTargetVer).toBe(0);
    expect(h.emu.offlineQueue).toEqual([]);
    expect((await h.one({ kind: 'appStart' }, 'selfInfo')).info.name).toBe('Kept');
    expect(h.emu.contacts.length).toBe(3);
  });

  it('REBOOT needs the literal; FACTORY_RESET wipes contacts, channels and identity (no OK)', async () => {
    const h = await setup({ contacts: contactSeeds, channels: [null, { name: 'x', secret: new Uint8Array(16).fill(1) }] });
    expect(await h.err(x('13 7265626f'))).toBe(ERR.UNSUPPORTED_CMD);
    const reboots: boolean[] = [];
    h.emu.events.on('reboot', (r) => reboots.push(r.factoryReset));
    const before = h.emu.publicKey;
    expect(await h.send({ kind: 'factoryReset' })).toEqual([]);
    expect(reboots).toEqual([true]);
    expect(h.emu.contacts).toEqual([]);
    expect(h.emu.publicKey).not.toEqual(before);
    expect(h.emu.channels[0]?.name).toBe('Public');
    expect(h.emu.channels[1]?.name).toBe('');
    expect(h.emu.prefs.name).toBe('NONAME');
  });
});

describe('remote requests (§4 notes, §6.6-§6.10)', () => {
  const nodes = (extra: Partial<RemoteNodeConfig> = {}): RemoteNodeConfig[] => [
    { type: 'repeater', pubKey: RPT, name: 'Rpt', password: 'admin', guestPassword: 'guest', responseDelayMs: 100, contact: { outPathLen: 0 }, ...extra },
    { type: 'room', pubKey: ROOM, name: 'Room', password: 'admin', guestPassword: '', responseDelayMs: 100, contact: { outPathLen: 0 } },
    { type: 'sensor', pubKey: SENSOR, name: 'Sensor', responseDelayMs: 100, telemetry: x('01 74 018a 02 67 00b8'), contact: { outPathLen: 0 } },
  ];

  it('SEND_LOGIN: SENT tag = first 4 pubkey bytes; LOGIN_SUCCESS (admin, ACL, level) after the delay', async () => {
    const h = await setup({ remoteNodes: nodes() });
    const sent = await h.one({ kind: 'sendLogin', pubKey: RPT, password: 'admin' }, 'sent');
    expect(sent.tagBytes).toEqual(RPT.slice(0, 4));
    expect(sent.flood).toBe(false);
    expect(h.emu.pendingRequests.login).toBe(readU32LE(RPT, 0));
    const [f] = await h.advance(100);
    expect(f).toMatchObject({ kind: 'loginSuccess', adminFlag: 1, isAdmin: true, pubKeyPrefix: RPT.slice(0, 6), legacy: false, serverTimestamp: NOW, aclPermissions: 3, firmwareVerLevel: 2 });
    expect(h.emu.pendingRequests.login).toBe(0);
  });

  it('room guest login: is_admin 2, ACL guest; repeater guest: is_admin 0', async () => {
    const h = await setup({ remoteNodes: nodes() });
    await h.send({ kind: 'sendLogin', pubKey: ROOM, password: '' });
    expect((await h.advance(100))[0]).toMatchObject({ kind: 'loginSuccess', adminFlag: 2, isAdmin: false, aclPermissions: 0, firmwareVerLevel: 1 });
    await h.send({ kind: 'sendLogin', pubKey: RPT, password: 'guest' });
    expect((await h.advance(100))[0]).toMatchObject({ kind: 'loginSuccess', adminFlag: 0 });
  });

  it('wrong password: servers stay silent; with rejectWithResponse → LOGIN_FAIL; legacy servers → 8-byte LOGIN_SUCCESS', async () => {
    const h = await setup({ remoteNodes: nodes() });
    await h.send({ kind: 'sendLogin', pubKey: RPT, password: 'nope' });
    expect(await h.advance(1000)).toEqual([]);
    const r = await setup({ remoteNodes: nodes({ rejectWithResponse: true }) });
    await r.send({ kind: 'sendLogin', pubKey: RPT, password: 'nope' });
    expect(await r.advance(100)).toEqual([{ kind: 'loginFail', code: PUSH.LOGIN_FAIL, pubKeyPrefix: RPT.slice(0, 6) }]);
    const l = await setup({ remoteNodes: nodes({ legacyLogin: true }) });
    await l.send({ kind: 'sendLogin', pubKey: RPT, password: 'admin' });
    const [f] = await l.advance(100);
    expect(f).toMatchObject({ kind: 'loginSuccess', legacy: true, adminFlag: 0 });
    expect(l.raw).toEqual([]);
  });

  it('SEND_LOGIN to an unknown key → ERR 2; passwords are cut to 15 chars', async () => {
    const h = await setup({ remoteNodes: nodes({ password: '123456789012345' }) });
    expect(await h.err({ kind: 'sendLogin', pubKey: key(9), password: 'x' })).toBe(ERR.NOT_FOUND);
    await h.send({ kind: 'sendLogin', pubKey: RPT, password: '1234567890123456789' });
    expect((await h.advance(100))[0]?.kind).toBe('loginSuccess');
  });

  it('SEND_STATUS_REQ → STATUS_RESPONSE (RepeaterStats 56 B; room ServerStats 52 B); sensors do not answer', async () => {
    const h = await setup({ remoteNodes: nodes({ stats: { batteryMv: 4200, upTimeSecs: 3600, lastSnr: 6.25 } }) });
    const sent = await h.one({ kind: 'sendStatusReq', pubKey: RPT }, 'sent');
    expect(sent.tag).toBe(NOW); // tag = getCurrentTimeUnique
    const [st] = await h.advance(100);
    if (st?.kind !== 'statusResponse') throw new Error('expected STATUS_RESPONSE');
    expect(st.raw.length).toBe(56);
    expect(st.stats).toMatchObject({ kind: 'repeater', batteryMv: 4200, upTimeSecs: 3600, lastSnr: 6.25 });
    const sentRoom = await h.one({ kind: 'sendStatusReq', pubKey: ROOM }, 'sent');
    expect(sentRoom.tag).toBe(NOW + 1); // unique, strictly increasing
    const [room] = await h.advance(100);
    expect(room).toMatchObject({ kind: 'statusResponse', stats: { kind: 'room', posted: 10 } });
    await h.send({ kind: 'sendStatusReq', pubKey: SENSOR });
    expect(await h.advance(500)).toEqual([]);
  });

  it('SEND_TELEMETRY_REQ → TELEMETRY_RESPONSE (matched by tag); self telemetry (len 4) answers at once, no SENT', async () => {
    const h = await setup({ remoteNodes: nodes(), battery: { mv: 4000 }, mcuTemperature: 21.5 });
    await h.one({ kind: 'sendTelemetryReq', pubKey: SENSOR }, 'sent');
    expect(await h.advance(100)).toEqual([{ kind: 'telemetryResponse', code: PUSH.TELEMETRY_RESPONSE, pubKeyPrefix: SENSOR.slice(0, 6), lpp: x('01 74 018a 02 67 00b8') }]);
    const self = await h.one({ kind: 'sendTelemetryReq' }, 'telemetryResponse');
    expect(self).toMatchObject({ pubKeyPrefix: h.emu.publicKey.slice(0, 6), lpp: x('01 74 0190 01 67 00d7') });
  });

  it('SEND_BINARY_REQ → BINARY_RESPONSE with the SENT tag (neighbours, ACL, owner info, custom handler)', async () => {
    const h = await setup({
      remoteNodes: nodes({
        neighbours: [{ pubKey: ALICE, heardSecsAgo: 60, snr: 5.5 }],
        acl: [{ prefix: ALICE.slice(0, 6), permissions: 3 }],
        ownerInfo: 'me',
        onBinaryRequest: (t) => (t === 0x7f ? x('cafe') : undefined),
      }),
    });
    const sent = await h.one({ kind: 'sendBinaryReq', pubKey: RPT, data: x('06 00 05 0000 00 04 01020304') }, 'sent');
    const [nb] = await h.advance(100);
    expect(nb).toMatchObject({ kind: 'binaryResponse', tag: sent.tag });
    expect(toHex((nb as FrameOf<'binaryResponse'>).data)).toBe('0100' + '0100' + toHex(ALICE.slice(0, 4)) + '3c000000' + '16');
    await h.send({ kind: 'sendBinaryReq', pubKey: RPT, data: Uint8Array.of(ReqType.GET_ACCESS_LIST, 0, 0) });
    expect((await h.advance(100))[0]).toMatchObject({ data: concatBytes(ALICE.slice(0, 6), x('03')) });
    await h.send({ kind: 'sendBinaryReq', pubKey: RPT, data: Uint8Array.of(ReqType.GET_OWNER_INFO) });
    expect((await h.advance(100))[0]).toMatchObject({ data: utf8Encode('v1.18.0\nRpt\nme') });
    await h.send({ kind: 'sendBinaryReq', pubKey: RPT, data: x('7f') });
    expect((await h.advance(100))[0]).toMatchObject({ data: x('cafe') });
  });

  it('mutex: a new request clears the pending one; the late reply arrives as an unmatched BINARY_RESPONSE', async () => {
    const h = await setup({ remoteNodes: nodes() });
    const status = await h.one({ kind: 'sendStatusReq', pubKey: RPT }, 'sent');
    h.clock.advance(50);
    const bin = await h.one({ kind: 'sendBinaryReq', pubKey: ROOM, data: Uint8Array.of(ReqType.GET_STATUS) }, 'sent');
    expect(h.emu.pendingRequests).toEqual({ login: 0, status: 0, telemetry: 0, discovery: 0, req: bin.tag });
    const [late] = await h.advance(50);
    if (late?.kind !== 'binaryResponse') throw new Error('expected BINARY_RESPONSE');
    // [2..5] is the remote's tag (= the old request's timestamp), then the status struct
    expect(late.tag).toBe(status.tag);
    expect(late.data.length).toBe(56);
    const [matched] = await h.advance(50);
    expect(matched).toMatchObject({ kind: 'binaryResponse', tag: bin.tag });
    expect((matched as FrameOf<'binaryResponse'>).data.length).toBe(52);
  });

  it('a late login reply after another request is not a LOGIN_SUCCESS', async () => {
    const h = await setup({ remoteNodes: nodes({ responseDelayMs: 3000 }) });
    await h.send({ kind: 'sendLogin', pubKey: RPT, password: 'admin' });
    h.clock.advance(2000);
    await h.send({ kind: 'sendTelemetryReq', pubKey: SENSOR }); // tag NOW+2, answered at +2.1 s
    const fs = await h.advance(1000);
    expect(kinds(fs)).toEqual(['telemetryResponse', 'binaryResponse']);
    expect((fs[1] as FrameOf<'binaryResponse'>).tag).toBe(NOW + 3); // the login reply's server time
    expect((fs[1] as FrameOf<'binaryResponse'>).data[0]).toBe(0); // RESP_SERVER_LOGIN_OK
  });

  it('quirk: a late reply whose tag equals the pending telemetry tag is taken as TELEMETRY_RESPONSE', async () => {
    // the login reply's tag is the server's clock — here NOW + 1 after a 1 s reply delay — the same
    // value the device used as the telemetry request tag (its unique RTC: the login took NOW), so
    // §6.10 rule 3 matches it; the sensor's real reply then arrives unmatched
    const [rpt, , sensor] = nodes({ responseDelayMs: 1000 });
    const h = await setup({ remoteNodes: [rpt!, { ...sensor!, responseDelayMs: 1500 }] });
    await h.send({ kind: 'sendLogin', pubKey: RPT, password: 'admin' });
    await h.send({ kind: 'sendTelemetryReq', pubKey: SENSOR });
    const fs = await h.advance(1500);
    expect(kinds(fs)).toEqual(['telemetryResponse', 'binaryResponse']);
    expect(fs[0]).toMatchObject({ pubKeyPrefix: RPT.slice(0, 6) });
  });

  it('flood-routed requests learn the return path: PATH_UPDATED precedes the response', async () => {
    const h = await setup({ remoteNodes: [{ type: 'repeater', pubKey: RPT, name: 'Rpt', returnPath: { pathLen: 1, path: x('99') } }] });
    const sent = await h.one({ kind: 'sendStatusReq', pubKey: RPT }, 'sent');
    expect(sent.flood).toBe(true);
    expect(kinds(await h.advance(300))).toEqual(['pathUpdated', 'statusResponse']);
    expect(h.emu.getContact(RPT)).toMatchObject({ outPathLen: 1, outPath: x('99') });
    expect((await h.one({ kind: 'sendStatusReq', pubKey: RPT }, 'sent')).flood).toBe(false);
  });

  it('SEND_PATH_DISCOVERY_REQ: always flood; PATH_DISCOVERY_RESPONSE without touching the contact path', async () => {
    const h = await setup({ remoteNodes: nodes({ returnPath: { pathLen: 2, path: x('a1a2') }, discoveryInPath: { pathLen: 1, path: x('b1') } }) });
    const sent = await h.one({ kind: 'sendPathDiscoveryReq', pubKey: RPT }, 'sent');
    expect(sent.flood).toBe(true);
    expect(h.emu.pendingRequests.discovery).toBe(sent.tag);
    const [f] = await h.advance(100);
    expect(f).toMatchObject({ kind: 'pathDiscoveryResponse', pubKeyPrefix: RPT.slice(0, 6), outPathLen: 2, outPath: x('a1a2'), inPathLen: 1, inPath: x('b1') });
    expect(h.emu.getContact(RPT)?.outPathLen).toBe(0);
    // late discovery reply → normal PATH handling
    await h.send({ kind: 'sendPathDiscoveryReq', pubKey: RPT });
    await h.send({ kind: 'sendStatusReq', pubKey: ROOM });
    expect(kinds(await h.advance(100))).toEqual(['pathUpdated', 'binaryResponse', 'statusResponse']);
    expect(h.emu.getContact(RPT)).toMatchObject({ outPathLen: 2, outPath: x('a1a2') });
  });

  it('SEND_TRACE_PATH: SENT [1]=0 with the tag echoed; TRACE_DATA with per-hop SNRs; unknown hops get no reply', async () => {
    const h = await setup({ remoteNodes: [{ type: 'repeater', pubKey: RPT, name: 'R1', snr: 7.5 }, { type: 'repeater', pubKey: ROOM, name: 'R2', snr: -2 }] });
    const sent = await h.one({ kind: 'sendTracePath', tag: 0xabcdef01, authCode: 7, path: Uint8Array.of(RPT[0]!, ROOM[0]!) }, 'sent');
    expect(sent).toMatchObject({ flood: false, tag: 0xabcdef01 });
    expect(h.emu.pendingRequests).toEqual({ login: 0, status: 0, telemetry: 0, discovery: 0, req: 0 }); // not part of the mutex
    const [t] = await h.advance(600);
    expect(t).toMatchObject({ kind: 'traceData', tag: 0xabcdef01, authCode: 7, pathLen: 2, flags: 0, snrs: [7.5, -2], finalSnr: -2 });
    await h.send({ kind: 'sendTracePath', tag: 1, authCode: 0, path: x('ee') });
    expect(await h.advance(5000)).toEqual([]);
    // 2-byte hashes
    const t2 = await h.one({ kind: 'sendTracePath', tag: 2, authCode: 0, path: RPT.slice(0, 2), pathHashSize: 2 }, 'sent');
    expect(t2.tag).toBe(2);
    expect((await h.advance(300))[0]).toMatchObject({ kind: 'traceData', flags: 1, pathHashSize: 2, snrs: [7.5] });
  });

  it('offline nodes never answer; ANON_REQ to an unknown key creates a temporary contact', async () => {
    const h = await setup({ remoteNodes: nodes({ online: false }) });
    await h.send({ kind: 'sendStatusReq', pubKey: RPT });
    expect(await h.advance(5000)).toEqual([]);
    const sent = await h.one({ kind: 'sendAnonReq', pubKey: key(9), data: x('03') }, 'sent');
    expect(sent.flood).toBe(false); // anon contact = zero-hop direct
    expect(h.emu.anonContacts.map((c) => c.pubKey)).toEqual([key(9)]);
    expect((await h.one({ kind: 'getContacts' }, 'contactsStart')).total).toBe(3); // anon slots not counted
  });

  it('remote request ERR 2 for unknown contacts', async () => {
    const h = await setup();
    for (const cmd of [
      { kind: 'sendStatusReq', pubKey: key(9) },
      { kind: 'sendTelemetryReq', pubKey: key(9) },
      { kind: 'sendBinaryReq', pubKey: key(9), data: x('01') },
      { kind: 'sendPathDiscoveryReq', pubKey: key(9) },
    ] as Command[]) {
      expect(await h.err(cmd)).toBe(ERR.NOT_FOUND);
    }
  });
});

describe('over-the-air receive (LOG_RX_DATA, RAW_DATA, CONTROL_DATA)', () => {
  it('every received packet is logged first; DIRECT RAW_CUSTOM → RAW_DATA; zero-hop CONTROL → CONTROL_DATA', async () => {
    const h = await setup();
    h.emu.injectRxPacket(x('3e 00 deadbeef'), 6.5, -97); // RAW_CUSTOM, DIRECT
    h.emu.injectRxPacket(x('2e 00 9201020304'), 2, -60); // CONTROL, DIRECT zero-hop
    h.emu.injectRxPacket(x('ff'), 0, -120); // garbage: logged only
    await settle();
    expect(h.take()).toEqual([
      { kind: 'logRxData', code: 0x88, snr: 6.5, rssi: -97, packet: x('3e00deadbeef') },
      { kind: 'rawData', code: 0x84, snr: 6.5, rssi: -97, payload: x('deadbeef') },
      { kind: 'logRxData', code: 0x88, snr: 2, rssi: -60, packet: x('2e009201020304') },
      { kind: 'controlData', code: 0x8e, snr: 2, rssi: -60, pathLen: 0, payload: x('9201020304') },
      { kind: 'logRxData', code: 0x88, snr: 0, rssi: -120, packet: x('ff') },
    ]);
  });

  it('logRx: false suppresses LOG_RX_DATA; packets longer than 173 bytes are not logged', async () => {
    const h = await setup({ logRx: false });
    h.emu.injectRxPacket(x('3e 00 01020304'));
    await settle();
    expect(kinds(h.take())).toEqual(['rawData']);
    const g = await setup();
    g.emu.injectRxPacket(concatBytes(x('3e 00'), new Uint8Array(172)));
    await settle();
    expect(kinds(g.take())).toEqual(['rawData']);
  });
});

describe('handleFrame / onFrame API (for the web mocks)', () => {
  it('works without a transport; "connected" while a sink is registered', () => {
    const emu = new CompanionEmulator({ clock: new ManualClock(START), seed: 3, contacts: contactSeeds });
    const out: Uint8Array[] = [];
    emu.injectContactMessage(ALICE, 'before'); // no sink → no MSG_WAITING
    expect(emu.connected).toBe(false);
    const off = emu.onFrame((f) => out.push(f));
    emu.handleFrame(encodeCommand({ kind: 'getDeviceTime' }));
    emu.injectContactMessage(ALICE, 'after');
    emu.handleFrame(x('16')); // ERR 1
    off();
    emu.handleFrame(encodeCommand({ kind: 'getDeviceTime' }));
    expect(out.map((f) => toHex(f))).toEqual([toHex(concatBytes(x('09'), u32le(NOW))), '83', '0101']);
  });

  it('frames over 176 bytes are truncated like the serial parser does', () => {
    const emu = new CompanionEmulator({ clock: new ManualClock(START), seed: 3 });
    const seen: Uint8Array[] = [];
    emu.events.on('frameIn', (f) => seen.push(f));
    emu.onFrame(() => undefined);
    emu.handleFrame(concatBytes(x('22'), new Uint8Array(200)));
    expect(seen[0]?.length).toBe(176);
  });
});
