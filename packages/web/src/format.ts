/** Small display formatters shared by pages. */
import type { ConnectionPhase } from '@meshcore-web/core/app';

export const PHASE_LABEL: Record<ConnectionPhase, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  handshaking: 'Handshaking…',
  connected: 'Connected',
  disconnecting: 'Disconnecting…',
  disconnected: 'Disconnected',
  error: 'Connection failed',
};

/** First 8 hex chars + … (pubkey hex). */
export function shortKey(hex: string, n = 8): string {
  return hex.length > n ? `${hex.slice(0, n)}…` : hex;
}

export function formatRelative(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

/** Rough Li-ion state of charge from millivolts (3.0 V → 0 %, 4.2 V → 100 %). */
export function batteryPercent(mv: number): number {
  return Math.max(0, Math.min(100, Math.round(((mv - 3000) / 1200) * 100)));
}
