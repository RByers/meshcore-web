import { describe, expect, it, vi } from 'vitest';
import { toHex } from '../util/bytes.js';
import { PayloadType } from '../packet/constants.js';
import { channelKeyForPsk } from '../store/channels.js';
import type { MessageRecord, MessageStatus } from '../store/schema.js';
import { FAST_TIMING, publicChannelSecret } from '../emulator/scenarios.js';
import type { AppModelOptions } from './app-model.js';
import { FAST_RETRY, connectedApp } from './testing.js';

async function connected(over: AppModelOptions = {}) {
  const t = await connectedApp({ app: over });
  return { t, app: t.app, s: t.scenario, hex: t.keys, store: t.store };
}

describe('ChatModel: direct messages', () => {
  it('sends with progress pending → sent → delivered and receives the auto-reply', async () => {
    const { app, hex, store, s } = await connected();
    const chat = app.chat('contact', hex.alice);
    await chat.settled();
    const statuses: MessageStatus[] = [];
    store.events.on('message', (e) => {
      if (e.type !== 'delete' && e.record.direction === 'out') statuses.push(e.record.status);
    });
    const h = await chat.send('ping');
    expect(h.record.status).toBe('pending');
    expect(h.record.attempt).toBe(0);
    const done = await h.done;
    expect(done.status).toBe('delivered');
    expect(done.ackCode).toBeGreaterThan(0);
    expect(done.roundTripMs).toBeGreaterThanOrEqual(FAST_TIMING.ackDelayMs); // the shared clock times the emulated ACK delay
    expect(done.deliveredAt).toBeGreaterThan(0);
    expect(statuses[0]).toBe('pending');
    expect(statuses).toContain('sent');
    expect(statuses.at(-1)).toBe('delivered');
    expect(s.nodes.alice.inbox.map((x) => x.text)).toContain('ping');
    await vi.waitFor(() => expect(chat.messages.value.map((x) => x.text)).toContain('pong'), { timeout: 5000 });
    const out = chat.messages.value.find((x) => x.direction === 'out')!;
    expect(out.status).toBe('delivered');
    expect((await store.messages.get(out.id))!.status).toBe('delivered');
  });

  it('marks a message failed when the peer never ACKs, and retry delivers it', async () => {
    const { t, app, hex, s } = await connected({ messaging: { retry: FAST_RETRY } });
    s.nodes.bob.config.ackPolicy = 'never';
    const chat = app.chat('contact', hex.bob);
    await chat.settled();
    const h = await chat.send('anyone?');
    await t.missAck(); // attempt 0
    await t.missAck(); // attempt 1 (the last)
    const failed = await h.done;
    expect(failed.status).toBe('failed');
    expect(failed.attempt).toBe(1);
    expect(s.nodes.bob.inbox.filter((x) => x.text === 'anyone?')).toHaveLength(2);
    await vi.waitFor(() => expect(chat.messages.value.find((m) => m.id === failed.id)?.status).toBe('failed'));

    s.nodes.bob.config.ackPolicy = 'auto';
    // a same-second retry must still go out as a new packet (retry bumps the sender timestamp)
    const r = await chat.retry(failed.id);
    expect(r.record.status).toBe('pending');
    const ok = await r.done;
    expect(ok.status).toBe('delivered');
    await expect(chat.retry(failed.id)).rejects.toThrow(/failed/);
  });

  it('validates length, applies the reply convention and finds the quoted message', async () => {
    const { app, hex } = await connected();
    const chat = app.chat('contact', hex.alice);
    await chat.settled();
    await vi.waitFor(() => expect(chat.contact.value?.name).toBe('Alice'));
    expect(chat.title.value).toBe('Alice');
    expect(chat.byteLimit.value).toBe(160);
    expect(chat.budget('héllo')).toMatchObject({ used: 6, remaining: 154, over: false });
    await expect(chat.send('x'.repeat(161))).rejects.toThrow(/too long/);
    await expect(chat.send('   ')).rejects.toThrow(/empty/);

    const incoming = chat.messages.value[0]!;
    chat.setReplyTo(incoming);
    expect(chat.byteLimit.value).toBe(160 - '@[Alice] '.length);
    const h = await chat.send('yes I am');
    expect(h.record.text).toBe('@[Alice] yes I am');
    expect(chat.replyTo.value).toBeNull();
    await vi.waitFor(() => expect(chat.messages.value.some((m) => m.id === h.record.id)).toBe(true));
    expect(chat.quotedMessage(h.record)?.id).toBe(incoming.id);
    await h.done;
  });

  it('pages history with loadMore', async () => {
    const { app, hex, store } = await connected();
    for (let i = 0; i < 5; i++) {
      await store.messages.append({ convKey: hex.carol, convType: 'contact', direction: 'in', text: `m${i}`, timestamp: 1000 + i, receivedAt: 1000 + i });
    }
    const chat = app.chat('contact', hex.carol);
    // a separate small-page model on the same conversation
    const { ChatModel } = await import('./chat-model.js');
    const small = new ChatModel(app.connection, 'contact', hex.carol, { pageSize: 2 }).start();
    await small.settled();
    expect(small.messages.value.map((m) => m.text)).toEqual(['m3', 'm4']);
    expect(small.hasMore.value).toBe(true);
    await small.loadMore();
    await small.loadMore();
    expect(small.messages.value.map((m) => m.text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(small.hasMore.value).toBe(false);
    small.dispose();
    await chat.settled();
    expect(chat.messages.value).toHaveLength(5);
  });
});

describe('ChatModel: channels', () => {
  it('sends "name: text" to the channel (status sent) and parses incoming senders', async () => {
    const { app, s } = await connected();
    const pubKey = await channelKeyForPsk(publicChannelSecret());
    const chat = app.chat('channel', pubKey);
    await chat.settled();
    await vi.waitFor(() => expect(chat.channel.value?.name).toBe('Public'));
    expect(chat.messages.value.map((m) => [m.senderName, m.text])).toEqual([['Dave', 'Good morning everyone']]);
    expect(chat.byteLimit.value).toBe(160 - 'Emulator: '.length);
    await expect(chat.send('y'.repeat(151))).rejects.toThrow(/too long/);

    const h = await chat.send('hello all');
    expect(h.record.senderName).toBe('Emulator');
    expect((await h.done).status).toBe('sent');
    await vi.waitFor(() => expect(s.nodes.alice.channelMessages.map((m) => m.text)).toContain('Emulator: hello all'));

    s.nodes.bob.sendChannelMessage('Public', 'hi from bob');
    await vi.waitFor(() => expect(chat.messages.value.at(-1)).toMatchObject({ senderName: 'Bob', text: 'hi from bob', direction: 'in' }), {
      timeout: 5000,
    });
  });

  it('fails a send to a channel that is not on the radio', async () => {
    const { app, store } = await connected();
    const rec = await store.channels.put({ name: 'Old', psk: new Uint8Array(16).fill(9), deviceIndex: null });
    const chat = app.chat('channel', rec.key);
    await chat.settled();
    await expect(chat.send('hi')).rejects.toThrow(/not on the radio/);
  });
});

describe('message paths and direct signal (issues #3, #11)', () => {
  it('stores the flood path of a relayed channel message and resolves it to the repeater', async () => {
    const { app, s, store } = await connected();
    const pub = (await store.channels.byDeviceIndex(0))!.key;
    // Carol only reaches the repeater, so her message arrives with a 1-hop path
    s.nodes.carol.sendChannelMessage('Public', 'via the hill');
    let msg: MessageRecord | undefined;
    await vi.waitFor(async () => {
      await app.connection.capture!.idle();
      msg = (await store.messages.list(pub)).items.find((m) => m.text === 'via the hill');
      expect(msg).toBeDefined();
    });
    expect(msg!.senderName).toBe('Carol');
    expect([...msg!.path!]).toEqual([s.keys.repeater[0]]);
    await app.contacts.settled();
    const countLabel = '1 hop';
    expect(app.contacts.pathLabel({ pathLen: msg!.pathLen, path: msg!.path, countLabel }, false).label).toBe('1 hop');
    expect(app.contacts.pathLabel({ pathLen: msg!.pathLen, path: msg!.path, countLabel }, true).label).toBe('Hilltop Repeater');
    // Alice's stored out path goes via the repeater too
    expect(app.contacts.outPathLabel(app.contacts.view(toHex(s.keys.alice))!, true).label).toBe('Hilltop Repeater');
  });

  it('records the SNR of zero-hop adverts and messages on the contact, ignoring relayed ones', async () => {
    const { app, s, hex, store } = await connected();
    s.nodes.bob.advertise({ flood: false });
    await vi.waitFor(async () => {
      await app.connection.capture!.idle();
      expect((await store.contacts.get(hex.bob))?.directSnr).toBe(8);
    });
    await app.contacts.settled();
    const bob = app.contacts.view(hex.bob)!;
    expect(bob.directSnr).toBe(8);
    expect(bob.directSnrAt).toBeGreaterThan(0);
    // the sensor is only heard through the repeater: no direct signal
    s.nodes.sensor.advertise();
    // wait until the relayed advert (1 hop via the repeater) has been captured: that is the step that
    // would record a direct hearing
    await vi.waitFor(async () => {
      await app.connection.capture!.idle();
      const adverts = (await store.packets.query({ payloadType: PayloadType.ADVERT, limit: 1000 })).items;
      expect(adverts.some((r) => r.pathLen === 1 && toHex(r.bytes).includes(hex.sensor))).toBe(true);
    });
    expect((await store.contacts.get(hex.sensor))?.directSnr).toBeUndefined();
    // a contact sync keeps the local direct-signal fields
    await app.contacts.refresh();
    expect((await store.contacts.get(hex.bob))?.directSnr).toBe(8);
  });
});
