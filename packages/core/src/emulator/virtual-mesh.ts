/**
 * VirtualMesh — a shared "air" for emulated MeshCore nodes. Everything on it is a real over-the-air
 * packet (docs/mesh-packet-format.md): Ed25519-signed adverts, X25519/AES/HMAC-encrypted datagrams,
 * real ACK codes, flood paths built by repeaters and TRACE SNR lists.
 *
 * - `VirtualMesh` delivers each transmission to every other joined endpoint whose link is enabled,
 *   with that link's SNR/RSSI, after a fixed propagation delay (or the packet's LoRa airtime), and
 *   drops it with the link's loss probability (seeded RNG, so runs are reproducible).
 * - `MeshNode` is an emulated chat / repeater / room / sensor node. Its answers come from
 *   `RemoteNode` (logins, status, telemetry, binary requests, CLI); the routing follows `Mesh.cpp`
 *   and `BaseChatMesh.cpp`: de-dup by packet hash, flood forwarding that appends the node hash,
 *   DIRECT forwarding that removes it, PATH returns (with the ACK/RESPONSE as extra) for flood
 *   traffic, reciprocal PATHs, early ACKs and TRACE SNR appends.
 * - `CompanionEmulator` joins with `joinMesh()` (or the `mesh` option) and then transmits and
 *   receives real packets too.
 *
 * Not modelled: collisions / channel busy, retransmit back-off randomisation, transport-code
 * region filtering by repeaters, multipart ACKs, room-server post fan-out, sensor subscriptions.
 */

import { bytesEqual, concatBytes, readU32LE, toHex, u32le, utf8Encode } from '../util/bytes.js';
import { TypedEmitter } from '../util/events.js';
import { ReqType, TxtType } from '../protocol/constants.js';
import type { CommonNodeStats } from '../protocol/types.js';
import { PayloadType, isDirectRoute } from '../packet/constants.js';
import type { ParsedPacket } from '../packet/packet.js';
import {
  advertSignedMessage,
  buildGrpTxtPlaintext,
  buildPathPlaintext,
  buildResponsePlaintext,
  buildTxtMsgPlaintext,
  parseAdvertPayload,
  parseGrpTxtPlaintext,
  parseLoginRequest,
  parsePathPlaintext,
  parseReqPlaintext,
  parseTxtMsgPlaintext,
} from '../packet/payloads.js';
import { loraAirtimeMs } from './airtime.js';
import type { EmulatorClock, TimerHandle } from './clock.js';
import { systemClock } from './clock.js';
import {
  ackCodeSync,
  calcSharedSecretSync,
  channelHashSync,
  ed25519KeyPairFromSeedSync,
  ed25519PublicKeySync,
  ed25519VerifySync,
  macThenDecryptSync,
  packetHashSync,
  sha256Sync,
} from './crypto-sync.js';
import {
  FLOOD,
  ackPayload,
  advertPayload,
  anonReqPayload,
  appendHop,
  envelope,
  fitsEncrypted,
  groupPayload,
  isFlood,
  keyStartsWith,
  pathWithAck,
  peerDatagramPayload,
  parseTraceSafe,
  rebuild,
  tryParse,
} from './mesh-packets.js';
import type { MeshIdentity, SendRoute } from './mesh-packets.js';
import { RemoteNode, contactTypeOf } from './remote-node.js';
import type { RemoteNodeConfig, RemoteNodeType } from './remote-node.js';
import type { Rng } from './rng.js';
import { createSeededRng, randomBytes } from './rng.js';

// ===========================================================================
// The air
// ===========================================================================

/** Reception info handed to an endpoint with each packet. */
export interface RxInfo {
  /** dB. */
  snr: number;
  /** dBm. */
  rssi: number;
  /** meshId of the transmitter. */
  from: string;
}

/** Anything that can join the air (a MeshNode, or the companion emulator's radio). */
export interface MeshEndpoint {
  readonly meshId: string;
  /** Current public key (the companion's may change on key import / factory reset). */
  readonly publicKey: Uint8Array;
  readonly displayName: string;
  receivePacket(packet: Uint8Array, rx: RxInfo): void;
  /** Private key, when the endpoint is willing to sign on behalf of others (scenario setup). */
  readonly identity?: MeshIdentity;
}

export interface LinkQuality {
  /** dB (quantised to 0.25 dB on the wire). Default 8. */
  snr: number;
  /** dBm. Default -70. */
  rssi: number;
  /** Drop probability 0..1. Default 0. */
  loss: number;
  /** false = out of range. Default true. */
  enabled: boolean;
  /** Extra per-link delay (ms) on top of the propagation delay. Default 0. */
  delayMs: number;
}

export interface AirPacket {
  /** Clock time (ms) of the transmission. */
  time: number;
  /** meshId of the transmitter. */
  from: string;
  packet: Uint8Array;
}

export interface VirtualMeshEvents {
  /** A packet was put on the air. */
  transmit: AirPacket;
  /** A packet reached an endpoint. */
  deliver: AirPacket & { to: string; snr: number; rssi: number };
  /** A packet was lost on a link. */
  drop: AirPacket & { to: string };
}

export interface VirtualMeshOptions {
  /** Shared with every node and with the companion emulator. Default systemClock. */
  clock?: EmulatorClock;
  rng?: Rng;
  /** Seed for the loss RNG when `rng` is not given (default 1). */
  seed?: number;
  /** Quality of links without an explicit setLink(). */
  defaultLink?: Partial<LinkQuality>;
  /** Propagation delay (ms) when `airtime` is off. Default 0 (radio waves are fast; use `airtime` for time on air). */
  delayMs?: number;
  /** Deliver after the packet's LoRa time on air instead; `true` = SF11 / 250 kHz / CR 4/5. */
  airtime?: boolean | { sf: number; bwHz: number; cr: number };
}

export type EndpointRef = string | MeshEndpoint;

const DEFAULT_LINK: LinkQuality = { snr: 8, rssi: -70, loss: 0, enabled: true, delayMs: 0 };

export class VirtualMesh {
  readonly clock: EmulatorClock;
  readonly rng: Rng;
  readonly events = new TypedEmitter<VirtualMeshEvents>();
  /** Every transmission, oldest first. */
  readonly log: AirPacket[] = [];
  readonly #options: VirtualMeshOptions;
  readonly #endpoints = new Map<string, MeshEndpoint>();
  readonly #links = new Map<string, Partial<LinkQuality>>();

  constructor(options: VirtualMeshOptions = {}) {
    this.#options = options;
    this.clock = options.clock ?? systemClock;
    this.rng = options.rng ?? createSeededRng(options.seed ?? 1);
  }

  /** Puts an endpoint on the air. Throws if its meshId is taken. */
  join(endpoint: MeshEndpoint): void {
    if (this.#endpoints.has(endpoint.meshId) && this.#endpoints.get(endpoint.meshId) !== endpoint) {
      throw new Error(`mesh id "${endpoint.meshId}" is already taken`);
    }
    this.#endpoints.set(endpoint.meshId, endpoint);
  }

  /** Takes an endpoint (or whatever holds this meshId, for a string) off the air. */
  leave(ref: EndpointRef): void {
    const id = idOf(ref);
    if (typeof ref === 'string' || this.#endpoints.get(id) === ref) this.#endpoints.delete(id);
  }

  /** Creates a MeshNode, joins it, and returns it. */
  addNode(config: MeshNodeConfig): MeshNode {
    const node = new MeshNode(this, config);
    this.join(node);
    return node;
  }

  get endpoints(): MeshEndpoint[] {
    return [...this.#endpoints.values()];
  }

  get nodes(): MeshNode[] {
    return this.endpoints.filter((e): e is MeshNode => e instanceof MeshNode);
  }

  /** Looks an endpoint up by meshId, name (case-insensitive) or public-key prefix. */
  endpoint(ref: string | Uint8Array): MeshEndpoint | undefined {
    if (typeof ref !== 'string') return this.endpoints.find((e) => ref.length > 0 && keyStartsWith(e.publicKey, ref));
    return this.#endpoints.get(ref) ?? this.endpoints.find((e) => e.displayName.toLowerCase() === ref.toLowerCase());
  }

  node(ref: string | Uint8Array): MeshNode | undefined {
    const e = this.endpoint(ref);
    return e instanceof MeshNode ? e : undefined;
  }

  /** Identity (with private key) of a mesh node, for signing contact adverts in scenarios. */
  identityOf(publicKey: Uint8Array): MeshIdentity | undefined {
    const e = this.endpoints.find((x) => x.identity && bytesEqual(x.publicKey, publicKey));
    return e?.identity;
  }

  /** Configures the a → b link (and b → a unless `symmetric: false`). */
  setLink(a: EndpointRef, b: EndpointRef, quality: Partial<LinkQuality>, opts: { symmetric?: boolean } = {}): void {
    const [ia, ib] = [idOf(a), idOf(b)];
    this.#links.set(`${ia}\u0000${ib}`, { ...this.#links.get(`${ia}\u0000${ib}`), ...quality });
    if (opts.symmetric ?? true) this.#links.set(`${ib}\u0000${ia}`, { ...this.#links.get(`${ib}\u0000${ia}`), ...quality });
  }

  /** Takes a and b out of each other's range. */
  isolate(a: EndpointRef, b: EndpointRef): void {
    this.setLink(a, b, { enabled: false });
  }

  /** The effective a → b link. */
  link(a: EndpointRef, b: EndpointRef): LinkQuality {
    return { ...DEFAULT_LINK, ...this.#options.defaultLink, ...this.#links.get(`${idOf(a)}\u0000${idOf(b)}`) };
  }

  /** Every MeshNode learns every other endpoint as a contact (path unknown). */
  introduceAll(): void {
    for (const n of this.nodes) {
      for (const e of this.endpoints) if (e !== n) n.addContact(e.publicKey, { name: e.displayName, type: e instanceof MeshNode ? contactTypeOf(e.type) : 1 });
    }
  }

  /** Puts `packet` on the air from `from`. */
  transmit(from: EndpointRef, packet: Uint8Array): void {
    const fromId = idOf(from);
    const air: AirPacket = { time: this.clock.now(), from: fromId, packet: packet.slice() };
    this.log.push(air);
    this.events.emit('transmit', air);
    const base = this.#delayFor(packet.length);
    for (const to of this.#endpoints.values()) {
      if (to.meshId === fromId) continue;
      const l = this.link(fromId, to.meshId);
      if (!l.enabled) continue;
      if (l.loss > 0 && randomBytes(this.rng, 1)[0]! / 256 < l.loss) {
        this.events.emit('drop', { ...air, to: to.meshId });
        continue;
      }
      this.clock.setTimeout(() => {
        if (this.#endpoints.get(to.meshId) !== to) return; // left meanwhile
        this.events.emit('deliver', { ...air, to: to.meshId, snr: l.snr, rssi: l.rssi });
        to.receivePacket(air.packet.slice(), { snr: l.snr, rssi: l.rssi, from: fromId });
      }, base + l.delayMs);
    }
  }

  #delayFor(len: number): number {
    const a = this.#options.airtime;
    if (!a) return this.#options.delayMs ?? 0;
    const r = a === true ? { sf: 11, bwHz: 250000, cr: 5 } : a;
    return loraAirtimeMs(len, r.sf, r.bwHz, r.cr);
  }
}

function idOf(ref: EndpointRef): string {
  return typeof ref === 'string' ? ref : ref.meshId;
}

// ===========================================================================
// Emulated nodes
// ===========================================================================

export interface MeshNodeConfig extends Omit<RemoteNodeConfig, 'pubKey' | 'returnPath' | 'discoveryInPath' | 'addContact' | 'contact'> {
  /** meshId (default: name). */
  id?: string;
  /** Identity seed: 32 bytes, or a string hashed (SHA-256) into one. Default: random from the mesh RNG. */
  seed?: Uint8Array | string;
  /** 64-byte expanded private key (alternative to `seed`). */
  privateKey?: Uint8Array;
  /** Re-transmit packets for others (Mesh `allowPacketForward`). Default: repeaters only. */
  forward?: boolean;
  /** Forward a flood only while its hop count is below this. Default 64. */
  maxFloodHops?: number;
  /** Delay before a forwarded packet is re-sent (ms). Default 50. */
  forwardDelayMs?: number;
  /** Path hash size used for the node's own floods (1..3). Default 1. */
  pathHashSize?: number;
  /** Group channels the node is a member of. */
  channels?: Array<{ name: string; secret: Uint8Array }>;
  /** Node RTC offset from the clock (secs). Default 0. */
  rtcOffsetSecs?: number;
  /**
   * Report the node's real packet counters / last SNR / RSSI in STATUS replies (fields in
   * `stats` still win). Default false: the configured / default RemoteNode values.
   */
  liveStats?: boolean;
}

export interface NodeContact {
  publicKey: Uint8Array;
  name: string;
  type: number;
  /** null = unknown (flood). */
  outPath: Uint8Array | null;
  hashSize: number;
  lastAdvert: number;
}

export interface NodeMessage {
  from: Uint8Array;
  text: string;
  txtType: number;
  attempt: number;
  timestamp: number;
  /** Encoded flood path_len, or 0xFF when received DIRECT. */
  pathLen: number;
  snr: number;
}

export interface NodeChannelMessage {
  channel: string;
  text: string;
  senderName?: string;
  message: string;
  timestamp: number;
  pathLen: number;
}

export interface NodeTrace {
  tag: number;
  authCode: number;
  flags: number;
  hashes: Uint8Array;
  /** dB per hop. */
  snrs: number[];
  finalSnr: number;
}

interface NodeCounters {
  recv: number;
  sent: number;
  recvFlood: number;
  recvDirect: number;
  sentFlood: number;
  sentDirect: number;
  floodDups: number;
  directDups: number;
  recvErrors: number;
}

const SEEN_TABLE_SIZE = 256;
const hex = (b: Uint8Array): string => toHex(b);
const i8 = (b: number): number => (b > 127 ? b - 256 : b);
const snrByte = (snr: number): number => Math.max(-128, Math.min(127, Math.round(snr * 4))) & 0xff;

/** Derives a 32-byte identity seed from text (deterministic scenario keys). */
export function seedFromString(text: string): Uint8Array {
  return sha256Sync(utf8Encode(text));
}

/**
 * Key pair for a seed, re-hashing the seed until the public key's first byte is not 0x00 / 0xFF
 * (reserved hash values, `LocalIdentity::validatePrivateKey`).
 */
export function meshIdentityFromSeed(seed: Uint8Array | string): MeshIdentity & { seed: Uint8Array } {
  let s = typeof seed === 'string' ? seedFromString(seed) : seed.slice();
  for (;;) {
    const kp = ed25519KeyPairFromSeedSync(s);
    if (kp.publicKey[0] !== 0x00 && kp.publicKey[0] !== 0xff) return { seed: s, publicKey: kp.publicKey, privateKey: kp.privateKey };
    s = sha256Sync(s);
  }
}

export class MeshNode implements MeshEndpoint {
  readonly mesh: VirtualMesh;
  readonly config: MeshNodeConfig;
  /** Request/login/CLI behaviour; its `messages` / `requests` arrays record what arrived. */
  readonly remote: RemoteNode;
  readonly meshId: string;
  readonly publicKey: Uint8Array;
  readonly identity: MeshIdentity;
  readonly contacts = new Map<string, NodeContact>();
  /** Every packet heard (incl. duplicates), oldest first. */
  readonly heard: Array<{ time: number; packet: Uint8Array; snr: number; rssi: number; from: string }> = [];
  /** Text messages received from any contact. */
  readonly inbox: NodeMessage[] = [];
  readonly channelMessages: NodeChannelMessage[] = [];
  /** RESPONSE plaintexts received (tag first). */
  readonly responses: Array<{ from: Uint8Array; data: Uint8Array }> = [];
  /** Completed traces heard. */
  readonly traces: NodeTrace[] = [];
  /** ACK codes received for this node's own messages. */
  readonly acked: number[] = [];
  readonly counters: NodeCounters = { recv: 0, sent: 0, recvFlood: 0, recvDirect: 0, sentFlood: 0, sentDirect: 0, floodDups: 0, directDups: 0, recvErrors: 0 };
  #seen: string[] = [];
  #seenSet = new Set<string>();
  #pendingAcks = new Map<number, Uint8Array>();
  #lastUnique = 0;
  #lastSnr = 0;
  #lastRssi = -120;
  readonly #bootMs: number;

  constructor(mesh: VirtualMesh, config: MeshNodeConfig) {
    this.mesh = mesh;
    this.config = config;
    this.meshId = config.id ?? config.name;
    if (config.privateKey) {
      this.identity = { publicKey: ed25519PublicKeySync(config.privateKey), privateKey: config.privateKey.slice() };
    } else {
      const id = meshIdentityFromSeed(config.seed ?? randomBytes(mesh.rng, 32));
      this.identity = { publicKey: id.publicKey, privateKey: id.privateKey };
    }
    this.publicKey = this.identity.publicKey;
    this.remote = new RemoteNode({ ...config, pubKey: this.publicKey });
    this.#bootMs = mesh.clock.now();
  }

  get name(): string {
    return this.remote.config.name;
  }
  get displayName(): string {
    return this.name;
  }
  get type(): RemoteNodeType {
    return this.config.type;
  }
  get online(): boolean {
    return this.remote.online;
  }
  /** Brings the node's radio up / down (offline nodes neither hear nor send). */
  set online(v: boolean) {
    this.remote.config.online = v;
  }
  get forwards(): boolean {
    return this.config.forward ?? this.config.type === 'repeater';
  }
  /** Node RTC (unix secs). */
  get rtcSecs(): number {
    return (Math.floor(this.mesh.clock.now() / 1000) + (this.config.rtcOffsetSecs ?? 0)) >>> 0;
  }

  // ---- contacts -----------------------------------------------------------

  addContact(publicKey: Uint8Array, o: { name?: string; type?: number; path?: Uint8Array | null; hashSize?: number } = {}): NodeContact {
    const k = hex(publicKey);
    const existing = this.contacts.get(k);
    const c: NodeContact = existing ?? { publicKey: publicKey.slice(), name: '', type: 1, outPath: null, hashSize: 1, lastAdvert: 0 };
    if (o.name !== undefined) c.name = o.name;
    if (o.type !== undefined) c.type = o.type;
    if (o.path !== undefined) c.outPath = o.path === null ? null : o.path.slice();
    if (o.hashSize !== undefined) c.hashSize = o.hashSize;
    this.contacts.set(k, c);
    return c;
  }

  getContact(publicKey: Uint8Array): NodeContact | undefined {
    return this.contacts.get(hex(publicKey)) ?? [...this.contacts.values()].find((c) => keyStartsWith(c.publicKey, publicKey));
  }

  /** Sets the out path to a contact (null = unknown → flood). */
  setPath(publicKey: Uint8Array, path: Uint8Array | null, hashSize = 1): void {
    this.addContact(publicKey, { path, hashSize });
  }

  // ---- sending ------------------------------------------------------------

  /** Sends a signed advert (flood by default, else zero-hop). */
  advertise(o: { flood?: boolean; timestamp?: number } = {}): Uint8Array {
    const c = this.config;
    const payload = advertPayload(this.identity, o.timestamp ?? this.#rtcUnique(), {
      nodeType: contactTypeOf(c.type),
      ...(c.lat !== undefined && c.lon !== undefined ? { latitude: c.lat, longitude: c.lon } : {}),
      name: c.name,
    });
    return this.#send(PayloadType.ADVERT, payload, o.flood === false ? { path: new Uint8Array(0) } : this.#floodRoute());
  }

  /** Sends a text message to a contact; returns the expected ACK code (0 for CLI types). */
  sendText(to: Uint8Array, text: string, o: { txtType?: number; attempt?: number; timestamp?: number } = {}): number {
    const c = this.getContact(to);
    if (!c) throw new Error(`${this.name}: unknown contact ${hex(to.subarray(0, 4))}`);
    const txtType = o.txtType ?? TxtType.PLAIN;
    const pt = buildTxtMsgPlaintext({ timestamp: o.timestamp ?? this.#rtcUnique(), text, txtType, attempt: o.attempt ?? 0 });
    let ack = 0;
    if (txtType === TxtType.PLAIN) {
      ack = ackCodeSync(pt.subarray(0, 5 + utf8Encode(text).length), this.publicKey);
      this.#pendingAcks.set(ack, c.publicKey);
    }
    this.#send(PayloadType.TXT_MSG, peerDatagramPayload(c.publicKey, this.publicKey, this.#secret(c.publicKey), pt), this.#routeTo(c));
    return ack;
  }

  /** Sends "<name>: text" on a channel the node is a member of (by name or secret). */
  sendChannelMessage(channel: string | Uint8Array, text: string, o: { timestamp?: number } = {}): void {
    const ch = this.#channel(channel);
    const pt = buildGrpTxtPlaintext({ timestamp: o.timestamp ?? this.#rtcUnique(), senderName: this.name, text });
    this.#send(PayloadType.GRP_TXT, groupPayload(channelHashSync(ch.secret), ch.secret, pt), this.#floodRoute());
  }

  /** Sends an ANON_REQ login to a server (used for node-to-node tests). */
  sendLogin(to: Uint8Array, password: string): void {
    const pt = concatBytes(u32le(this.#rtcUnique()), utf8Encode(password));
    const c = this.getContact(to);
    this.#send(PayloadType.ANON_REQ, anonReqPayload(to, this.publicKey, this.#secret(to), pt), c ? this.#routeTo(c) : this.#floodRoute());
  }

  // ---- receiving (Mesh::onRecvPacket) -------------------------------------

  receivePacket(raw: Uint8Array, rx: RxInfo): void {
    if (!this.online) return;
    this.heard.push({ time: this.mesh.clock.now(), packet: raw, snr: rx.snr, rssi: rx.rssi, from: rx.from });
    this.counters.recv++;
    this.#lastSnr = rx.snr;
    this.#lastRssi = rx.rssi;
    const p = tryParse(raw);
    if (!p) {
      this.counters.recvErrors++;
      return;
    }
    const direct = isDirectRoute(p.routeType);
    if (direct && p.payloadType === PayloadType.TRACE) return this.#onTrace(p, rx);
    if (direct && p.pathHashCount > 0) {
      // 'early received' ACK: overheard on its way to us
      if (p.payloadType === PayloadType.ACK && p.payload.length >= 4) this.#onAck(readU32LE(p.payload, 0));
      if (this.forwards && keyStartsWith(this.publicKey, p.path.subarray(0, p.pathHashSize))) {
        if (this.#markSeen(p)) {
          this.counters.directDups++;
          return;
        }
        this.#forward(rebuild(p, { path: p.path.slice(p.pathHashSize) }), false);
      }
      return;
    }
    if (this.#markSeen(p)) {
      if (direct) this.counters.directDups++;
      else this.counters.floodDups++;
      return;
    }
    if (direct) this.counters.recvDirect++;
    else this.counters.recvFlood++;
    const consumed = this.#process(p, rx);
    if (!direct && !consumed && this.forwards && p.pathHashCount < (this.config.maxFloodHops ?? 64)) {
      const path = appendHop(p, this.publicKey);
      if (path) this.#forward(rebuild(p, { path }), true);
    }
  }

  /** Handles a fresh packet; true when it was addressed to (and decrypted by) this node. */
  #process(p: ParsedPacket, rx: RxInfo): boolean {
    switch (p.payloadType) {
      case PayloadType.ADVERT:
        this.#onAdvert(p);
        return false;
      case PayloadType.TXT_MSG:
      case PayloadType.REQ:
      case PayloadType.RESPONSE:
      case PayloadType.PATH:
        return this.#onPeerDatagram(p, rx);
      case PayloadType.ANON_REQ:
        return this.#onAnonReq(p);
      case PayloadType.ACK:
        return p.payload.length >= 4 && this.#onAck(readU32LE(p.payload, 0));
      case PayloadType.GRP_TXT:
        this.#onGroupText(p);
        return false;
      default:
        return false;
    }
  }

  #onAdvert(p: ParsedPacket): void {
    let a;
    try {
      a = parseAdvertPayload(p.payload);
    } catch {
      return;
    }
    if (bytesEqual(a.publicKey, this.publicKey) || !a.app.name) return;
    if (!ed25519VerifySync(a.publicKey, advertSignedMessage(a.publicKey, a.timestamp, a.appData), a.signature)) return;
    const c = this.getContact(a.publicKey);
    if (c && a.timestamp <= c.lastAdvert) return;
    this.addContact(a.publicKey, { name: a.app.name, type: a.app.nodeType }).lastAdvert = a.timestamp;
  }

  #onPeerDatagram(p: ParsedPacket, rx: RxInfo): boolean {
    if (p.payload.length < 4 || p.payload[0] !== this.publicKey[0]) return false;
    const src = p.payload[1];
    for (const c of this.contacts.values()) {
      if (c.publicKey[0] !== src) continue;
      const pt = macThenDecryptSync(this.#secret(c.publicKey), p.payload.subarray(2));
      if (!pt) continue;
      switch (p.payloadType) {
        case PayloadType.TXT_MSG:
          this.#onText(c, pt, p, rx);
          break;
        case PayloadType.REQ:
          this.#onRequest(c, pt, p);
          break;
        case PayloadType.RESPONSE:
          this.responses.push({ from: c.publicKey.slice(), data: pt });
          break;
        case PayloadType.PATH:
          this.#onPath(c, pt, p);
          break;
      }
      return true;
    }
    return false;
  }

  /** BaseChatMesh::onPeerDataRecv for TXT_MSG. */
  #onText(c: NodeContact, pt: Uint8Array, p: ParsedPacket, rx: RxInfo): void {
    let m;
    try {
      m = parseTxtMsgPlaintext(pt);
    } catch {
      return;
    }
    const flood = isFlood(p);
    this.remote.messages.push({ text: m.text, txtType: m.txtType, attempt: m.attempt, timestamp: m.timestamp });
    this.inbox.push({ from: c.publicKey.slice(), text: m.text, txtType: m.txtType, attempt: m.attempt, timestamp: m.timestamp, pathLen: flood ? p.pathLen : 0xff, snr: rx.snr });
    const cfg = this.config;
    const ackDelay = cfg.ackDelayMs ?? 300;
    if (m.txtType === TxtType.PLAIN || m.txtType === TxtType.SIGNED_PLAIN) {
      const policy = cfg.ackPolicy ?? 'auto';
      const acked = policy === 'auto' || (typeof policy === 'object' && m.attempt >= policy.minAttempt);
      if (!acked) return; // modelled as a lost message: no ACK, no reply
      const ack =
        m.txtType === TxtType.PLAIN
          ? ackCodeSync(pt.subarray(0, 5 + m.textBytes.length), c.publicKey)
          : ackCodeSync(pt.subarray(0, 9 + m.textBytes.length), this.publicKey);
      this.#later(() => this.#replyAck(c, ack, flood ? p : null), ackDelay);
      const reply = m.txtType === TxtType.PLAIN ? cfg.autoReply?.(m.text) : undefined;
      if (reply) this.#later(() => this.sendText(c.publicKey, reply), ackDelay + this.remote.responseDelayMs);
      return;
    }
    if (flood) this.#later(() => this.#sendPathReturn(c, p, false), ackDelay); // path only, no ACK for CLI types
    if (m.txtType === TxtType.CLI_COMMAND || m.txtType === TxtType.CLI_DATA) {
      // simple_repeater / simple_room_server handle CLI_DATA and CLI_COMMAND identically (no ACK):
      // the reply is CLI_DATA stamped with the unique RTC time, bumped if it equals the sender's.
      const reply = this.remote.cliReply(m.text);
      if (reply !== null) {
        let timestamp = this.#rtcUnique();
        if (timestamp === m.timestamp) timestamp = this.#rtcUnique();
        this.#later(() => this.sendText(c.publicKey, reply, { txtType: TxtType.CLI_DATA, timestamp }), this.remote.responseDelayMs);
      }
    }
  }

  /** Server request handling (`RPT/ROOM/SENS onPeerDataRecv` REQ). */
  #onRequest(c: NodeContact, pt: Uint8Array, p: ParsedPacket): void {
    let r;
    try {
      r = parseReqPlaintext(pt);
    } catch {
      return;
    }
    const data = pt.subarray(4);
    this.remote.requests.push({ kind: reqKind(r.reqType), data: data.slice() });
    let body: Uint8Array | null;
    if (r.reqType === ReqType.GET_TELEMETRY_DATA) body = this.type === 'chat' && !this.config.telemetry ? null : this.remote.telemetryBody();
    else if (r.reqType === ReqType.GET_STATUS) body = this.remote.statusBody(this.#uptimeSecs(), this.config.liveStats ? this.#liveStats() : {});
    else body = this.remote.binaryBody(data, this.#uptimeSecs());
    if (body === null) return;
    const resp = buildResponsePlaintext(r.timestamp, body);
    this.#later(() => this.#sendResponse(c, resp, isFlood(p) ? p : null), this.remote.responseDelayMs);
  }

  /** ANON_REQ: login (or a custom anon request) from a possibly unknown client. §3.8 */
  #onAnonReq(p: ParsedPacket): boolean {
    if (p.payload.length < 35 || p.payload[0] !== this.publicKey[0]) return false;
    const sender = p.payload.slice(1, 33);
    const pt = macThenDecryptSync(this.#secret(sender), p.payload.subarray(33));
    if (!pt || pt.length < 5) return false;
    const room = this.type === 'room';
    const kindByte = pt[4]!;
    let resp: Uint8Array | null;
    if (!room && kindByte > 0 && kindByte < 0x20) {
      // anonymous request ([tag][type][...]): answered with the binary handlers
      this.remote.requests.push({ kind: 'anon', data: pt.slice(4) });
      const body = this.remote.binaryBody(pt.subarray(4), this.#uptimeSecs());
      resp = body === null ? null : buildResponsePlaintext(readU32LE(pt, 0), body);
    } else {
      const password = parseLoginRequest(pt, room).password;
      this.remote.requests.push({ kind: 'login', data: utf8Encode(password) });
      resp = this.remote.loginResponse(password, this.rtcSecs, this.mesh.rng);
    }
    if (!resp) return true;
    const c = this.getContact(sender) ?? this.addContact(sender, {});
    const reply = resp;
    this.#later(() => this.#sendResponse(c, reply, isFlood(p) ? p : null), this.remote.responseDelayMs);
    return true;
  }

  /** PATH addressed to us (`Mesh.cpp` L160-179, `BCM onContactPathRecv`). */
  #onPath(c: NodeContact, pt: Uint8Array, p: ParsedPacket): void {
    let pp;
    try {
      pp = parsePathPlaintext(pt);
    } catch {
      return;
    }
    c.outPath = pp.path;
    c.hashSize = pp.hashSize;
    if (pp.extraType === PayloadType.ACK && pp.extra.length >= 4) this.#onAck(readU32LE(pp.extra, 0));
    else if (pp.extraType === PayloadType.RESPONSE && pp.hasExtra) this.responses.push({ from: c.publicKey.slice(), data: pp.extra });
    // a flood PATH earns a reciprocal PATH, sent DIRECT along the path just learned
    if (isFlood(p)) this.#later(() => this.#sendPathReturn(c, p, true), 0);
  }

  #onAck(ack: number): boolean {
    if (!this.#pendingAcks.has(ack)) return false;
    this.#pendingAcks.delete(ack);
    this.acked.push(ack);
    return true;
  }

  #onGroupText(p: ParsedPacket): void {
    if (p.payload.length < 3) return;
    for (const ch of this.config.channels ?? []) {
      if (channelHashSync(ch.secret) !== p.payload[0]) continue;
      const pt = macThenDecryptSync(ch.secret, p.payload.subarray(1));
      if (!pt) continue;
      try {
        const g = parseGrpTxtPlaintext(pt);
        if (g.txtType !== 0) return;
        const m: NodeChannelMessage = { channel: ch.name, text: g.text, message: g.message, timestamp: g.timestamp, pathLen: isFlood(p) ? p.pathLen : 0xff };
        if (g.senderName !== undefined) m.senderName = g.senderName;
        this.channelMessages.push(m);
      } catch {
        // malformed plaintext: dropped
      }
      return;
    }
  }

  /** TRACE (`Mesh.cpp` L42-68): append our SNR if we are the next listed hop. */
  #onTrace(p: ParsedPacket, rx: RxInfo): void {
    const t = parseTraceSafe(p.payload);
    if (!t) return;
    const offset = p.pathHashCount << (t.flags & 3);
    if (offset >= t.hashes.length) {
      this.traces.push({ tag: t.tag, authCode: t.authCode, flags: t.flags, hashes: t.hashes, snrs: [...p.path].map((b) => i8(b) / 4), finalSnr: rx.snr });
      return;
    }
    const hop = t.hashes.subarray(offset, offset + t.hashSize);
    if (!this.forwards || !keyStartsWith(this.publicKey, hop) || p.path.length >= 64) return;
    if (this.#markSeen(p)) return;
    this.#forward(rebuild(p, { path: concatBytes(p.path, Uint8Array.of(snrByte(rx.snr))), pathHashSize: 1 }), false);
  }

  // ---- replies -------------------------------------------------------------

  /** ACK for a received message: inside a flood PATH when it came by flood, else a plain ACK. */
  #replyAck(c: NodeContact, ack: number, floodPkt: ParsedPacket | null): void {
    if (floodPkt) {
      const pt = pathWithAck(floodPkt.path, floodPkt.pathHashSize, ack);
      this.#send(PayloadType.PATH, peerDatagramPayload(c.publicKey, this.publicKey, this.#secret(c.publicKey), pt), this.#floodRoute());
    } else {
      this.#send(PayloadType.ACK, ackPayload(ack), this.#routeTo(c));
    }
  }

  #sendResponse(c: NodeContact, resp: Uint8Array, floodPkt: ParsedPacket | null): void {
    if (floodPkt) {
      const pt = buildPathPlaintext({ path: floodPkt.path, hashSize: floodPkt.pathHashSize, extraType: PayloadType.RESPONSE, extra: resp });
      if (!fitsEncrypted(2, pt.length)) return;
      this.#send(PayloadType.PATH, peerDatagramPayload(c.publicKey, this.publicKey, this.#secret(c.publicKey), pt), this.#floodRoute());
      return;
    }
    if (!fitsEncrypted(2, resp.length)) return;
    this.#send(PayloadType.RESPONSE, peerDatagramPayload(c.publicKey, this.publicKey, this.#secret(c.publicKey), resp), this.#routeTo(c));
  }

  /** PATH return carrying only the path (CLI messages, reciprocal paths). */
  #sendPathReturn(c: NodeContact, viaPkt: ParsedPacket, direct: boolean): void {
    const pt = buildPathPlaintext({ path: viaPkt.path, hashSize: viaPkt.pathHashSize });
    const payload = peerDatagramPayload(c.publicKey, this.publicKey, this.#secret(c.publicKey), pt);
    this.#send(PayloadType.PATH, payload, direct ? this.#routeTo(c) : this.#floodRoute());
  }

  // ---- plumbing -------------------------------------------------------------

  #send(payloadType: number, payload: Uint8Array, route: SendRoute): Uint8Array {
    const raw = envelope(payloadType, payload, route);
    if (!this.online) return raw;
    const p = tryParse(raw);
    if (p) this.#markSeen(p);
    this.counters.sent++;
    if (route.path === null) this.counters.sentFlood++;
    else this.counters.sentDirect++;
    this.mesh.transmit(this, raw);
    return raw;
  }

  #forward(raw: Uint8Array, flood: boolean): void {
    this.#later(() => {
      this.counters.sent++;
      if (flood) this.counters.sentFlood++;
      else this.counters.sentDirect++;
      this.mesh.transmit(this, raw);
    }, this.config.forwardDelayMs ?? 50);
  }

  #later(fn: () => void, ms: number): TimerHandle {
    return this.mesh.clock.setTimeout(() => {
      if (this.online) fn();
    }, ms);
  }

  /** Records the packet hash; true if it had been seen before (`hasSeen`). */
  #markSeen(p: ParsedPacket): boolean {
    const h = hex(packetHashSync(p));
    if (this.#seenSet.has(h)) return true;
    this.#seenSet.add(h);
    this.#seen.push(h);
    if (this.#seen.length > SEEN_TABLE_SIZE) this.#seenSet.delete(this.#seen.shift()!);
    return false;
  }

  #routeTo(c: NodeContact): SendRoute {
    return c.outPath === null ? this.#floodRoute() : { path: c.outPath, hashSize: c.hashSize };
  }

  #floodRoute(): SendRoute {
    return { ...FLOOD, hashSize: this.config.pathHashSize ?? 1 };
  }

  #secretCache = new Map<string, Uint8Array>();
  #secret(peer: Uint8Array): Uint8Array {
    const k = hex(peer);
    let s = this.#secretCache.get(k);
    if (!s) {
      s = calcSharedSecretSync(this.identity.privateKey, peer);
      this.#secretCache.set(k, s);
    }
    return s;
  }

  #channel(ref: string | Uint8Array): { name: string; secret: Uint8Array } {
    const chs = this.config.channels ?? [];
    const ch = typeof ref === 'string' ? chs.find((c) => c.name === ref) : chs.find((c) => bytesEqual(c.secret, ref)) ?? { name: '', secret: ref };
    if (!ch) throw new Error(`${this.name}: not a member of channel ${String(ref)}`);
    return ch;
  }

  #rtcUnique(): number {
    const t = this.rtcSecs;
    if (t <= this.#lastUnique) return ++this.#lastUnique;
    return (this.#lastUnique = t);
  }

  #uptimeSecs(): number {
    return Math.floor((this.mesh.clock.now() - this.#bootMs) / 1000);
  }

  #liveStats(): Partial<CommonNodeStats> {
    const c = this.counters;
    return {
      packetsRecv: c.recv,
      packetsSent: c.sent,
      sentFlood: c.sentFlood,
      sentDirect: c.sentDirect,
      recvFlood: c.recvFlood,
      recvDirect: c.recvDirect,
      floodDups: c.floodDups,
      directDups: c.directDups,
      lastSnr: this.#lastSnr,
      lastRssiDbm: this.#lastRssi,
    };
  }
}

function reqKind(reqType: number): string {
  switch (reqType) {
    case ReqType.GET_STATUS:
      return 'status';
    case ReqType.GET_TELEMETRY_DATA:
      return 'telemetry';
    default:
      return 'binary';
  }
}

