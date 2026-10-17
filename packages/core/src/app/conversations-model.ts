/**
 * Recent conversations (DMs and channels) for the messages overview, newest first, with unread
 * counts and the last message.
 */

import type { RadioStore } from '../store/radio-store.js';
import type { ConversationType, MessageRecord } from '../store/schema.js';
import { ContactType } from '../protocol/constants.js';
import { StoreBoundModel } from './store-bound.js';
import { signal, type ReadonlySignal } from './signal.js';
import { contactTypeName, channelKind, type ChannelKind, type ContactKind } from './messaging.js';

export interface ConversationView {
  convType: ConversationType;
  key: string;
  name: string;
  /** Contact type for DMs, channel kind for channels. */
  icon: ContactKind | ChannelKind;
  unread: number;
  muted: boolean;
  lastMessage: MessageRecord | undefined;
  /** Epoch ms of the last message (0 = none). */
  lastActivity: number;
  /** Channel slot on the device (channels only). */
  onDevice: boolean;
}

export class ConversationsModel extends StoreBoundModel {
  readonly #items = signal<readonly ConversationView[]>([]);
  /**
   * Contacts and channels with at least one message or unread, newest message first (ties and
   * unread-only conversations by name).
   */
  readonly items: ReadonlySignal<readonly ConversationView[]> = this.#items.readonly;

  protected override bind(store: RadioStore) {
    const offs = [
      store.events.on('message', () => void this.reload()),
      store.events.on('unread', () => void this.reload()),
      store.events.on('contact', () => void this.reload()),
      store.events.on('channel', () => void this.reload()),
    ];
    return () => offs.forEach((off) => off());
  }

  protected async load(store: RadioStore): Promise<void> {
    const [contacts, channels] = await Promise.all([store.contacts.list(), store.channels.list()]);
    const last = await store.messages.lastMessages([...contacts.map((c) => c.key), ...channels.map((c) => c.key)]);
    const out: ConversationView[] = [];
    for (const c of contacts) {
      const lm = last.get(c.key);
      const unread = c.type === ContactType.REPEATER ? 0 : c.unreadCount;
      if (!lm && unread === 0) continue;
      out.push({
        convType: 'contact',
        key: c.key,
        name: c.name || c.key.slice(0, 12),
        icon: contactTypeName(c.type),
        unread,
        muted: c.muted,
        lastMessage: lm,
        lastActivity: lm?.receivedAt ?? 0,
        onDevice: c.onDevice,
      });
    }
    for (const ch of channels) {
      const lm = last.get(ch.key);
      if (!lm && ch.unread === 0) continue;
      out.push({
        convType: 'channel',
        key: ch.key,
        name: ch.name,
        icon: channelKind(ch.name, ch.psk),
        unread: ch.unread,
        muted: ch.muted,
        lastMessage: lm,
        lastActivity: lm?.receivedAt ?? 0,
        onDevice: ch.deviceIndex !== null,
      });
    }
    out.sort((a, b) => b.lastActivity - a.lastActivity || a.name.localeCompare(b.name));
    this.#items.value = out;
  }

  protected reset(): void {
    this.#items.value = [];
  }
}
