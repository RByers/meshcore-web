/** Contacts (device contact records merged with app-only fields), keyed by public key hex. */

import type { Contact } from '../protocol/types.js';
import { ContactType } from '../protocol/constants.js';
import type { TypedEmitter } from '../util/events.js';
import type { IdbDatabase } from './idb.js';
import { DEFAULT_CONTACT_LOCAL, STORE, pubKeyHex, type ContactLocalFields, type ContactRecord, type SettingRecord } from './schema.js';
import { safeEmit, type RadioStoreEvents } from './events.js';

/** Unread counts are not kept for repeaters (feature-inventory.md §3.7). */
export function countsUnread(c: Pick<Contact, 'type'>): boolean {
  return c.type !== ContactType.REPEATER;
}

/**
 * Settings key of the contact sync cursor: the client's `contactsSince` after the last sync stored
 * here, i.e. the `since` from which the stored device contacts are complete.
 */
export const CONTACTS_SINCE_SETTING = 'contacts.since';

/** The stored device contacts and their sync cursor (see {@link ContactsRepo.deviceSnapshot}). */
export interface DeviceContactsSnapshot {
  contacts: Contact[];
  since: number;
}

/** The device fields of a stored record (drops the app-only ones). */
export function deviceContact(r: ContactRecord): Contact {
  return {
    pubKey: r.pubKey,
    type: r.type,
    flags: r.flags,
    outPathLen: r.outPathLen,
    outPathInfo: r.outPathInfo,
    outPath: r.outPath,
    name: r.name,
    lastAdvert: r.lastAdvert,
    lat: r.lat,
    lon: r.lon,
    lastMod: r.lastMod,
  };
}

export class ContactsRepo {
  constructor(
    private readonly db: IdbDatabase,
    private readonly emitter: TypedEmitter<RadioStoreEvents>,
    /** Host time (epoch ms) for default timestamps. */
    private readonly now: () => number,
  ) {}

  get(pubKey: Uint8Array | string): Promise<ContactRecord | undefined> {
    return this.db.get<ContactRecord>(STORE.contacts, pubKeyHex(pubKey));
  }

  /** All contacts, sorted by name (case-insensitive). */
  async list(): Promise<ContactRecord[]> {
    const all = await this.db.getAll<ContactRecord>(STORE.contacts);
    return all.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key));
  }

  /**
   * Contacts whose key starts with `prefix` (bytes or hex), e.g. the 6-byte sender prefix of a
   * CONTACT_MSG_RECV frame.
   */
  async findByPrefix(prefix: Uint8Array | string): Promise<ContactRecord[]> {
    const hex = pubKeyHex(prefix);
    return this.db.getAll<ContactRecord>(STORE.contacts, { query: this.db.range(hex, `${hex}￿`) });
  }

  /**
   * Inserts or updates a contact from the device, preserving local fields. `lastSeen` advances
   * to the contact's `lastmod` if that is newer (see {@link mergeContact}).
   */
  async upsertFromDevice(contact: Contact, now = this.now()): Promise<ContactRecord> {
    const key = pubKeyHex(contact.pubKey);
    const rec = await this.db.transaction(STORE.contacts, 'readwrite', async (t) => {
      const s = t.store<ContactRecord>(STORE.contacts);
      const prev = await s.get(key);
      const next = mergeContact(prev, contact, key, now);
      await s.put(next);
      return next;
    });
    safeEmit(this.emitter, 'contact', { type: 'put', record: rec });
    return rec;
  }

  /**
   * Stores a full contact list from the device in one transaction. With `full` (a complete
   * GET_CONTACTS sync), contacts not in the list are kept but marked `onDevice: false`. `since`
   * (the client's cursor after the sync) is saved in the same transaction, so the cursor never
   * runs ahead of the stored contacts.
   */
  async syncFromDevice(contacts: readonly Contact[], opts: { full?: boolean; now?: number; since?: number } = {}): Promise<ContactRecord[]> {
    const now = opts.now ?? this.now();
    const changed = await this.db.transaction([STORE.contacts, STORE.settings], 'readwrite', async (t) => {
      const s = t.store<ContactRecord>(STORE.contacts);
      if (opts.since !== undefined) await t.store<SettingRecord>(STORE.settings).put({ key: CONTACTS_SINCE_SETTING, value: opts.since });
      const out: ContactRecord[] = [];
      const seen = new Set<string>();
      for (const c of contacts) {
        const key = pubKeyHex(c.pubKey);
        seen.add(key);
        const next = mergeContact(await s.get(key), c, key, now);
        await s.put(next);
        out.push(next);
      }
      if (opts.full) {
        for (const r of await s.getAll()) {
          if (!seen.has(r.key) && r.onDevice) {
            const next = { ...r, onDevice: false, updatedAt: now };
            await s.put(next);
            out.push(next);
          }
        }
      }
      return out;
    });
    for (const record of changed) safeEmit(this.emitter, 'contact', { type: 'put', record });
    return changed;
  }

  /** Updates app-only fields. Resolves undefined if the contact does not exist. */
  async updateLocal(pubKey: Uint8Array | string, patch: Partial<ContactLocalFields>): Promise<ContactRecord | undefined> {
    const key = pubKeyHex(pubKey);
    const rec = await this.db.transaction(STORE.contacts, 'readwrite', async (t) => {
      const s = t.store<ContactRecord>(STORE.contacts);
      const prev = await s.get(key);
      if (!prev) return undefined;
      const next: ContactRecord = { ...prev, ...definedOnly(patch), updatedAt: this.now() };
      await s.put(next);
      return next;
    });
    if (rec) {
      safeEmit(this.emitter, 'contact', { type: 'put', record: rec });
      if (patch.unreadCount !== undefined) safeEmit(this.emitter, 'unread', { convType: 'contact', convKey: key, count: rec.unreadCount });
    }
    return rec;
  }

  /** Records that we heard from this contact at `ts` (only moves forward). */
  async touch(pubKey: Uint8Array | string, ts = this.now()): Promise<ContactRecord | undefined> {
    const prev = await this.get(pubKey);
    if (!prev || prev.lastSeen >= ts) return prev;
    return this.updateLocal(pubKey, { lastSeen: ts });
  }

  /** Marks the contact as removed from the device (CONTACT_DELETED push) without losing history. */
  async markRemovedFromDevice(pubKey: Uint8Array | string): Promise<ContactRecord | undefined> {
    const key = pubKeyHex(pubKey);
    const rec = await this.db.transaction(STORE.contacts, 'readwrite', async (t) => {
      const s = t.store<ContactRecord>(STORE.contacts);
      const prev = await s.get(key);
      if (!prev) return undefined;
      const next = { ...prev, onDevice: false, updatedAt: this.now() };
      await s.put(next);
      return next;
    });
    if (rec) safeEmit(this.emitter, 'contact', { type: 'put', record: rec });
    return rec;
  }

  /**
   * The contacts last seen on the device (`onDevice`, device fields only) and the cursor they are
   * complete up to, for an incremental connect-time sync. Undefined before the first saved sync.
   */
  async deviceSnapshot(): Promise<DeviceContactsSnapshot | undefined> {
    return this.db.transaction([STORE.contacts, STORE.settings], 'readonly', async (t) => {
      const since = (await t.store<SettingRecord>(STORE.settings).get(CONTACTS_SINCE_SETTING))?.value;
      if (typeof since !== 'number' || since <= 0) return undefined;
      const all = await t.store<ContactRecord>(STORE.contacts).getAll();
      return { contacts: all.filter((r) => r.onDevice).map(deviceContact), since };
    });
  }

  async delete(pubKey: Uint8Array | string): Promise<void> {
    const key = pubKeyHex(pubKey);
    await this.db.delete(STORE.contacts, key);
    safeEmit(this.emitter, 'contact', { type: 'delete', key });
  }

  async count(): Promise<number> {
    return this.db.count(STORE.contacts);
  }
}

/** Clock skew tolerated before a "heard" time counts as in the future. */
const FUTURE_SLACK_MS = 10 * 60_000;

function mergeContact(prev: ContactRecord | undefined, c: Contact, key: string, now: number): ContactRecord {
  const local: ContactLocalFields = prev
    ? { lastSeen: prev.lastSeen, unreadCount: prev.unreadCount, notes: prev.notes, favourite: prev.favourite, muted: prev.muted }
    : { ...DEFAULT_CONTACT_LOCAL };
  if (prev?.smaz !== undefined) local.smaz = prev.smaz;
  if (prev?.pathHistory !== undefined) local.pathHistory = prev.pathHistory;
  if (prev?.directSnr !== undefined) {
    local.directSnr = prev.directSnr;
    if (prev.directSnrAt !== undefined) local.directSnrAt = prev.directSnrAt;
  }
  // "Heard" comes from lastmod, our radio's RTC when it last heard the contact (advert, message or
  // path update), not last_advert_timestamp, which is the sender's clock: a node whose clock was
  // never set adverts from 15 May 2024 (firmware VolatileRTCClock default). Values in the future
  // came from a wrong clock (or from older versions that used the advert time) and are dropped,
  // or they would pin lastSeen ahead of every real hearing.
  const limit = now + FUTURE_SLACK_MS;
  if (local.lastSeen > limit) local.lastSeen = 0;
  const modMs = c.lastMod * 1000;
  if (modMs > local.lastSeen && modMs <= limit) local.lastSeen = modMs;
  return { ...c, ...local, key, onDevice: true, updatedAt: now };
}

function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}
