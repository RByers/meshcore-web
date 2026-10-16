/**
 * One conversation (DM or channel). Phase 7/8 add sending (with retry/status), reactions,
 * replies. Messages are kept oldest → newest; `loadOlder()` pages back in history.
 */

import type { RadioStore } from '../store/radio-store.js';
import type { ConversationType, MessageRecord } from '../store/schema.js';
import { StoreBoundModel } from './store-bound.js';
import type { ConnectionModel } from './connection.js';
import { signal, type ReadonlySignal } from './signal.js';

export class ChatModel extends StoreBoundModel {
  readonly #messages = signal<readonly MessageRecord[]>([]);
  readonly #hasMore = signal(false);
  readonly #unread = signal(0);
  /** Loaded messages, oldest first. */
  readonly messages: ReadonlySignal<readonly MessageRecord[]> = this.#messages.readonly;
  readonly hasMore: ReadonlySignal<boolean> = this.#hasMore.readonly;
  readonly unread: ReadonlySignal<number> = this.#unread.readonly;

  constructor(
    connection: ConnectionModel,
    readonly convType: ConversationType,
    readonly convKey: string,
    readonly pageSize = 50,
  ) {
    super(connection);
  }

  protected override bind(store: RadioStore) {
    const key = this.convKey.toLowerCase();
    const offs = [
      store.events.on('message', (e) => {
        if (e.type === 'delete') {
          if (e.convKey === key) this.#messages.update((ms) => ms.filter((m) => m.id !== e.id));
          return;
        }
        const r = e.record;
        if (r.convKey !== key) return;
        if (e.type === 'add') this.#messages.update((ms) => [...ms, r]);
        else this.#messages.update((ms) => ms.map((m) => (m.id === r.id ? r : m)));
      }),
      store.events.on('unread', (e) => {
        if (e.convKey === key && e.convType === this.convType) this.#unread.value = e.count;
      }),
    ];
    return () => offs.forEach((off) => off());
  }

  protected async load(store: RadioStore): Promise<void> {
    const page = await store.messages.list(this.convKey, { limit: this.pageSize });
    this.#messages.value = [...page.items].reverse();
    this.#hasMore.value = page.hasMore;
    this.#unread.value = await store.messages.unreadCount(this.convType, this.convKey);
  }

  protected reset(): void {
    this.#messages.value = [];
    this.#hasMore.value = false;
    this.#unread.value = 0;
  }

  /** Prepends the next older page. */
  async loadOlder(): Promise<void> {
    const store = this.store;
    const oldest = this.#messages.peek()[0];
    if (!store || !oldest) return;
    const page = await store.messages.list(this.convKey, { limit: this.pageSize, before: oldest });
    this.#messages.update((ms) => [...[...page.items].reverse(), ...ms]);
    this.#hasMore.value = page.hasMore;
  }

  /** Opening the conversation: resets its unread count. */
  async markRead(): Promise<void> {
    await this.store?.messages.markRead(this.convType, this.convKey);
  }
}
