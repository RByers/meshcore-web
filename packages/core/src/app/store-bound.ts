/** Base class for feature models whose state comes from the connected radio's RadioStore. */

import type { RadioStore } from '../store/radio-store.js';
import type { Unsubscribe } from '../util/events.js';
import type { ConnectionModel } from './connection.js';
import { effect, signal, untracked, type ReadonlySignal } from './signal.js';

/**
 * Subclasses implement `bind(store)`: load initial state, subscribe to `store.events`, and return
 * a cleanup. `bind` runs whenever a radio's store opens; the cleanup runs (and `reset()` is
 * called) when it closes, so the model is empty while disconnected. `reload()` is coalesced:
 * many store events in one tick cause one reload.
 */
export abstract class StoreBoundModel {
  readonly #loading = signal(false);
  /** True while the first load after a store opened is in progress. */
  readonly loading: ReadonlySignal<boolean> = this.#loading.readonly;
  #dispose: Unsubscribe | undefined;
  #store: RadioStore | null = null;
  #reloadQueued = false;
  #lastReload: Promise<void> = Promise.resolve();

  constructor(protected readonly connection: ConnectionModel) {}

  /** Starts following the connection's store. Called by AppModel right after construction. */
  start(): this {
    if (this.#dispose) return this;
    this.#dispose = effect(() => {
      const store = this.connection.store.value;
      this.#store = store;
      if (!store) return;
      const off = untracked(() => {
        const cleanup = this.bind(store);
        this.#loading.value = true;
        this.#lastReload = this.load(store)
          .catch((err: unknown) => this.onError(err))
          .finally(() => {
            if (this.#store === store) this.#loading.value = false;
          });
        return cleanup;
      });
      return () => {
        off?.();
        this.#store = null;
        this.reset();
      };
    });
    return this;
  }

  /** The store currently bound (null while disconnected). */
  protected get store(): RadioStore | null {
    return this.#store;
  }

  /** Subscribe to store events here; return a cleanup. */
  protected bind(_store: RadioStore): Unsubscribe | void {
    return undefined;
  }

  /** (Re)loads the model's state from the store. */
  protected abstract load(store: RadioStore): Promise<void>;

  /** Clears state when the store closes. */
  protected abstract reset(): void;

  protected onError(err: unknown): void {
    console.error(`${this.constructor.name}:`, err);
  }

  /** Schedules a coalesced `load()` of the current store. Resolves when it has run. */
  reload(): Promise<void> {
    const store = this.#store;
    if (!store) return Promise.resolve();
    if (this.#reloadQueued) return this.#lastReload;
    this.#reloadQueued = true;
    this.#lastReload = this.#lastReload
      .then(() => new Promise<void>((r) => queueMicrotask(r)))
      .then(async () => {
        this.#reloadQueued = false;
        if (this.#store === store) await this.load(store);
      })
      .catch((err: unknown) => this.onError(err));
    return this.#lastReload;
  }

  /** Resolves when the pending load / reload has finished. */
  settled(): Promise<void> {
    return this.#lastReload;
  }

  dispose(): void {
    this.#dispose?.();
    this.#dispose = undefined;
  }
}
