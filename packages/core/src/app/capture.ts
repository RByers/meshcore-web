/**
 * Capture pipeline: persists everything a CompanionClient reports into the radio's RadioStore.
 *
 * - every `frame` event → `RadioStore.captureFrame` (packets carried by LOG_RX/RAW/TRACE pushes
 *   are extracted there);
 * - contact / channel message pushes → `MessagesRepo.append` (which bumps unread counts); emoji
 *   reactions (`r:…`) attach to their target message instead (`MessagesRepo.addReaction`); a
 *   SMAZ-compressed DM can turn on the sender's compression (`smazAutoEnable`, §2.4a);
 * - `contactsChanged` → `ContactsRepo.syncFromDevice` (with the sync cursor) / `markRemovedFromDevice`;
 * - `selfInfo` updates → `DevicesRepo.update`;
 * - SEND_CONFIRMED pushes → `MessagesRepo.markDeliveredByAck` (outgoing DMs expecting that ACK).
 *   (Send outcomes on the packet log's tx rows are correlated inside `RadioStore.captureFrame`.)
 * - once per radio, in the background: `runSendBackfillOnce` rebuilds sent-packet rows and their
 *   outcomes from frames logged before this session (store/send-backfill.ts).
 *
 * The pipeline is attached to the client *before* `connect()` so the handshake is captured too.
 * The radio's public key is only known once the handshake has finished, so events are buffered
 * until `attachStore()`; after that every event is processed in order on one serial queue.
 */

import type { CompanionClient } from '../client/companion-client.js';
import type { ChannelMessageEvent, ContactMessageEvent, ContactsChangedEvent, FrameLogEntry } from '../client/types.js';
import type { SelfInfo } from '../protocol/types.js';
import { fromHex, toHex } from '../util/bytes.js';
import { channelHash } from '../packet/payloads.js';
import { decodePathLen, PATH_LEN_UNKNOWN } from '../protocol/constants.js';
import type { Unsubscribe } from '../util/events.js';
import type { DevicesRepo } from '../store/devices.js';
import { messageInputFromChannelFrame, messageInputFromContactFrame, type MessageInput } from '../store/messages.js';
import type { RadioStore } from '../store/radio-store.js';
import { SEND_BACKFILL_SETTING, runSendBackfillOnce, type SendBackfillResult } from '../store/send-backfill.js';
import { TxtType } from '../protocol/constants.js';
import { parseReaction, reactionMatches, type ParsedReaction } from './reactions.js';
import { RxPathCorrelator, type DirectHearing } from './rx-path-correlator.js';

type Task = (store: RadioStore) => Promise<void>;

export interface CapturePipelineOptions {
  devices?: DevicesRepo | null | undefined;
  /**
   * Whether a compressed DM turns on SMAZ compression for its sender when the contact's setting
   * was never set (`ContactRecord.smaz` absent; feature-inventory.md §2.4a). Default off.
   */
  smazAutoEnable?: () => boolean;
  /** Called for each failed step (the pipeline keeps going). */
  onError?: (err: unknown, step: string) => void;
  /** Run the one-time sent-packet backfill when a store is attached (default true). */
  backfillSends?: boolean;
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
  /** Matches message frames to the logged packets that carried them (paths, direct SNR). */
  readonly #rx = new RxPathCorrelator();
  readonly #channelHashes = new Map<string, number>();
  /** Counters, mostly for tests and the status bar. */
  framesCaptured = 0;
  messagesCaptured = 0;
  /**
   * The background sent-packet backfill started by `attachStore` (resolves null when it was not
   * needed or failed; failures go to `onError` as step 'sent-packet history').
   */
  sendBackfill: Promise<SendBackfillResult | null> = Promise.resolve(null);

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
    if (this.opts.backfillSends ?? true) {
      this.sendBackfill = new Promise((resolve) => this.#chainTask('sent-packet history', (s) => this.#startBackfill(s, resolve)));
    }
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

  /**
   * Snapshots the frame log's end on the serial queue (before any frame of this session is
   * captured), then backfills up to it without holding up the queue: later frames are correlated live.
   */
  async #startBackfill(store: RadioStore, started: (run: Promise<SendBackfillResult | null>) => void): Promise<void> {
    try {
      if ((await store.settings.get<unknown>(SEND_BACKFILL_SETTING)) !== undefined) return started(Promise.resolve(null));
      const upToFrameId = await store.frames.lastId();
      started(
        runSendBackfillOnce(store, { upToFrameId, now: this.client.clock.now() }).catch((err: unknown) => {
          if (!this.#stopped) this.opts.onError?.(err, 'sent-packet history');
          return null;
        }),
      );
    } catch (err) {
      started(Promise.resolve(null));
      throw err; // reported by the queue
    }
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
    if (r.packet) {
      const heard = this.#rx.observe(r.packet);
      if (heard) await recordDirect(store, heard);
    }
  }

  /** Stores an incoming message (or attaches a reaction); false only for a duplicate (already captured). */
  async #append(store: RadioStore, input: MessageInput): Promise<boolean> {
    if ((input.txtType ?? TxtType.PLAIN) === TxtType.PLAIN) {
      const r = parseReaction(input.text);
      // MeshCore Open: a matched reaction attaches to its target; an unmatched "r:" is dropped,
      // an unmatched MeshCoreOne reaction is shown as an ordinary message.
      if (r && ((await this.#react(store, input, r)) || r.format === 'ours')) return true;
    }
    if (await isDuplicate(store, input)) return false;
    await store.messages.append(input);
    this.messagesCaptured++;
    return true;
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
    await store.messages.addReaction(target.id, { emoji: r.emoji, sender, at: input.receivedAt ?? this.client.clock.now() });
    return true;
  }

  async #contactMessage(store: RadioStore, e: ContactMessageEvent): Promise<void> {
    const f = e.message;
    let key = e.contact ? toHex(e.contact.pubKey) : undefined;
    if (!key) key = (await store.contacts.findByPrefix(f.senderPrefix))[0]?.key;
    key ??= toHex(f.senderPrefix);
    const meta = this.#meta();
    const input = messageInputFromContactFrame(f, key, meta);
    const path = this.#rx.claimContactMessage({
      pathLen: f.route.pathLen,
      senderHash: f.senderPrefix[0] ?? -1,
      selfHash: fromHex(store.pubKey)[0] ?? -1,
      now: meta.receivedAt,
    });
    if (path) input.path = path;
    if (!(await this.#append(store, input))) return;
    if (key.length === 64) {
      await store.contacts.touch(key, meta.receivedAt);
      if (input.compressed && this.opts.smazAutoEnable?.()) {
        // an explicit false (the user turned it off) sticks
        const c = await store.contacts.get(key);
        if (c && c.smaz === undefined) await store.contacts.updateLocal(key, { smaz: true });
      }
      if (f.snr !== undefined && isZeroHop(f.route.pathLen)) await recordDirect(store, { key, snr: f.snr, ts: meta.receivedAt });
    }
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
    const meta = this.#meta();
    const input = messageInputFromChannelFrame(f, key, meta);
    if (ch) {
      let hash = this.#channelHashes.get(ch.key);
      if (hash === undefined) {
        hash = await channelHash(ch.psk).catch(() => -1);
        this.#channelHashes.set(ch.key, hash);
      }
      const path = this.#rx.claimChannelMessage({ pathLen: f.route.pathLen, channelHash: hash, now: meta.receivedAt });
      if (path) input.path = path;
    }
    await this.#append(store, input);
  }

  #meta(): { receivedAt: number; rawFrameId?: number } {
    const receivedAt = this.client.clock.now();
    return this.#lastInFrameId !== undefined ? { receivedAt, rawFrameId: this.#lastInFrameId } : { receivedAt };
  }

  async #contactsChanged(store: RadioStore, e: ContactsChangedEvent): Promise<void> {
    const now = this.client.clock.now();
    // the cursor is saved with the contacts it covers (seeds the next connect's incremental sync)
    if (e.updated.length > 0 || e.full) await store.contacts.syncFromDevice(e.updated, { full: e.full, now, since: e.since });
    for (const k of e.removed) await store.contacts.markRemovedFromDevice(k);
  }

  async #selfInfo(store: RadioStore, info: SelfInfo): Promise<void> {
    await this.opts.devices?.update(store.pubKey, { selfInfo: info, name: info.name });
  }
}

/** A flood message with an empty path: the sender was heard directly. */
function isZeroHop(pathLen: number): boolean {
  return (pathLen & 0xff) !== PATH_LEN_UNKNOWN && decodePathLen(pathLen).hops === 0;
}

/** Stores a zero-hop SNR on a known contact (issue #11); never moves backwards in time. */
async function recordDirect(store: RadioStore, h: DirectHearing): Promise<void> {
  const prev = await store.contacts.get(h.key);
  if (!prev || (prev.directSnrAt ?? 0) > h.ts) return;
  await store.contacts.updateLocal(h.key, { directSnr: h.snr, directSnrAt: h.ts });
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
