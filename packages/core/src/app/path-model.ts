/**
 * Path view model (issue #2): builds {@link PathSpec}s for the places the UI shows "N hops" —
 * a contact's stored out_path, a received message, a logged packet — and lays them out with
 * {@link buildPathGeometry} against the known contacts and this radio.
 *
 * Messages: CONTACT_MSG_RECV / CHANNEL_MSG_RECV only carry the path_len byte (hop count), not the
 * hop hashes (companion-protocol.md §6). The hashes are recovered from the packet log: the
 * LOG_RX_DATA capture of the TXT_MSG (src hash = the contact's first key byte) or GRP_TXT
 * (channel hash = first byte of the channel key, sha256(psk)) with the same path_len, heard
 * closest to the message's arrival. Without such a packet only the hop count is shown. When the
 * capture pipeline already matched the message to its packet (`MessageRecord.path`, issue #3)
 * those bytes are used directly and the packet log is not searched.
 */

import { PATH_LEN_UNKNOWN, decodePathLen } from '../protocol/constants.js';
import type { SelfInfo } from '../protocol/types.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import { splitPath } from '../packet/packet.js';
import { channelHash } from '../packet/payloads.js';
import type { RadioStore } from '../store/radio-store.js';
import type { MessageRecord, PacketRecord } from '../store/schema.js';
import { toHex } from '../util/bytes.js';
import type { ContactView } from './contacts-model.js';
import { hasLocation } from './geo.js';
import { buildPathGeometry, type PathEndpoint, type PathGeoNode, type PathGeometry, type PathSpec } from './path-geometry.js';
import { viewPacket } from './packet-summary.js';
import { computed, type ReadonlySignal } from './signal.js';

/** What a "N hops" link refers to. */
export type PathRequest =
  | { kind: 'contact'; key: string }
  | { kind: 'message'; message: MessageRecord }
  | { kind: 'packet'; id: number }
  | { kind: 'spec'; spec: PathSpec };

/** How far before / after a message's arrival its carrying packet is searched for (ms). */
export const MESSAGE_PACKET_WINDOW_BEFORE_MS = 120_000;
export const MESSAGE_PACKET_WINDOW_AFTER_MS = 10_000;

/** Path nodes for contacts (location only when advertised). */
export function pathNodesFromContacts(views: readonly ContactView[]): PathGeoNode[] {
  return views.map((v) => {
    const n: PathGeoNode = { key: v.key.toLowerCase(), name: v.name, kind: v.typeName };
    if (hasLocation({ lat: v.record.lat, lon: v.record.lon })) {
      n.lat = v.record.lat;
      n.lon = v.record.lon;
    }
    return n;
  });
}

/** This radio as a path node. */
export function selfPathNode(si: SelfInfo | null): PathGeoNode | null {
  if (!si) return null;
  const n: PathGeoNode = { key: toHex(si.pubKey).toLowerCase(), name: si.name || 'This radio', kind: 'self' };
  if (hasLocation(si)) {
    n.lat = si.lat;
    n.lon = si.lon;
  }
  return n;
}

/** Hop count of an encoded path_len, or null for 0xFF (unknown / direct). */
export function hopsOfPathLen(pathLen: number): number | null {
  if ((pathLen & 0xff) === PATH_LEN_UNKNOWN) return null;
  return decodePathLen(pathLen).hops;
}

/** The route to a contact: this radio → its out_path hops → the contact. */
export function contactPathSpec(v: ContactView): PathSpec {
  const c = v.record;
  const spec: PathSpec = { title: `Path to ${v.name}`, hashes: [], from: { kind: 'self' }, to: { kind: 'contact', key: v.key } };
  if ((c.outPathLen & 0xff) === PATH_LEN_UNKNOWN) {
    spec.note = 'No path is known yet; messages to this contact flood.';
    return spec;
  }
  const info = decodePathLen(c.outPathLen);
  const path = (c.outPath ?? new Uint8Array(0)).subarray(0, info.byteLength);
  spec.hashes = info.hashSize > 0 ? splitPath(path, info.hashSize).map(toHex) : [];
  if (spec.hashes.length === 0 && info.hops > 0) spec.hopCount = info.hops;
  return spec;
}

/**
 * The logged packet that most likely carried `m` (an incoming flood message), or undefined.
 * `selfKey` (hex) narrows TXT_MSG matches to ones addressed to this radio; `channelHash` is the
 * channel's 1-byte hash (default: the first byte of the channel key, sha256(psk)).
 */
export function findMessagePacket(
  m: MessageRecord,
  packets: readonly PacketRecord[],
  opts: { selfKey?: string | undefined; channelHash?: number | undefined } = {},
): PacketRecord | undefined {
  const { selfKey } = opts;
  if (m.direction !== 'in' || hopsOfPathLen(m.pathLen) === null) return undefined;
  const channel = m.convType === 'channel';
  const want = channel ? PayloadType.GRP_TXT : PayloadType.TXT_MSG;
  const convHash = (channel ? opts.channelHash : undefined) ?? parseInt(m.convKey.slice(0, 2), 16);
  const selfHash = selfKey ? parseInt(selfKey.slice(0, 2), 16) : undefined;
  const matches = packets.filter((r) => {
    if (r.direction !== 'rx' || r.format !== 'packet' || r.payloadType !== want || r.pathLen !== m.pathLen) return false;
    if (r.ts < m.receivedAt - MESSAGE_PACKET_WINDOW_BEFORE_MS || r.ts > m.receivedAt + MESSAGE_PACKET_WINDOW_AFTER_MS) return false;
    const p = viewPacket(r).payload;
    if (channel) return p?.kind === 'grpTxt' && p.channelHash === convHash;
    return p?.kind === 'txtMsg' && p.srcHash === convHash && (selfHash === undefined || p.destHash === selfHash);
  });
  if (matches.length === 0) return undefined;
  // closest to the arrival, preferring packets heard before it
  const cost = (r: PacketRecord): number => Math.abs(r.ts - m.receivedAt) + (r.ts > m.receivedAt ? MESSAGE_PACKET_WINDOW_BEFORE_MS : 0);
  const best = matches.reduce((a, b) => (cost(b) < cost(a) ? b : a));
  // the radio keeps the first copy it hears of a packet; prefer that one
  const copies = best.hash ? matches.filter((r) => r.hash === best.hash) : [best];
  return copies.reduce((a, b) => (b.ts < a.ts || (b.ts === a.ts && b.id < a.id) ? b : a));
}

/** The hop hashes stored on a message by the capture pipeline (`MessageRecord.path`), or undefined. */
export function storedMessageHashes(m: MessageRecord): string[] | undefined {
  if (!m.path || (m.pathLen & 0xff) === PATH_LEN_UNKNOWN) return undefined;
  const info = decodePathLen(m.pathLen);
  if (info.hops === 0 || m.path.length < info.byteLength) return undefined;
  return splitPath(m.path.subarray(0, info.byteLength), info.hashSize).map(toHex);
}

/** The route a received message took (hashes from `m.path`, else from `packet` when found). */
export function messagePathSpec(m: MessageRecord, packet: PacketRecord | undefined): PathSpec {
  const from: PathEndpoint =
    m.convType === 'channel'
      ? m.senderName
        ? { kind: 'name', name: m.senderName }
        : { kind: 'unknown', label: 'Sender' }
      : { kind: 'contact', key: m.convKey };
  const spec: PathSpec = { title: 'Message path', hashes: [], from, to: { kind: 'self' } };
  const hops = hopsOfPathLen(m.pathLen);
  if (m.direction !== 'in' || hops === null) {
    spec.note = 'The radio did not report a flood path for this message.';
    return spec;
  }
  const stored = storedMessageHashes(m);
  if (stored) {
    spec.hashes = stored;
    spec.note = 'Hops recorded when the message arrived.';
  } else if (packet) {
    spec.hashes = viewPacket(packet).path;
    spec.note = `Hops from the packet log (packet #${packet.id}).`;
  } else if (hops > 0) {
    spec.hopCount = hops;
    spec.note =
      'The radio reports only the hop count for messages; the repeaters are read from the packet that carried it. ' +
      'That packet is not in the packet log (most likely the message arrived while the app was not connected), so they were not recorded.';
  }
  return spec;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/**
 * The route of a logged packet. FLOOD: path = hops taken so far (oldest first), so origin → hops
 * → this radio (rx). DIRECT: path = hops still to travel, so this radio → hops → destination
 * (docs/mesh-packet-format.md §1.3).
 */
export function packetPathSpec(r: PacketRecord): PathSpec {
  const view = viewPacket(r);
  const p = view.payload;
  let origin: PathEndpoint = { kind: 'unknown', label: 'Origin' };
  let dest: PathEndpoint = { kind: 'unknown', label: 'Destination' };
  if (p?.kind === 'advert') {
    const key = toHex(p.publicKey);
    const lat = p.app.latitude;
    const lon = p.app.longitude;
    origin =
      lat !== undefined && lon !== undefined && hasLocation({ lat, lon })
        ? { kind: 'point', name: p.app.name || key.slice(0, 12), lat, lon, key }
        : { kind: 'contact', key };
  } else if (p && (p.kind === 'req' || p.kind === 'response' || p.kind === 'txtMsg' || p.kind === 'path')) {
    origin = { kind: 'hash', hash: hex2(p.srcHash) };
    dest = { kind: 'hash', hash: hex2(p.destHash) };
  } else if (p?.kind === 'anonReq') {
    origin = { kind: 'contact', key: toHex(p.senderPublicKey) };
    dest = { kind: 'hash', hash: hex2(p.destHash) };
  }
  const direct = r.routeType === RouteType.DIRECT || r.routeType === RouteType.TRANSPORT_DIRECT;
  const spec: PathSpec = {
    title: `${view.typeName} packet #${r.id}`,
    hashes: view.path,
    from: direct || r.direction === 'tx' ? { kind: 'self' } : origin,
    to: direct ? dest : r.direction === 'rx' ? { kind: 'self' } : { kind: 'unknown', label: 'Flood' },
  };
  if (direct) spec.note = 'A direct packet carries the hops still to travel.';
  return spec;
}

export interface PathModelSources {
  contacts: ReadonlySignal<readonly ContactView[]>;
  selfInfo: ReadonlySignal<SelfInfo | null>;
  store: ReadonlySignal<RadioStore | null>;
}

/** `app.paths`: path specs for the "N hops" links and their geometry. */
export class PathModel {
  /** Known contacts as path nodes. */
  readonly nodes: ReadonlySignal<readonly PathGeoNode[]>;
  readonly self: ReadonlySignal<PathGeoNode | null>;

  constructor(private readonly src: PathModelSources) {
    this.nodes = computed(() => pathNodesFromContacts(src.contacts.value));
    this.self = computed(() => selfPathNode(src.selfInfo.value));
  }

  /** Lays out `spec` against the current contacts (reads signals: reactive in a render). */
  geometry(spec: PathSpec): PathGeometry {
    return buildPathGeometry(spec, this.nodes.value, this.self.value);
  }

  contactSpec(key: string): PathSpec | null {
    const k = key.toLowerCase();
    const v = this.src.contacts.peek().find((c) => c.key === k);
    return v ? contactPathSpec(v) : null;
  }

  async messageSpec(m: MessageRecord): Promise<PathSpec> {
    const store = this.src.store.peek();
    let packet: PacketRecord | undefined;
    if (store && m.direction === 'in' && hopsOfPathLen(m.pathLen) && !storedMessageHashes(m)) {
      const page = await store.packets
        .query({
          direction: 'rx',
          payloadType: m.convType === 'channel' ? PayloadType.GRP_TXT : PayloadType.TXT_MSG,
          from: m.receivedAt - MESSAGE_PACKET_WINDOW_BEFORE_MS,
          to: m.receivedAt + MESSAGE_PACKET_WINDOW_AFTER_MS,
          limit: 500,
        })
        .catch(() => ({ items: [] as PacketRecord[] }));
      let hash: number | undefined;
      if (m.convType === 'channel') {
        const ch = await store.channels.get(m.convKey).catch(() => undefined);
        hash = ch ? await channelHash(ch.psk).catch(() => undefined) : undefined;
      }
      packet = findMessagePacket(m, page.items, { selfKey: this.self.peek()?.key, channelHash: hash });
    }
    return messagePathSpec(m, packet);
  }

  async packetSpec(id: number): Promise<PathSpec | null> {
    const r = await this.src.store.peek()?.packets.get(id);
    return r ? packetPathSpec(r) : null;
  }

  async resolve(req: PathRequest): Promise<PathSpec | null> {
    switch (req.kind) {
      case 'contact':
        return this.contactSpec(req.key);
      case 'message':
        return this.messageSpec(req.message);
      case 'packet':
        return this.packetSpec(req.id);
      case 'spec':
        return req.spec;
    }
  }
}
