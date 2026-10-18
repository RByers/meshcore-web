/**
 * Channel list synced with the device's slots (0..max_channels-1): add / edit (name + PSK, or a
 * #hashtag / Public key derived from the name), delete (clears the slot), mute, unread and the
 * last message per channel. Records are keyed by sha256(psk) so history survives slot reuse.
 */

import type { RadioStore } from '../store/radio-store.js';
import type { ChannelRecord, MessageRecord } from '../store/schema.js';
import { StoreBoundModel } from './store-bound.js';
import { computed, signal, type ReadonlySignal } from './signal.js';
import { channelHash } from '../packet/payloads.js';
import { base64Encode, toHex } from '../util/bytes.js';
import { channelKind, channelNameError, parsePsk, resolveChannelPsk, type ChannelKind } from './messaging.js';

export interface ChannelView {
  key: string;
  record: ChannelRecord;
  name: string;
  kind: ChannelKind;
  /** Device slot, or null when not loaded on the radio. */
  slot: number | null;
  unread: number;
  muted: boolean;
  /** SMAZ compression of outgoing messages (MeshCore Open compatible). */
  smaz: boolean;
  lastMessage: MessageRecord | undefined;
}

/** Everything shown in a channel's details dialog. */
export interface ChannelDetails {
  name: string;
  kind: ChannelKind;
  slot: number | null;
  /** The PSK (shared secret) as hex and base64. */
  keyHex: string;
  keyBase64: string;
  /** 1-byte channel hash carried in GRP_TXT / GRP_DATA packets (SHA256(psk)[0]); -1 if the PSK is malformed. */
  hash: number;
  /** Local storage id: sha256(psk) hex. */
  id: string;
  muted: boolean;
  smaz: boolean;
}

export interface ChannelInput {
  name: string;
  /** 32 hex digits or base64 (16 bytes); empty → derived from the name (#hashtag, Public) or random. */
  psk?: string;
  /** Device slot (default: the first free one). */
  slot?: number;
  /** SMAZ-compress outgoing messages (local setting; default off). */
  smaz?: boolean;
}

export class ChannelsModel extends StoreBoundModel {
  readonly #channels = signal<readonly ChannelRecord[]>([]);
  readonly #last = signal<ReadonlyMap<string, MessageRecord>>(new Map());
  /** Stored channels: loaded on the device first (by slot), then the rest by name. */
  readonly channels: ReadonlySignal<readonly ChannelRecord[]> = this.#channels.readonly;
  readonly onDevice = computed(() => this.#channels.value.filter((c) => c.deviceIndex !== null));

  /** Number of device slots (DEVICE_INFO max_channels; 8 if unknown). */
  readonly slotCount: ReadonlySignal<number> = computed(() => this.connection.deviceInfo.value?.maxChannels ?? 8);

  readonly views: ReadonlySignal<readonly ChannelView[]> = computed(() => {
    const last = this.#last.value;
    return this.#channels.value.map((c) => ({
      key: c.key,
      record: c,
      name: c.name,
      kind: channelKind(c.name, c.psk),
      slot: c.deviceIndex,
      unread: c.unread,
      muted: c.muted,
      smaz: c.smaz === true,
      lastMessage: last.get(c.key),
    }));
  });

  /** Lowest unused slot, or null when every slot is taken. */
  readonly freeSlot: ReadonlySignal<number | null> = computed(() => {
    const used = new Set(this.onDevice.value.map((c) => c.deviceIndex));
    for (let i = 0; i < this.slotCount.value; i++) if (!used.has(i)) return i;
    return null;
  });

  find(key: string): ChannelRecord | undefined {
    const k = key.toLowerCase();
    return this.#channels.peek().find((c) => c.key === k);
  }

  /** Key, hash and settings of a stored channel (undefined if unknown). */
  async details(key: string): Promise<ChannelDetails | undefined> {
    const c = this.find(key);
    if (!c) return undefined;
    return {
      name: c.name,
      kind: channelKind(c.name, c.psk),
      slot: c.deviceIndex,
      keyHex: toHex(c.psk),
      keyBase64: base64Encode(c.psk),
      hash: await channelHash(c.psk).catch(() => -1),
      id: c.key,
      muted: c.muted,
      smaz: c.smaz === true,
    };
  }

  protected override bind(store: RadioStore) {
    const offs = [
      store.events.on('channel', () => void this.reload()),
      store.events.on('message', (e) => {
        if (e.type === 'delete') return void this.reload();
        const r = e.record;
        if (r.convType !== 'channel') return;
        this.#last.update((m) => {
          const prev = m.get(r.convKey);
          if (prev && prev.id !== r.id && prev.receivedAt > r.receivedAt) return m;
          return new Map(m).set(r.convKey, r);
        });
      }),
    ];
    return () => offs.forEach((off) => off());
  }

  protected async load(store: RadioStore): Promise<void> {
    const channels = await store.channels.list();
    this.#last.value = await store.messages.lastMessages(channels.map((c) => c.key));
    this.#channels.value = channels;
  }

  protected reset(): void {
    this.#channels.value = [];
    this.#last.value = new Map();
  }

  #ctx() {
    const client = this.connection.client.peek();
    const store = this.store;
    if (!client?.connected || !store) throw new Error('Not connected');
    return { client, store };
  }

  /** Re-reads every slot from the device. */
  async refresh(): Promise<void> {
    const { client, store } = this.#ctx();
    await store.channels.syncFromDevice(await client.getChannels(), client.clock.now());
    await this.reload();
  }

  /** Writes slot `index` and stores what the device reports back. */
  async #write(index: number, name: string, psk: Uint8Array): Promise<ChannelRecord | null> {
    const { client, store } = this.#ctx();
    await client.setChannel(index, name, psk);
    const rec = await store.channels.upsertFromDevice(await client.getChannel(index), client.clock.now());
    await this.reload();
    return rec;
  }

  /** Adds a channel to a free (or the given) slot. */
  async add(input: ChannelInput): Promise<ChannelRecord> {
    const name = input.name.trim();
    const err = channelNameError(name);
    if (err) throw new Error(err);
    const psk = await resolveChannelPsk(name, input.psk);
    const slot = input.slot ?? this.freeSlot.peek();
    if (slot === null) throw new Error('All channel slots on the radio are in use');
    if (slot < 0 || slot >= this.slotCount.peek()) throw new Error(`Slot must be 0-${this.slotCount.peek() - 1}`);
    const rec = await this.#write(slot, name, psk);
    if (!rec) throw new Error('The radio did not store the channel');
    return input.smaz === undefined ? rec : this.#setSmaz(rec, input.smaz);
  }

  /** Stores the local SMAZ setting on `rec` (unchanged if it already matches). */
  async #setSmaz(rec: ChannelRecord, smaz: boolean): Promise<ChannelRecord> {
    if ((rec.smaz === true) === smaz) return rec;
    const next = await this.store?.channels.update(rec.key, { smaz });
    await this.reload();
    return next ?? rec;
  }

  /**
   * Renames and/or re-keys a channel (a new PSK makes it a different conversation). Renaming to
   * a different "#hashtag" without an explicit key switches to that hashtag's derived key.
   */
  async edit(key: string, patch: { name?: string; psk?: string; smaz?: boolean }): Promise<ChannelRecord> {
    const cur = this.find(key);
    if (!cur) throw new Error('Unknown channel');
    const name = (patch.name ?? cur.name).trim();
    // a re-keyed channel is a new record; it keeps the setting being edited
    const smaz = patch.smaz ?? cur.smaz === true;
    const err = channelNameError(name);
    if (err) throw new Error(err);
    // No explicit key: keep the current one, except that renaming to a different #hashtag joins
    // that hashtag (its key is derived from the name; keeping the old key would leave a channel
    // labelled "#new" that only talks to "#old").
    const psk =
      patch.psk !== undefined && patch.psk.trim()
        ? parsePsk(patch.psk)
        : name.startsWith('#') && name !== cur.name
          ? await resolveChannelPsk(name)
          : cur.psk;
    if (cur.deviceIndex === null) {
      const store = this.store;
      if (!store) throw new Error('Not connected');
      const rec = await store.channels.put({ name, psk, deviceIndex: null });
      await this.reload();
      return this.#setSmaz(rec, smaz);
    }
    const rec = await this.#write(cur.deviceIndex, name, psk);
    if (!rec) throw new Error('The radio did not store the channel');
    return this.#setSmaz(rec, smaz);
  }

  /**
   * Clears the channel's device slot and deletes the local record. Messages are kept unless
   * `deleteMessages` (re-adding the same PSK restores the history).
   */
  async remove(key: string, opts: { deleteMessages?: boolean } = {}): Promise<void> {
    const cur = this.find(key);
    if (!cur) return;
    if (cur.deviceIndex !== null) await this.#write(cur.deviceIndex, '', new Uint8Array(16));
    const store = this.store;
    if (!store) return;
    await store.channels.delete(cur.key);
    if (opts.deleteMessages) await store.messages.deleteConversation(cur.key);
    await this.reload();
  }

  async setMuted(key: string, muted: boolean): Promise<void> {
    await this.store?.channels.update(key, { muted });
  }

  /** Local SMAZ compression setting for outgoing messages (MeshCore Open compatible). */
  async setSmaz(key: string, smaz: boolean): Promise<void> {
    await this.store?.channels.update(key, { smaz });
  }
}
