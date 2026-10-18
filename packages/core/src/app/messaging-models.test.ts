import { describe, expect, it, vi } from 'vitest';
import { ContactFlag } from '../protocol/constants.js';
import { toHex } from '../util/bytes.js';
import { channelKeyForPsk } from '../store/channels.js';
import type { MessageRecord } from '../store/schema.js';
import { hashtagChannelSecret, publicChannelSecret, scenarioKey } from '../emulator/scenarios.js';
import type { AppModelOptions } from './app-model.js';
import { connectedApp } from './testing.js';
import { firstUnreadId } from './chat-model.js';
import { base64Encode } from './messaging.js';
import { messagePreview } from './contacts-model.js';

async function connected(over: AppModelOptions = {}) {
  const { app, scenario, keys, store } = await connectedApp({ app: over });
  return { app, s: scenario, hex: keys, store };
}

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

describe('"New messages" divider (ChatModel.firstUnreadId)', () => {
  const msg = (id: number, direction: 'in' | 'out', txtType = 0) => ({ id, direction, txtType }) as MessageRecord;

  it('firstUnreadId: the unread-th newest incoming non-CLI message, else the oldest loaded', () => {
    const ms = [msg(1, 'in'), msg(2, 'in'), msg(3, 'out'), msg(4, 'in', 1 /* CLI_DATA */), msg(5, 'in')];
    expect(firstUnreadId(ms, 0)).toBeNull();
    expect(firstUnreadId([], 3)).toBeNull();
    expect(firstUnreadId(ms, 1)).toBe(5);
    expect(firstUnreadId(ms, 2)).toBe(2); // skips the CLI reply and our own message
    expect(firstUnreadId(ms, 3)).toBe(1);
    expect(firstUnreadId(ms, 9)).toBe(1); // more unread than loaded
  });

  it('is captured on open before marking read, stays put while open, and clears on send / close', async () => {
    const { app, hex, s } = await connected();
    s.emulator.injectContactMessage(s.keys.bob, 'one');
    s.emulator.injectContactMessage(s.keys.bob, 'two');
    await vi.waitFor(() => expect(app.contacts.view(hex.bob)?.unread).toBe(2));
    const chat = app.chat('contact', hex.bob);
    await chat.settled();
    await vi.waitFor(() => expect(chat.messages.value).toHaveLength(2));
    expect(chat.firstUnreadId.value).toBeNull(); // not open yet

    chat.setActive(true);
    const one = chat.messages.value.find((m) => m.text === 'one')!;
    expect(chat.firstUnreadId.value).toBe(one.id);
    await vi.waitFor(() => expect(chat.unread.value).toBe(0));
    expect(chat.firstUnreadId.value).toBe(one.id);

    // arriving while open: read at once, the divider does not move
    s.emulator.injectContactMessage(s.keys.bob, 'three');
    await vi.waitFor(() => expect(chat.messages.value.at(-1)?.text).toBe('three'));
    await vi.waitFor(() => expect(chat.unread.value).toBe(0));
    expect(chat.firstUnreadId.value).toBe(one.id);
    chat.setActive(true); // re-activating while open does not move it either
    expect(chat.firstUnreadId.value).toBe(one.id);

    // replying clears it
    const h = await chat.send('hi');
    expect(chat.firstUnreadId.value).toBeNull();
    await h.done;

    // closing clears it; reopening with nothing unread shows none
    chat.setActive(false);
    chat.setActive(true);
    expect(chat.firstUnreadId.value).toBeNull();
    chat.setActive(false);

    // a message while closed: the next open places it there
    s.emulator.injectContactMessage(s.keys.bob, 'four');
    await vi.waitFor(() => expect(chat.unread.value).toBe(1));
    await vi.waitFor(() => expect(chat.messages.value.at(-1)?.text).toBe('four'));
    chat.setActive(true);
    expect(chat.firstUnreadId.value).toBe(chat.messages.value.at(-1)!.id);
    chat.setActive(false);
    expect(chat.firstUnreadId.value).toBeNull();
  });

  it('is placed once loading finishes when opened before the first load (DM and channel)', async () => {
    const { app, hex } = await connected();
    await vi.waitFor(() => expect(app.unread.totals.value).toEqual({ contacts: 2, channels: 1, total: 3 }));
    const dm = app.chat('contact', hex.alice);
    dm.setActive(true);
    await dm.settled();
    expect(dm.firstUnreadId.value).toBe(dm.messages.value.find((m) => m.text === 'Hi! Are you on the mesh today?')!.id);
    await vi.waitFor(() => expect(dm.unread.value).toBe(0));

    const pub = await channelKeyForPsk(publicChannelSecret());
    const ch = app.chat('channel', pub);
    ch.setActive(true);
    await ch.settled();
    expect(ch.firstUnreadId.value).toBe(ch.messages.value.find((m) => m.text === 'Good morning everyone')!.id);
    await vi.waitFor(() => expect(ch.unread.value).toBe(0));
    expect(ch.firstUnreadId.value).not.toBeNull();
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
