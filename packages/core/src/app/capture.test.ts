/**
 * CapturePipeline (app/capture.ts) edge cases: channel messages on slots the store does not know,
 * DMs from senders that are not contacts, and the direct-signal (zero-hop SNR) bookkeeping.
 */

import { describe, expect, it, vi } from 'vitest';
import { toHex } from '../util/bytes.js';
import { channelKeyForPsk } from '../store/channels.js';
import { PayloadType } from '../packet/constants.js';
import { CMD, encodePathLen } from '../protocol/constants.js';
import { hashtagChannelSecret, scenarioKey } from '../emulator/scenarios.js';
import type { RadioStore } from '../store/radio-store.js';
import type { AppModel } from './app-model.js';
import { testApp } from './testing.js';
import { unknownChannelKey } from './capture.js';
import type { TransportFactory } from './connection.js';

/**
 * Connects the app to the basic scenario. With `failGetChannel`, a GET_CHANNEL for that slot is
 * rewritten on the wire to an out-of-range index, so the device answers ERR_NOT_FOUND.
 */
async function connected(opts: { failGetChannel?: number } = {}) {
  let emulator: TransportFactory | undefined;
  const factory: TransportFactory = async (req) => {
    const t = await emulator!(req);
    const fail = opts.failGetChannel;
    if (fail === undefined) return t;
    const send = t.send.bind(t);
    return Object.assign(t, {
      send: (f: Uint8Array) => send(f[0] === CMD.GET_CHANNEL && f[1] === fail ? Uint8Array.of(CMD.GET_CHANNEL, 200) : f),
    });
  };
  const t = testApp({ scenario: { defaultAckDelayMs: 0 }, app: { createEmulatorTransport: factory } });
  emulator = t.emulator;
  const { app } = t;
  expect(await app.connection.connect('emulator')).toBe(true);
  await app.connection.capture!.idle();
  const s = t.emulator.scenario();
  return { app, clock: t.clock, s, emu: s.emulator, store: app.connection.store.value! };
}

/** Waits (via the capture queue) until `convKey` holds a message with `text`. */
async function messageArrives(app: AppModel, store: RadioStore, convKey: string, text: string) {
  return vi.waitFor(async () => {
    await app.connection.capture!.idle();
    const m = (await store.messages.list(convKey)).items.find((x) => x.text === text);
    expect(m).toBeDefined();
    return m!;
  });
}

describe('channel messages on a slot missing from the store', () => {
  it('looks the slot up with getChannel and files the message under that channel', async () => {
    const { app, emu, store } = await connected();
    expect(await store.channels.byDeviceIndex(2)).toBeUndefined();
    const secret = hashtagChannelSecret('#late');
    emu.setChannelSlot(2, '#late', secret); // written behind the app's back: no push, store unaware
    emu.injectChannelMessage(2, 'Eve', 'joined late');
    const key = await channelKeyForPsk(secret);
    const msg = await messageArrives(app, store, key, 'joined late');
    expect(msg).toMatchObject({ convType: 'channel', senderName: 'Eve' });
    expect(await store.channels.byDeviceIndex(2)).toMatchObject({ key, name: '#late', deviceIndex: 2 });
    expect((await store.messages.list(unknownChannelKey(2))).items).toEqual([]);
  });

  it('uses the "slot-N" key when getChannel reports an empty slot', async () => {
    const { app, emu, store } = await connected();
    expect(unknownChannelKey(5)).toBe('slot-5');
    emu.injectChannelMessage(5, 'Ghost', 'anyone here?');
    const msg = await messageArrives(app, store, 'slot-5', 'anyone here?');
    expect(msg).toMatchObject({ convType: 'channel', convKey: 'slot-5', senderName: 'Ghost' });
    expect(await store.channels.byDeviceIndex(5)).toBeUndefined();
    expect(app.notifications.toasts.value.filter((t) => t.kind === 'error')).toEqual([]);
  });

  it('falls back to the "slot-N" key when getChannel fails, reporting the error', async () => {
    const { app, emu, store } = await connected({ failGetChannel: 3 });
    const secret = hashtagChannelSecret('#hidden');
    emu.setChannelSlot(3, '#hidden', secret);
    emu.injectChannelMessage(3, 'Eve', 'can you see me?');
    const msg = await messageArrives(app, store, unknownChannelKey(3), 'can you see me?');
    expect(msg).toMatchObject({ convType: 'channel', convKey: 'slot-3', senderName: 'Eve' });
    expect(await store.channels.byDeviceIndex(3)).toBeUndefined();
    expect((await store.messages.list(await channelKeyForPsk(secret))).items).toEqual([]);
    // the pipeline's onError → the connection's "Could not save getChannel" toast
    expect(app.notifications.toasts.value.some((t) => t.kind === 'error' && /getChannel/.test(t.message))).toBe(true);
  });
});

describe('DMs from a sender that is not a contact', () => {
  it('lands under the 12-hex-char sender prefix and creates no contact record', async () => {
    const { app, emu, store } = await connected();
    const dave = scenarioKey('dave');
    // on the device, but neither the client's contact cache nor the store know Dave
    emu.addContact({ pubKey: dave, name: 'Dave' });
    expect(app.connection.client.value!.findContact(dave.slice(0, 6))).toBeUndefined();
    const before = await store.contacts.count();
    emu.injectContactMessage(dave, 'who am I?', { pathLen: 0, snr: 7 });
    const prefixKey = toHex(dave.slice(0, 6));
    expect(prefixKey).toHaveLength(12);
    const msg = await messageArrives(app, store, prefixKey, 'who am I?');
    expect(msg).toMatchObject({ convType: 'contact', convKey: prefixKey, direction: 'in' });
    // no touch / recordDirect: nothing was created or updated under either key
    expect(await store.contacts.count()).toBe(before);
    expect(await store.contacts.get(prefixKey)).toBeUndefined();
    expect(await store.contacts.get(toHex(dave))).toBeUndefined();
    expect((await store.messages.list(toHex(dave))).items).toEqual([]);
  });
});

describe('direct signal (zero-hop SNR, issue #11)', () => {
  it('a zero-hop DM records the SNR on the contact; a relayed one does not', async () => {
    const { app, s, emu, store } = await connected();
    const bob = toHex(s.keys.bob);
    const carol = toHex(s.keys.carol);
    expect((await store.contacts.get(bob))?.directSnr).toBeUndefined();
    emu.injectContactMessage(s.keys.bob, 'right here', { pathLen: 0, snr: 5.25 });
    emu.injectContactMessage(s.keys.carol, 'via the hill', { pathLen: encodePathLen(1), snr: 2 });
    await messageArrives(app, store, bob, 'right here');
    await messageArrives(app, store, carol, 'via the hill');
    const b = (await store.contacts.get(bob))!;
    expect(b.directSnr).toBe(5.25);
    expect(b.directSnrAt).toBe(b.lastSeen);
    expect((await store.contacts.get(carol))?.directSnr).toBeUndefined();
  });

  it('never moves backwards in time: a newer stored reading survives a zero-hop advert', async () => {
    const { app, clock, s, store } = await connected();
    const bob = toHex(s.keys.bob);
    const alice = toHex(s.keys.alice);
    const future = clock.now() + 3_600_000;
    await store.contacts.updateLocal(bob, { directSnr: -3, directSnrAt: future });
    const adverts = () => store.packets.count({ payloadType: PayloadType.ADVERT });
    const before = await adverts();
    s.nodes.bob.advertise({ flood: false });
    s.nodes.alice.advertise({ flood: false });
    await vi.waitFor(async () => {
      await app.connection.capture!.idle();
      expect(await adverts()).toBeGreaterThanOrEqual(before + 2);
    });
    await app.connection.capture!.idle();
    // Alice (no previous reading) takes the advert's SNR, Bob keeps the newer one
    expect((await store.contacts.get(alice))?.directSnr).toBe(8);
    expect(await store.contacts.get(bob)).toMatchObject({ directSnr: -3, directSnrAt: future });
  });
});
