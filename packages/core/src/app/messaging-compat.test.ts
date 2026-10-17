import { describe, expect, it, vi } from 'vitest';
import { smazEncodeIfSmaller } from '../util/smaz.js';
import { channelKeyForPsk } from '../store/channels.js';
import { publicChannelSecret } from '../emulator/scenarios.js';
import type { AppModelOptions } from './app-model.js';
import { FAST_RETRY, connectedApp } from './testing.js';
import { computeReactionHash, reactionMessageHash } from './reactions.js';

async function connected(over: AppModelOptions = {}) {
  const t = await connectedApp({ app: over });
  return { t, app: t.app, s: t.scenario, hex: t.keys, store: t.store };
}

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
    const { t, app, hex, s, store } = await connected({ messaging: { retry: FAST_RETRY } });
    const chat = app.chat('contact', hex.alice);
    await chat.settled();
    await vi.waitFor(() => expect(chat.messages.value.length).toBeGreaterThan(0));
    const theirs = chat.messages.value.find((m) => m.direction === 'in')!;
    s.nodes.alice.config.ackPolicy = 'never';
    const h = await chat.react(theirs.id, '😂');
    await t.missAck(); // attempt 0
    await t.missAck(); // attempt 1 (the last)
    expect(await h.done).toBe('failed');
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
