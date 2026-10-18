/** Formatting helpers for the packet log pages and the inputs of `<mc-packet-inspector>`. */
import { html, nothing } from 'lit';
import {
  NO_BYTES_MEANING,
  formatDurationMs,
  sendOutcomeLabel,
  type FrameInspection,
  type PacketInspection,
  type PacketRelation,
  type RelatedGroup,
  type RelationRule,
  type ResolvedHop,
} from '@meshcore-web/core/app';
import type { Annotation } from '@meshcore-web/core/packet';
import type { PacketRecord } from '@meshcore-web/core/store';
import { toHex } from '@meshcore-web/core/util/bytes';
import type { InspectorMeta } from './packet-inspector.js';
import { hopsLink } from '../../components/path-dialog.js';
import { hrefFor } from '../../router.js';
import { hashLink, nodeLink, pathHops } from '../../components/node-link.js';

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

/**
 * The "Send" entry of a tx row: what the radio did with the request (only the fields recorded).
 * `now` is the app clock (a DM unconfirmed past its estimated timeout reads "no ACK").
 */
export function sendSection(r: PacketRecord, now: number): InspectorMeta | null {
  const s = r.send;
  const label = sendOutcomeLabel(r, now);
  if (!s || !label) return null;
  const rows: [string, string][] = [['Status', `${label.text} · ${label.title}`]];
  if (s.flood !== undefined) rows.push(['Route', s.flood ? 'flood' : 'direct']);
  if (s.tag !== undefined) rows.push(['ACK tag', `0x${(s.tag >>> 0).toString(16).padStart(8, '0')}`]);
  if (s.estTimeoutMs !== undefined) rows.push(['Est. timeout', formatDurationMs(s.estTimeoutMs)]);
  if (s.respondedAt !== undefined) rows.push(['Response', `after ${formatDurationMs(Math.max(0, s.respondedAt - r.ts))}`]);
  if (s.confirmedAt !== undefined) {
    const rtt = s.rttMs !== undefined ? ` · round trip ${formatDurationMs(s.rttMs)}` : '';
    rows.push(['Confirmed', `${new Date(s.confirmedAt).toISOString()}${rtt}`]);
  } else if (s.rttMs !== undefined) rows.push(['Round trip', formatDurationMs(s.rttMs)]);
  if (s.error !== undefined || s.errCode !== undefined) rows.push(['Error', `${s.error ?? 'ERR'}${s.errCode !== undefined ? ` (code ${s.errCode})` : ''}`]);
  return {
    label: 'Send',
    value: html`<dl class="sub" data-section="send">${rows.map(([k, v]) => html`<dt>${k}</dt><dd data-send=${k}>${v}</dd>`)}</dl>`,
  };
}

/** What the other packet is to this one (see core packet-relations.ts). */
const RELATION_LABEL: Record<PacketRelation, string> = {
  ack: 'ACK',
  acked: 'Acknowledges',
  reply: 'Reply',
  request: 'Request',
  hop: 'Trace hop',
};

/** Rules whose name the relation label already implies (an ACK pairs by the `ack` rule). */
const IMPLIED_RULE: Partial<Record<PacketRelation, RelationRule>> = { ack: 'ack', acked: 'ack', hop: 'trace' };

/** "Reply (trace) →" / "← Acknowledges": the arrow points to where the other packet is in time. */
export function relationLabel(g: RelatedGroup, ts: number): string {
  const rule = IMPLIED_RULE[g.relation] === g.rule ? '' : ` (${g.rule})`;
  const text = `${RELATION_LABEL[g.relation]}${rule}`;
  const first = g.rows[0];
  return first && first.row.record.ts < ts ? `← ${text}` : `${text} →`;
}

/** "+1.2 s" / "−350 ms": a time relative to this packet's. */
export function relativeTime(ms: number): string {
  return `${ms < 0 ? '−' : '+'}${formatDurationMs(Math.abs(ms))}`;
}

/**
 * The "Related" entry: requests / replies / ACKs paired with this packet, each a link to its detail
 * page (copies of one packet grouped: "ACK → · heard 3×"). Null when there are none.
 */
export function relatedSection(ins: PacketInspection): InspectorMeta | null {
  const groups = ins.relatedGroups;
  if (!groups.length) return null;
  const ts = ins.record.ts;
  return {
    label: 'Related',
    value: html`<dl class="sub" data-section="related">
      ${groups.map((g) => {
        const first = g.rows[0]!.row;
        const heard = g.rows.length > 1 ? html` <span class="muted" data-related-copies>· heard ${g.rows.length}×</span>` : nothing;
        return html`<dt data-relation=${g.relation} data-rule=${g.rule}>${relationLabel(g, ts)}</dt>
          <dd data-relation=${g.relation}>
            ${first.typeName}${first.summary ? html` · <span>${first.summary}</span>` : nothing}${heard}<br />
            ${g.rows.map(
              (r, i) =>
                html`${i ? ', ' : ''}<a href=${hrefFor(`/packets/${r.id}`)} data-related-id=${r.id} title=${`Packet #${r.id} (${r.row.record.direction})`}
                    >#${r.id}</a
                  >
                  ${relativeTime(r.row.record.ts - ts)}${r.row.record.snr !== undefined ? ` · ${r.row.record.snr} dB` : ''}`,
            )}
          </dd>`;
      })}
    </dl>`,
  };
}

export function packetInspectorProps(ins: PacketInspection, resolve: HopResolver | undefined, now: number): InspectorProps {
  const r = ins.record;
  const meta: InspectorMeta[] = [
    { label: 'Time', value: new Date(r.ts).toISOString() },
    { label: 'Direction', value: r.direction === 'rx' ? '↓ rx (heard by the radio)' : '↑ tx (sent by the radio at this app\'s request)' },
    { label: 'Type', value: `${ins.view.typeName}${ins.view.routeName ? ` · ${ins.view.routeName}` : ''}` },
    { label: 'Summary', value: ins.summary },
  ];
  // the payload's source / destination hashes link to the nodes with that hash; ANON_REQ's full sender key to its node
  const { src, dst } = ins.view.endpoints;
  if (src !== null) {
    meta.push({
      label: 'From',
      value: html`<span class="mono" data-endpoint="src"
        >${src.length > 2 ? nodeLink(src, src, 'Node details') : hashLink(src, src, `Nodes whose key starts with ${src}`)}</span
      >`,
    });
  }
  if (dst !== null) {
    meta.push({ label: 'To', value: html`<span class="mono" data-endpoint="dst">${hashLink(dst, dst, `Nodes whose key starts with ${dst}`)}</span>` });
  }
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
  const related = relatedSection(ins);
  if (related) meta.push(related);
  const send = sendSection(r, now);
  if (send) meta.push(send);
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
