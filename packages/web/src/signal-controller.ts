/**
 * Re-renders a Lit element when any app-model signal read during its render changes.
 *
 *   class MyEl extends LitElement {
 *     readonly #signals = new SignalController(this);
 *     render() { return html`${app.connection.phase.value}`; } // tracked automatically
 *   }
 *
 * Tracking spans hostUpdate → hostUpdated, i.e. willUpdate + render. `watch(sig)` additionally
 * subscribes to a signal that is not read during render (e.g. one used only in `updated`).
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { Watcher, type ReadonlySignal } from '@meshcore-web/core/app';

export class SignalController implements ReactiveController {
  readonly #watcher: Watcher;
  readonly #extra = new Map<ReadonlySignal<unknown>, () => void>();
  #connected = false;

  constructor(private readonly host: ReactiveControllerHost) {
    this.#watcher = new Watcher(() => this.host.requestUpdate());
    host.addController(this);
  }

  /** Also re-render when `sig` changes, even if render does not read it. */
  watch<T>(sig: ReadonlySignal<T>): ReadonlySignal<T> {
    if (!this.#extra.has(sig)) {
      this.#extra.set(sig, () => undefined);
      if (this.#connected) this.#extra.set(sig, sig.subscribe(() => this.host.requestUpdate()));
    }
    return sig;
  }

  hostConnected(): void {
    this.#connected = true;
    for (const sig of this.#extra.keys()) this.#extra.set(sig, sig.subscribe(() => this.host.requestUpdate()));
    // signals may have changed while disconnected
    this.host.requestUpdate();
  }

  hostDisconnected(): void {
    this.#connected = false;
    this.#watcher.dispose();
    for (const [sig, off] of this.#extra) {
      off();
      this.#extra.set(sig, () => undefined);
    }
  }

  hostUpdate(): void {
    this.#watcher.begin();
  }

  hostUpdated(): void {
    this.#watcher.end();
    if (!this.#connected) this.#watcher.dispose();
  }
}
