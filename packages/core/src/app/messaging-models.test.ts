import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { toHex } from '../util/bytes.js';
import { channelKeyForPsk } from '../store/channels.js';
import type { MessageStatus } from '../store/schema.js';
import { hashtagChannelSecret, publicChannelSecret, scenarioKey } from '../emulator/scenarios.js';
import { AppModel, createEmulatorTransportFactory, type AppModelOptions } from './app-model.js';
import { memoryPreferences } from './connection.js';
import { base64Encode } from './messaging.js';

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
});

describe('ConversationsModel', () => {
  it('lists DMs and channels by last message with unread counts', async () => {
    const { app, hex, s } = await connected();
    const c = app.conversations;
    await vi.waitFor(() => expect(c.items.value.length).toBe(4));
    await c.settled();
    expect(c.items.value.map((x) => x.name).sort()).toEqual(['#test', 'Alice', 'Public', 'Town Square']);
    expect(c.items.value.at(-1)!.name).toBe('#test'); // no messages
    s.emulator.injectContactMessage(s.keys.carol, 'news from the valley');
    await vi.waitFor(() => expect(c.items.value[0]).toMatchObject({ key: hex.carol, convType: 'contact', unread: 1, icon: 'chat' }));
    expect(c.items.value[0]!.lastMessage?.text).toBe('news from the valley');
  });
});
