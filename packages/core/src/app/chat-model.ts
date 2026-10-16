/**
 * One conversation (DM or channel): paged history (oldest → newest; `loadMore()` pages back),
 * sending with delivery status persisted in MessagesRepo (feature-inventory.md §3.2/§3.3),
 * retry, read tracking, byte budget and the reply convention.
 *
 * DMs go through `sendTextMessageWithRetry`: the record moves pending → sent (per attempt, with
 * the expected ACK code) → delivered (with round trip) or failed; a late ACK after failure still
 * marks it delivered. Channel messages have no ACK: pending → sent (device accepted) or failed.
 */

import type { CompanionClient } from '../client/companion-client.js';
import type { RetryOptions, SendProgress } from '../client/types.js';
import type { RadioStore } from '../store/radio-store.js';
import type { ChannelRecord, ContactRecord, ConversationType, MessageRecord, MessageStatus } from '../store/schema.js';
import { fromHex } from '../util/bytes.js';
import { StoreBoundModel } from './store-bound.js';
import type { ConnectionModel } from './connection.js';
import { computed, signal, type ReadonlySignal } from './signal.js';
import { byteBudget, messageByteLimit, parseReply, replyPrefix, type ByteBudget } from './messaging.js';

/** Retry tuning for DMs (the model supplies timestamp and onProgress). */
export type ChatRetryOptions = Omit<RetryOptions, 'onProgress' | 'timestamp'>;

export interface ChatModelOptions {
  pageSize?: number;
  retry?: ChatRetryOptions;
}

/** Default: 5 attempts, 30 s late-ACK grace (feature-inventory.md §3.3). */
export const DEFAULT_CHAT_RETRY: ChatRetryOptions = { maxAttempts: 5, lateAckGraceMs: 30_000 };

export interface SendHandle {
  /** The outgoing record as first stored ('pending'). */
  record: MessageRecord;
  /** Resolves with the record in its final state ('delivered' / 'sent' / 'failed'). */
  done: Promise<MessageRecord>;
}

export class ChatModel extends StoreBoundModel {
  readonly #messages = signal<readonly MessageRecord[]>([]);
  readonly #hasMore = signal(false);
  readonly #unread = signal(0);
  readonly #contact = signal<ContactRecord | null>(null);
  readonly #channel = signal<ChannelRecord | null>(null);
  readonly #replyTo = signal<MessageRecord | null>(null);
  readonly #active = signal(false);
  readonly #sending = new Set<Promise<unknown>>();

  /** Loaded messages, oldest first. */
  readonly messages: ReadonlySignal<readonly MessageRecord[]> = this.#messages.readonly;
  readonly hasMore: ReadonlySignal<boolean> = this.#hasMore.readonly;
  readonly unread: ReadonlySignal<number> = this.#unread.readonly;
  /** The contact (DM) of this conversation, once loaded. */
  readonly contact: ReadonlySignal<ContactRecord | null> = this.#contact.readonly;
  /** The channel of this conversation, once loaded. */
  readonly channel: ReadonlySignal<ChannelRecord | null> = this.#channel.readonly;
  /** The message being replied to (the composer prefixes "@[name] "). */
  readonly replyTo: ReadonlySignal<MessageRecord | null> = this.#replyTo.readonly;
  /** True while the conversation is on screen (incoming messages are read immediately). */
  readonly active: ReadonlySignal<boolean> = this.#active.readonly;

  readonly title: ReadonlySignal<string> = computed(() => {
    if (this.convType === 'channel') return this.#channel.value?.name ?? 'Channel';
    const c = this.#contact.value;
    return c?.name || this.convKey.slice(0, 12);
  });

  /** Our advert name (channel messages are sent as "<name>: <text>"). */
  readonly selfName: ReadonlySignal<string> = computed(() => this.connection.selfInfo.value?.name ?? '');

  /** Text bytes available to the user (after the channel name and any reply prefix). */
  readonly byteLimit: ReadonlySignal<number> = computed(() =>
    messageByteLimit(this.convType, this.selfName.value, this.#replyTo.value ? replyPrefix(this.replyName(this.#replyTo.value)) : ''),
  );

  readonly pageSize: number;
  readonly #retry: ChatRetryOptions;

  constructor(
    connection: ConnectionModel,
    readonly convType: ConversationType,
    readonly convKey: string,
    opts: ChatModelOptions | number = {},
  ) {
    super(connection);
    const o = typeof opts === 'number' ? { pageSize: opts } : opts;
    this.pageSize = o.pageSize ?? 50;
    this.#retry = o.retry ?? DEFAULT_CHAT_RETRY;
    this.convKey = convKey.toLowerCase();
  }

  protected override bind(store: RadioStore) {
    const key = this.convKey;
    const offs = [
      store.events.on('message', (e) => {
        if (e.type === 'delete') {
          if (e.convKey === key) this.#messages.update((ms) => ms.filter((m) => m.id !== e.id));
          return;
        }
        const r = e.record;
        if (r.convKey !== key) return;
        if (e.type === 'add') {
          this.#messages.update((ms) => (ms.some((m) => m.id === r.id) ? ms : [...ms, r]));
        } else {
          this.#messages.update((ms) => ms.map((m) => (m.id === r.id ? r : m)));
        }
      }),
      store.events.on('unread', (e) => {
        if (e.convKey !== key || e.convType !== this.convType) return;
        this.#unread.value = e.count;
        if (e.count > 0 && this.#active.peek()) void this.markRead();
      }),
      store.events.on('contact', (e) => {
        if (this.convType !== 'contact') return;
        if (e.type === 'delete') {
          if (e.key === key) this.#contact.value = null;
        } else if (e.record.key === key) this.#contact.value = e.record;
      }),
      store.events.on('channel', (e) => {
        if (this.convType !== 'channel') return;
        if (e.type === 'delete') {
          if (e.key === key) this.#channel.value = null;
        } else if (e.record.key === key) this.#channel.value = e.record;
      }),
    ];
    return () => offs.forEach((off) => off());
  }

  protected async load(store: RadioStore): Promise<void> {
    const page = await store.messages.list(this.convKey, { limit: this.pageSize });
    this.#messages.value = [...page.items].reverse();
    this.#hasMore.value = page.hasMore;
    this.#unread.value = await store.messages.unreadCount(this.convType, this.convKey);
    if (this.convType === 'contact') this.#contact.value = (await store.contacts.get(this.convKey)) ?? null;
    else this.#channel.value = (await store.channels.get(this.convKey)) ?? null;
    if (this.#active.peek() && this.#unread.peek() > 0) await this.markRead();
  }

  protected reset(): void {
    this.#messages.value = [];
    this.#hasMore.value = false;
    this.#unread.value = 0;
    this.#contact.value = null;
    this.#channel.value = null;
    this.#replyTo.value = null;
  }

  /** Prepends the next older page. */
  async loadMore(): Promise<void> {
    const store = this.store;
    const oldest = this.#messages.peek()[0];
    if (!store || !oldest) return;
    const page = await store.messages.list(this.convKey, { limit: this.pageSize, before: oldest });
    const have = new Set(this.#messages.peek().map((m) => m.id));
    this.#messages.update((ms) => [...[...page.items].reverse().filter((m) => !have.has(m.id)), ...ms]);
    this.#hasMore.value = page.hasMore;
  }

  /** @deprecated use {@link loadMore} */
  loadOlder(): Promise<void> {
    return this.loadMore();
  }

  /** Opening the conversation: resets its unread count. */
  async markRead(): Promise<void> {
    await this.store?.messages.markRead(this.convType, this.convKey);
  }

  /** The conversation is shown (true) or hidden (false); while shown, incoming messages are read. */
  setActive(active: boolean): void {
    this.#active.value = active;
    if (active && this.#unread.peek() > 0) void this.markRead();
  }

  // ---- composing ----

  /** Bytes used / left for `text` under the current limit. */
  budget(text: string): ByteBudget {
    return byteBudget(text, this.byteLimit.value);
  }

  /** The display name a reply to `m` addresses. */
  replyName(m: MessageRecord): string {
    if (m.direction === 'out') return this.selfName.peek() || 'me';
    if (this.convType === 'channel') return m.senderName ?? 'unknown';
    return this.#contact.peek()?.name ?? m.senderPrefix ?? 'unknown';
  }

  setReplyTo(m: MessageRecord | null): void {
    this.#replyTo.value = m;
  }

  /**
   * For a message "@[name] text": the latest earlier loaded message from `name` (the quoted
   * message), or undefined.
   */
  quotedMessage(m: MessageRecord): MessageRecord | undefined {
    const r = parseReply(m.text);
    if (!r) return undefined;
    const ms = this.#messages.peek();
    const idx = ms.findIndex((x) => x.id === m.id);
    for (let i = (idx < 0 ? ms.length : idx) - 1; i >= 0; i--) {
      const x = ms[i]!;
      if (this.replyName(x) === r.name) return x;
    }
    return undefined;
  }

  // ---- sending ----

  #client(): CompanionClient {
    const client = this.connection.client.peek();
    if (!client?.connected) throw new Error('Not connected');
    return client;
  }

  /** Validates `text` against the current limit; returns the text to send (with reply prefix). */
  #compose(text: string): string {
    const body = text.trim();
    if (!body) throw new Error('Message is empty');
    const b = this.budget(body);
    if (b.over) throw new Error(`Message is ${b.used - b.limit} bytes too long`);
    const reply = this.#replyTo.peek();
    return reply ? `${replyPrefix(this.replyName(reply))}${body}` : body;
  }

  /**
   * Sends `text` (prefixed "@[name] " when replying). Resolves once the outgoing record is
   * stored; `done` resolves when delivery is settled.
   */
  async send(text: string): Promise<SendHandle> {
    const store = this.store;
    if (!store) throw new Error('Not connected');
    const client = this.#client();
    const full = this.#compose(text);
    const channelIdx = this.convType === 'channel' ? await this.#channelIndex(store) : -1;
    const now = client.clock.now();
    const record = await store.messages.append({
      convKey: this.convKey,
      convType: this.convType,
      direction: 'out',
      text: full,
      timestamp: Math.floor(now / 1000),
      receivedAt: now,
      status: 'pending',
      ...(this.convType === 'contact' ? { attempt: 0 } : { senderName: this.selfName.peek() }),
    });
    this.#replyTo.value = null;
    const done = this.#track(this.#deliver(store, client, record, channelIdx));
    return { record, done };
  }

  /** Resends a failed message (a new sender timestamp, so the mesh does not drop it as a repeat). */
  async retry(id: number): Promise<SendHandle> {
    const store = this.store;
    if (!store) throw new Error('Not connected');
    const client = this.#client();
    const rec = await store.messages.get(id);
    if (!rec || rec.convKey !== this.convKey || rec.direction !== 'out') throw new Error('No such outgoing message');
    if (rec.status !== 'failed') throw new Error('Only failed messages can be retried');
    const channelIdx = this.convType === 'channel' ? await this.#channelIndex(store) : -1;
    const record = (await store.messages.updateStatus(id, 'pending', { attempt: 0 })) ?? rec;
    const done = this.#track(this.#deliver(store, client, record, channelIdx, Math.floor(client.clock.now() / 1000)));
    return { record, done };
  }

  /** Resolves when every send started by this model has settled (tests). */
  async idle(): Promise<void> {
    while (this.#sending.size > 0) await Promise.allSettled([...this.#sending]);
  }

  #track<T>(p: Promise<T>): Promise<T> {
    this.#sending.add(p);
    void p.finally(() => this.#sending.delete(p)).catch(() => undefined);
    return p;
  }

  async #channelIndex(store: RadioStore): Promise<number> {
    const ch = await store.channels.get(this.convKey);
    if (!ch || ch.deviceIndex === null) throw new Error('This channel is not on the radio');
    return ch.deviceIndex;
  }

  async #deliver(store: RadioStore, client: CompanionClient, record: MessageRecord, channelIdx: number, timestamp = record.timestamp): Promise<MessageRecord> {
    const id = record.id;
    if (this.convType === 'channel') {
      try {
        await client.sendChannelMessage(channelIdx, record.text, { timestamp });
        return (await store.messages.updateStatus(id, 'sent')) ?? record;
      } catch {
        return (await store.messages.markFailed(id)) ?? record;
      }
    }

    // progress callbacks are synchronous; apply them to the store in order
    let chain: Promise<unknown> = Promise.resolve();
    let last: MessageRecord = record;
    const apply = (p: SendProgress): void => {
      chain = chain.then(async () => {
        const patch: { ackCode?: number; attempt?: number; roundTripMs?: number; deliveredAt?: number } = { attempt: p.attempt };
        if (p.ackCode !== undefined) patch.ackCode = p.ackCode;
        if (p.roundTripMs !== undefined) patch.roundTripMs = p.roundTripMs;
        if (p.status === 'delivered') patch.deliveredAt = client.clock.now();
        const cur = await store.messages.get(id);
        if (!cur || !canMove(cur.status, p.status, p.late === true)) return;
        last = (await store.messages.updateStatus(id, p.status, patch)) ?? last;
      });
    };
    try {
      await client.sendTextMessageWithRetry(fromHex(this.convKey), record.text, { ...this.#retry, timestamp, onProgress: apply });
    } catch {
      apply({ status: 'failed', attempt: last.attempt ?? 0 });
    }
    await chain;
    return last;
  }
}

/** A delivered message never goes back; a failed one only moves on a late ACK. */
function canMove(from: MessageStatus, to: MessageStatus, late: boolean): boolean {
  if (from === 'delivered') return false;
  if (from === 'failed' && to !== 'failed') return late || to === 'delivered';
  return true;
}
