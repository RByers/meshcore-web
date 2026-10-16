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
    this.#totals.value = await store.messages.totalUnread();
  }

  protected reset(): void {
    this.#totals.value = ZERO;
  }
}
