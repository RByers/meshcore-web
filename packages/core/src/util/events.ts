/** A tiny strongly-typed event emitter (no DOM dependency). */

export type Listener<T> = (payload: T) => void;
export type Unsubscribe = () => void;

/**
 * `Events` maps event names to payload types, e.g. `TypedEmitter<{ frame: Uint8Array }>`.
 *
 * Registering the same function twice for one event has no extra effect (set semantics).
 * Listeners are called synchronously in registration order on a snapshot of the listener
 * list, so adding/removing listeners during `emit` affects only later emits. If a listener
 * throws, the remaining listeners still run and the first error is re-thrown afterwards.
 */
export class TypedEmitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    const entry = listener as Listener<never>;
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  /** Removes `listener` (or every listener for `event` if omitted). */
  off<K extends keyof Events>(event: K, listener?: Listener<Events[K]>): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    if (listener) set.delete(listener as Listener<never>);
    else set.clear();
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return;
    let firstError: unknown;
    let failed = false;
    for (const entry of [...set]) {
      try {
        (entry as Listener<Events[K]>)(payload);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
      }
    }
    if (failed) throw firstError;
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  removeAllListeners(): void {
    this.#listeners.clear();
  }
}
