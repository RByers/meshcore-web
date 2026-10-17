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

export function formatRelative(ts: number, now: number): string {
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

/** Clock time of an epoch-ms timestamp ("14:05"), with the date when not today. */
export function formatTime(ts: number, now: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString()} ${time}`;
}

/** "6.5 dB" */
export function formatSnr(snr: number): string {
  return `${Number.isInteger(snr) ? snr : snr.toFixed(2).replace(/0$/, '')} dB`;
}

/** "850 ms" / "1.2 s" / "12 min" / "3.5 h" / "2.1 d" */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${trim1(ms / 3_600_000)} h`;
  return `${trim1(ms / 86_400_000)} d`;
}

/** "512 B" / "1.2 KB" / "34 MB" / "1.1 GB" (1 KB = 1024 B). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? trim1(v) : Math.round(v)} ${units[i]}`;
}

function trim1(v: number): string {
  return v.toFixed(1).replace(/\.0$/, '');
}
