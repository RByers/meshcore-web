/**
 * Contacts list: search / type filter / sort over the store's contacts, per-contact derived
 * fields (last seen, last message, unread, path, SNR), and the device actions (refresh, add,
 * remove, reset path, share, export). State comes from ContactsRepo; the capture pipeline keeps
 * the repo in sync with the device.
 */

import { ContactFlag, ContactType, PATH_LEN_UNKNOWN } from '../protocol/constants.js';
import type { Contact } from '../protocol/types.js';
import type { RadioStore } from '../store/radio-store.js';
import type { ContactRecord, MessageRecord } from '../store/schema.js';
import { fromHex, toHex } from '../util/bytes.js';
import { StoreBoundModel } from './store-bound.js';
import { computed, signal, type ReadonlySignal } from './signal.js';
import {
  contactShareUrl,
  contactTypeName,
  parseContactShare,
  pathDisplay,
  type ContactShare,
  type ContactKind,
  type PathDisplay,
  parseReply,
  receivedHops,
  resolveSenderName,
  type SenderTarget,
} from './messaging.js';
import { pathLabel, resolvePath, type PathLabel, type ResolvedHop, type ResolvePathOptions } from './path-resolver.js';

export type ContactSort = 'recent' | 'name';
export type ContactFilter = 'all' | ContactKind | 'favourites' | 'unread';

export const CONTACT_FILTERS: readonly ContactFilter[] = ['all', 'chat', 'repeater', 'room', 'sensor', 'favourites', 'unread'];

/** A contact plus the fields list views show. */
export interface ContactView {
  key: string;
  record: ContactRecord;
  name: string;
  typeName: ContactKind;
  /** Epoch ms (0 = never). */
  lastSeen: number;
  lastMessage: MessageRecord | undefined;
  /** Epoch ms of the last message (0 = none). */
  lastActivity: number;
  unread: number;
  path: PathDisplay;
  /**
   * SNR (dB) of the most recent packet heard directly (zero hop) from this contact: a zero-hop
   * advert or message (issue #11). Relayed messages do not count: their SNR is the last hop's.
   */
  directSnr: number | undefined;
  /** Epoch ms {@link directSnr} was heard (0 = never). */
  directSnrAt: number;
  /** @deprecated alias of {@link directSnr}. */
  lastSnr: number | undefined;
  favourite: boolean;
  onDevice: boolean;
}

export interface ContactExport {
  packet: Uint8Array;
  hex: string;
  /** `meshcore://<hex>` */
  url: string;
}

export interface AddContactOptions {
  /** Name for a contact added by bare public key (default: the key prefix). */
  name?: string;
  /** ContactType for a bare public key (default CHAT). */
  type?: number;
  /** How long to wait for the device to report an imported advert (default 3000 ms). */
  timeoutMs?: number;
}

function preview(m: MessageRecord | undefined): string {
  if (!m) return '';
  const who = m.direction === 'out' ? 'You: ' : m.senderName ? `${m.senderName}: ` : '';
  // Replies are stored as "@[name] text"; show them as "↪ text" rather than the raw convention.
  const reply = parseReply(m.text);
  return `${who}${reply ? `↪ ${reply.text}` : m.text}`;
}

/** "You: hi" / "Dave: hi" / "hi" / "You: ↪ hi" (a reply) for list previews. */
export function messagePreview(m: MessageRecord | undefined): string {
  return preview(m);
}

/** An incoming message heard zero hop, with an SNR. */
function isDirectSnrMessage(m: MessageRecord): boolean {
  return m.direction === 'in' && m.snr !== undefined && receivedHops(m.pathLen) === 0;
}

export class ContactsModel extends StoreBoundModel {
  readonly #contacts = signal<readonly ContactRecord[]>([]);
  readonly #last = signal<ReadonlyMap<string, MessageRecord>>(new Map());
  /** Zero-hop message SNRs found in history (fallback for contacts without `directSnr`). */
  readonly #lastSnr = signal<ReadonlyMap<string, { snr: number; at: number }>>(new Map());
  readonly #sort = signal<ContactSort>('recent');
  readonly #filter = signal<ContactFilter>('all');
  readonly #search = signal('');

  /** All stored contacts of the connected radio, sorted by name. */
  readonly contacts: ReadonlySignal<readonly ContactRecord[]> = this.#contacts.readonly;
  readonly sort: ReadonlySignal<ContactSort> = this.#sort.readonly;
  readonly filter: ReadonlySignal<ContactFilter> = this.#filter.readonly;
  readonly search: ReadonlySignal<string> = this.#search.readonly;
  /** Contacts currently on the device. */
  readonly onDevice = computed(() => this.#contacts.value.filter((c) => c.onDevice));
  readonly countsByType = computed(() => {
    const out = { chat: 0, repeater: 0, room: 0, sensor: 0 };
    for (const c of this.#contacts.value) out[contactTypeName(c.type)]++;
    return out;
  });

  /** Every contact as a view, unsorted (name order). */
  readonly views: ReadonlySignal<readonly ContactView[]> = computed(() => {
    const last = this.#last.value;
    const snr = this.#lastSnr.value;
    return this.#contacts.value.map((c): ContactView => {
      const lm = last.get(c.key);
      const fromMsg = snr.get(c.key);
      const direct =
        c.directSnr !== undefined && (!fromMsg || (c.directSnrAt ?? 0) >= fromMsg.at)
          ? { snr: c.directSnr, at: c.directSnrAt ?? 0 }
          : fromMsg;
      return {
        key: c.key,
        record: c,
        name: c.name || toHex(c.pubKey.subarray(0, 6)),
        typeName: contactTypeName(c.type),
        lastSeen: c.lastSeen,
        lastMessage: lm,
        lastActivity: lm?.receivedAt ?? 0,
        unread: c.type === ContactType.REPEATER ? 0 : c.unreadCount,
        path: pathDisplay(c.outPathLen),
        directSnr: direct?.snr,
        directSnrAt: direct?.at ?? 0,
        lastSnr: direct?.snr,
        favourite: c.favourite || (c.flags & ContactFlag.FAVOURITE) !== 0,
        onDevice: c.onDevice,
      };
    });
  });

  /** Filtered by type / search and sorted. */
  readonly visible: ReadonlySignal<readonly ContactView[]> = computed(() => {
    const filter = this.#filter.value;
    const q = this.#search.value.trim().toLowerCase();
    const sort = this.#sort.value;
    const out = this.views.value.filter((v) => {
      if (filter === 'favourites' && !v.favourite) return false;
      if (filter === 'unread' && v.unread === 0) return false;
      if (filter !== 'all' && filter !== 'favourites' && filter !== 'unread' && v.typeName !== filter) return false;
      if (q && !v.name.toLowerCase().includes(q) && !v.key.startsWith(q)) return false;
      return true;
    });
    const byName = (a: ContactView, b: ContactView): number =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key);
    if (sort === 'name') return out.sort(byName);
    return out.sort((a, b) => Math.max(b.lastActivity, b.lastSeen) - Math.max(a.lastActivity, a.lastSeen) || byName(a, b));
  });

  setSort(s: ContactSort): void {
    this.#sort.value = s;
  }

  setFilter(f: ContactFilter): void {
    this.#filter.value = f;
  }

  setSearch(q: string): void {
    this.#search.value = q;
  }

  find(key: string): ContactRecord | undefined {
    const k = key.toLowerCase();
    return this.#contacts.peek().find((c) => c.key === k);
  }

  /** The view of one contact (tracked). */
  view(key: string): ContactView | undefined {
    const k = key.toLowerCase();
    return this.views.value.find((v) => v.key === k);
  }

  /** Where a message sender name links to: one contact, a name search, or nowhere (tracked). */
  senderTarget(name: string | undefined): SenderTarget {
    return resolveSenderName(name, this.views.value);
  }

  /** Opens the list searched for `name` (all types), e.g. for an ambiguous sender name. */
  showByName(name: string): void {
    this.#filter.value = 'all';
    this.#search.value = name;
  }

  /** Resolves path hop hashes to known contacts (tracked; see {@link resolvePath}). */
  resolvePath(hashes: Uint8Array | readonly number[] | readonly (string | Uint8Array)[], opts: ResolvePathOptions = {}): ResolvedHop[] {
    return resolvePath(hashes, this.#contacts.value, opts);
  }

  /**
   * Label for a path: the hop-count `countLabel`, or with `names` the "Alice > Bob" chain when
   * the path bytes are known (issue #3).
   */
  pathLabel(o: { pathLen: number; path?: Uint8Array | undefined; countLabel: string }, names: boolean): PathLabel {
    return pathLabel(o, this.#contacts.value, { names });
  }

  /** Label for a contact's stored out path (flood / direct / N hops, or the name chain). */
  outPathLabel(v: Pick<ContactView, 'record' | 'path'>, names: boolean): PathLabel {
    return this.pathLabel({ pathLen: v.record.outPathLen, path: v.record.outPath, countLabel: v.path.label }, names);
  }

  protected override bind(store: RadioStore) {
    const offs = [
      store.events.on('contact', () => void this.reload()),
      store.events.on('message', (e) => {
        if (e.type === 'delete') return void this.reload();
        const r = e.record;
        if (r.convType !== 'contact') return;
        this.#last.update((m) => {
          const prev = m.get(r.convKey);
          if (prev && prev.id !== r.id && prev.receivedAt > r.receivedAt) return m;
          return new Map(m).set(r.convKey, r);
        });
        if (isDirectSnrMessage(r)) this.#lastSnr.update((m) => new Map(m).set(r.convKey, { snr: r.snr!, at: r.receivedAt }));
      }),
    ];
    return () => offs.forEach((off) => off());
  }

  protected async load(store: RadioStore): Promise<void> {
    const contacts = await store.contacts.list();
    const keys = contacts.map((c) => c.key);
    const last = await store.messages.lastMessages(keys);
    const snr = new Map<string, { snr: number; at: number }>();
    for (const c of contacts) {
      if (c.directSnr !== undefined) continue;
      const lm = last.get(c.key);
      let m = lm && isDirectSnrMessage(lm) ? lm : undefined;
      if (!m) m = (await store.messages.list(c.key, { limit: 10 })).items.find(isDirectSnrMessage);
      if (m?.snr !== undefined) snr.set(c.key, { snr: m.snr, at: m.receivedAt });
    }
    this.#contacts.value = contacts;
    this.#last.value = last;
    this.#lastSnr.value = snr;
  }

  protected reset(): void {
    this.#contacts.value = [];
    this.#last.value = new Map();
    this.#lastSnr.value = new Map();
  }

  // ---- device actions ----

  #client() {
    const client = this.connection.client.peek();
    if (!client?.connected) throw new Error('Not connected');
    return client;
  }

  /** Waits until the capture pipeline has persisted everything and the list has reloaded. */
  async #persisted(): Promise<void> {
    await this.connection.capture?.idle();
    await this.reload();
  }

  /** Full contact sync from the device. */
  async refresh(): Promise<void> {
    await this.#client().syncContacts({ full: true });
    await this.#persisted();
  }

  /**
   * Adds a contact from a pasted share (`meshcore://…`, advert hex) or a bare public key.
   * Resolves with the stored record.
   */
  async add(input: string | ContactShare, opts: AddContactOptions = {}): Promise<ContactRecord> {
    const share = typeof input === 'string' ? parseContactShare(input) : input;
    const client = this.#client();
    const key = toHex(share.pubKey);
    if (share.kind === 'pubKey') {
      await client.addOrUpdateContact({
        pubKey: share.pubKey,
        type: opts.type ?? ContactType.CHAT,
        flags: 0,
        outPathLen: PATH_LEN_UNKNOWN,
        name: opts.name?.trim() || key.slice(0, 12),
        lastAdvert: 0,
      });
    } else {
      // IMPORT_CONTACT: the device processes the advert like a received one and pushes ADVERT,
      // which makes the client re-read the contact. Wait for that, then read it ourselves.
      const seen = new Promise<boolean>((resolve) => {
        const timer = client.clock.setTimeout(() => {
          off();
          resolve(false);
        }, opts.timeoutMs ?? 3000);
        const off = client.events.on('contactsChanged', (e) => {
          if (e.updated.some((c) => toHex(c.pubKey) === key)) {
            client.clock.clearTimeout(timer);
            off();
            resolve(true);
          }
        });
      });
      await client.importContact(share.packet);
      if (!(await seen) && !(await client.refreshContact(share.pubKey))) {
        throw new Error('The radio did not add the contact (manual-add mode or invalid advert?)');
      }
    }
    await this.#persisted();
    const rec = await this.store?.contacts.get(key);
    if (!rec) throw new Error('Contact was not stored');
    return rec;
  }

  /** Removes from the device and deletes the contact (and, by default, its messages) locally. */
  async remove(key: string, opts: { keepMessages?: boolean } = {}): Promise<void> {
    const store = this.store;
    if (!store) throw new Error('Not connected');
    const rec = await store.contacts.get(key);
    const client = this.connection.client.peek();
    if (rec?.onDevice && client?.connected) await client.removeContact(rec.pubKey);
    await this.connection.capture?.idle();
    await store.contacts.delete(key);
    if (!opts.keepMessages) await store.messages.deleteConversation(key);
    await this.reload();
  }

  /** RESET_PATH: the next message floods and a new path is learnt. */
  async resetPath(key: string): Promise<void> {
    await this.#client().resetPath(fromHex(key));
    await this.#persisted();
  }

  /** SHARE_CONTACT: re-broadcasts the contact's advert zero-hop. */
  async share(key: string): Promise<void> {
    await this.#client().shareContact(fromHex(key));
  }

  /** EXPORT_CONTACT as hex and `meshcore://` URL; no key = this radio's own advert. */
  async export(key?: string): Promise<ContactExport> {
    const client = this.#client();
    const packet = key ? await client.exportContact(fromHex(key)) : await client.exportContact();
    return { packet, hex: toHex(packet), url: contactShareUrl(packet) };
  }

  /** Alias of {@link add} for a pasted share string. */
  import(share: string): Promise<ContactRecord> {
    return this.add(share);
  }

  /** Local favourite flag. */
  async setFavourite(key: string, favourite: boolean): Promise<void> {
    await this.store?.contacts.updateLocal(key, { favourite });
  }

  /** Local SMAZ compression setting for outgoing DMs (MeshCore Open compatible). */
  async setSmaz(key: string, smaz: boolean): Promise<void> {
    await this.store?.contacts.updateLocal(key, { smaz });
  }

  /** Re-reads one contact from the device (path / advert changes). */
  async refreshOne(key: string): Promise<Contact | undefined> {
    const c = await this.#client().refreshContact(fromHex(key));
    await this.#persisted();
    return c;
  }
}
