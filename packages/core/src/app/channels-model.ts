/** Channel list (Phase 8 extends this: add/edit/delete, hashtag channels, muting). */

import type { RadioStore } from '../store/radio-store.js';
import type { ChannelRecord } from '../store/schema.js';
import { StoreBoundModel } from './store-bound.js';
import { computed, signal, type ReadonlySignal } from './signal.js';

export class ChannelsModel extends StoreBoundModel {
  readonly #channels = signal<readonly ChannelRecord[]>([]);
  /** Stored channels: loaded on the device first (by slot), then the rest by name. */
  readonly channels: ReadonlySignal<readonly ChannelRecord[]> = this.#channels.readonly;
  readonly onDevice = computed(() => this.#channels.value.filter((c) => c.deviceIndex !== null));

  find(key: string): ChannelRecord | undefined {
    const k = key.toLowerCase();
    return this.#channels.peek().find((c) => c.key === k);
  }

  protected override bind(store: RadioStore) {
    return store.events.on('channel', () => void this.reload());
  }

  protected async load(store: RadioStore): Promise<void> {
    this.#channels.value = await store.channels.list();
  }

  protected reset(): void {
    this.#channels.value = [];
  }
}
