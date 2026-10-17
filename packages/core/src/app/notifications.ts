/** Toasts and error surface for the UI (framework-agnostic). */

import { systemClock, type Clock } from '../util/clock.js';
import { signal, type ReadonlySignal } from './signal.js';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Optional detail line (e.g. an error's cause). */
  detail?: string;
  /** Epoch ms. */
  createdAt: number;
  /** Auto-dismiss delay; 0 = sticky. */
  timeoutMs: number;
}

export interface NotifyInput {
  kind?: ToastKind;
  message: string;
  detail?: string;
  /** Default 5000 ms (info/success), 8000 ms (warning), 0 = sticky (error). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT: Record<ToastKind, number> = { info: 5000, success: 5000, warning: 8000, error: 0 };

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

export class NotificationsModel {
  readonly #toasts = signal<readonly Toast[]>([]);
  readonly toasts: ReadonlySignal<readonly Toast[]> = this.#toasts.readonly;
  readonly #timers = new Map<number, unknown>();
  #seq = 0;

  /** At most this many toasts are kept; the oldest are dropped. */
  constructor(
    private readonly clock: Clock = systemClock,
    readonly maxToasts = 5,
  ) {}

  notify(input: NotifyInput): Toast {
    const kind = input.kind ?? 'info';
    const toast: Toast = {
      id: ++this.#seq,
      kind,
      message: input.message,
      createdAt: this.clock.now(),
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT[kind],
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    };
    const next = [...this.#toasts.peek(), toast];
    for (const dropped of next.splice(0, Math.max(0, next.length - this.maxToasts))) this.#clearTimer(dropped.id);
    this.#toasts.value = next;
    if (toast.timeoutMs > 0) this.#timers.set(toast.id, this.clock.setTimeout(() => this.dismiss(toast.id), toast.timeoutMs));
    return toast;
  }

  info(message: string, detail?: string): Toast {
    return this.notify({ kind: 'info', message, ...(detail !== undefined ? { detail } : {}) });
  }

  success(message: string, detail?: string): Toast {
    return this.notify({ kind: 'success', message, ...(detail !== undefined ? { detail } : {}) });
  }

  warning(message: string, detail?: string): Toast {
    return this.notify({ kind: 'warning', message, ...(detail !== undefined ? { detail } : {}) });
  }

  /** An error toast; `err` (if given) becomes the detail line. */
  error(message: string, err?: unknown): Toast {
    return this.notify({ kind: 'error', message, ...(err !== undefined ? { detail: errorMessage(err) } : {}) });
  }

  dismiss(id: number): void {
    this.#clearTimer(id);
    const cur = this.#toasts.peek();
    if (cur.some((t) => t.id === id)) this.#toasts.value = cur.filter((t) => t.id !== id);
  }

  clear(): void {
    for (const id of [...this.#timers.keys()]) this.#clearTimer(id);
    this.#toasts.value = [];
  }

  #clearTimer(id: number): void {
    const h = this.#timers.get(id);
    if (h !== undefined) this.clock.clearTimeout(h);
    this.#timers.delete(id);
  }
}
