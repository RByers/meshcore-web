/**
 * Capture pipeline: persists everything a CompanionClient reports into the radio's RadioStore.
 *
 * - every `frame` event → `RadioStore.captureFrame` (packets carried by LOG_RX/RAW/TRACE pushes
 *   are extracted there);
 * - contact / channel message pushes → `MessagesRepo.append` (which bumps unread counts); emoji
 *   reactions (`r:…`) attach to their target message instead (`MessagesRepo.addReaction`);
 * - `contactsChanged` → `ContactsRepo.syncFromDevice` / `markRemovedFromDevice`;
 * - `selfInfo` updates → `DevicesRepo.update`;
 * - SEND_CONFIRMED pushes → `MessagesRepo.markDeliveredByAck` (outgoing DMs expecting that ACK).
 *
 * The pipeline is attached to the client *before* `connect()` so the handshake is captured too.
 * The radio's public key is only known once the handshake has finished, so events are buffered
 * until `attachStore()`; after that every event is processed in order on one serial queue.
 */

import type { CompanionClient } from '../client/companion-client.js';
import type { ChannelMessageEvent, ContactMessageEvent, ContactsChangedEvent, FrameLogEntry } from '../client/types.js';
import type { SelfInfo } from '../protocol/types.js';
import { toHex } from '../util/bytes.js';
import type { Unsubscribe } from '../util/events.js';
import type { DevicesRepo } from '../store/devices.js';
import { messageInputFromChannelFrame, messageInputFromContactFrame, type MessageInput } from '../store/messages.js';
import type { RadioStore } from '../store/radio-store.js';
import { TxtType } from '../protocol/constants.js';
import { parseReaction, reactionMatches, type ParsedReaction } from './reactions.js';

type Task = (store: RadioStore) => Promise<void>;

export interface CapturePipelineOptions {
  devices?: DevicesRepo | null | undefined;
  /** Called for each failed step (the pipeline keeps going). */
  onError?: (err: unknown, step: string) => void;
}

/** Fallback conversation key for a channel message whose slot is unknown to the store. */
export function unknownChannelKey(channelIdx: number): string {
  return `slot-${channelIdx}`;
}

export class CapturePipeline {
  #store: RadioStore | null = null;
  #buffer: Array<{ step: string; task: Task }> = [];
  #chain: Promise<void> = Promise.resolve();
  #unsubs: Unsubscribe[] = [];
  #stopped = false;
  /** id of the most recently captured incoming frame (messages link to it). */
  #lastInFrameId: number | undefined;
  /** Counters, mostly for tests and the status bar. */
  framesCaptured = 0;
  messagesCaptured = 0;

  constructor(
    readonly client: CompanionClient,
    private readonly opts: CapturePipelineOptions = {},
  ) {
    const ev = client.events;
    this.#unsubs = [
      ev.on('frame', (e) => this.#enqueue('frame', (s) => this.#captureFrame(s, e))),
      ev.on('contactMessage', (e) => this.#enqueue('contactMessage', (s) => this.#contactMessage(s, e))),
      ev.on('channelMessage', (e) => this.#enqueue('channelMessage', (s) => this.#channelMessage(s, e))),
      ev.on('contactsChanged', (e) => this.#enqueue('contactsChanged', (s) => this.#contactsChanged(s, e))),
      ev.on('selfInfo', (e) => this.#enqueue('selfInfo', (s) => this.#selfInfo(s, e))),
      ev.on('sendConfirmed', (e) =>
        this.#enqueue('sendConfirmed', (s) => s.messages.markDeliveredByAck(e.ackCode, { roundTripMs: e.roundTripMs, now: this.client.clock.now() }).then(() => undefined)),
      ),
    ];
  }

  get store(): RadioStore | null {
    return this.#store;
  }

  /** Events waiting for a store. */
  get buffered(): number {
    return this.#buffer.length;
  }

  /**
   * Starts persisting into `store`: runs `setup` first (e.g. recording the connection, loading
   * channels), then the buffered events, then live events.
   */
  attachStore(store: RadioStore, setup?: Task): void {
    if (this.#stopped) return;
    this.#store = store;
    if (setup) this.#chainTask('setup', setup);
    for (const { step, task } of this.#buffer.splice(0)) this.#chainTask(step, task);
  }

  /** Resolves once every queued step (including steps queued meanwhile) has run. */
  async idle(): Promise<void> {
    let c: Promise<void>;
    do {
      c = this.#chain;
      await c;
    } while (c !== this.#chain);
  }

  /** Detaches from the client; already-queued steps still run (await `idle()`). */
  stop(): void {
    this.#stopped = true;
    for (const off of this.#unsubs) off();
    this.#unsubs = [];
    this.#buffer = [];
  }

  #enqueue(step: string, task: Task): void {
    if (this.#stopped) return;
    if (this.#store) this.#chainTask(step, task);
    else this.#buffer.push({ step, task });
  }

  #chainTask(step: string, task: Task): void {
    const store = this.#store;
    if (!store) return;
    this.#chain = this.#chain.then(() =>
      task(store).catch((err: unknown) => {
        this.opts.onError?.(err, step);
      }),
    );
  }

  async #captureFrame(store: RadioStore, e: FrameLogEntry): Promise<void> {
    const r = await store.captureFrame(e.direction, e.bytes, { ts: e.timestamp, ...(e.frame ? { decoded: e.frame } : {}) });
    if (e.direction === 'in') this.#lastInFrameId = r.frame.id;
    this.framesCaptured++;
  }

  async #append(store: RadioStore, input: MessageInput): Promise<void> {
    if ((input.txtType ?? TxtType.PLAIN) === TxtType.PLAIN) {
      const r = parseReaction(input.text);
      // MeshCore Open: a matched reaction attaches to its target; an unmatched "r:" is dropped,
      // an unmatched MeshCoreOne reaction is shown as an ordinary message.
      if (r && ((await this.#react(store, input, r)) || r.format === 'ours')) return;
    }
    if (await isDuplicate(store, input)) return;
    await store.messages.append(input);
    this.messagesCaptured++;
  }

  /**
   * Attaches an incoming reaction to the newest message it targets (feature-inventory.md §2.4b).
   * DMs: only our outgoing messages; channels: any message. Returns false when nothing matched.
   */
  async #react(store: RadioStore, input: MessageInput, r: ParsedReaction): Promise<boolean> {
    const target = await store.messages.findRecent(input.convKey, (m) => (input.convType === 'channel' || m.direction === 'out') && reactionMatches(r, m));
    if (!target) return false;
    const sender =
      input.convType === 'channel'
        ? (input.senderName ?? 'unknown')
        : ((await store.contacts.get(input.convKey))?.name || input.senderPrefix || input.convKey.slice(0, 12));
    await store.messages.addReaction(target.id, { emoji: r.emoji, sender, at: input.receivedAt ?? Date.now() });
    return true;
  }

  async #contactMessage(store: RadioStore, e: ContactMessageEvent): Promise<void> {
    const f = e.message;
    let key = e.contact ? toHex(e.contact.pubKey) : undefined;
    if (!key) key = (await store.contacts.findByPrefix(f.senderPrefix))[0]?.key;
    key ??= toHex(f.senderPrefix);
    const meta = this.#meta();
    await this.#append(store, messageInputFromContactFrame(f, key, meta));
    if (key.length === 64) await store.contacts.touch(key, meta.receivedAt);
  }

  async #channelMessage(store: RadioStore, e: ChannelMessageEvent): Promise<void> {
    const f = e.message;
    let ch = await store.channels.byDeviceIndex(f.channelIdx);
    if (!ch && this.client.connected) {
      try {
        const info = await this.client.getChannel(f.channelIdx);
        ch = (await store.channels.upsertFromDevice(info)) ?? undefined;
      } catch (err) {
        this.opts.onError?.(err, 'getChannel');
      }
    }
    const key = ch?.key ?? unknownChannelKey(f.channelIdx);
    await this.#append(store, messageInputFromChannelFrame(f, key, this.#meta()));
  }

  #meta(): { receivedAt: number; rawFrameId?: number } {
    const receivedAt = this.client.clock.now();
    return this.#lastInFrameId !== undefined ? { receivedAt, rawFrameId: this.#lastInFrameId } : { receivedAt };
  }

  async #contactsChanged(store: RadioStore, e: ContactsChangedEvent): Promise<void> {
    const now = this.client.clock.now();
    if (e.updated.length > 0 || e.full) await store.contacts.syncFromDevice(e.updated, { full: e.full, now });
    for (const k of e.removed) await store.contacts.markRemovedFromDevice(k);
  }

  async #selfInfo(store: RadioStore, info: SelfInfo): Promise<void> {
    await this.opts.devices?.update(store.pubKey, { selfInfo: info, name: info.name });
  }
}

/**
 * The device delivers each queued message once, but the emulator re-seeds its history on every
 * page load; skip a message identical (sender time, text, direction) to a recent one.
 */
async function isDuplicate(store: RadioStore, m: MessageInput): Promise<boolean> {
  const page = await store.messages.list(m.convKey, { limit: 50, order: 'sender' });
  return page.items.some(
    (x) => x.direction === m.direction && x.timestamp === m.timestamp && x.text === m.text && (x.senderName ?? '') === (m.senderName ?? ''),
  );
}
