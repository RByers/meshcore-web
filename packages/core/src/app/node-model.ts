/**
 * The node page (`/node/:key[/:tab]`): resolves a node reference — a full public key, a key
 * prefix or a bare 1-byte path hash — to a stored contact, a node only heard advertising (from
 * the packet log), several candidates, or nothing, and decides which tabs the page shows.
 * Add / remove contact act on the resolved identity; the identity follows the contacts list and
 * the packet log, so adding or removing flips it without a reload.
 */

import type { ContactRecord } from '../store/schema.js';
import type { ConnectionModel } from './connection.js';
import type { ContactsModel, ContactView, RemoveOptions } from './contacts-model.js';
import type { ContactKind } from './messaging.js';
import { heardNodesIn, type HeardNode, type PacketLogModel } from './packet-log-model.js';
import { computed, effect, signal, type ReadonlySignal } from './signal.js';

export type NodeTab = 'info' | 'messages' | 'path' | 'overview' | 'telemetry' | 'cli' | 'tools' | 'stats';

/** Every tab, in display order. */
export const NODE_TAB_ORDER: readonly NodeTab[] = ['info', 'messages', 'path', 'overview', 'telemetry', 'cli', 'tools', 'stats'];

export type NodeIdentity =
  /** Exactly one stored contact's key starts with the reference. */
  | { kind: 'contact'; key: string; contact: ContactView }
  /** No contact matches, but exactly one node was heard advertising with that key (prefix). */
  | { kind: 'heard'; key: string; heard: HeardNode }
  /** Several contacts, or (no contact and) several heard nodes, share the prefix. */
  | { kind: 'ambiguous'; ref: string; contacts: readonly ContactView[]; heard: readonly HeardNode[] }
  /** Nothing known. `valid` is false when `ref` is not even-length hex of 1..32 bytes. */
  | { kind: 'unknown'; ref: string; valid: boolean };

/** One node a reference may name: a stored contact, or a node only heard advertising. */
export interface NodeCandidate {
  /** Full public key hex. */
  key: string;
  /** Contact / advertised name ('' when a heard advert has none). */
  name: string;
  typeName: ContactKind;
  /** Only heard advertising (not a stored contact). */
  heard: boolean;
  /** The contact's local note ('' for heard nodes). */
  note: string;
}

/**
 * The contacts, then the heard nodes that aren't contacts, as one candidate list (the node page's
 * "N nodes match" and the `/nodes/:prefix` listing).
 */
export function nodeCandidates(contacts: readonly ContactView[], heard: readonly HeardNode[]): NodeCandidate[] {
  const keys = new Set(contacts.map((v) => v.key));
  return [
    ...contacts.map((v) => ({ key: v.key, name: v.name, typeName: v.typeName, heard: false, note: v.note })),
    ...heard
      .filter((h) => !keys.has(h.key))
      .map((h) => ({ key: h.key, name: h.name, typeName: h.typeName, heard: true, note: '' })),
  ];
}

export interface NodeModelOptions {
  /**
   * Listing mode (`/nodes/:prefix`): always look the reference up in the packet log, so
   * {@link NodeModel.candidates} lists every match even when exactly one contact has the prefix.
   */
  list?: boolean;
}

/** Lowercase hex of 1..32 whole bytes, or null. */
export function normalizeNodeRef(ref: string): string | null {
  const n = ref.trim().toLowerCase();
  return /^(?:[0-9a-f]{2}){1,32}$/.test(n) ? n : null;
}

/** Contacts whose public key starts with `ref` (normalised; none for an invalid ref). */
export function resolveContactRef(ref: string, views: readonly ContactView[]): ContactView[] {
  const n = normalizeNodeRef(ref);
  return n ? views.filter((v) => v.key.startsWith(n)) : [];
}

const CONTACT_TABS: Record<ContactKind, readonly NodeTab[]> = {
  chat: ['info', 'messages', 'path', 'stats'],
  room: ['info', 'messages', 'path', 'overview', 'telemetry', 'cli', 'tools', 'stats'],
  repeater: ['info', 'messages', 'path', 'overview', 'telemetry', 'cli', 'tools', 'stats'],
  sensor: ['info', 'messages', 'path', 'overview', 'telemetry', 'cli', 'tools', 'stats'],
};

/** The tabs shown for an identity (null = still resolving: Info only). */
export function nodeTabs(id: NodeIdentity | null): readonly NodeTab[] {
  if (!id) return ['info'];
  switch (id.kind) {
    case 'contact':
      return CONTACT_TABS[id.contact.typeName];
    case 'heard':
      return ['info', 'stats'];
    default:
      return ['info'];
  }
}

/** The tab to show: `requested` when the identity has it, else 'info'. */
export function nodeTabFor(id: NodeIdentity | null, requested?: string): NodeTab {
  const tabs = nodeTabs(id);
  return tabs.find((t) => t === requested) ?? 'info';
}

/**
 * The tab a contacts-list click opens: the conversation for chat and room nodes, else Info.
 * (A Messages-list click always opens Messages: the user picked a conversation.)
 */
export function entryTab(kind: ContactKind): NodeTab {
  return kind === 'chat' || kind === 'room' ? 'messages' : 'info';
}

export interface NodeModelDeps {
  connection: ConnectionModel;
  contacts: ContactsModel;
  packetLog: PacketLogModel;
}

export class NodeModel {
  /** The normalised reference (lowercase; kept as given, trimmed, when invalid). */
  readonly ref: string;
  readonly #valid: boolean;
  readonly #deps: NodeModelDeps;
  /** Heard nodes for `ref` from the packet log; null until looked up (or after the store closed). */
  readonly #heard = signal<readonly HeardNode[] | null>(null);
  #lookup: Promise<void> = Promise.resolve();
  #gen = 0;
  readonly #off: () => void;
  readonly #disposed = signal(false);

  /** Stored contacts matching `ref`. */
  readonly #matches: ReadonlySignal<readonly ContactView[]>;

  /** What `ref` names; null while resolving (store closed, contacts loading, or the first heard lookup pending). */
  readonly identity: ReadonlySignal<NodeIdentity | null>;
  /** {@link nodeTabs} of the identity. */
  readonly tabs: ReadonlySignal<readonly NodeTab[]>;
  /** A heard (non-contact) node while connected: it can be added from its advert. */
  readonly canAddContact: ReadonlySignal<boolean>;
  /** Listing mode ({@link NodeModelOptions.list}). */
  readonly list: boolean;
  /**
   * Every known node whose key starts with `ref` ({@link nodeCandidates}): the matching contacts
   * and, once looked up, the matching heard nodes. Null while resolving. Without listing mode the
   * packet log isn't consulted while exactly one contact matches, so that contact is all it lists.
   */
  readonly candidates: ReadonlySignal<readonly NodeCandidate[] | null>;

  constructor(ref: string, deps: NodeModelDeps, opts: NodeModelOptions = {}) {
    const n = normalizeNodeRef(ref);
    this.ref = n ?? ref.trim().toLowerCase();
    this.#valid = n !== null;
    this.#deps = deps;
    this.list = opts.list ?? false;
    const { connection, contacts, packetLog } = deps;

    this.#matches = computed(() => (this.#valid ? contacts.views.value.filter((v) => v.key.startsWith(this.ref)) : []));

    // The last identity, so a heard lookup that starts once the contact is gone (after Remove)
    // keeps showing it instead of flashing "loading": contact → heard / unknown directly.
    let last: NodeIdentity | null = null;
    this.identity = computed((): NodeIdentity | null => (last = this.#resolve(last)));
    this.tabs = computed(() => nodeTabs(this.identity.value), { equals: (a, b) => a.length === b.length && a.every((t, i) => t === b[i]) });
    this.canAddContact = computed(() => this.identity.value?.kind === 'heard' && connection.phase.value === 'connected');
    this.candidates = computed(() => {
      if (!this.#valid) return [];
      if (!connection.store.value || contacts.loading.value) return null;
      const matches = this.#matches.value;
      const heard = this.#heard.value;
      if (heard === null) return !this.list && matches.length === 1 ? nodeCandidates(matches, []) : null;
      return nodeCandidates(matches, heard);
    });

    // Heard lookup: while no single contact matches, re-run whenever the packet log grows.
    this.#off = effect(() => {
      const store = connection.store.value;
      void packetLog.packets.total.value;
      if (!this.#valid) return;
      if (!store) {
        this.#gen++;
        this.#heard.value = null;
        return;
      }
      if (!this.list && this.#matches.value.length === 1) return;
      const gen = ++this.#gen;
      this.#lookup = this.#lookup
        .then(() => heardNodesIn(store, this.ref))
        .then((heard) => {
          if (gen === this.#gen) this.#heard.value = heard;
        })
        .catch((err: unknown) => console.error('NodeModel:', err));
    });
  }

  #resolve(last: NodeIdentity | null): NodeIdentity | null {
    const { connection, contacts } = this.#deps;
    if (!this.#valid) return { kind: 'unknown', ref: this.ref, valid: false };
    if (!connection.store.value || contacts.loading.value) return null;
    const matches = this.#matches.value;
    const first = matches[0];
    if (matches.length === 1 && first) return { kind: 'contact', key: first.key, contact: first };
    const heard = this.#heard.value;
    if (matches.length > 1) return { kind: 'ambiguous', ref: this.ref, contacts: matches, heard: heard ?? [] };
    if (heard === null) return last; // lookup pending: null on first load, else what was shown
    const one = heard[0];
    if (heard.length === 1 && one) return { kind: 'heard', key: one.key, heard: one };
    if (heard.length > 1) return { kind: 'ambiguous', ref: this.ref, contacts: [], heard };
    return { kind: 'unknown', ref: this.ref, valid: true };
  }

  /** Resolves once the contacts list, the packet log and any heard lookup have settled. */
  async settled(): Promise<void> {
    const { contacts, packetLog } = this.#deps;
    await Promise.all([contacts.settled(), packetLog.settled()]);
    let p: Promise<void>;
    do {
      p = this.#lookup;
      await p;
    } while (p !== this.#lookup);
  }

  /** Adds the heard node as a contact from its advert ({@link ContactsModel.addFromAdvert}). */
  async addContact(): Promise<ContactRecord> {
    const id = this.identity.peek();
    if (id?.kind !== 'heard') throw new Error('Not a heard node');
    const rec = await this.#deps.contacts.addFromAdvert(id.heard);
    await this.settled();
    return rec;
  }

  /** Removes the contact ({@link ContactsModel.remove}); the page then shows it as heard / unknown. */
  async removeContact(opts?: RemoveOptions): Promise<void> {
    const id = this.identity.peek();
    if (id?.kind !== 'contact') throw new Error('Not a contact');
    await this.#deps.contacts.remove(id.key, opts);
    await this.settled();
  }

  /**
   * True once disposed (evicted from `AppModel.node`'s cache): the heard lookup no longer follows
   * the packet log. A view reads it while rendering so eviction re-renders it, and the re-render
   * re-requests a fresh model with `app.node(ref)`.
   */
  get disposed(): ReadonlySignal<boolean> {
    return this.#disposed;
  }

  dispose(): void {
    if (this.#disposed.peek()) return;
    this.#off();
    this.#gen++;
    this.#disposed.value = true;
  }
}
