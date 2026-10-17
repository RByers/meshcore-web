/**
 * Channels keyed by sha256(psk) hex, so history survives device slot reuse and re-adding a
 * channel with the same PSK restores it (feature-inventory.md §3.1).
 */

import type { ChannelInfo } from '../protocol/types.js';
import { sha256 } from '../packet/crypto.js';
import { toHex } from '../util/bytes.js';
import type { TypedEmitter } from '../util/events.js';
import type { IdbDatabase, TxStore } from './idb.js';
import { INDEX, STORE, type ChannelRecord } from './schema.js';
import { safeEmit, type RadioStoreEvents } from './events.js';

/** Channel key: lowercase hex of SHA-256(psk). */
export async function channelKeyForPsk(psk: Uint8Array): Promise<string> {
  return toHex(await sha256(psk));
}

/** A device slot with an empty name and an all-zero secret is unused. */
export function isEmptyChannelSlot(info: Pick<ChannelInfo, 'name' | 'secret'>): boolean {
  return info.name === '' && info.secret.every((b) => b === 0);
}

export interface ChannelPatch {
  name?: string;
  muted?: boolean;
  unread?: number;
  deviceIndex?: number | null;
  smaz?: boolean;
}

export class ChannelsRepo {
  constructor(
    private readonly db: IdbDatabase,
    private readonly emitter: TypedEmitter<RadioStoreEvents>,
    /** Host time (epoch ms) for default timestamps. */
    private readonly now: () => number,
  ) {}

  get(key: string): Promise<ChannelRecord | undefined> {
    return this.db.get<ChannelRecord>(STORE.channels, key.toLowerCase());
  }

  async getByPsk(psk: Uint8Array): Promise<ChannelRecord | undefined> {
    return this.get(await channelKeyForPsk(psk));
  }

  byDeviceIndex(index: number): Promise<ChannelRecord | undefined> {
    return this.db.transaction(STORE.channels, 'readonly', (t) =>
      t.store<ChannelRecord>(STORE.channels).getFromIndex(INDEX.channels.deviceIndex, index),
    );
  }

  /** Loaded channels first by slot, then unloaded ones by name. */
  async list(): Promise<ChannelRecord[]> {
    const all = await this.db.getAll<ChannelRecord>(STORE.channels);
    return all.sort((a, b) => {
      if (a.deviceIndex !== null && b.deviceIndex !== null) return a.deviceIndex - b.deviceIndex;
      if (a.deviceIndex !== null) return -1;
      if (b.deviceIndex !== null) return 1;
      return a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
    });
  }

  /**
   * Stores one GET_CHANNEL result. Any other channel recorded at the same slot is unassigned;
   * an empty slot just unassigns and resolves null. Local fields (muted, unread) are preserved.
   */
  async upsertFromDevice(info: ChannelInfo, now = this.now()): Promise<ChannelRecord | null> {
    const key = isEmptyChannelSlot(info) ? null : await channelKeyForPsk(info.secret);
    const changed = await this.db.transaction(STORE.channels, 'readwrite', async (t) => {
      const s = t.store<ChannelRecord>(STORE.channels);
      const out: ChannelRecord[] = [];
      out.push(...(await unassignSlot(s, info.index, key, now)));
      if (key !== null) {
        const prev = await s.get(key);
        const next: ChannelRecord = {
          key,
          deviceIndex: info.index,
          name: info.name,
          psk: info.secret,
          muted: prev?.muted ?? false,
          unread: prev?.unread ?? 0,
          ...(prev?.smaz !== undefined ? { smaz: prev.smaz } : {}),
          updatedAt: now,
        };
        await s.put(next);
        out.push(next);
      }
      return out;
    });
    for (const record of changed) safeEmit(this.emitter, 'channel', { type: 'put', record });
    return key === null ? null : (changed.find((c) => c.key === key) ?? null);
  }

  /**
   * Stores a complete channel list (all slots read from the device): upserts each, and marks
   * channels whose slot is not in the list (or is empty) as not loaded.
   */
  async syncFromDevice(infos: readonly ChannelInfo[], now = this.now()): Promise<ChannelRecord[]> {
    const keyed = await Promise.all(
      infos.map(async (info) => ({ info, key: isEmptyChannelSlot(info) ? null : await channelKeyForPsk(info.secret) })),
    );
    const changed = await this.db.transaction(STORE.channels, 'readwrite', async (t) => {
      const s = t.store<ChannelRecord>(STORE.channels);
      const wanted = new Map<string, ChannelInfo>();
      for (const { info, key } of keyed) if (key !== null) wanted.set(key, info);
      const out: ChannelRecord[] = [];
      for (const prev of await s.getAll()) {
        if (!wanted.has(prev.key) && prev.deviceIndex !== null) {
          const next = { ...prev, deviceIndex: null, updatedAt: now };
          await s.put(next);
          out.push(next);
        }
      }
      for (const [key, info] of wanted) {
        const prev = await s.get(key);
        const next: ChannelRecord = {
          key,
          deviceIndex: info.index,
          name: info.name,
          psk: info.secret,
          muted: prev?.muted ?? false,
          unread: prev?.unread ?? 0,
          ...(prev?.smaz !== undefined ? { smaz: prev.smaz } : {}),
          updatedAt: now,
        };
        await s.put(next);
        out.push(next);
      }
      return out;
    });
    for (const record of changed) safeEmit(this.emitter, 'channel', { type: 'put', record });
    return this.list();
  }

  /** Adds (or updates) a channel known locally, e.g. before writing it to the device. */
  async put(o: { name: string; psk: Uint8Array; deviceIndex?: number | null; muted?: boolean }): Promise<ChannelRecord> {
    const key = await channelKeyForPsk(o.psk);
    const now = this.now();
    const changed = await this.db.transaction(STORE.channels, 'readwrite', async (t) => {
      const s = t.store<ChannelRecord>(STORE.channels);
      const prev = await s.get(key);
      const deviceIndex = o.deviceIndex === undefined ? (prev?.deviceIndex ?? null) : o.deviceIndex;
      const out = deviceIndex === null ? [] : await unassignSlot(s, deviceIndex, key, now);
      const next: ChannelRecord = {
        key,
        deviceIndex,
        name: o.name,
        psk: o.psk,
        muted: o.muted ?? prev?.muted ?? false,
        unread: prev?.unread ?? 0,
        ...(prev?.smaz !== undefined ? { smaz: prev.smaz } : {}),
        updatedAt: now,
      };
      await s.put(next);
      out.push(next);
      return out;
    });
    for (const record of changed) safeEmit(this.emitter, 'channel', { type: 'put', record });
    return changed[changed.length - 1]!;
  }

  async update(key: string, patch: ChannelPatch): Promise<ChannelRecord | undefined> {
    const k = key.toLowerCase();
    const rec = await this.db.transaction(STORE.channels, 'readwrite', async (t) => {
      const s = t.store<ChannelRecord>(STORE.channels);
      const prev = await s.get(k);
      if (!prev) return undefined;
      const next: ChannelRecord = { ...prev, updatedAt: this.now() };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.muted !== undefined) next.muted = patch.muted;
      if (patch.unread !== undefined) next.unread = patch.unread;
      if (patch.deviceIndex !== undefined) next.deviceIndex = patch.deviceIndex;
      if (patch.smaz !== undefined) next.smaz = patch.smaz;
      await s.put(next);
      return next;
    });
    if (rec) {
      safeEmit(this.emitter, 'channel', { type: 'put', record: rec });
      if (patch.unread !== undefined) safeEmit(this.emitter, 'unread', { convType: 'channel', convKey: k, count: rec.unread });
    }
    return rec;
  }

  /** Deletes the channel record (messages are kept; re-adding the PSK restores the history). */
  async delete(key: string): Promise<void> {
    const k = key.toLowerCase();
    await this.db.delete(STORE.channels, k);
    safeEmit(this.emitter, 'channel', { type: 'delete', key: k });
  }
}

async function unassignSlot(s: TxStore<ChannelRecord>, index: number, keepKey: string | null, now: number): Promise<ChannelRecord[]> {
  const out: ChannelRecord[] = [];
  const holders = await s.getAll({ index: INDEX.channels.deviceIndex, query: index });
  for (const h of holders) {
    if (h.key === keepKey) continue;
    const next = { ...h, deviceIndex: null, updatedAt: now };
    await s.put(next);
    out.push(next);
  }
  return out;
}
