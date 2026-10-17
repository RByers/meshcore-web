import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { ContactType, TxtType } from '../protocol/constants.js';
import type { ChannelMsgFrame, ContactMsgFrame } from '../protocol/types.js';
import type { MessageInput } from './messages.js';
import { decodeReceivedText, messageInputFromChannelFrame, messageInputFromContactFrame } from './messages.js';
import { hexKey, key32, makeContact, openStore } from './test-helpers.js';

const PSK = Uint8Array.from({ length: 16 }, (_, i) => i);

function dm(convKey: string, i: number, over: Partial<MessageInput> = {}): MessageInput {
  return { convKey, convType: 'contact', direction: 'in', text: `m${i}`, timestamp: 1000 + i, receivedAt: 5000 + i, ...over };
}

describe('MessagesRepo', () => {
  it('appends with defaults and pages a conversation newest-first', async () => {
    const s = await openStore();
    const A = hexKey(2);
    for (let i = 0; i < 7; i++) await s.messages.append(dm(A, i));
    await s.messages.append(dm(hexKey(3), 99));
    const first = await s.messages.get(1);
    expect(first).toMatchObject({ id: 1, status: 'delivered', txtType: 0, pathLen: 0xff, convType: 'contact' });
    const p1 = await s.messages.list(A, { limit: 3 });
    expect(p1.items.map((m) => m.text)).toEqual(['m6', 'm5', 'm4']);
    expect(p1.hasMore).toBe(true);
    const p2 = await s.messages.list(A, { limit: 3, before: p1.items[2]! });
    expect(p2.items.map((m) => m.text)).toEqual(['m3', 'm2', 'm1']);
    const p3 = await s.messages.list(A, { limit: 3, before: p2.items[2]! });
    expect(p3.items.map((m) => m.text)).toEqual(['m0']);
    expect(p3.hasMore).toBe(false);
    expect(await s.messages.countConversation(A)).toBe(7);
    s.close();
  });

  it('pages correctly across equal receivedAt and supports sender-clock order', async () => {
    const s = await openStore();
    const A = hexKey(2);
    // Arrival order differs from sender clock; three share one receivedAt.
    await s.messages.append(dm(A, 0, { receivedAt: 10, timestamp: 300 }));
    await s.messages.append(dm(A, 1, { receivedAt: 20, timestamp: 100 }));
    await s.messages.append(dm(A, 2, { receivedAt: 20, timestamp: 200 }));
    await s.messages.append(dm(A, 3, { receivedAt: 20, timestamp: 50 }));
    const p1 = await s.messages.list(A, { limit: 2 });
    expect(p1.items.map((m) => m.text)).toEqual(['m3', 'm2']);
    const p2 = await s.messages.list(A, { limit: 2, before: p1.items[1]! });
    expect(p2.items.map((m) => m.text)).toEqual(['m1', 'm0']);
    const bySender = await s.messages.list(A, { order: 'sender' });
    expect(bySender.items.map((m) => m.text)).toEqual(['m0', 'm2', 'm1', 'm3']);
    s.close();
  });

  it('outgoing DM lifecycle: pending → sent → delivered by ack code', async () => {
    const s = await openStore();
    const A = hexKey(2);
    const m = await s.messages.append(dm(A, 0, { direction: 'out' }));
    expect(m.status).toBe('pending');
    const other = await s.messages.append(dm(A, 1, { direction: 'out' }));
    await s.messages.markSent(m.id, { ackCode: 0xdeadbeef, attempt: 0 });
    await s.messages.markSent(other.id, { ackCode: 0x01020304 });
    expect((await s.messages.listByStatus('sent')).map((x) => x.id)).toEqual([m.id, other.id]);
    expect((await s.messages.byAckCode(0xdeadbeef)).map((x) => x.id)).toEqual([m.id]);
    // Retry with a new attempt / ack code.
    await s.messages.updateStatus(m.id, 'sent', { ackCode: 0xcafebabe, attempt: 1 });
    expect(await s.messages.markDeliveredByAck(0xdeadbeef)).toEqual([]);
    const updated = await s.messages.markDeliveredByAck(0xcafebabe, { roundTripMs: 1234, now: 99 });
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ id: m.id, status: 'delivered', attempt: 1, roundTripMs: 1234, deliveredAt: 99 });
    expect((await s.messages.get(m.id))!.status).toBe('delivered');
    expect((await s.messages.get(other.id))!.status).toBe('sent');
    // Duplicate ACK is a no-op.
    expect(await s.messages.markDeliveredByAck(0xcafebabe)).toEqual([]);
    s.close();
  });

  it('a late ACK rescues a failed message; channel messages are never delivered', async () => {
    const s = await openStore();
    const m = await s.messages.append(dm(hexKey(2), 0, { direction: 'out', ackCode: 7 }));
    await s.messages.markFailed(m.id);
    expect((await s.messages.markDeliveredByAck(7)).map((x) => x.status)).toEqual(['delivered']);
    const ch = await s.messages.append({ convKey: 'aa', convType: 'channel', direction: 'out', text: 'hi', timestamp: 1, ackCode: 8 });
    expect(await s.messages.markDeliveredByAck(8)).toEqual([]);
    expect((await s.messages.get(ch.id))!.status).toBe('pending');
    expect(await s.messages.updateStatus(999, 'sent')).toBeUndefined();
    s.close();
  });

  it('unread counts: increment on incoming, skip outgoing / CLI / repeaters / opted-out, reset, mark-unread-from', async () => {
    const s = await openStore();
    const A = hexKey(2);
    const R = hexKey(5);
    await s.contacts.upsertFromDevice(makeContact(2));
    await s.contacts.upsertFromDevice(makeContact(5, { type: ContactType.REPEATER }));
    const ch = (await s.channels.put({ name: 'Public', psk: PSK }))!;
    const events: string[] = [];
    s.events.on('unread', (e) => events.push(`${e.convType}:${e.count}`));

    const m0 = await s.messages.append(dm(A, 0));
    await s.messages.append(dm(A, 1));
    await s.messages.append(dm(A, 2, { direction: 'out' }));
    await s.messages.append(dm(A, 3, { txtType: TxtType.CLI_DATA }));
    await s.messages.append(dm(A, 4), { countUnread: false });
    await s.messages.append(dm(R, 5));
    await s.messages.append({ convKey: ch.key, convType: 'channel', direction: 'in', text: 'x', timestamp: 1, senderName: 'bob' });
    await s.messages.append(dm(hexKey(9), 6)); // unknown contact: nothing to count on

    expect(await s.messages.unreadCount('contact', A)).toBe(2);
    expect((await s.contacts.get(A))!.unreadCount).toBe(2);
    expect(await s.messages.unreadCount('contact', R)).toBe(0);
    expect(await s.messages.unreadCount('channel', ch.key)).toBe(1);
    expect(await s.messages.totalUnread()).toEqual({ contacts: 2, channels: 1, total: 3 });
    expect(events).toEqual(['contact:1', 'contact:2', 'channel:1']);

    expect(await s.messages.markRead('contact', A)).toBe(0);
    expect(await s.messages.unreadCount('contact', A)).toBe(0);
    // m0, m1, m4 are incoming non-CLI from m0 on.
    expect(await s.messages.markUnreadFrom(m0.id)).toBe(3);
    expect((await s.contacts.get(key32(2)))!.unreadCount).toBe(3);
    expect(await s.messages.setUnread('channel', ch.key, 0)).toBe(0);
    expect(await s.messages.totalUnread()).toEqual({ contacts: 3, channels: 0, total: 3 });
    s.close();
  });

  it('last message per conversation, delete and delete conversation', async () => {
    const s = await openStore();
    const A = hexKey(2);
    const B = hexKey(3);
    await s.messages.append(dm(A, 0));
    const a1 = await s.messages.append(dm(A, 1));
    const b0 = await s.messages.append(dm(B, 0, { receivedAt: 1 }));
    expect((await s.messages.lastMessage(A))!.id).toBe(a1.id);
    const map = await s.messages.lastMessages([A, B, hexKey(4)]);
    expect([...map.keys()]).toEqual([A, B]);
    expect(map.get(B)!.id).toBe(b0.id);
    const ev: string[] = [];
    s.events.on('message', (e) => ev.push(e.type));
    await s.messages.delete(a1.id);
    expect((await s.messages.lastMessage(A))!.text).toBe('m0');
    expect(await s.messages.deleteConversation(A)).toBe(1);
    expect(await s.messages.lastMessage(A)).toBeUndefined();
    expect(await s.messages.countConversation(B)).toBe(1);
    expect(ev).toEqual(['delete', 'delete']);
    s.close();
  });

  it('builds inputs from contact and channel message frames', () => {
    const route = { pathLen: 2, receivedVia: 'flood' as const, hops: 2, hashSize: 1 };
    const cf: ContactMsgFrame = {
      kind: 'contactMsg',
      code: 0x10,
      version: 3,
      snr: 4.5,
      senderPrefix: key32(2).subarray(0, 6),
      route,
      txtType: 0,
      senderTimestamp: 1234,
      text: 'hello',
    };
    expect(messageInputFromContactFrame(cf, hexKey(2).toUpperCase(), { rawFrameId: 5, receivedAt: 9 })).toEqual({
      convKey: hexKey(2),
      convType: 'contact',
      direction: 'in',
      text: 'hello',
      timestamp: 1234,
      txtType: 0,
      pathLen: 2,
      senderPrefix: '020202020202',
      snr: 4.5,
      rawFrameId: 5,
      receivedAt: 9,
    });
    const chf: ChannelMsgFrame = {
      kind: 'channelMsg',
      code: 0x08,
      version: 1,
      channelIdx: 0,
      route,
      txtType: 0,
      senderTimestamp: 1,
      text: 'bob: hi',
      senderName: 'bob',
      message: 'hi',
    };
    expect(messageInputFromChannelFrame(chf, 'AB')).toMatchObject({ convKey: 'ab', convType: 'channel', text: 'hi', senderName: 'bob' });
  });

  it('emits add and update events', async () => {
    const s = await openStore();
    const ev: string[] = [];
    s.events.on('message', (e) => ev.push(e.type === 'delete' ? 'delete' : `${e.type}:${e.record.status}`));
    const m = await s.messages.append(dm(hexKey(2), 0, { direction: 'out', ackCode: 1 }));
    await s.messages.markSent(m.id);
    await s.messages.markDeliveredByAck(1);
    expect(ev).toEqual(['add:pending', 'update:sent', 'update:delivered']);
    s.close();
  });
});

describe('decodeReceivedText (MeshCore Open SMAZ envelope)', () => {
  it('decodes "s:" envelopes on chat text types, never on CLI', () => {
    const env = 's:/lRMOKw+rZg+w0Y='; // "This is a small string"
    expect(decodeReceivedText(env, TxtType.PLAIN)).toEqual({ text: 'This is a small string', compressed: true });
    expect(decodeReceivedText(env, TxtType.SIGNED_PLAIN)).toEqual({ text: 'This is a small string', compressed: true });
    expect(decodeReceivedText(env, TxtType.CLI_DATA)).toEqual({ text: env });
    expect(decodeReceivedText('s:test', TxtType.PLAIN)).toEqual({ text: 's:test' });
    expect(decodeReceivedText('hello', TxtType.PLAIN)).toEqual({ text: 'hello' });
  });
});
