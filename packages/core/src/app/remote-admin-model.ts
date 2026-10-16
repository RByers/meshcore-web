/**
 * Repeater / room / sensor administration sessions (Phase 10: login, status, telemetry, CLI,
 * neighbours, trace). Holds per-node session state keyed by public key hex.
 */

import type { ConnectionModel } from './connection.js';
import { effect, signal, type ReadonlySignal } from './signal.js';

export interface RemoteSession {
  key: string;
  loggedIn: boolean;
  isAdmin: boolean;
  /** Epoch ms of the last successful login. */
  since: number;
}

export class RemoteAdminModel {
  readonly #sessions = signal<ReadonlyMap<string, RemoteSession>>(new Map());
  readonly sessions: ReadonlySignal<ReadonlyMap<string, RemoteSession>> = this.#sessions.readonly;
  readonly #dispose: () => void;

  constructor(private readonly connection: ConnectionModel) {
    // sessions end with the connection
    this.#dispose = effect(() => {
      if (!this.connection.connected.value) this.#sessions.value = new Map();
    });
  }

  session(key: string): RemoteSession | undefined {
    return this.#sessions.peek().get(key.toLowerCase());
  }

  dispose(): void {
    this.#dispose();
  }
}
