/**
 * App-level error boundary: uncaught errors (`error`) and unhandled promise rejections
 * (`unhandledrejection`) on `window` become an error toast plus a `console.error`. Repeats of
 * the same message within `dedupeMs` are logged but not toasted again.
 */
import { errorMessage, type NotificationsModel } from '@meshcore-web/core/app';

/** Browser noise that is not an app failure. */
const IGNORED = [/ResizeObserver loop/i];

export interface ErrorBoundaryOptions {
  dedupeMs?: number;
  now?: () => number;
}

export function installErrorBoundary(
  target: EventTarget,
  notifications: NotificationsModel,
  { dedupeMs = 10_000, now = () => Date.now() }: ErrorBoundaryOptions = {},
): () => void {
  const lastShown = new Map<string, number>();

  const report = (kind: string, reason: unknown, fallback: string): void => {
    const message = reason !== undefined && reason !== null ? errorMessage(reason) : fallback;
    if (IGNORED.some((re) => re.test(message))) return;
    console.error(`[MeshCore Web] ${kind}:`, reason ?? fallback);
    const t = now();
    const prev = lastShown.get(message);
    if (prev !== undefined && t - prev < dedupeMs) return;
    lastShown.set(message, t);
    if (lastShown.size > 50) lastShown.delete(lastShown.keys().next().value as string);
    notifications.notify({ kind: 'error', message: 'Something went wrong', detail: message });
  };

  const onError = (e: Event): void => {
    const ev = e as ErrorEvent;
    report('Uncaught error', ev.error, ev.message || 'Unknown error');
  };
  const onRejection = (e: Event): void => {
    const ev = e as PromiseRejectionEvent;
    report('Unhandled rejection', ev.reason, 'Unhandled promise rejection');
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
