/**
 * Live tail of the frame and packet logs (Phase 9 adds filters, paging, inspector selection,
 * export/import).
 */

import type { RadioStore } from '../store/radio-store.js';
import type { FrameRecord, PacketRecord } from '../store/schema.js';
import { StoreBoundModel } from './store-bound.js';
import type { ConnectionModel } from './connection.js';
import { signal, type ReadonlySignal } from './signal.js';

export class PacketLogModel extends StoreBoundModel {
  readonly #frames = signal<readonly FrameRecord[]>([]);
  readonly #packets = signal<readonly PacketRecord[]>([]);
  /** Most recent frames, oldest first, at most `tailSize`. */
  readonly frames: ReadonlySignal<readonly FrameRecord[]> = this.#frames.readonly;
  readonly packets: ReadonlySignal<readonly PacketRecord[]> = this.#packets.readonly;

  constructor(
    connection: ConnectionModel,
    readonly tailSize = 200,
  ) {
    super(connection);
  }

  protected override bind(store: RadioStore) {
    const offs = [
      store.events.on('frame', (r) => this.#frames.update((xs) => [...xs, r].slice(-this.tailSize))),
      store.events.on('packet', (r) => this.#packets.update((xs) => [...xs, r].slice(-this.tailSize))),
      store.events.on('logChanged', () => void this.reload()),
    ];
    return () => offs.forEach((off) => off());
  }

  protected async load(store: RadioStore): Promise<void> {
    const byTs = (a: { ts: number; id: number }, b: { ts: number; id: number }) => a.ts - b.ts || a.id - b.id;
    this.#frames.value = (await store.frames.latest(this.tailSize)).sort(byTs);
    this.#packets.value = (await store.packets.latest(this.tailSize)).sort(byTs);
  }

  protected reset(): void {
    this.#frames.value = [];
    this.#packets.value = [];
  }
}
