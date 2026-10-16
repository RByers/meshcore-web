/**
 * Contacts list (Phase 7 extends this: search/filter/sort, add/remove/share/reset path).
 * State comes from ContactsRepo; the capture pipeline keeps the repo in sync with the device.
 */

import { ContactType } from '../protocol/constants.js';
import type { RadioStore } from '../store/radio-store.js';
import type { ContactRecord } from '../store/schema.js';
import { StoreBoundModel } from './store-bound.js';
import { computed, signal, type ReadonlySignal } from './signal.js';

export class ContactsModel extends StoreBoundModel {
  readonly #contacts = signal<readonly ContactRecord[]>([]);
  /** All stored contacts of the connected radio, sorted by name. */
  readonly contacts: ReadonlySignal<readonly ContactRecord[]> = this.#contacts.readonly;
  /** Contacts currently on the device. */
  readonly onDevice = computed(() => this.#contacts.value.filter((c) => c.onDevice));
  readonly countsByType = computed(() => {
    const out = { chat: 0, repeater: 0, room: 0, sensor: 0 };
    for (const c of this.#contacts.value) {
      if (c.type === ContactType.REPEATER) out.repeater++;
      else if (c.type === ContactType.ROOM) out.room++;
      else if (c.type === ContactType.SENSOR) out.sensor++;
      else out.chat++;
    }
    return out;
  });

  find(key: string): ContactRecord | undefined {
    const k = key.toLowerCase();
    return this.#contacts.peek().find((c) => c.key === k);
  }

  protected override bind(store: RadioStore) {
    return store.events.on('contact', () => void this.reload());
  }

  protected async load(store: RadioStore): Promise<void> {
    this.#contacts.value = await store.contacts.list();
  }

  protected reset(): void {
    this.#contacts.value = [];
  }
}
