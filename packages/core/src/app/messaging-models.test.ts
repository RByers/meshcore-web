import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { ContactFlag } from '../protocol/constants.js';
import { toHex } from '../util/bytes.js';
import { smazEncodeIfSmaller } from '../util/smaz.js';
import { channelKeyForPsk } from '../store/channels.js';
import type { MessageRecord, MessageStatus } from '../store/schema.js';
import { hashtagChannelSecret, publicChannelSecret, scenarioKey } from '../emulator/scenarios.js';
import { AppModel, createEmulatorTransportFactory, type AppModelOptions } from './app-model.js';
import { memoryPreferences } from './connection.js';
import { base64Encode } from './messaging.js';
import { messagePreview } from './contacts-model.js';
import { computeReactionHash, reactionMessageHash } from './reactions.js';

const apps: AppModel[] = [];

/** Short retry timings so the failure path finishes quickly with the real clock. */
const FAST_RETRY = { maxAttempts: 2, ackTimeoutMs: 1000, retryDelayMs: () => 0, lateAckGraceMs: 0 };

async function connected(over: AppModelOptions = {}) {
  const emulator = createEmulatorTransportFactory();
  const app = new AppModel({
    indexedDB: new IDBFactory(),
    keyRange: IDBKeyRange,
    createEmulatorTransport: emulator,
    preferences: memoryPreferences(),
    ...over,
  });
  apps.push(app);
  expect(await app.connection.connect('emulator')).toBe(true);
  await app.connection.capture!.idle();
  const s = emulator.scenario();
  const hex = {
    alice: toHex(s.keys.alice),
    bob: toHex(s.keys.bob),
    carol: toHex(s.keys.carol),
    repeater: toHex(s.keys.repeater),
    room: toHex(s.keys.room),
    sensor: toHex(s.keys.sensor),
  };
  return { app, s, hex, store: app.connection.store.value! };
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
});

describe('ContactsModel', () => {
  it('derives views: type, path, last message, unread, SNR', async () => {
    const { app, hex } = await connected();
    const m = app.contacts;
    await vi.waitFor(() => expect(m.views.value).toHaveLength(6));
    await m.settled();
    const alice = m.view(hex.alice)!;
    expect(alice.typeName).toBe('chat');
    expect(alice.path.label).toBe('1 hop');
    expect(alice.lastMessage?.text).toBe('Hi! Are you on the mesh today?');
    expect(alice.unread).toBe(1);
    expect(alice.lastSnr).toBe(6.5);
    expect(alice.favourite).toBe(true);
    expect(m.view(hex.repeater)!.path.label).toBe('direct');
    expect(m.view(hex.repeater)!.typeName).toBe('repeater');
    expect(m.view(hex.bob)!.path.label).toBe('flood');
    expect(m.view(hex.room)!.unread).toBe(1);
    expect(m.view(hex.sensor)!.typeName).toBe('sensor');
    expect(m.view(hex.bob)!.lastSeen).toBeGreaterThan(0);
  });

  it('sorts by recent activity or name, filters by type / favourites / unread and searches', async () => {
    const { app } = await connected();
    const m = app.contacts;
    await vi.waitFor(() => expect(m.views.value).toHaveLength(6));
    await m.settled();
    const names = () => m.visible.value.map((v) => v.name);
    // recent: contacts with messages (arrived now) first, then by last advert (newest first)
    expect(names().slice(0, 2).sort()).toEqual(['Alice', 'Town Square']);
    expect(names().slice(2)).toEqual(['Weather Station', 'Hilltop Repeater', 'Carol', 'Bob']);
    m.setSort('name');
    expect(names()).toEqual(['Alice', 'Bob', 'Carol', 'Hilltop Repeater', 'Town Square', 'Weather Station']);
    m.setFilter('repeater');
    expect(names()).toEqual(['Hilltop Repeater']);
    m.setFilter('chat');
    expect(names()).toEqual(['Alice', 'Bob', 'Carol']);
    m.setFilter('favourites');
    expect(names()).toEqual(['Alice']);
    m.setFilter('unread');
    expect(names()).toEqual(['Alice', 'Town Square']);
    m.setFilter('all');
    m.setSearch('car');
    expect(names()).toEqual(['Carol']);
    m.setSearch(toHex(scenarioKey('bob')).slice(0, 6));
    expect(names()).toEqual(['Bob']);
  });

  it('stars / unstars a contact on the radio (FAVOURITE flag) and lists favourites first', async () => {
    const { app, s, hex } = await connected();
    const m = app.contacts;
    await vi.waitFor(() => expect(m.views.value).toHaveLength(6));
    await m.settled();
    const names = () => m.visible.value.map((v) => v.name);
    m.setSort('name');
    expect(names()[0]).toBe('Alice');

    await m.setFavourite(hex.carol, true);
    expect(m.view(hex.carol)!.favourite).toBe(true);
    expect(s.emulator.getContact(s.keys.carol)!.flags & ContactFlag.FAVOURITE).toBe(ContactFlag.FAVOURITE);
    expect(names()).toEqual(['Alice', 'Carol', 'Bob', 'Hilltop Repeater', 'Town Square', 'Weather Station']);

    // Alice's favourite comes from the radio flag: unstarring clears it there too
    await m.setFavourite(hex.alice, false);
    expect(m.view(hex.alice)!.favourite).toBe(false);
    expect(s.emulator.getContact(s.keys.alice)!.flags & ContactFlag.FAVOURITE).toBe(0);
    expect(names()).toEqual(['Carol', 'Alice', 'Bob', 'Hilltop Repeater', 'Town Square', 'Weather Station']);
    m.setSort('recent');
    expect(names()[0]).toBe('Carol');
  });

  it('resets a path, shares, exports and re-imports, removes and adds by key', async () => {
    const { app, s, hex, store } = await connected();
    const m = app.contacts;
    await vi.waitFor(() => expect(m.views.value).toHaveLength(6));

    await m.resetPath(hex.alice);
    expect(m.view(hex.alice)!.path.label).toBe('flood');
    expect(s.emulator.getContact(s.keys.alice)!.outPathLen).toBe(0xff);

    await m.share(hex.alice);

    const exp = await m.export(hex.bob);
    expect(exp.url).toBe(`meshcore://${exp.hex}`);
    const self = await m.export();
    expect(self.hex.length).toBeGreaterThan(100);

    await m.remove(hex.bob);
    expect(m.find(hex.bob)).toBeUndefined();
    expect(s.emulator.getContact(s.keys.bob)).toBeUndefined();
    expect(await store.contacts.get(hex.bob)).toBeUndefined();

    const rec = await m.add(exp.url);
    expect(rec.name).toBe('Bob');
    expect(s.emulator.getContact(s.keys.bob)).toBeDefined();
    await vi.waitFor(() => expect(m.find(hex.bob)?.onDevice).toBe(true));

    const dave = scenarioKey('dave');
    const d = await m.add(toHex(dave), { name: 'Dave' });
    expect(d.name).toBe('Dave');
    expect(s.emulator.getContact(dave)?.name).toBe('Dave');
    await expect(m.add('nonsense')).rejects.toThrow(/hex/);

    await m.refresh();
    expect(m.views.value).toHaveLength(7);
  });

  it('removes the conversation history with the contact', async () => {
    const { app, hex, store } = await connected();
    await app.contacts.settled();
    expect((await store.messages.list(hex.alice)).items).toHaveLength(1);
    await app.contacts.remove(hex.alice);
    expect((await store.messages.list(hex.alice)).items).toHaveLength(0);
  });
});

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
    expect(done.roundTripMs).toBeGreaterThanOrEqual(0);
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
    const { app, hex, s } = await connected({ messaging: { retry: FAST_RETRY } });
    s.nodes.bob.config.ackPolicy = 'never';
    const chat = app.chat('contact', hex.bob);
    await chat.settled();
    const failed = await (await chat.send('anyone?')).done;
    expect(failed.status).toBe('failed');
    expect(failed.attempt).toBe(1);
    expect(s.nodes.bob.inbox.filter((x) => x.text === 'anyone?')).toHaveLength(2);
    await vi.waitFor(() => expect(chat.messages.value.find((m) => m.id === failed.id)?.status).toBe('failed'));

    s.nodes.bob.config.ackPolicy = 'auto';
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

describe('unread and read tracking', () => {
  it('counts incoming messages, clears on markRead / while active, and skips muted channels in totals', async () => {
    const { app, hex, s } = await connected();
    const unread = app.unread;
    await vi.waitFor(() => expect(unread.totals.value).toEqual({ contacts: 2, channels: 1, total: 3 }));
    s.emulator.injectContactMessage(s.keys.bob, 'hey');
    await vi.waitFor(() => expect(unread.totals.value.contacts).toBe(3));
    await vi.waitFor(() => expect(app.contacts.view(hex.bob)?.unread).toBe(1));

    const chat = app.chat('contact', hex.bob);
    await chat.settled();
    chat.setActive(true);
    await vi.waitFor(() => expect(chat.unread.value).toBe(0));
    s.emulator.injectContactMessage(s.keys.bob, 'still there?');
    await vi.waitFor(() => expect(chat.messages.value.at(-1)?.text).toBe('still there?'));
    await vi.waitFor(() => expect(chat.unread.value).toBe(0));
    await vi.waitFor(() => expect(unread.totals.value.contacts).toBe(2));
    chat.setActive(false);

    const pub = await channelKeyForPsk(publicChannelSecret());
    await app.channels.setMuted(pub, true);
    await vi.waitFor(() => expect(unread.totals.value.channels).toBe(0));
    expect(app.channels.views.value.find((c) => c.key === pub)!.unread).toBe(1);
  });
});

describe('ChannelsModel', () => {
  it('lists device slots with kinds, unread and last message', async () => {
    const { app } = await connected();
    const m = app.channels;
    await vi.waitFor(() => expect(m.views.value).toHaveLength(2));
    await m.settled();
    expect(m.views.value.map((c) => [c.name, c.kind, c.slot, c.unread])).toEqual([
      ['Public', 'public', 0, 1],
      ['#test', 'hashtag', 1, 0],
    ]);
    expect(m.views.value[0]!.lastMessage?.text).toBe('Good morning everyone');
    expect(m.freeSlot.value).toBe(2);
    expect(m.slotCount.value).toBeGreaterThanOrEqual(8);
  });

  it('adds hashtag / keyed channels, edits, deletes and mutes, keeping the device in sync', async () => {
    const { app, s, store } = await connected();
    const m = app.channels;
    await vi.waitFor(() => expect(m.views.value).toHaveLength(2));

    const tag = await m.add({ name: '#hello' });
    expect(tag.deviceIndex).toBe(2);
    expect(s.emulator.channels[2]!.name).toBe('#hello');
    expect(toHex(s.emulator.channels[2]!.secret)).toBe(toHex(hashtagChannelSecret('#hello')));
    expect(tag.key).toBe(await channelKeyForPsk(hashtagChannelSecret('#hello')));

    const psk = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const team = await m.add({ name: 'Team', psk: base64Encode(psk) });
    expect(team.deviceIndex).toBe(3);
    expect(toHex(s.emulator.channels[3]!.secret)).toBe(toHex(psk));
    expect(m.views.value.map((c) => c.name)).toEqual(['Public', '#test', '#hello', 'Team']);
    await expect(m.add({ name: '' })).rejects.toThrow(/required/);
    await expect(m.add({ name: 'Bad', psk: 'zz' })).rejects.toThrow(/16 bytes/);

    const renamed = await m.edit(team.key, { name: 'Crew' });
    expect(renamed.key).toBe(team.key);
    expect(s.emulator.channels[3]!.name).toBe('Crew');

    await m.setMuted(renamed.key, true);
    await vi.waitFor(() => expect(m.find(renamed.key)?.muted).toBe(true));

    await m.remove(tag.key);
    expect(s.emulator.channels[2]!.name).toBe('');
    expect(s.emulator.channels[2]!.secret.every((b) => b === 0)).toBe(true);
    expect(m.find(tag.key)).toBeUndefined();
    expect(await store.channels.get(tag.key)).toBeUndefined();
    expect(m.freeSlot.value).toBe(2);

    // the device changed behind our back: refresh re-reads every slot
    s.emulator.setChannelSlot(5, '#side', hashtagChannelSecret('#side'));
    await m.refresh();
    expect(m.views.value.map((c) => [c.name, c.slot])).toEqual([
      ['Public', 0],
      ['#test', 1],
      ['Crew', 3],
      ['#side', 5],
    ]);
  });

  it('renaming a #hashtag channel without a key joins the new hashtag', async () => {
    const { app, s } = await connected();
    const m = app.channels;
    await vi.waitFor(() => expect(m.views.value).toHaveLength(2));
    const tag = await m.add({ name: '#hiking' });
    const renamed = await m.edit(tag.key, { name: '#hike' });
    expect(s.emulator.channels[2]!.name).toBe('#hike');
    expect(toHex(s.emulator.channels[2]!.secret)).toBe(toHex(hashtagChannelSecret('#hike')));
    expect(renamed.key).toBe(await channelKeyForPsk(hashtagChannelSecret('#hike')));
    // same name, no key: unchanged
    const same = await m.edit(renamed.key, { name: '#hike' });
    expect(same.key).toBe(renamed.key);
  });
});

describe('ConversationsModel', () => {
  it('lists DMs and channels with messages by last message with unread counts', async () => {
    const { app, hex, s } = await connected();
    const c = app.conversations;
    await vi.waitFor(() => expect(c.items.value.length).toBe(3));
    await c.settled();
    // #test has no messages, so it is left out
    expect(c.items.value.map((x) => x.name).sort()).toEqual(['Alice', 'Public', 'Town Square']);
    s.emulator.injectContactMessage(s.keys.carol, 'news from the valley');
    await vi.waitFor(() => expect(c.items.value[0]).toMatchObject({ key: hex.carol, convType: 'contact', unread: 1, icon: 'chat' }));
    expect(c.items.value[0]!.lastMessage?.text).toBe('news from the valley');
  });
});

describe('messagePreview', () => {
  const base: MessageRecord = {
    id: 1,
    convKey: 'aa',
    convType: 'contact',
    direction: 'out',
    text: 'hi',
    timestamp: 0,
    receivedAt: 0,
    txtType: 0,
    status: 'sent',
    pathLen: 0,
  };
  it('prefixes the author and shows replies without the raw @[name] convention', () => {
    expect(messagePreview(undefined)).toBe('');
    expect(messagePreview(base)).toBe('You: hi');
    expect(messagePreview({ ...base, direction: 'in', senderName: 'Dave', text: 'yo' })).toBe('Dave: yo');
    expect(messagePreview({ ...base, text: '@[Alice] Yes, all day' })).toBe('You: ↪ Yes, all day');
  });
});

describe('SMAZ compression (MeshCore Open compatible)', () => {
  const LONG = 'the weather is fine here, meet at the station at ten';

  it('DM: decodes incoming "s:" envelopes whatever the setting, compresses outgoing when on', async () => {
    const { app, hex, s, store } = await connected();
    const chat = app.chat('contact', hex.alice);
    await chat.settled();
    await vi.waitFor(() => expect(chat.contact.value?.name).toBe('Alice'));
    expect(chat.compression.value).toBe(false);

    // a virtual contact running MeshCore Open sends a compressed message over the mesh
    const env = smazEncodeIfSmaller(LONG);
    expect(env.startsWith('s:')).toBe(true);
    s.nodes.alice.sendText(s.keys.self, env);
    await vi.waitFor(() => expect(chat.messages.value.at(-1)).toMatchObject({ direction: 'in', text: LONG, compressed: true }), { timeout: 5000 });

    // plain "s:" text that is not a valid envelope stays as it is
    s.nodes.alice.sendText(s.keys.self, 's:test');
    await vi.waitFor(() => expect(chat.messages.value.at(-1)?.text).toBe('s:test'), { timeout: 5000 });
    expect(chat.messages.value.at(-1)?.compressed).toBeUndefined();

    // budget: plain size while off, on-air size while on
    expect(chat.budget(LONG)).toMatchObject({ used: LONG.length, limit: 160, compressed: false });
    await chat.setCompression(true);
    await vi.waitFor(() => expect(chat.compression.value).toBe(true));
    expect((await store.contacts.get(hex.alice))?.smaz).toBe(true);
    expect(chat.budget(LONG)).toMatchObject({ used: env.length, limit: 160, compressed: true });
    expect(chat.budget('ok')).toMatchObject({ used: 2, compressed: false });

    const h = await chat.send(LONG);
    expect(h.record).toMatchObject({ text: LONG, compressed: true });
    expect((await h.done).status).toBe('delivered'); // the ACK is computed over the envelope
    expect(s.nodes.alice.inbox.at(-1)?.text).toBe(env);

    // short texts are sent plain even with compression on
    const short = await chat.send('ok');
    expect(short.record.compressed).toBeUndefined();
    await short.done;
    expect(s.nodes.alice.inbox.at(-1)?.text).toBe('ok');

    // the setting survives a device contact sync
    await app.contacts.refresh();
    expect((await store.contacts.get(hex.alice))?.smaz).toBe(true);
  });

  it('DM reply: the "@[name] " prefix is compressed with the text and not subtracted from the limit', async () => {
    const { app, hex, s } = await connected();
    const chat = app.chat('contact', hex.alice);
    await chat.settled();
    await vi.waitFor(() => expect(chat.contact.value).not.toBeNull());
    await chat.setCompression(true);
    await vi.waitFor(() => expect(chat.compression.value).toBe(true));
    chat.setReplyTo(chat.messages.value[0]!);
    expect(chat.byteLimit.value).toBe(160);
    const env = smazEncodeIfSmaller(`@[Alice] ${LONG}`);
    expect(env.startsWith('s:')).toBe(true);
    expect(chat.budget(LONG).used).toBe(env.length);
    const h = await chat.send(LONG);
    expect(h.record.text).toBe(`@[Alice] ${LONG}`);
    await h.done;
    expect(s.nodes.alice.inbox.at(-1)?.text).toBe(env);
  });

  it('channel: "sender: s:…" decodes; outgoing is compressed and the device adds "name: "', async () => {
    const { app, s, store } = await connected();
    const pubKey = await channelKeyForPsk(publicChannelSecret());
    const chat = app.chat('channel', pubKey);
    await chat.settled();
    await vi.waitFor(() => expect(chat.channel.value?.name).toBe('Public'));

    const env = smazEncodeIfSmaller(LONG);
    s.nodes.bob.sendChannelMessage('Public', env);
    await vi.waitFor(() => expect(chat.messages.value.at(-1)).toMatchObject({ senderName: 'Bob', text: LONG, compressed: true }), { timeout: 5000 });

    await app.channels.setSmaz(pubKey, true);
    await vi.waitFor(() => expect(chat.compression.value).toBe(true));
    await vi.waitFor(() => expect(app.channels.views.value.find((c) => c.key === pubKey)?.smaz).toBe(true));
    expect(chat.byteLimit.value).toBe(160 - 'Emulator: '.length);
    expect(chat.budget(LONG)).toMatchObject({ used: env.length, compressed: true });

    const h = await chat.send(LONG);
    expect((await h.done).status).toBe('sent');
    await vi.waitFor(() => expect(s.nodes.alice.channelMessages.at(-1)?.text).toBe(`Emulator: ${env}`));

    // structured payloads (GIF "g:", location "m:") are never compressed
    const g = await chat.send('g:the the the the the the the the the the');
    expect(g.record.compressed).toBeUndefined();
    await g.done;

    // a channel refresh from the device keeps the local setting; editing can turn it off
    await app.channels.refresh();
    expect((await store.channels.get(pubKey))?.smaz).toBe(true);
    await app.channels.edit(pubKey, { smaz: false });
    expect((await store.channels.get(pubKey))?.smaz).toBe(false);
  });
});

describe('emoji reactions (MeshCore Open compatible)', () => {
  it('DM: a virtual contact reacts to our message; we react to theirs with the exact "r:" text', async () => {
    const { app, hex, s, store } = await connected();
    const chat = app.chat('contact', hex.alice);
    await chat.settled();
    await vi.waitFor(() => expect(chat.contact.value?.name).toBe('Alice'));

    const mine = await (await chat.send('Lunch at noon?')).done;
    expect(mine.status).toBe('delivered');
    // Alice (MeshCore Open) reacts 👍: hash over "<ts>" + first 5 chars, no sender name in DMs
    const hash = computeReactionHash(mine.timestamp, null, 'Lunch at noon?');
    s.nodes.alice.sendText(s.keys.self, `r:${hash}:00`);
    await vi.waitFor(() => expect(chat.messages.value.find((m) => m.id === mine.id)?.reactions).toEqual([{ emoji: '👍', sender: 'Alice', at: expect.any(Number) }]), {
      timeout: 5000,
    });
    // a reaction to nothing we know is dropped, never shown as a bubble
    s.nodes.alice.sendText(s.keys.self, 'r:0000:01');
    s.nodes.alice.sendText(s.keys.self, 'after');
    await vi.waitFor(() => expect(chat.messages.value.at(-1)?.text).toBe('after'), { timeout: 5000 });
    expect(chat.messages.value.some((m) => m.text.startsWith('r:'))).toBe(false);
    expect(chat.reactions(chat.messages.value.find((m) => m.id === mine.id)!)).toEqual([{ emoji: '👍', count: 1, senders: ['Alice'], own: false }]);

    // we react ❤️ to Alice's incoming message
    const theirs = chat.messages.value.find((m) => m.direction === 'in' && m.text === 'after')!;
    expect(chat.canReact(theirs)).toBe(true);
    expect(chat.canReact(mine)).toBe(false);
    const h = await chat.react(theirs.id, '❤️');
    const expected = `r:${computeReactionHash(theirs.timestamp, null, 'after')}:01`;
    expect(h.text).toBe(expected);
    expect(chat.reactions(h.record)).toEqual([{ emoji: '❤️', count: 1, senders: ['Emulator'], own: true, state: 'pending' }]);
    expect(await h.done).toBe('delivered');
    expect(s.nodes.alice.inbox.at(-1)?.text).toBe(expected);
    expect((await store.messages.get(theirs.id))?.reactions).toEqual([{ emoji: '❤️', sender: 'Emulator', own: true, status: 'delivered', at: expect.any(Number) }]);
    await expect(chat.react(theirs.id, '🦄')).rejects.toThrow(/Unsupported/);
    expect(chat.messages.value.some((m) => m.text.startsWith('r:'))).toBe(false);
  });

  it('DM: an unacknowledged reaction fails and can be retried', async () => {
    const { app, hex, s, store } = await connected({ messaging: { retry: FAST_RETRY } });
    const chat = app.chat('contact', hex.alice);
    await chat.settled();
    await vi.waitFor(() => expect(chat.messages.value.length).toBeGreaterThan(0));
    const theirs = chat.messages.value.find((m) => m.direction === 'in')!;
    s.nodes.alice.config.ackPolicy = 'never';
    expect(await (await chat.react(theirs.id, '😂')).done).toBe('failed');
    await vi.waitFor(() => expect(chat.reactions(chat.messages.value.find((m) => m.id === theirs.id)!)[0]?.state).toBe('failed'));
    s.nodes.alice.config.ackPolicy = 'auto';
    expect(await (await chat.retryReaction(theirs.id, '😂')).done).toBe('delivered');
    expect((await store.messages.get(theirs.id))?.reactions).toHaveLength(1);
    await expect(chat.retryReaction(theirs.id, '😂')).rejects.toThrow(/failed/);
  });

  it('channel: "sender: r:…" attaches with the sender name; ours goes out uncompressed as "name: r:…"', async () => {
    const { app, s } = await connected();
    const pubKey = await channelKeyForPsk(publicChannelSecret());
    const chat = app.chat('channel', pubKey);
    await chat.settled();
    await vi.waitFor(() => expect(chat.messages.value.map((m) => m.text)).toEqual(['Good morning everyone']));
    const dave = chat.messages.value[0]!;
    const hash = computeReactionHash(dave.timestamp, 'Dave', 'Good morning everyone');
    expect(reactionMessageHash(dave)).toBe(hash);

    s.nodes.bob.sendChannelMessage('Public', `r:${hash}:03`);
    s.nodes.carol.sendChannelMessage('Public', `r:${hash}:03`);
    await vi.waitFor(() => expect(chat.reactions(chat.messages.value[0]!)).toEqual([{ emoji: '🎉', count: 2, senders: ['Bob', 'Carol'], own: false }]), { timeout: 5000 });

    // with compression on, a reaction is still sent as is
    await app.channels.setSmaz(pubKey, true);
    await vi.waitFor(() => expect(chat.compression.value).toBe(true));
    const h = await chat.react(dave.id, '🎉');
    expect(h.text).toBe(`r:${hash}:03`);
    expect(await h.done).toBe('sent');
    await vi.waitFor(() => expect(s.nodes.alice.channelMessages.at(-1)?.text).toBe(`Emulator: r:${hash}:03`));
    await vi.waitFor(() =>
      expect(chat.reactions(chat.messages.value[0]!)).toEqual([{ emoji: '🎉', count: 3, senders: ['Bob', 'Carol', 'Emulator'], own: true }]),
    );
    expect(chat.messages.value).toHaveLength(1);

    // a reaction to our own channel message (sender = our name)
    const mine = await (await chat.send('see you all')).done;
    s.nodes.bob.sendChannelMessage('Public', `r:${computeReactionHash(mine.timestamp, 'Emulator', 'see you')}:05`);
    await vi.waitFor(() => expect(chat.reactions(chat.messages.value.find((m) => m.id === mine.id)!)).toEqual([{ emoji: '🔥', count: 1, senders: ['Bob'], own: false }]), {
      timeout: 5000,
    });
    expect(chat.messages.value).toHaveLength(2);
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
    await new Promise((r) => setTimeout(r, 300));
    await app.connection.capture!.idle();
    expect((await store.contacts.get(hex.sensor))?.directSnr).toBeUndefined();
    // a contact sync keeps the local direct-signal fields
    await app.contacts.refresh();
    expect((await store.contacts.get(hex.bob))?.directSnr).toBe(8);
  });
});
