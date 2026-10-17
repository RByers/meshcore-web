/** Formatting helpers for the packet log pages and the inputs of `<mc-packet-inspector>`. */
import { html } from 'lit';
import { NO_BYTES_MEANING, type FrameInspection, type PacketInspection, type ResolvedHop } from '@meshcore-web/core/app';
import type { Annotation } from '@meshcore-web/core/packet';
import { toHex } from '@meshcore-web/core/util/bytes';
import type { InspectorMeta } from './packet-inspector.js';
import { hopsLink } from '../../components/path-dialog.js';
import { pathHops } from '../../components/node-link.js';

/** "14:05:09.123" (local), with the date when not today. */
export function formatLogTime(ts: number, now: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return new Date(now).toDateString() === d.toDateString() ? t : `${d.toLocaleDateString()} ${t}`;
}

/** Value for a `datetime-local` input (local time, minutes). */
export function toDatetimeLocal(ts: number | undefined): string {
  if (ts === undefined) return '';
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function fromDatetimeLocal(v: string): number | undefined {
  if (!v) return undefined;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? undefined : t;
}

export interface InspectorProps {
  heading: string;
  meta: InspectorMeta[];
  bytes: Uint8Array;
  annotation: Annotation;
  json: unknown;
}

/** Resolves path hop hashes to known contacts (so hops link to their contact pages). */
export type HopResolver = (hashes: readonly string[]) => readonly ResolvedHop[];

export function packetInspectorProps(ins: PacketInspection, resolve?: HopResolver): InspectorProps {
  const r = ins.record;
  const meta: InspectorMeta[] = [
    { label: 'Time', value: new Date(r.ts).toISOString() },
    { label: 'Direction', value: r.direction === 'rx' ? '↓ rx (heard by the radio)' : '↑ tx (sent by the radio at this app\'s request)' },
    { label: 'Type', value: `${ins.view.typeName}${ins.view.routeName ? ` · ${ins.view.routeName}` : ''}` },
    { label: 'Summary', value: ins.summary },
  ];
  if (ins.view.path.length) {
    const n = ins.view.path.length;
    const hops = resolve?.(ins.view.path);
    const label = `(${n} ${n === 1 ? 'hop' : 'hops'})`;
    meta.push({
      label: 'Path',
      value: hops
        ? html`${pathHops(hops, { names: false, sep: ' → ' })} ${hopsLink(label, { kind: 'packet', id: r.id })}`
        : hopsLink(`${ins.view.path.join(' → ')} ${label}`, { kind: 'packet', id: r.id }),
    });
  }
  if (r.snr !== undefined) meta.push({ label: 'SNR', value: `${r.snr} dB` });
  if (r.rssi !== undefined) meta.push({ label: 'RSSI', value: `${r.rssi} dBm` });
  if (r.format === 'none') meta.push({ label: 'Bytes', value: `none: ${NO_BYTES_MEANING}` });
  else meta.push({ label: 'Size', value: `${r.bytes.length} B${r.format === 'payload' ? ' (payload only)' : ''}` });
  if (r.hash) meta.push({ label: 'Packet hash', value: `${r.hash}${ins.copies > 1 ? ` (${ins.copies} copies logged)` : ''}` });
  meta.push({ label: 'Source', value: r.source + (ins.sourceFrame ? ` · frame #${ins.sourceFrame.id} (${ins.sourceFrame.kind})` : '') });
  return {
    heading: `Packet #${r.id}`,
    meta,
    bytes: r.bytes,
    annotation: ins.annotation,
    json: { ...r, bytes: toHex(r.bytes), summary: ins.summary, annotation: ins.annotation },
  };
}

export function frameInspectorProps(ins: FrameInspection): InspectorProps {
  const r = ins.record;
  const meta: InspectorMeta[] = [
    { label: 'Time', value: new Date(r.ts).toISOString() },
    { label: 'Direction', value: r.direction === 'out' ? 'host → device' : 'device → host' },
    { label: 'Code', value: `0x${r.code.toString(16).padStart(2, '0')} ${ins.name}` },
    { label: 'Size', value: `${r.size} B` },
  ];
  if (ins.decodeError) meta.push({ label: 'Decode', value: ins.decodeError });
  if (ins.packetId !== undefined) meta.push({ label: 'Packet', value: `#${ins.packetId}` });
  return {
    heading: `Frame #${r.id} · ${ins.name}`,
    meta,
    bytes: r.bytes,
    annotation: ins.annotation,
    json: { ...r, bytes: toHex(r.bytes), name: ins.name, decoded: ins.decoded, annotation: ins.annotation },
  };
}
