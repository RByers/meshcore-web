/**
 * Direct and channel messages, with delivery status (feature-inventory.md §3.2) and unread
 * counts kept on the conversation's contact / channel record (§3.7).
 */

import type { ChannelMsgFrame, ContactMsgFrame } from '../protocol/types.js';
import { TxtType } from '../protocol/constants.js';
import { toHex } from '../util/bytes.js';
import { smazTryDecode } from '../util/smaz.js';
import type { TypedEmitter } from '../util/events.js';
import type { IdbDatabase, TxScope } from './idb.js';
import {
  INDEX,
  STORE,
  type ChannelRecord,
  type ContactRecord,
  type ConversationType,
  type MessageDirection,
  type MessageReaction,
  type MessageRecord,
  type MessageStatus,
} from './schema.js';
import { safeEmit, type RadioStoreEvents } from './events.js';
import { countsUnread } from './contacts.js';

export interface MessageInput {
  convKey: string;
  convType: ConversationType;
  direction: MessageDirection;
  text: string;
  /** Sender clock, epoch secs. */
  timestamp: number;
  /** Default: the store's clock. */
  receivedAt?: number;
  /** Default TxtType.PLAIN. */
  txtType?: number;
  /** Default 'delivered' for incoming, 'pending' for outgoing. */
  status?: MessageStatus;
  ackCode?: number;
  attempt?: number;
  /** Default 0xff (unknown / flood). */
  pathLen?: number;
  snr?: number;
  senderName?: string;
  senderPrefix?: string;
  rawFrameId?: number;
  /** The text went over the air SMAZ-compressed ("s:" envelope); `text` is the plain text. */
  compressed?: boolean;
  /** Flood path bytes, when the capture pipeline matched the message to its LOG_RX_DATA packet. */
  path?: Uint8Array;
  /** Channel messages: the region (flood scope name, no '#') it was sent / received in. */
  region?: string;
}

export interface AppendOptions {
  /**
   * Whether an incoming message bumps the conversation's unread count. Default true, except
   * CLI messages and repeater contacts (feature-inventory.md §3.7). Pass false while the
   * conversation is open.
   */
  countUnread?: boolean;
}

export type MessageOrder = 'received' | 'sender';

export interface MessageListOptions {
  /** Page size; default 50. */
  limit?: number;
  /** Return messages strictly older than this one (pass the oldest message of the last page). */
  before?: Pick<MessageRecord, 'id' | 'receivedAt' | 'timestamp'>;
  /** 'received' (arrival order, default) or 'sender' (sender clock). */
  order?: MessageOrder;
}

export interface MessagePage {
  /** Newest first. */
  items: MessageRecord[];
  hasMore: boolean;
}

/** Statuses from which an ACK moves a message to 'delivered' (late ACKs rescue 'failed'). */
const ACKABLE: readonly MessageStatus[] = ['pending', 'sent', 'failed'];

function isCli(txtType: number): boolean {
  return txtType === TxtType.CLI_DATA || txtType === TxtType.CLI_COMMAND;
}

/**
 * Undoes MeshCore Open's SMAZ envelope ("s:" + base64, feature-inventory.md §2.4a) on received
 * text. Like MeshCore Open, it is tried on every non-CLI message whatever the conversation's
 * compression setting; CLI replies are left as they are.
 */
export function decodeReceivedText(text: string, txtType: number): { text: string; compressed?: true } {
  if (isCli(txtType)) return { text };
  const decoded = smazTryDecode(text);
  return decoded === null ? { text } : { text: decoded, compressed: true };
}

/** Message input for a CONTACT_MSG_RECV(_V3) frame; `convKey` is the resolved contact key. */
export function messageInputFromContactFrame(
  f: ContactMsgFrame,
  convKey: string,
  meta: { receivedAt?: number; rawFrameId?: number } = {},
): MessageInput {
  const m: MessageInput = {
    convKey: convKey.toLowerCase(),
    convType: 'contact',
    direction: 'in',
    ...decodeReceivedText(f.text, f.txtType),
    timestamp: f.senderTimestamp,
    txtType: f.txtType,
    pathLen: f.route.pathLen,
    senderPrefix: toHex(f.senderPrefix),
    ...meta,
  };
  if (f.snr !== undefined) m.snr = f.snr;
  return m;
}

/** Message input for a CHANNEL_MSG_RECV(_V3) frame; `convKey` is the channel key. */
export function messageInputFromChannelFrame(
  f: ChannelMsgFrame,
  convKey: string,
  meta: { receivedAt?: number; rawFrameId?: number } = {},
): MessageInput {
  const m: MessageInput = {
    convKey: convKey.toLowerCase(),
    convType: 'channel',
    direction: 'in',
    ...decodeReceivedText(f.message, f.txtType),
    timestamp: f.senderTimestamp,
    txtType: f.txtType,
    pathLen: f.route.pathLen,
    ...meta,
  };
  if (f.senderName !== undefined) m.senderName = f.senderName;
  if (f.snr !== undefined) m.snr = f.snr;
  return m;
}

export class MessagesRepo {
  constructor(
    private readonly db: IdbDatabase,
    private readonly emitter: TypedEmitter<RadioStoreEvents>,
    /** Host time (epoch ms) for default timestamps. */
    private readonly now: () => number,
  ) {}

  get(id: number): Promise<MessageRecord | undefined> {
    return this.db.get<MessageRecord>(STORE.messages, id);
  }

  /** Appends a message; for incoming ones also bumps the conversation's unread count. */
  async append(input: MessageInput, opts: AppendOptions = {}): Promise<MessageRecord> {
    const base: Omit<MessageRecord, 'id'> = {
      convKey: input.convKey.toLowerCase(),
      convType: input.convType,
      direction: input.direction,
      text: input.text,
      timestamp: input.timestamp,
      receivedAt: input.receivedAt ?? this.now(),
      txtType: input.txtType ?? TxtType.PLAIN,
      status: input.status ?? (input.direction === 'in' ? 'delivered' : 'pending'),
      pathLen: input.pathLen ?? 0xff,
    };
    for (const k of ['ackCode', 'attempt', 'snr', 'senderName', 'senderPrefix', 'rawFrameId', 'compressed', 'path', 'region'] as const) {
      if (input[k] !== undefined) (base as Record<string, unknown>)[k] = input[k];
    }
    const wantUnread = base.direction === 'in' && opts.countUnread !== false && !isCli(base.txtType);
    const { record, unread } = await this.db.transaction(
      [STORE.messages, STORE.contacts, STORE.channels],
      'readwrite',
      async (t) => {
        const id = (await t.store<Omit<MessageRecord, 'id'>>(STORE.messages).add(base)) as number;
        const record: MessageRecord = { ...base, id };
        const unread = wantUnread ? await adjustUnread(t, record.convType, record.convKey, (n) => n + 1) : null;
        return { record, unread };
      },
    );
    safeEmit(this.emitter, 'message', { type: 'add', record });
    if (unread !== null) safeEmit(this.emitter, 'unread', { convType: record.convType, convKey: record.convKey, count: unread });
    return record;
  }

  /** A page of one conversation, newest first. */
  async list(convKey: string, opts: MessageListOptions = {}): Promise<MessagePage> {
    const key = convKey.toLowerCase();
    const limit = opts.limit ?? 50;
    const order = opts.order ?? 'received';
    const index = order === 'received' ? INDEX.messages.convReceived : INDEX.messages.convTs;
    const col = (m: Pick<MessageRecord, 'receivedAt' | 'timestamp'>): number => (order === 'received' ? m.receivedAt : m.timestamp);
    const before = opts.before;
    const upper = before ? col(before) : Infinity;
    const items = await this.db.iterate<MessageRecord>(STORE.messages, {
      index,
      query: this.db.range([key, -Infinity], [key, upper]),
      direction: 'prev',
      limit: limit + 1,
      // Index ties are ordered by primary key, so skip the boundary entries not older than `before`.
      ...(before ? { filter: (m: MessageRecord) => col(m) < upper || m.id < before.id } : {}),
    });
    const hasMore = items.length > limit;
    if (hasMore) items.length = limit;
    return { items, hasMore };
  }

  async countConversation(convKey: string): Promise<number> {
    const key = convKey.toLowerCase();
    return this.db.count(STORE.messages, this.db.range([key, -Infinity], [key, Infinity]), INDEX.messages.convReceived);
  }

  /** Most recent message (by arrival) of a conversation. */
  async lastMessage(convKey: string): Promise<MessageRecord | undefined> {
    return (await this.list(convKey, { limit: 1 })).items[0];
  }

  /** Most recent message per conversation, for list views. Missing conversations are omitted. */
  async lastMessages(convKeys: readonly string[]): Promise<Map<string, MessageRecord>> {
    const keys = convKeys.map((k) => k.toLowerCase());
    return this.db.transaction(STORE.messages, 'readonly', async (t) => {
      const s = t.store<MessageRecord>(STORE.messages);
      const out = new Map<string, MessageRecord>();
      for (const key of keys) {
        const [m] = await s.iterate({
          index: INDEX.messages.convReceived,
          query: this.db.range([key, -Infinity], [key, Infinity]),
          direction: 'prev',
          limit: 1,
        });
        if (m) out.set(key, m);
      }
      return out;
    });
  }

  listByStatus(status: MessageStatus): Promise<MessageRecord[]> {
    return this.db.getAll<MessageRecord>(STORE.messages, { index: INDEX.messages.status, query: status });
  }

  /** Outgoing messages currently expecting `ackCode`. */
  byAckCode(ackCode: number): Promise<MessageRecord[]> {
    return this.db.getAll<MessageRecord>(STORE.messages, { index: INDEX.messages.ackCode, query: ackCode >>> 0 });
  }

  /** Sets status and optional send metadata on one message. */
  async updateStatus(
    id: number,
    status: MessageStatus,
    patch: { ackCode?: number; attempt?: number; roundTripMs?: number; deliveredAt?: number; compressed?: boolean; timestamp?: number; region?: string | null } = {},
  ): Promise<MessageRecord | undefined> {
    const rec = await this.db.transaction(STORE.messages, 'readwrite', async (t) => {
      const s = t.store<MessageRecord>(STORE.messages);
      const prev = await s.get(id);
      if (!prev) return undefined;
      const next: MessageRecord = { ...prev, status };
      if (patch.ackCode !== undefined) next.ackCode = patch.ackCode >>> 0;
      if (patch.attempt !== undefined) next.attempt = patch.attempt;
      if (patch.roundTripMs !== undefined) next.roundTripMs = patch.roundTripMs;
      if (patch.timestamp !== undefined) next.timestamp = patch.timestamp;
      if (patch.compressed === true) next.compressed = true;
      else if (patch.compressed === false) delete next.compressed;
      if (patch.region === null) delete next.region;
      else if (patch.region !== undefined) next.region = patch.region;
      if (patch.deliveredAt !== undefined) next.deliveredAt = patch.deliveredAt;
      else if (status === 'delivered' && prev.status !== 'delivered') next.deliveredAt = this.now();
      await s.put(next);
      return next;
    });
    if (rec) safeEmit(this.emitter, 'message', { type: 'update', record: rec });
    return rec;
  }

  // ---- reactions (feature-inventory.md §2.4b) ----

  /**
   * Adds a reaction to message `id`. The same emoji from the same sender is only counted once; for
   * our own reaction a repeat replaces the stored one (a resend: new status / time). Returns the
   * updated record, or undefined when the message is gone or nothing changed.
   */
  async addReaction(id: number, reaction: MessageReaction): Promise<MessageRecord | undefined> {
    return this.#patchReactions(id, (rs) => {
      const i = rs.findIndex((r) => r.emoji === reaction.emoji && (reaction.own ? r.own === true : !r.own && r.sender === reaction.sender));
      if (i < 0) return [...rs, reaction];
      if (!reaction.own) return null;
      const next = [...rs];
      next[i] = reaction;
      return next;
    });
  }

  /** Sets the send status of our own reaction `emoji` on message `id`. */
  async setReactionStatus(id: number, emoji: string, status: MessageStatus): Promise<MessageRecord | undefined> {
    return this.#patchReactions(id, (rs) => {
      const i = rs.findIndex((r) => r.own === true && r.emoji === emoji);
      if (i < 0 || rs[i]!.status === status) return null;
      const next = [...rs];
      next[i] = { ...rs[i]!, status };
      return next;
    });
  }

  /** Newest message of a conversation (among the latest `limit`, by arrival) that satisfies `match`. */
  async findRecent(convKey: string, match: (m: MessageRecord) => boolean, limit = 500): Promise<MessageRecord | undefined> {
    const { items } = await this.list(convKey, { limit });
    return items.find(match);
  }

  async #patchReactions(id: number, f: (rs: readonly MessageReaction[]) => MessageReaction[] | null): Promise<MessageRecord | undefined> {
    const rec = await this.db.transaction(STORE.messages, 'readwrite', async (t) => {
      const s = t.store<MessageRecord>(STORE.messages);
      const prev = await s.get(id);
      if (!prev) return undefined;
      const reactions = f(prev.reactions ?? []);
      if (!reactions) return undefined;
      const next: MessageRecord = { ...prev, reactions };
      await s.put(next);
      return next;
    });
    if (rec) safeEmit(this.emitter, 'message', { type: 'update', record: rec });
    return rec;
  }

  /** RESP_SENT: the device transmitted; remember the expected ACK code for this attempt. */
  markSent(id: number, o: { ackCode?: number; attempt?: number } = {}): Promise<MessageRecord | undefined> {
    return this.updateStatus(id, 'sent', o);
  }

  markFailed(id: number): Promise<MessageRecord | undefined> {
    return this.updateStatus(id, 'failed');
  }

  /**
   * PUSH_SEND_CONFIRMED: marks every outgoing DM expecting `ackCode` (pending / sent, or failed
   * within the grace window) as delivered. Returns the updated messages.
   */
  async markDeliveredByAck(ackCode: number, o: { roundTripMs?: number; now?: number } = {}): Promise<MessageRecord[]> {
    const now = o.now ?? this.now();
    const code = ackCode >>> 0;
    const updated = await this.db.transaction(STORE.messages, 'readwrite', async (t) => {
      const s = t.store<MessageRecord>(STORE.messages);
      const out: MessageRecord[] = [];
      await s.each({ index: INDEX.messages.ackCode, query: code }, (m, cursor) => {
        if (m.direction !== 'out' || m.convType !== 'contact' || !ACKABLE.includes(m.status)) return;
        const next: MessageRecord = { ...m, status: 'delivered', deliveredAt: now };
        if (o.roundTripMs !== undefined) next.roundTripMs = o.roundTripMs;
        cursor.update(next);
        out.push(next);
      });
      return out;
    });
    for (const record of updated) safeEmit(this.emitter, 'message', { type: 'update', record });
    return updated;
  }

  /** Deletes one message (local only; the mesh is not affected). */
  async delete(id: number): Promise<void> {
    const prev = await this.get(id);
    if (!prev) return;
    await this.db.delete(STORE.messages, id);
    safeEmit(this.emitter, 'message', { type: 'delete', id, convKey: prev.convKey });
  }

  /** Deletes all messages of a conversation (local only). Returns the number removed. */
  async deleteConversation(convKey: string): Promise<number> {
    const key = convKey.toLowerCase();
    const ids = await this.db.transaction(STORE.messages, 'readwrite', async (t) => {
      const s = t.store<MessageRecord>(STORE.messages);
      const removed: number[] = [];
      await s.each({ index: INDEX.messages.convReceived, query: this.db.range([key, -Infinity], [key, Infinity]) }, (m, cursor) => {
        cursor.delete();
        removed.push(m.id);
      });
      return removed;
    });
    for (const id of ids) safeEmit(this.emitter, 'message', { type: 'delete', id, convKey: key });
    return ids.length;
  }

  // ---- unread ----

  async unreadCount(convType: ConversationType, convKey: string): Promise<number> {
    const key = convKey.toLowerCase();
    if (convType === 'contact') return (await this.db.get<ContactRecord>(STORE.contacts, key))?.unreadCount ?? 0;
    return (await this.db.get<ChannelRecord>(STORE.channels, key))?.unread ?? 0;
  }

  /** Opening a conversation: resets its unread count to 0. */
  markRead(convType: ConversationType, convKey: string): Promise<number> {
    return this.setUnread(convType, convKey, 0);
  }

  async setUnread(convType: ConversationType, convKey: string, count: number): Promise<number> {
    const key = convKey.toLowerCase();
    const n = await this.db.transaction([STORE.contacts, STORE.channels], 'readwrite', (t) =>
      adjustUnread(t, convType, key, () => Math.max(0, count)),
    );
    if (n !== null) safeEmit(this.emitter, 'unread', { convType, convKey: key, count: n });
    return n ?? 0;
  }

  /**
   * "Mark as unread": the given incoming message and every later incoming (non-CLI) message in
   * its conversation become unread. Returns the new count.
   */
  async markUnreadFrom(messageId: number): Promise<number> {
    const m = await this.get(messageId);
    if (!m) return 0;
    let n = 0;
    await this.db.transaction(STORE.messages, 'readonly', (t) =>
      t.store<MessageRecord>(STORE.messages).each(
        { index: INDEX.messages.convReceived, query: this.db.range([m.convKey, m.receivedAt], [m.convKey, Infinity]) },
        (x) => {
          if (x.direction === 'in' && !isCli(x.txtType) && (x.receivedAt > m.receivedAt || x.id >= m.id)) n++;
        },
      ),
    );
    return this.setUnread(m.convType, m.convKey, n);
  }

  /** Sum of unread counts over contacts (excluding repeaters) and channels. */
  async totalUnread(): Promise<{ contacts: number; channels: number; total: number }> {
    return this.db.transaction([STORE.contacts, STORE.channels], 'readonly', async (t) => {
      let contacts = 0;
      let channels = 0;
      await t.store<ContactRecord>(STORE.contacts).each({}, (c) => {
        if (countsUnread(c)) contacts += c.unreadCount;
      });
      await t.store<ChannelRecord>(STORE.channels).each({}, (c) => {
        channels += c.unread;
      });
      return { contacts, channels, total: contacts + channels };
    });
  }
}

/**
 * Applies `f` to the unread count of a conversation inside `t` (needs contacts + channels).
 * Returns the new count, or null when the conversation has no record (or is a repeater).
 */
async function adjustUnread(t: TxScope, convType: ConversationType, key: string, f: (n: number) => number): Promise<number | null> {
  if (convType === 'contact') {
    const s = t.store<ContactRecord>(STORE.contacts);
    const c = await s.get(key);
    if (!c || !countsUnread(c)) return null;
    const next = { ...c, unreadCount: f(c.unreadCount) };
    await s.put(next);
    return next.unreadCount;
  }
  const s = t.store<ChannelRecord>(STORE.channels);
  const c = await s.get(key);
  if (!c) return null;
  const next = { ...c, unread: f(c.unread) };
  await s.put(next);
  return next.unread;
}
