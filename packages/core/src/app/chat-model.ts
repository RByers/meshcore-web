/**
 * One conversation (DM or channel): paged history (oldest → newest; `loadMore()` pages back),
 * sending with delivery status persisted in MessagesRepo (feature-inventory.md §3.2/§3.3),
 * retry, read tracking, byte budget and the reply convention.
 *
 * DMs go through `sendTextMessageWithRetry`: the record moves pending → sent (per attempt, with
 * the expected ACK code) → delivered (with round trip) or failed; a late ACK after failure still
 * marks it delivered. Channel messages have no ACK: pending → sent (device accepted) or failed.
 */

import { FLOOD_UNSCOPED_MIN_VER, type CompanionClient } from '../client/companion-client.js';
import type { RetryOptions, SendProgress } from '../client/types.js';
import type { RadioStore } from '../store/radio-store.js';
import type { ChannelRecord, ContactRecord, ConversationType, MessageRecord, MessageStatus } from '../store/schema.js';
import { fromHex } from '../util/bytes.js';
import { StoreBoundModel } from './store-bound.js';
import type { ConnectionModel } from './connection.js';
import { batch, computed, signal, untracked, type ReadonlySignal } from './signal.js';
import type { DmPathRecorder } from './path-history.js';
import { messageByteLimit, outboundText, parseReply, replyPrefix, textByteLength, type ByteBudget } from './messaging.js';
import { ContactType, TxtType } from '../protocol/constants.js';
import { encodeReaction, ownReaction, reactionChips, reactionMessageHash, type ReactionChip } from './reactions.js';
import { UNSCOPED_REGION, normalizeRegionName, regionKeySync, validateRegionName, type ChannelRegion, type RadioDefaultRegion } from './regions-model.js';

/** Retry tuning for DMs (the model supplies timestamp and onProgress). */
export type ChatRetryOptions = Omit<RetryOptions, 'onProgress' | 'timestamp'>;

export interface ChatModelOptions {
  pageSize?: number;
  retry?: ChatRetryOptions;
  /** Records per-path delivery statistics of DMs (AppModel passes `app.contactPaths`). */
  pathRecorder?: DmPathRecorder;
  /** Region keys and the radio's default scope (AppModel passes `app.regions`). */
  regions?: ChatRegionSource;
}

/** What a chat needs from `RegionsModel`. */
export interface ChatRegionSource {
  readonly radioDefault: ReadonlySignal<RadioDefaultRegion | null | undefined>;
  keyFor(name: string): Uint8Array;
}

/** The scope a channel send goes out with: a region (`fromDefault`: the radio's default scope), or null for none. */
export type EffectiveRegion = { name: string; fromDefault: boolean } | null;

export interface ChatSendOptions {
  /**
   * Channels: send with this scope instead of the channel's (a region name or `UNSCOPED_REGION`),
   * e.g. to reply in the region of the quoted message.
   */
  region?: string;
}

/** Default: 5 attempts, 30 s late-ACK grace (feature-inventory.md §3.3). */
export const DEFAULT_CHAT_RETRY: ChatRetryOptions = { maxAttempts: 5, lateAckGraceMs: 30_000 };

export interface SendHandle {
  /** The outgoing record as first stored ('pending'). */
  record: MessageRecord;
  /** Resolves with the record in its final state ('delivered' / 'sent' / 'failed'). */
  done: Promise<MessageRecord>;
}

export interface ReactionHandle {
  /** The target message with our reaction stored ('pending'). */
  record: MessageRecord;
  /** The on-air text, `"r:<hash>:<index>"`. */
  text: string;
  /** Resolves with the reaction's final status ('delivered' / 'sent' / 'failed'). */
  done: Promise<MessageStatus>;
}

export class ChatModel extends StoreBoundModel {
  readonly #messages = signal<readonly MessageRecord[]>([]);
  readonly #hasMore = signal(false);
  readonly #unread = signal(0);
  readonly #contact = signal<ContactRecord | null>(null);
  readonly #channel = signal<ChannelRecord | null>(null);
  readonly #replyTo = signal<MessageRecord | null>(null);
  readonly #active = signal(false);
  readonly #firstUnreadId = signal<number | null>(null);
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
  /**
   * The "New messages" divider: the id of the first message that was unread when the
   * conversation was opened (captured before it is marked read), or null for no divider. It stays
   * put while the conversation is open (messages read on arrival do not move it), is cleared when
   * the conversation is hidden or we send a message (our reply shows we have read what is above),
   * and is captured afresh on the next open.
   */
  readonly firstUnreadId: ReadonlySignal<number | null> = this.#firstUnreadId.readonly;

  readonly title: ReadonlySignal<string> = computed(() => {
    if (this.convType === 'channel') return this.#channel.value?.name ?? 'Channel';
    const c = this.#contact.value;
    return c?.name || this.convKey.slice(0, 12);
  });

  /** Our advert name (channel messages are sent as "<name>: <text>"). */
  readonly selfName: ReadonlySignal<string> = computed(() => this.connection.selfInfo.value?.name ?? '');

  /**
   * SMAZ compression of outgoing messages is on for this contact / channel (MeshCore Open
   * compatible; local setting, feature-inventory.md §2.4a). Incoming compressed messages are
   * decoded regardless.
   */
  readonly compression: ReadonlySignal<boolean> = computed(() =>
    this.convType === 'contact' ? this.#contact.value?.smaz === true : this.#channel.value?.smaz === true,
  );

  /**
   * Bytes available for the text. Without compression: after the channel name and any reply
   * prefix (the prefix is subtracted). With compression the reply prefix is compressed together
   * with the text, so it is counted in {@link budget}'s `used` instead and not subtracted here.
   */
  readonly byteLimit: ReadonlySignal<number> = computed(() => {
    const reply = this.#replyTo.value;
    const prefix = reply && !this.compression.value ? replyPrefix(this.replyName(reply)) : '';
    return messageByteLimit(this.convType, this.selfName.value, prefix);
  });

  /**
   * The channel's scope choice (`ChannelRecord.region`): a region name, `UNSCOPED_REGION`, or
   * undefined (the radio default applies). Always undefined for DMs (they are never scoped by the
   * app; they flood with the radio default).
   */
  readonly region: ReadonlySignal<ChannelRegion> = computed(() => (this.convType === 'channel' ? this.#channel.value?.region : undefined));

  /**
   * The scope channel sends go out with: the channel's region, else the radio's default scope
   * (`fromDefault`), or null for an unscoped flood. `UNSCOPED_REGION` on firmware before v12 is
   * not supported, so the default applies.
   */
  readonly effectiveRegion: ReadonlySignal<EffectiveRegion> = computed(() => this.#effective(this.region.value));

  /** Whether the radio can send a channel message unscoped despite its default scope (firmware v12+). */
  readonly unscopedSupported: ReadonlySignal<boolean> = computed(() => this.#unscopedSupported());

  readonly pageSize: number;
  readonly #retry: ChatRetryOptions;
  readonly #paths: DmPathRecorder | undefined;
  readonly #regions: ChatRegionSource | undefined;

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
    this.#paths = o.pathRecorder;
    this.#regions = o.regions;
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
    // Read everything first and publish in one batch so the view never renders messages with a
    // placeholder title (the conversation key) while the contact / channel record is still loading.
    const [page, unread, peer] = await Promise.all([
      store.messages.list(this.convKey, { limit: this.pageSize }),
      store.messages.unreadCount(this.convType, this.convKey),
      this.convType === 'contact' ? store.contacts.get(this.convKey) : store.channels.get(this.convKey),
    ]);
    batch(() => {
      this.#messages.value = [...page.items].reverse();
      this.#hasMore.value = page.hasMore;
      this.#unread.value = unread;
      if (this.convType === 'contact') this.#contact.value = (peer as ContactRecord | undefined) ?? null;
      else this.#channel.value = (peer as ChannelRecord | undefined) ?? null;
    });
    if (this.#active.peek() && this.#unread.peek() > 0) await this.#openUnread();
  }

  /** Opened with unread messages: places the divider (if not already placed), then marks read. */
  #openUnread(): Promise<void> {
    if (this.#firstUnreadId.peek() === null) this.#firstUnreadId.value = firstUnreadId(this.#messages.peek(), this.#unread.peek());
    return this.markRead();
  }

  protected reset(): void {
    this.#firstUnreadId.value = null;
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
    const was = this.#active.peek();
    this.#active.value = active;
    if (!active) this.#firstUnreadId.value = null;
    else if (this.#unread.peek() > 0) void (was ? this.markRead() : this.#openUnread());
  }

  // ---- composing ----

  /**
   * Bytes used / left for `text` under the current limit. With compression on, `used` is the
   * size of what goes on the air (the "s:" envelope of reply prefix + text, or the plain text when
   * compressing would not make it shorter) and `compressed` says which.
   */
  budget(text: string): ByteBudget & { compressed: boolean } {
    const limit = this.byteLimit.value;
    let used = textByteLength(text);
    let compressed = false;
    if (this.compression.value) {
      const reply = this.#replyTo.value;
      const full = reply ? `${replyPrefix(this.replyName(reply))}${text}` : text;
      const wire = this.#wire(full);
      used = textByteLength(wire);
      compressed = wire !== full;
    }
    return { used, limit, remaining: limit - used, over: used > limit, compressed };
  }

  /** The on-air text for the full message text `full` (reply prefix included). */
  #wire(full: string): string {
    return outboundText(this.convType, full, this.compression.peek());
  }

  /** Turns SMAZ compression of outgoing messages on or off for this contact / channel. */
  async setCompression(on: boolean): Promise<void> {
    const store = this.store;
    if (!store) throw new Error('Not connected');
    if (this.convType === 'contact') await store.contacts.updateLocal(this.convKey, { smaz: on });
    else await store.channels.update(this.convKey, { smaz: on });
  }

  /**
   * Sets this channel's scope: a region name ('#' optional), `UNSCOPED_REGION`, or undefined for
   * the radio default. Stored locally on the channel record.
   */
  async setRegion(region: ChannelRegion): Promise<void> {
    const store = this.store;
    if (!store) throw new Error('Not connected');
    if (this.convType !== 'channel') throw new Error('Only channels have a region');
    await store.channels.update(this.convKey, { region: region === undefined ? null : checkRegion(region) });
  }

  #unscopedSupported(): boolean {
    return (this.connection.deviceInfo.value?.firmwareVerCode ?? 0) >= FLOOD_UNSCOPED_MIN_VER;
  }

  #effective(choice: ChannelRegion): EffectiveRegion {
    if (choice !== undefined && choice !== UNSCOPED_REGION) return { name: choice, fromDefault: false };
    if (choice === UNSCOPED_REGION && this.#unscopedSupported()) return null;
    const def = this.#regions?.radioDefault.value;
    return def && def.name ? { name: def.name, fromDefault: true } : null;
  }

  /** The flood scope for `withFloodScope` and the region name to record, for a channel send. */
  #scopeFor(choice: ChannelRegion): { scope: Uint8Array | 'unscoped' | null; applied: string | undefined } {
    if (this.convType !== 'channel') return { scope: null, applied: undefined };
    const applied = untracked(() => this.#effective(choice))?.name;
    if (choice === undefined) return { scope: null, applied };
    if (choice === UNSCOPED_REGION) return { scope: 'unscoped', applied };
    return { scope: this.#regions?.keyFor(choice) ?? regionKeySync(choice), applied };
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
  async send(text: string, opts: ChatSendOptions = {}): Promise<SendHandle> {
    const store = this.store;
    if (!store) throw new Error('Not connected');
    const client = this.#client();
    const full = this.#compose(text);
    const choice = opts.region !== undefined ? checkRegion(opts.region) : this.region.peek();
    const { scope, applied } = this.#scopeFor(choice);
    const compressed = this.#wire(full) !== full;
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
      ...(compressed ? { compressed } : {}),
      ...(applied !== undefined ? { region: applied } : {}),
      ...(this.convType === 'contact' ? { attempt: 0 } : { senderName: this.selfName.peek() }),
    });
    batch(() => {
      this.#replyTo.value = null;
      this.#firstUnreadId.value = null;
    });
    const done = this.#track(this.#deliver(store, client, record, channelIdx, record.timestamp, scope));
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
    // the compression setting may have changed since the first attempt
    const compressed = this.#wire(rec.text) !== rec.text;
    // the record keeps the timestamp that went on air: reactions to it hash over it. It must differ
    // from the failed attempt's (seconds granularity), or the mesh treats the packet as a repeat.
    const timestamp = Math.max(Math.floor(client.clock.now() / 1000), rec.timestamp + 1);
    // a retry goes out with the channel's current scope
    const { scope, applied } = this.#scopeFor(this.region.peek());
    const record = (await store.messages.updateStatus(id, 'pending', { attempt: 0, compressed, timestamp, region: applied ?? null })) ?? rec;
    const done = this.#track(this.#deliver(store, client, record, channelIdx, timestamp, scope));
    return { record, done };
  }

  // ---- reactions (MeshCore Open compatible, feature-inventory.md §2.4b) ----

  /**
   * Whether we can react to `m`: incoming, not a CLI reply, and not in a room server (MeshCore
   * Open hashes room posts with the author's name, which the store does not keep). Like MeshCore
   * Open, our own messages cannot be reacted to.
   */
  canReact(m: MessageRecord): boolean {
    if (m.direction !== 'in' || m.convKey !== this.convKey) return false;
    if (m.txtType === TxtType.CLI_DATA || m.txtType === TxtType.CLI_COMMAND) return false;
    return this.convType === 'channel' || this.#contact.peek()?.type !== ContactType.ROOM;
  }

  /** The reaction chips under `m` (counts, who reacted, our pending / failed state). */
  reactions(m: MessageRecord): ReactionChip[] {
    return reactionChips(m);
  }

  /**
   * Reacts to message `id` with `emoji` (one of `REACTION_EMOJIS`): stores our reaction as
   * 'pending' and sends `"r:<hash>:<index>"` as a DM (with ACK and retries; SMAZ applies as for any
   * DM text, though it never makes a reaction shorter) or a channel message (never compressed, as
   * in MeshCore Open). Reacting again with the same emoji resends it (e.g. after a failure).
   */
  async react(id: number, emoji: string): Promise<ReactionHandle> {
    const store = this.store;
    if (!store) throw new Error('Not connected');
    const client = this.#client();
    const target = await store.messages.get(id);
    if (!target || !this.canReact(target)) throw new Error('Cannot react to this message');
    const text = encodeReaction(reactionMessageHash(target), emoji);
    if (text === null) throw new Error('Unsupported reaction emoji');
    const channelIdx = this.convType === 'channel' ? await this.#channelIndex(store) : -1;
    // A resend must carry a later sender timestamp (seconds) than the previous attempt, or the
    // packet is byte-identical and the mesh drops it as a repeat.
    const prev = ownReaction(target, emoji);
    const timestamp = Math.max(Math.floor(client.clock.now() / 1000), prev ? Math.floor(prev.at / 1000) + 1 : 0);
    const now = Math.max(client.clock.now(), timestamp * 1000);
    const record =
      (await store.messages.addReaction(id, { emoji, sender: this.selfName.peek() || 'me', own: true, status: 'pending', at: now })) ?? target;
    const done = this.#track(this.#sendReaction(store, client, id, emoji, text, channelIdx, timestamp));
    return { record, text, done };
  }

  /** Resends our failed reaction `emoji` on message `id`. */
  async retryReaction(id: number, emoji: string): Promise<ReactionHandle> {
    const m = await this.store?.messages.get(id);
    if (!m || ownReaction(m, emoji)?.status !== 'failed') throw new Error('Only failed reactions can be retried');
    return this.react(id, emoji);
  }

  async #sendReaction(store: RadioStore, client: CompanionClient, id: number, emoji: string, text: string, channelIdx: number, timestamp: number): Promise<MessageStatus> {
    const set = async (status: MessageStatus): Promise<MessageStatus> => {
      await store.messages.setReactionStatus(id, emoji, status);
      return status;
    };
    if (this.convType === 'channel') {
      try {
        const { scope } = this.#scopeFor(this.region.peek());
        await client.withFloodScope(scope, () => client.sendChannelMessage(channelIdx, text, { timestamp }));
        return await set('sent');
      } catch {
        return await set('failed');
      }
    }
    let chain: Promise<unknown> = Promise.resolve();
    let last: MessageStatus = 'pending';
    const apply = (p: SendProgress): void => {
      chain = chain.then(async () => {
        if (!canMove(last, p.status, p.late === true)) return;
        last = await set(p.status);
      });
    };
    try {
      await client.sendTextMessageWithRetry(fromHex(this.convKey), this.#wire(text), { ...this.#retry, timestamp, onProgress: apply });
    } catch {
      apply({ status: 'failed', attempt: 0 });
    }
    await chain;
    return last;
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

  async #deliver(
    store: RadioStore,
    client: CompanionClient,
    record: MessageRecord,
    channelIdx: number,
    timestamp = record.timestamp,
    scope: Uint8Array | 'unscoped' | null = null,
  ): Promise<MessageRecord> {
    const id = record.id;
    // compressed ("s:" envelope) when the record says so; the ACK code is computed over this text
    const wire = record.compressed ? outboundText(this.convType, record.text, true) : record.text;
    if (this.convType === 'channel') {
      try {
        await client.withFloodScope(scope, () => client.sendChannelMessage(channelIdx, wire, { timestamp }));
        return (await store.messages.updateStatus(id, 'sent')) ?? record;
      } catch {
        return (await store.messages.markFailed(id)) ?? record;
      }
    }

    // progress callbacks are synchronous; apply them to the store in order
    let chain: Promise<unknown> = Promise.resolve();
    let last: MessageRecord = record;
    const paths = this.#paths?.track(this.convKey);
    const apply = (p: SendProgress): void => {
      paths?.progress(p);
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
      await client.sendTextMessageWithRetry(fromHex(this.convKey), wire, { ...this.#retry, timestamp, onProgress: apply });
    } catch {
      apply({ status: 'failed', attempt: last.attempt ?? 0 });
    }
    await chain;
    return last;
  }
}

/**
 * Where the "New messages" divider goes when a conversation with `unread` unread messages is
 * opened: the id of the `unread`-th newest incoming message of `messages` (oldest first), counting
 * only the messages that bump the unread count (incoming, not CLI; as `MessagesRepo.markUnreadFrom`).
 * When fewer are loaded, the oldest loaded message. Null when nothing is unread or loaded.
 */
export function firstUnreadId(messages: readonly MessageRecord[], unread: number): number | null {
  if (unread <= 0 || messages.length === 0) return null;
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.direction === 'in' && m.txtType !== TxtType.CLI_DATA && m.txtType !== TxtType.CLI_COMMAND && ++n === unread) return m.id;
  }
  return messages[0]!.id;
}

/** A normalised, valid region name, or `UNSCOPED_REGION`; throws otherwise. */
function checkRegion(region: string): string {
  if (region === UNSCOPED_REGION) return region;
  const n = normalizeRegionName(region);
  const err = validateRegionName(n);
  if (err) throw new Error(err);
  return n;
}

/** A delivered message never goes back; a failed one only moves on a late ACK. */
function canMove(from: MessageStatus, to: MessageStatus, late: boolean): boolean {
  if (from === 'delivered') return false;
  if (from === 'failed' && to !== 'failed') return late || to === 'delivered';
  return true;
}
