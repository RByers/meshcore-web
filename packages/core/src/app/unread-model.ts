/** Unread totals for nav badges, from the unread counts kept on contact / channel records. */

import type { RadioStore } from '../store/radio-store.js';
import { StoreBoundModel } from './store-bound.js';
import { signal, type ReadonlySignal } from './signal.js';

export interface UnreadTotals {
  contacts: number;
  channels: number;
  total: number;
}

const ZERO: UnreadTotals = { contacts: 0, channels: 0, total: 0 };

export class UnreadModel extends StoreBoundModel {
  readonly #totals = signal<UnreadTotals>(ZERO, {
    equals: (a, b) => a.contacts === b.contacts && a.channels === b.channels,
  });
  readonly totals: ReadonlySignal<UnreadTotals> = this.#totals.readonly;

  protected override bind(store: RadioStore) {
    const offs = [
      store.events.on('unread', () => void this.reload()),
      store.events.on('contact', () => void this.reload()),
      store.events.on('channel', () => void this.reload()),
    ];
    return () => offs.forEach((off) => off());
  }

  protected async load(store: RadioStore): Promise<void> {
    const t = await store.messages.totalUnread();
    // muted channels keep their own count but do not add to the badges
    let muted = 0;
    for (const c of await store.channels.list()) if (c.muted) muted += c.unread;
    this.#totals.value = { contacts: t.contacts, channels: t.channels - muted, total: t.total - muted };
  }

  protected reset(): void {
    this.#totals.value = ZERO;
  }
}
