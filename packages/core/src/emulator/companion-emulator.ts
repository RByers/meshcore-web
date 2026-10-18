/**
 * CompanionEmulator — an in-process stand-in for a MeshCore companion radio running firmware
 * v1.18.0. It consumes host → device frames and produces device → host frames exactly as
 * `examples/companion_radio/MyMesh.cpp` does (docs/companion-protocol.md is the reference):
 *
 * - every command of §4 with the firmware's guard checks and quirky ERR codes (§3);
 * - offline message queue + MSG_WAITING + SYNC_NEXT_MESSAGE with queue-full eviction (§6.1);
 * - GET_CONTACTS streaming with the strict `lastmod > since` filter (§7.2);
 * - protocol version gating of V1/V3 message frames by DEVICE_QUERY (§2, §11);
 * - SENT / SEND_CONFIRMED with real ACK codes and the 8-slot expected-ACK table (§6.5);
 * - the single-outstanding remote request mutex and response matching rules (§4 notes, §6.10).
 *
 * The radio side produces real over-the-air packets (docs/mesh-packet-format.md, built with
 * `packet/`): Ed25519 identity and advert signatures, X25519 + AES-128 + HMAC encrypted datagrams,
 * real ACK codes. Every transmission is recorded in `airLog` (`raw` = the packet bytes). Joined to
 * a `VirtualMesh` (option `mesh` / `joinMesh`), packets go on that air and received packets are
 * decrypted and turned into the device frames (LOG_RX_DATA first). Nodes registered with
 * `addRemoteNode` (no mesh) are still simulated directly with timers.
 *
 * Crypto runs synchronously (crypto-sync.ts) so the device stays deterministic under ManualClock.
 */

import { bytesEqual, concatBytes, toHex, u32le, readU32LE, utf8Decode, utf8Encode } from '../util/bytes.js';
import { TypedEmitter } from '../util/events.js';
import type { Unsubscribe } from '../util/events.js';
import {
  AutoAddFlag,
  CHANNEL_SECRET_SIZE,
  ContactFlag,
  ContactType,
  ERR,
  FIRMWARE_VER_CODE,
  FIRMWARE_VERSION,
  MAX_CHANNEL_DATA_LENGTH,
  MAX_FRAME_SIZE,
  MAX_GROUP_DATA_LENGTH,
  MAX_NAME_LEN,
  MAX_SIGN_DATA_LEN,
  MAX_TEXT_LEN,
  PATH_LEN_UNKNOWN,
  PRIVATE_KEY_SIZE,
  PUBLIC_CHANNEL_NAME,
  PUBLIC_CHANNEL_SECRET_HEX,
  PUB_KEY_PREFIX_SIZE,
  PUB_KEY_SIZE,
  RESP,
  ReqType,
  SIGNED_PLAIN_AUTHOR_PREFIX_SIZE,
  StatsType,
  TelemetryMode,
  TelemetryPerm,
  TxtType,
  V3_MESSAGES_MIN_VERSION,
  decodePathLen,
  directTimeoutMs,
  floodTimeoutMs,
  isValidPathLen,
  packTelemetryModes,
} from '../protocol/constants.js';
import { tryDecodeCommand } from '../protocol/decode-command.js';
import { encodeDeviceFrame } from '../protocol/encode-frame.js';
import { ProtocolEncodeError } from '../protocol/errors.js';
import type { Command, ContactInput, DeviceFrame, MessageRoute, RepeatFreqRange } from '../protocol/types.js';
import { LoopbackEndpoint, createLoopbackPair } from '../transport/loopback.js';
import type { LoopbackOptions } from '../transport/loopback.js';
import type { FrameTransport } from '../transport/transport.js';
import { loraAirtimeMs } from './airtime.js';
import type { EmulatorClock, TimerHandle } from './clock.js';
import { systemClock } from './clock.js';
import { PayloadType, RouteType, isDirectRoute } from '../packet/constants.js';
import { buildPacket } from '../packet/packet.js';
import type { ParsedPacket } from '../packet/packet.js';
import {
  advertSignedMessage,
  buildGrpDataPlaintext,
  buildLoginRequest,
  buildPathPlaintext,
  buildTracePayload,
  buildTxtMsgPlaintext,
  parseAdvertPayload,
  parseGrpDataPlaintext,
  parseGrpTxtPlaintext,
  parsePathPlaintext,
  parseReqPlaintext,
  parseTxtMsgPlaintext,
} from '../packet/payloads.js';
import type { AdvertAppDataInit } from '../packet/payloads.js';
import {
  ackCodeSync,
  calcSharedSecretSync,
  channelHashSync,
  ed25519PublicKeySync,
  ed25519SignExpanded,
  ed25519VerifySync,
  expandSeedSync,
  macThenDecryptSync,
  packetHashSync,
  sha256Sync,
} from './crypto-sync.js';
import {
  FLOOD,
  ZERO_HOP,
  ackPayload,
  advertPayload,
  anonReqPayload,
  contactRoute,
  envelope,
  groupPayload,
  isFlood,
  parseTraceSafe,
  pathWithAck,
  peerDatagramPayload,
  tryParse,
  unsignedAdvertPayload,
} from './mesh-packets.js';
import type { SendRoute } from './mesh-packets.js';
import { RemoteNode, contactTypeOf, lppTemperature, lppVoltage } from './remote-node.js';
import type { AckPolicy, RemoteNodeConfig } from './remote-node.js';
import type { Rng } from './rng.js';
import { createSeededRng, defaultRng, randomBytes } from './rng.js';
import type {
  AirEvent,
  ChannelSlot,
  CompanionEmulatorOptions,
  ContactSeed,
  DeviceContact,
  EmulatorPrefs,
  FirmwareInfo,
  InjectAdvertInput,
  InjectChannelOptions,
  InjectMessageOptions,
} from './types.js';
import type { MeshEndpoint, RxInfo, VirtualMesh } from './virtual-mesh.js';

/** MAX_ANON_CONTACTS (`BaseChatMesh.h`): reserved slots for SEND_ANON_REQ to non-contacts. */
export const MAX_ANON_CONTACTS = 8;
const EXPECTED_ACK_TABLE_SIZE = 8;
const ADVERT_PATH_TABLE_SIZE = 16;
const ADVERT_PATH_PREFIX = 7;
const CUSTOM_VARS_LIMIT = 140;
const DEFAULT_REPEAT_FREQS: RepeatFreqRange[] = [
  { lowerKhz: 433000, upperKhz: 433000 },
  { lowerKhz: 869495, upperKhz: 869495 },
  { lowerKhz: 918000, upperKhz: 918000 },
];
const CHANNEL_FRAME_CODES: ReadonlySet<number> = new Set([RESP.CHANNEL_MSG_RECV, RESP.CHANNEL_MSG_RECV_V3, RESP.CHANNEL_DATA_RECV]);

export interface EmulatorEvents {
  /** Every frame the device writes (before the "connected" check drops it). */
  frameOut: Uint8Array;
  /** Every frame the device receives. */
  frameIn: Uint8Array;
  /** A decoded command, before it is handled. */
  command: Command;
  /** Something was "transmitted" over the air. */
  air: AirEvent;
  /** REBOOT or FACTORY_RESET: the device goes offline for `rebootDelayMs`. */
  reboot: { factoryReset: boolean };
}

interface ExpectedAck {
  ack: number;
  sentMs: number;
  contactKey: Uint8Array;
}

interface AdvertPathEntry {
  prefix: Uint8Array;
  name: string;
  recvTimestamp: number;
  pathLen: number;
  path: Uint8Array;
}

interface PendingReqs {
  login: number;
  status: number;
  telemetry: number;
  discovery: number;
  req: number;
}

const routeOf = (pathLen: number): MessageRoute => {
  if (pathLen === PATH_LEN_UNKNOWN) return { pathLen, receivedVia: 'direct', hops: null, hashSize: null };
  const i = decodePathLen(pathLen);
  return { pathLen, receivedVia: 'flood', hops: i.hops, hashSize: i.hashSize };
};

const hex = (b: Uint8Array): string => toHex(b);
const startsWith = (key: Uint8Array, prefix: Uint8Array): boolean => {
  if (prefix.length > key.length) return false;
  for (let i = 0; i < prefix.length; i++) if (key[i] !== prefix[i]) return false;
  return true;
};
const pad16 = (n: number): number => Math.ceil(n / 16) * 16;

/** Truncates UTF-8 text to `max` bytes at a code-point boundary. */
function truncateUtf8(text: string, max: number): string {
  const b = utf8Encode(text);
  if (b.length <= max) return text;
  let n = Math.max(0, max);
  while (n > 0 && (b[n]! & 0xc0) === 0x80) n--;
  return utf8Decode(b.subarray(0, n));
}

/**
 * @deprecated The emulator now derives real Ed25519 public keys (`ed25519PublicKeySync`). This old
 * FAKE derivation (SHA-256 of the private key) is kept only for callers that pass it explicitly
 * as `derivePublicKey`.
 */
export function fakeDerivePublicKey(privateKey: Uint8Array): Uint8Array {
  return sha256Sync(utf8Encode('meshcore-web-emulator-pubkey'), privateKey);
}

/**
 * Real MeshCore plain-text ACK code (mesh-packet-format.md §3.4):
 * `SHA256(timestamp u32 ‖ attempt&3 ‖ text ‖ sender pubkey)[0..4]` read as u32 LE.
 * (Synchronous u32 form; `packet/` exports the async byte form under the same name, so this one is
 * not re-exported from emulator/index.ts — use `emulatorAckCode` there.)
 */
export function computeAckCode(timestamp: number, attempt: number, text: Uint8Array, senderPubKey: Uint8Array): number {
  return ackCodeSync(concatBytes(u32le(timestamp), Uint8Array.of(attempt & 3), text), senderPubKey);
}

/** Alias of {@link computeAckCode} under a name that does not clash with `packet/`. */
export const emulatorAckCode = computeAckCode;

/** Default identity derivation: the real Ed25519 public key of a 64-byte expanded private key. */
function derivePublicKeyReal(privateKey: Uint8Array): Uint8Array {
  return ed25519PublicKeySync(privateKey);
}

const i8 = (b: number): number => (b > 127 ? b - 256 : b);

/** An advert as handled by `#onAdvertRecv`. */
interface RxAdvert {
  pubKey: Uint8Array;
  timestamp: number;
  type: number;
  name: string;
  latE6?: number;
  lonE6?: number;
  hasName: boolean;
  packet: ParsedPacket;
}

/** Text message contents, from a decrypted packet or an injection. */
interface RxText {
  txtType: number;
  text: string;
  timestamp: number;
  /** Bytes the ACK code covers (`plaintext[0 .. 5|9 + text_len)`). */
  covered: Uint8Array;
  authorPrefix?: Uint8Array;
}

function publicChannel(): ChannelSlot {
  const secret = new Uint8Array(CHANNEL_SECRET_SIZE);
  for (let i = 0; i < CHANNEL_SECRET_SIZE; i++) secret[i] = parseInt(PUBLIC_CHANNEL_SECRET_HEX.slice(i * 2, i * 2 + 2), 16);
  return { name: PUBLIC_CHANNEL_NAME, secret };
}

export class CompanionEmulator {
  readonly events = new TypedEmitter<EmulatorEvents>();
  readonly clock: EmulatorClock;
  readonly rng: Rng;
  readonly firmware: FirmwareInfo;
  readonly maxContacts: number;
  readonly maxChannels: number;
  readonly offlineQueueSize: number;
  /** Everything the device "transmitted", oldest first. */
  readonly airLog: AirEvent[] = [];

  // ---- persisted state ----
  #publicKey: Uint8Array;
  #privateKey: Uint8Array;
  #prefs: EmulatorPrefs;
  #contacts: DeviceContact[] = [];
  #anon: Array<DeviceContact | null> = new Array<DeviceContact | null>(MAX_ANON_CONTACTS).fill(null);
  #channels: ChannelSlot[];
  #customVars: Map<string, string>;
  #remoteNodes = new Map<string, RemoteNode>();

  // ---- volatile state (lost on reboot) ----
  #appTargetVer = 0;
  #queue: Uint8Array[] = [];
  #iter: { since: number; index: number; mostRecent: number } | null = null;
  #iterTimer: TimerHandle | undefined;
  #acks: Array<ExpectedAck | null> = new Array<ExpectedAck | null>(EXPECTED_ACK_TABLE_SIZE).fill(null);
  #nextAckIdx = 0;
  #pending: PendingReqs = { login: 0, status: 0, telemetry: 0, discovery: 0, req: 0 };
  #sign: { chunks: Uint8Array[]; len: number } | null = null;
  #sendScope = new Uint8Array(16);
  #sendUnscoped = false;
  #advertPaths: AdvertPathEntry[] = [];
  #connections = new Set<string>();
  #bootMs: number;
  #rtcOffsetSecs: number;
  #lastUnique = 0;
  #offline = false;
  #timers = new Set<TimerHandle>();
  #counters = { recv: 0, sent: 0, sentFlood: 0, sentDirect: 0, recvFlood: 0, recvDirect: 0, recvErrors: 0, txAirMs: 0, rxAirMs: 0 };
  #lastRssi: number;
  #lastSnr: number;
  /** Fixed noise floor from `options.radioStats`; undefined = a slow deterministic wander (see #noiseFloorNow). */
  readonly #noiseFloor: number | undefined;
  readonly #options: CompanionEmulatorOptions;

  // ---- radio / mesh ----
  #mesh: VirtualMesh | undefined;
  #meshId: string;
  readonly #endpoint: MeshEndpoint;
  #seen: string[] = [];
  #seenSet = new Set<string>();
  #secrets = new Map<string, Uint8Array>();

  // ---- host link ----
  #listeners = new Set<(frame: Uint8Array) => void>();
  #transport: FrameTransport | undefined;
  #detachTransport: Unsubscribe | undefined;

  constructor(options: CompanionEmulatorOptions = {}) {
    this.#options = options;
    this.clock = options.clock ?? systemClock;
    this.rng = options.rng ?? (options.seed !== undefined ? createSeededRng(options.seed) : defaultRng);
    this.firmware = {
      verCode: options.firmware?.verCode ?? FIRMWARE_VER_CODE,
      version: options.firmware?.version ?? FIRMWARE_VERSION,
      buildDate: options.firmware?.buildDate ?? '15 Oct 2026',
      manufacturer: options.firmware?.manufacturer ?? 'MeshCore Web Emulator',
    };
    this.maxContacts = options.maxContacts ?? 350;
    this.maxChannels = options.maxChannels ?? 8;
    this.offlineQueueSize = options.offlineQueueSize ?? 256;
    this.#bootMs = this.clock.now();
    const nowSecs = Math.floor(this.clock.now() / 1000);
    this.#rtcOffsetSecs = (options.rtcEpochSecs ?? nowSecs) - nowSecs;
    this.#noiseFloor = options.radioStats?.noiseFloorDbm;
    this.#lastRssi = options.radioStats?.lastRssiDbm ?? -80;
    this.#lastSnr = options.radioStats?.lastSnr ?? 0;

    [this.#publicKey, this.#privateKey] = this.#makeIdentity(options.identity);
    this.#appTargetVer = options.appTargetVer ?? 0;
    this.#prefs = this.#defaultPrefs();
    this.#channels = this.#initialChannels();
    this.#customVars = new Map(Object.entries(options.customVars ?? {}));
    this.#meshId = options.meshId ?? 'self';
    const self = this;
    this.#endpoint = {
      get meshId() {
        return self.#meshId;
      },
      get publicKey() {
        return self.#publicKey;
      },
      get displayName() {
        return self.#prefs.name;
      },
      receivePacket: (packet: Uint8Array, rx: RxInfo) => this.#receive(packet, rx.snr, rx.rssi, false),
    };
    this.#mesh = options.mesh; // before contacts, so their stored adverts can be signed
    for (const seed of options.contacts ?? []) this.addContact(seed);
    for (const node of options.remoteNodes ?? []) this.addRemoteNode(node);
    if (options.mesh) this.joinMesh(options.mesh, this.#meshId);
  }

  // =========================================================================
  // Virtual mesh
  // =========================================================================

  /** Puts the device's radio on a VirtualMesh (it must share this emulator's clock). */
  joinMesh(mesh: VirtualMesh, meshId = this.#meshId): void {
    this.leaveMesh();
    this.#meshId = meshId;
    this.#mesh = mesh;
    mesh.join(this.#endpoint);
  }

  leaveMesh(): void {
    this.#mesh?.leave(this.#endpoint);
    this.#mesh = undefined;
  }

  get mesh(): VirtualMesh | undefined {
    return this.#mesh;
  }

  /** The device's endpoint on the mesh (for `mesh.setLink(emulator.meshEndpoint, …)`). */
  get meshEndpoint(): MeshEndpoint {
    return this.#endpoint;
  }

  // =========================================================================
  // Host link
  // =========================================================================

  /** Registers a sink for device → host frames. While any sink is registered the device counts as "connected". */
  onFrame(cb: (frame: Uint8Array) => void): Unsubscribe {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  /**
   * Attaches the device side of a link (e.g. one end of createLoopbackPair). Host frames are
   * handled as they arrive and device frames are sent back while the transport is connected.
   */
  attach(transport: FrameTransport): Unsubscribe {
    this.#detachTransport?.();
    this.#transport = transport;
    const offFrame = transport.events.on('frame', (f) => this.handleFrame(f));
    if (transport.state === 'disconnected') void transport.connect().catch(() => undefined);
    this.#detachTransport = () => {
      offFrame();
      if (this.#transport === transport) this.#transport = undefined;
    };
    return this.#detachTransport;
  }

  /** Creates a loopback pair, attaches the device end and returns the (unconnected) host end. */
  createLoopbackTransport(options: LoopbackOptions = {}): FrameTransport {
    const [host, device] = createLoopbackPair({ names: ['Emulator', 'Emulator (device)'], clock: this.clock, ...options });
    this.attach(device);
    return host;
  }

  /** True when the firmware's `_serial->isConnected()` would be (frames are delivered). */
  get connected(): boolean {
    if (this.#offline) return false;
    const t = this.#transport;
    if (t) {
      // a loopback device end is always open; the host end decides whether the app is connected
      if (t instanceof LoopbackEndpoint && t.peer) return t.state === 'connected' && t.peer.state === 'connected';
      return t.state === 'connected';
    }
    return this.#listeners.size > 0;
  }

  /** Feeds one host → device frame (as one serial frame / one BLE write). */
  handleFrame(frame: Uint8Array): void {
    if (this.#offline || frame.length === 0) return;
    // serial: frames longer than 176 are truncated (ASI checkRecvFrame, §1.1)
    const bytes = frame.length > MAX_FRAME_SIZE ? frame.slice(0, MAX_FRAME_SIZE) : frame;
    this.events.emit('frameIn', bytes);
    const r = tryDecodeCommand(bytes);
    if (!r.ok) {
      this.#err(r.error.errCode);
      return;
    }
    this.events.emit('command', r.command);
    this.#handle(r.command);
  }

  #write(frame: DeviceFrame): void {
    let bytes: Uint8Array;
    try {
      bytes = encodeDeviceFrame(frame);
    } catch (err) {
      // writeFrame silently drops frames > MAX_FRAME_SIZE (e.g. an exported advert with a long path)
      if (err instanceof ProtocolEncodeError && err.message.includes(`max ${MAX_FRAME_SIZE}`)) return;
      throw err;
    }
    this.#writeBytes(bytes);
  }

  #writeBytes(bytes: Uint8Array): void {
    if (bytes.length > MAX_FRAME_SIZE) return;
    this.events.emit('frameOut', bytes);
    if (!this.connected) return;
    for (const cb of [...this.#listeners]) cb(bytes.slice());
    const t = this.#transport;
    if (t && t.state === 'connected') void t.send(bytes).catch(() => undefined);
  }

  #ok(): void {
    this.#writeBytes(Uint8Array.of(RESP.OK));
  }

  #err(code: number): void {
    this.#writeBytes(Uint8Array.of(RESP.ERR, code));
  }

  #schedule(fn: () => void, ms: number): TimerHandle {
    const h: TimerHandle = this.clock.setTimeout(() => {
      this.#timers.delete(h);
      if (!this.#offline) fn();
    }, ms);
    this.#timers.add(h);
    return h;
  }

  #air(e: AirEvent): void {
    this.airLog.push(e);
    this.events.emit('air', e);
  }

  /**
   * Records `e` with its on-air bytes and puts them on the mesh (if joined). `onAir: false` only
   * records them (replies to inject* calls: the injected sender is not on the air).
   */
  #transmit(e: AirEvent, raw: Uint8Array, onAir = true): void {
    // non-enumerable: deep-equality assertions on the (pre-existing) event fields are unaffected
    Object.defineProperty(e, 'raw', { value: raw, enumerable: false, writable: true, configurable: true });
    this.#air(e);
    if (!onAir) return;
    const p = tryParse(raw);
    if (p) this.#markSeen(p);
    if (this.#mesh && !this.#offline) this.#mesh.transmit(this.#endpoint, raw);
  }

  /** Flood route with the active scope (`sendFloodScoped`) and the path hash mode. */
  #floodRoute(advert = false): SendRoute {
    const def = this.#prefs.defaultScope?.key;
    let scopeKey: Uint8Array | null = null;
    if (advert) scopeKey = def ?? null;
    else if (!this.#sendUnscoped) scopeKey = this.#sendScope.some((b) => b !== 0) ? this.#sendScope : def ?? null;
    return { ...FLOOD, hashSize: this.#prefs.pathHashMode + 1, scopeKey };
  }

  #routeTo(c: DeviceContact, forceFlood = false): SendRoute {
    return forceFlood || c.outPathLen === PATH_LEN_UNKNOWN ? this.#floodRoute() : contactRoute(c.outPathLen, c.outPath);
  }

  /** ECDH secret with a peer (cached until the identity changes). */
  #secret(peer: Uint8Array): Uint8Array {
    const k = hex(peer);
    let sec = this.#secrets.get(k);
    if (!sec) {
      sec = calcSharedSecretSync(this.#privateKey, peer);
      this.#secrets.set(k, sec);
    }
    return sec;
  }

  #peerPacket(type: number, to: Uint8Array, plaintext: Uint8Array, route: SendRoute): Uint8Array {
    return envelope(type, peerDatagramPayload(to, this.#publicKey, this.#secret(to), plaintext), route);
  }

  /** `hasSeen`: records the packet hash; true if already seen. */
  #markSeen(p: ParsedPacket): boolean {
    const h = hex(packetHashSync(p));
    if (this.#seenSet.has(h)) return true;
    this.#seenSet.add(h);
    this.#seen.push(h);
    if (this.#seen.length > 256) this.#seenSet.delete(this.#seen.shift()!);
    return false;
  }

  /** A mesh node (not a legacy RemoteNode) with this key is on the air. */
  #onMesh(pubKey: Uint8Array): boolean {
    return this.#mesh?.endpoints.some((e) => e !== this.#endpoint && bytesEqual(e.publicKey, pubKey)) ?? false;
  }

  // =========================================================================
  // Read access for tests
  // =========================================================================

  get publicKey(): Uint8Array {
    return this.#publicKey.slice();
  }
  get privateKey(): Uint8Array {
    return this.#privateKey.slice();
  }
  /** A copy of the persisted preferences. */
  get prefs(): EmulatorPrefs {
    return structuredClone(this.#prefs);
  }
  /** Contacts in device order (excluding the anon slots). */
  get contacts(): DeviceContact[] {
    return this.#contacts.map((c) => structuredClone(c));
  }
  /** Occupied anon (temporary) contact slots. */
  get anonContacts(): DeviceContact[] {
    return this.#anon.filter((c): c is DeviceContact => c !== null).map((c) => structuredClone(c));
  }
  get channels(): ChannelSlot[] {
    return this.#channels.map((c) => ({ name: c.name, secret: c.secret.slice() }));
  }
  /** app_target_ver from the last DEVICE_QUERY (0 until then). */
  get appTargetVer(): number {
    return this.#appTargetVer;
  }
  /** Encoded frames waiting in the offline queue. */
  get offlineQueue(): Uint8Array[] {
    return this.#queue.map((f) => f.slice());
  }
  /** True while a GET_CONTACTS iteration is streaming. */
  get iterating(): boolean {
    return this.#iter !== null;
  }
  /** The pending-request slots (`pending_login` … `pending_req`); at most one is non-zero. */
  get pendingRequests(): Readonly<PendingReqs> {
    return { ...this.#pending };
  }
  /** Expected-ACK table entries (null = free). */
  get expectedAcks(): Array<{ ack: number; sentMs: number; contactKey: Uint8Array } | null> {
    return this.#acks.map((a) => (a ? { ...a, contactKey: a.contactKey.slice() } : null));
  }
  /** Device RTC (unix secs). */
  get rtcSecs(): number {
    return this.#rtcNow();
  }
  get uptimeMs(): number {
    return this.clock.now() - this.#bootMs;
  }
  get customVars(): Record<string, string> {
    return Object.fromEntries(this.#customVars);
  }
  get floodScope(): { key: Uint8Array; unscoped: boolean } {
    return { key: this.#sendScope.slice(), unscoped: this.#sendUnscoped };
  }
  /** True while rebooting (frames are ignored). */
  get offline(): boolean {
    return this.#offline;
  }

  getContact(pubKeyOrPrefix: Uint8Array): DeviceContact | undefined {
    const c = this.#lookup(pubKeyOrPrefix);
    return c ? structuredClone(c) : undefined;
  }

  /** A node registered with addRemoteNode (simulated without the mesh). Mesh nodes: `mesh.node(key)`. */
  getRemoteNode(pubKeyOrPrefix: Uint8Array): RemoteNode | undefined {
    for (const n of this.#remoteNodes.values()) if (startsWith(n.pubKey, pubKeyOrPrefix)) return n;
    return undefined;
  }

  /** Nodes registered with addRemoteNode (not the MeshNodes of a joined mesh). */
  get remoteNodes(): RemoteNode[] {
    return [...this.#remoteNodes.values()];
  }

  // =========================================================================
  // Setup / scenario API
  // =========================================================================

  /** Adds (or replaces) a contact directly in the device database. Returns false if full. */
  addContact(seed: ContactSeed): boolean {
    const now = this.#rtcNow();
    const outPathLen = seed.outPathLen ?? PATH_LEN_UNKNOWN;
    const c: DeviceContact = {
      pubKey: seed.pubKey.slice(),
      type: seed.type ?? ContactType.CHAT,
      flags: seed.flags ?? 0,
      outPathLen,
      outPathInfo: decodePathLen(outPathLen),
      outPath: (seed.outPath ?? new Uint8Array(0)).slice(0, decodePathLen(outPathLen).byteLength),
      name: truncateUtf8(seed.name, MAX_NAME_LEN),
      lastAdvert: seed.lastAdvert ?? now,
      lat: seed.lat ?? 0,
      lon: seed.lon ?? 0,
      lastMod: seed.lastMod ?? now,
      syncSince: 0,
    };
    // stored advert: signed when the key is a mesh node's, else with filler (it won't verify)
    c.advertPacket = seed.advertPacket ?? this.#advertBlob(c.pubKey, c.lastAdvert, {
      nodeType: c.type,
      name: c.name,
      ...(seed.lat !== undefined && seed.lon !== undefined ? { latitude: seed.lat, longitude: seed.lon } : {}),
    });
    const existing = this.#lookup(c.pubKey, PUB_KEY_SIZE);
    if (existing) {
      Object.assign(existing, c);
      return true;
    }
    return this.#storeContact(c);
  }

  /** Registers an emulated remote node; also adds it as a contact unless `addContact: false`. */
  addRemoteNode(config: RemoteNodeConfig): RemoteNode {
    const node = new RemoteNode(config);
    this.#remoteNodes.set(hex(config.pubKey), node);
    if (config.addContact ?? true) {
      const seed: ContactSeed = {
        pubKey: config.pubKey,
        name: config.name,
        type: contactTypeOf(config.type),
        flags: config.contact?.flags ?? 0,
        outPathLen: config.contact?.outPathLen ?? PATH_LEN_UNKNOWN,
      };
      if (config.contact?.outPath !== undefined) seed.outPath = config.contact.outPath;
      if (config.contact?.lastAdvert !== undefined) seed.lastAdvert = config.contact.lastAdvert;
      if (config.contact?.lastMod !== undefined) seed.lastMod = config.contact.lastMod;
      if (config.lat !== undefined) seed.lat = config.lat;
      if (config.lon !== undefined) seed.lon = config.lon;
      this.addContact(seed);
    }
    return node;
  }

  /** Writes a channel slot directly. */
  setChannelSlot(index: number, name: string, secret: Uint8Array): void {
    if (index < 0 || index >= this.maxChannels) throw new RangeError(`channel index ${index} out of range`);
    const s = new Uint8Array(CHANNEL_SECRET_SIZE);
    s.set(secret.subarray(0, CHANNEL_SECRET_SIZE));
    this.#channels[index] = { name: truncateUtf8(name, MAX_NAME_LEN), secret: s };
  }

  /** Sets the device RTC directly (unlike SET_DEVICE_TIME it may go backwards). */
  setRtc(epochSecs: number): void {
    this.#rtcOffsetSecs = epochSecs - Math.floor(this.clock.now() / 1000);
  }

  /**
   * A direct message from a contact arrives (decrypted). Returns false if the sender is not a
   * contact (the firmware cannot decrypt it). PLAIN / SIGNED_PLAIN update the contact's
   * lastmod and are ACKed with the real ACK code; CLI_COMMAND from a contact with the REMOTE_CLI
   * flag is executed instead of queued. Like every inject* call this bypasses the air: replies are
   * recorded in `airLog` (with their packet bytes) but not transmitted on a joined mesh.
   */
  injectContactMessage(from: Uint8Array, text: string, opts: InjectMessageOptions = {}): boolean {
    const contact = this.#lookup(from);
    if (!contact) return false;
    const txtType = opts.txtType ?? TxtType.PLAIN;
    const ts = opts.senderTimestamp ?? this.#rtcNow();
    const pathLen = opts.pathLen ?? 0;
    this.#countRecv(pathLen !== PATH_LEN_UNKNOWN, opts.snr);
    const signed = txtType === TxtType.SIGNED_PLAIN;
    const authorPrefix = signed ? (opts.authorPrefix ?? contact.pubKey).slice(0, SIGNED_PLAIN_AUTHOR_PREFIX_SIZE) : undefined;
    // the plaintext the sender would have encrypted (attempt 0), for a real ACK code
    const covered = concatBytes(u32le(ts), Uint8Array.of((txtType & 0x3f) << 2), authorPrefix ?? new Uint8Array(0), utf8Encode(text));
    const m: RxText = { txtType, text, timestamp: ts, covered };
    if (authorPrefix) m.authorPrefix = authorPrefix;
    return this.#acceptText(contact, m, null, pathLen, opts.snr ?? 8);
  }

  /**
   * BaseChatMesh::onPeerDataRecv + MyMesh::onMessageRecv for a text message from `contact`.
   * `via` is the received packet (null for injections: the ACK then goes along the stored path).
   */
  #acceptText(contact: DeviceContact, m: RxText, via: ParsedPacket | null, pathLen: number, snr: number): boolean {
    const floodVia = via && isFlood(via) ? via : null;
    const onAir = via !== null;
    switch (m.txtType) {
      case TxtType.PLAIN:
        contact.lastMod = this.#rtcNow();
        this.#sendAck(contact, ackCodeSync(m.covered, contact.pubKey), floodVia, onAir);
        break;
      case TxtType.SIGNED_PLAIN:
        if (m.timestamp > contact.syncSince) contact.syncSince = m.timestamp;
        contact.lastMod = this.#rtcNow();
        this.#sendAck(contact, ackCodeSync(m.covered, this.#publicKey), floodVia, onAir); // receiver key
        break;
      case TxtType.CLI_DATA:
        if (floodVia) this.#sendPathReturn(contact, floodVia, false);
        break;
      case TxtType.CLI_COMMAND:
        if (floodVia) this.#sendPathReturn(contact, floodVia, false);
        if (contact.flags & ContactFlag.REMOTE_CLI) {
          const reply = this.#runCli(m.text);
          const pt = buildTxtMsgPlaintext({ timestamp: this.#rtcUnique(), text: utf8Encode(truncateUtf8(reply, MAX_TEXT_LEN)), txtType: TxtType.CLI_DATA });
          if (onAir) this.#countSent(contact.outPathLen === PATH_LEN_UNKNOWN);
          this.#transmit({ type: 'cliReply', to: contact.pubKey.slice(), text: reply }, this.#peerPacket(PayloadType.TXT_MSG, contact.pubKey, pt, this.#routeTo(contact)), onAir);
          return true;
        }
        break;
      default:
        return false; // BCM: unsupported message type, dropped
    }
    this.#queueContactMessage(contact, m.txtType, pathLen, snr, m.timestamp, m.text, m.authorPrefix);
    return true;
  }

  /** ACK for a received message: in a flood PATH return when it came by flood, else an ACK packet. */
  #sendAck(c: DeviceContact, ack: number, floodVia: ParsedPacket | null, onAir: boolean): void {
    const raw = floodVia
      ? this.#peerPacket(PayloadType.PATH, c.pubKey, pathWithAck(floodVia.path, floodVia.pathHashSize, ack), this.#floodRoute())
      : envelope(PayloadType.ACK, ackPayload(ack), this.#routeTo(c));
    if (onAir) this.#countSent(floodVia !== null || c.outPathLen === PATH_LEN_UNKNOWN);
    this.#transmit({ type: 'ack', to: c.pubKey.slice(), ackCode: ack }, raw, onAir);
  }

  /** PATH return with no extra: by flood (CLI messages), or DIRECT as a reciprocal path. */
  #sendPathReturn(c: DeviceContact, via: ParsedPacket, direct: boolean): void {
    const pt = buildPathPlaintext({ path: via.path, hashSize: via.pathHashSize, random: randomBytes(this.rng, 4) });
    const route = direct ? this.#routeTo(c) : this.#floodRoute();
    this.#countSent(route.path === null);
    this.#transmit({ type: 'path', to: c.pubKey.slice() }, this.#peerPacket(PayloadType.PATH, c.pubKey, pt, route));
  }

  /** A channel message arrives on slot `channelIdx` ("<senderName>: <text>"). */
  injectChannelMessage(channelIdx: number, senderName: string, text: string, opts: InjectChannelOptions = {}): boolean {
    if (channelIdx < 0 || channelIdx >= this.maxChannels) return false;
    const pathLen = opts.pathLen ?? 0;
    this.#countRecv(pathLen !== PATH_LEN_UNKNOWN, opts.snr);
    this.#queueChannelText(channelIdx, `${senderName}: ${text}`, text, opts.senderTimestamp ?? this.#rtcNow(), pathLen, opts.snr ?? 8);
    return true;
  }

  #queueChannelText(channelIdx: number, fullText: string, message: string, senderTimestamp: number, pathLen: number, snr: number): void {
    const v3 = this.#appTargetVer >= V3_MESSAGES_MIN_VERSION;
    const header = v3 ? 11 : 8;
    const frame: DeviceFrame = {
      kind: 'channelMsg',
      code: v3 ? RESP.CHANNEL_MSG_RECV_V3 : RESP.CHANNEL_MSG_RECV,
      version: v3 ? 3 : 1,
      snr,
      channelIdx,
      route: routeOf(pathLen),
      txtType: TxtType.PLAIN,
      senderTimestamp,
      text: truncateUtf8(fullText, MAX_FRAME_SIZE - header),
      message,
    };
    this.#queueFrame(encodeDeviceFrame(frame));
  }

  /** A channel datagram (GRP_DATA) arrives. Dropped (returns false) if data > 167 bytes. */
  injectChannelData(channelIdx: number, dataType: number, data: Uint8Array, opts: InjectChannelOptions = {}): boolean {
    if (channelIdx < 0 || channelIdx >= this.maxChannels) return false;
    if (data.length > MAX_CHANNEL_DATA_LENGTH) return false;
    const pathLen = opts.pathLen ?? 0;
    this.#countRecv(pathLen !== PATH_LEN_UNKNOWN, opts.snr);
    this.#queueFrame(
      encodeDeviceFrame({ kind: 'channelData', code: RESP.CHANNEL_DATA_RECV, snr: opts.snr ?? 8, channelIdx, route: routeOf(pathLen), dataType, data }),
    );
    return true;
  }

  /**
   * An advert arrives over the air (BCM onAdvertRecv): updates a known contact (PUSH ADVERT),
   * auto-adds a new one (PUSH ADVERT too) or reports it with NEW_ADVERT, per the manual-add /
   * auto-add flags, hop limit and table space. Emits LOG_RX_DATA first.
   */
  injectAdvert(input: InjectAdvertInput): void {
    const pathLen = input.pathLen ?? 0;
    // default: a fresh advert (newer than the stored one, so it is not dropped as a replay)
    const known = this.#lookup(input.pubKey, PUB_KEY_SIZE);
    const timestamp = input.timestamp ?? Math.max(this.#rtcNow(), known ? known.lastAdvert + 1 : 0);
    const blob = this.#advertBlob(input.pubKey, timestamp, {
      nodeType: input.type ?? ContactType.CHAT,
      name: input.name,
      ...(input.lat !== undefined && input.lon !== undefined ? { latitude: input.lat, longitude: input.lon } : {}),
    }, input.privateKey);
    const path = input.path ?? new Uint8Array(0);
    const raw = concatBytes(Uint8Array.of(blob[0]!, pathLen), path, blob.subarray(2));
    // injected adverts are trusted: the signature is only checked for packets from the air
    this.#receive(raw, input.snr ?? 8, input.rssi ?? -70, true);
  }

  /**
   * FLOOD zero-hop advert packet for `pubKey`: signed with `privateKey`, else with the key of the
   * mesh node that owns `pubKey`, else with random filler (a signature that will not verify).
   */
  #advertBlob(pubKey: Uint8Array, timestamp: number, app: AdvertAppDataInit, privateKey?: Uint8Array): Uint8Array {
    const priv = privateKey ?? (bytesEqual(pubKey, this.#publicKey) ? this.#privateKey : this.#mesh?.identityOf(pubKey)?.privateKey);
    const payload = priv
      ? advertPayload({ publicKey: pubKey, privateKey: priv }, timestamp, app)
      : unsignedAdvertPayload(pubKey, timestamp, app, randomBytes(this.rng, 64));
    return buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, payload });
  }

  /** A PATH update from a contact replaced its out_path (PUSH PATH_UPDATED). */
  injectPathUpdate(pubKey: Uint8Array, pathLen: number, path: Uint8Array = new Uint8Array(0)): boolean {
    const c = this.#lookup(pubKey);
    if (!c) return false;
    this.#setPath(c, pathLen, path);
    this.#pathUpdated(c);
    return true;
  }

  /** An ACK packet arrives (matched against the expected-ACK table). */
  injectAck(ackCode: number): boolean {
    return this.#processAck(ackCode) !== null;
  }

  /**
   * A raw over-the-air packet is received, exactly as from the mesh: LOG_RX_DATA is pushed (if
   * connected, logging on and len + 3 ≤ 176), then the packet is de-duplicated and processed
   * (adverts with signature check, datagrams decrypted with the contacts' shared secrets, ACKs,
   * channel messages, TRACE, DIRECT RAW_CUSTOM → RAW_DATA, zero-hop CONTROL → CONTROL_DATA).
   */
  injectRxPacket(raw: Uint8Array, snr = 8, rssi = -70): void {
    this.#receive(raw, snr, rssi, false);
  }

  // =========================================================================
  // Command dispatch (MyMesh::handleCmdFrame)
  // =========================================================================

  #handle(cmd: Command): void {
    switch (cmd.kind) {
      case 'deviceQuery':
        this.#appTargetVer = cmd.appTargetVer ?? 0;
        this.#write({
          kind: 'deviceInfo',
          code: 0x0d,
          info: {
            firmwareVerCode: this.firmware.verCode,
            maxContacts: this.maxContacts,
            maxChannels: this.maxChannels,
            blePin: this.#prefs.blePin,
            buildDate: this.firmware.buildDate,
            manufacturer: this.firmware.manufacturer,
            firmwareVersion: this.firmware.version,
            clientRepeat: this.#prefs.radio.clientRepeat,
            pathHashMode: this.#prefs.pathHashMode,
          },
        });
        return;
      case 'appStart':
        this.#stopIteration(); // _iter_started = false
        this.#write(this.#selfInfoFrame());
        return;
      case 'runCliCommand':
        this.#write({ kind: 'cliReply', code: 0x1d, text: this.#runCli(cmd.command) });
        return;
      case 'sendTxtMsg':
        this.#sendTxtMsg(cmd);
        return;
      case 'sendChannelTxtMsg': {
        if ((cmd.txtType ?? 0) !== TxtType.PLAIN) return this.#err(ERR.UNSUPPORTED_CMD);
        if (cmd.channelIdx >= this.maxChannels) return this.#err(ERR.NOT_FOUND);
        const prefix = `${this.#prefs.name}: `;
        const text = truncateUtf8(prefix + cmd.text, MAX_TEXT_LEN);
        const ch = this.#channels[cmd.channelIdx]!;
        // BCM sendGroupMessage: [timestamp][flags 0]["<name>: <text>"]
        const pt = concatBytes(u32le(cmd.timestamp), Uint8Array.of(0), utf8Encode(text));
        this.#countSent(true);
        this.#transmit(
          { type: 'grpTxt', channelIdx: cmd.channelIdx, timestamp: cmd.timestamp, text },
          envelope(PayloadType.GRP_TXT, groupPayload(channelHashSync(ch.secret), ch.secret, pt), this.#floodRoute()),
        );
        return this.#ok();
      }
      case 'sendChannelData': {
        if (cmd.channelIdx >= this.maxChannels) return this.#err(ERR.NOT_FOUND);
        if (cmd.dataType === 0) return this.#err(ERR.ILLEGAL_ARG);
        if (cmd.payload.length > MAX_GROUP_DATA_LENGTH) return this.#err(ERR.ILLEGAL_ARG);
        const flood = cmd.pathLen === undefined || cmd.pathLen === PATH_LEN_UNKNOWN;
        const ch = this.#channels[cmd.channelIdx]!;
        const payload = groupPayload(channelHashSync(ch.secret), ch.secret, buildGrpDataPlaintext(cmd.dataType, cmd.payload));
        const route = flood ? this.#floodRoute() : contactRoute(cmd.pathLen!, cmd.path ?? new Uint8Array(0));
        this.#countSent(flood);
        this.#transmit({ type: 'grpData', channelIdx: cmd.channelIdx, dataType: cmd.dataType, payload: cmd.payload, flood }, envelope(PayloadType.GRP_DATA, payload, route));
        return this.#ok();
      }
      case 'getContacts':
        return this.#getContacts(cmd.since ?? 0);
      case 'setAdvertName':
        this.#prefs.name = cmd.name;
        return this.#ok();
      case 'setAdvertLatLon': {
        const lat = Math.round(cmd.lat * 1e6);
        const lon = Math.round(cmd.lon * 1e6);
        if (Math.abs(lat) > 90e6 || Math.abs(lon) > 180e6) return this.#err(ERR.ILLEGAL_ARG);
        this.#prefs.latE6 = lat;
        this.#prefs.lonE6 = lon;
        return this.#ok();
      }
      case 'getDeviceTime':
        this.#write({ kind: 'currTime', code: 0x09, epochSecs: this.#rtcNow() });
        return;
      case 'setDeviceTime':
        if (cmd.epochSecs < this.#rtcNow()) return this.#err(ERR.ILLEGAL_ARG); // clock can't go backwards
        this.setRtc(cmd.epochSecs);
        return this.#ok();
      case 'sendSelfAdvert': {
        const flood = cmd.flood === true;
        const packet = this.#selfAdvert();
        const payload = packet.subarray(2); // FLOOD, empty path → payload starts at 2
        this.#countSent(flood);
        // flood: always the default scope; zero-hop: DIRECT with path_len 0 (Mesh::sendZeroHop)
        this.#transmit({ type: 'advert', flood, packet }, envelope(PayloadType.ADVERT, payload, flood ? this.#floodRoute(true) : ZERO_HOP));
        return this.#ok();
      }
      case 'resetPath': {
        const c = this.#lookup(cmd.pubKey, PUB_KEY_SIZE);
        if (!c) return this.#err(ERR.NOT_FOUND);
        this.#setPath(c, PATH_LEN_UNKNOWN, new Uint8Array(0)); // lastmod unchanged
        return this.#ok();
      }
      case 'addUpdateContact':
        return this.#addUpdateContact(cmd.contact);
      case 'removeContact': {
        const idx = this.#contacts.findIndex((c) => bytesEqual(c.pubKey, cmd.pubKey));
        if (idx >= 0) {
          this.#contacts.splice(idx, 1);
          if (this.#iter && this.#iter.index > idx) this.#iter.index--; // array shifts under the iterator
          return this.#ok();
        }
        const a = this.#anon.findIndex((c) => c !== null && bytesEqual(c.pubKey, cmd.pubKey));
        if (a >= 0) {
          this.#anon[a] = null;
          return this.#ok();
        }
        return this.#err(ERR.NOT_FOUND);
      }
      case 'shareContact': {
        const c = this.#lookup(cmd.pubKey, PUB_KEY_SIZE);
        if (!c) return this.#err(ERR.NOT_FOUND);
        if (!c.advertPacket) return this.#err(ERR.TABLE_FULL);
        const stored = tryParse(c.advertPacket);
        if (!stored) return this.#err(ERR.TABLE_FULL);
        this.#countSent(false);
        // re-broadcast zero-hop as TRANSPORT_DIRECT with codes {0, 0} (`RPT isShare`, §1.2)
        const raw = buildPacket({ routeType: RouteType.TRANSPORT_DIRECT, payloadType: PayloadType.ADVERT, transportCodes: [0, 0], payload: stored.payload });
        this.#transmit({ type: 'shareContact', pubKey: c.pubKey.slice(), packet: c.advertPacket.slice() }, raw);
        return this.#ok();
      }
      case 'getContactByKey': {
        const c = this.#lookup(cmd.pubKey, PUB_KEY_SIZE);
        if (!c) return this.#err(ERR.NOT_FOUND);
        this.#write({ kind: 'contact', code: 0x03, contact: c });
        return;
      }
      case 'exportContact': {
        if (cmd.pubKey === undefined) {
          this.#write({ kind: 'exportContact', code: 0x0b, packet: this.#selfAdvert() });
          return;
        }
        const c = this.#lookup(cmd.pubKey, PUB_KEY_SIZE);
        if (!c?.advertPacket) return this.#err(ERR.NOT_FOUND);
        this.#write({ kind: 'exportContact', code: 0x0b, packet: c.advertPacket });
        return;
      }
      case 'importContact': {
        const env = tryParse(cmd.packet);
        if (!env || env.payloadType !== PayloadType.ADVERT) return this.#err(ERR.ILLEGAL_ARG);
        this.#ok();
        // looped back as if received flood, processed on the next loop iteration (signature checked)
        const raw = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, path: env.path, pathHashSize: env.pathHashSize, payload: env.payload });
        this.#schedule(() => {
          const p = tryParse(raw);
          if (p) this.#rxAdvert(p, false);
        }, 0);
        return;
      }
      case 'syncNextMessage': {
        const next = this.#queue.shift();
        if (next) this.#writeBytes(next);
        else this.#writeBytes(Uint8Array.of(RESP.NO_MORE_MESSAGES));
        return;
      }
      case 'setRadioParams': {
        const repeat = cmd.clientRepeat === true;
        if (repeat && !this.#allowedRepeat(cmd.freqKhz)) return this.#err(ERR.ILLEGAL_ARG);
        if (
          cmd.freqKhz < 150000 || cmd.freqKhz > 2500000 || cmd.sf < 5 || cmd.sf > 12 ||
          cmd.cr < 5 || cmd.cr > 8 || cmd.bwHz < 7000 || cmd.bwHz > 500000
        ) {
          return this.#err(ERR.ILLEGAL_ARG);
        }
        Object.assign(this.#prefs.radio, { freqKhz: cmd.freqKhz, bwHz: cmd.bwHz, sf: cmd.sf, cr: cmd.cr, clientRepeat: repeat });
        return this.#ok();
      }
      case 'setRadioTxPower':
        if (cmd.dbm < -9 || cmd.dbm > this.#prefs.radio.maxTxPowerDbm) return this.#err(ERR.ILLEGAL_ARG);
        this.#prefs.radio.txPowerDbm = cmd.dbm;
        return this.#ok();
      case 'setTuningParams':
        this.#prefs.rxDelayBaseMilli = Math.round(cmd.rxDelayBase * 1000);
        this.#prefs.airtimeFactorMilli = Math.round(cmd.airtimeFactor * 1000);
        return this.#ok();
      case 'getTuningParams':
        this.#write({
          kind: 'tuningParams',
          code: 0x17,
          rxDelayBase: this.#prefs.rxDelayBaseMilli / 1000,
          airtimeFactor: this.#prefs.airtimeFactorMilli / 1000,
        });
        return;
      case 'setOtherParams':
        this.#prefs.manualAddContacts = cmd.manualAddContacts;
        if (cmd.telemetryModes) this.#prefs.telemetryModes = packTelemetryModes(cmd.telemetryModes);
        if (cmd.advertLocPolicy !== undefined) this.#prefs.advertLocPolicy = cmd.advertLocPolicy;
        if (cmd.multiAcks !== undefined) this.#prefs.multiAcks = cmd.multiAcks;
        return this.#ok();
      case 'setPathHashMode':
        if (cmd.mode >= 3) return this.#err(ERR.ILLEGAL_ARG);
        this.#prefs.pathHashMode = cmd.mode;
        return this.#ok();
      case 'reboot':
        this.#reboot(false);
        return;
      case 'getBattAndStorage': {
        const b = this.#options.battery ?? {};
        this.#write({
          kind: 'battAndStorage',
          code: 0x0c,
          batt: { batteryMv: b.mv ?? 4100, storageUsedKb: b.storageUsedKb ?? 48, storageTotalKb: b.storageTotalKb ?? 1024 },
        });
        return;
      }
      case 'exportPrivateKey':
        if (this.#options.privateKeyExport === false) return this.#writeBytes(Uint8Array.of(RESP.DISABLED));
        this.#write({ kind: 'privateKey', code: 0x0e, privateKey: this.#privateKey });
        return;
      case 'importPrivateKey': {
        if (this.#options.privateKeyImport === false) return this.#writeBytes(Uint8Array.of(RESP.DISABLED));
        // validatePrivateKey: reject an all-zero key and keys whose public key starts with a
        // reserved hash byte (0x00 / 0xFF). The key is the 64-byte *expanded* key; its public key
        // is re-derived from the scalar half, so any real exported key works (no seed needed).
        if (cmd.privateKey.every((b) => b === 0)) return this.#err(ERR.ILLEGAL_ARG);
        if (!bytesEqual(cmd.privateKey, this.#privateKey)) {
          const pub = (this.#options.derivePublicKey ?? derivePublicKeyReal)(cmd.privateKey).slice(0, PUB_KEY_SIZE);
          if (pub[0] === 0x00 || pub[0] === 0xff) return this.#err(ERR.ILLEGAL_ARG);
          this.#privateKey = cmd.privateKey.slice();
          this.#publicKey = pub;
          this.#secrets.clear();
        }
        this.#anon.fill(null); // resetContacts() + reload: temporary anon slots are dropped
        return this.#ok();
      }
      case 'sendRawData':
        this.#countSent(false);
        this.#transmit(
          { type: 'rawData', pathLen: cmd.pathLen, path: cmd.path, payload: cmd.payload },
          envelope(PayloadType.RAW_CUSTOM, cmd.payload, contactRoute(cmd.pathLen, cmd.path)),
        );
        return this.#ok();
      case 'sendLogin':
        return this.#sendLogin(cmd.pubKey, cmd.password);
      case 'sendAnonReq':
        return this.#sendAnonReq(cmd.pubKey, cmd.data);
      case 'sendStatusReq':
        return this.#sendRequest('status', cmd.pubKey, Uint8Array.of(ReqType.GET_STATUS));
      case 'sendPathDiscoveryReq':
        return this.#sendRequest('discovery', cmd.pubKey, Uint8Array.of(ReqType.GET_TELEMETRY_DATA, ~TelemetryPerm.BASE & 0xff));
      case 'sendTelemetryReq':
        if (cmd.pubKey === undefined) {
          this.#write({ kind: 'telemetryResponse', code: 0x8b, pubKeyPrefix: this.#publicKey.slice(0, 6), lpp: this.#selfTelemetry() });
          return;
        }
        return this.#sendRequest('telemetry', cmd.pubKey, Uint8Array.of(ReqType.GET_TELEMETRY_DATA));
      case 'sendBinaryReq':
        return this.#sendRequest('binary', cmd.pubKey, cmd.data);
      case 'hasConnection':
        return this.#connections.has(hex(cmd.pubKey)) ? this.#ok() : this.#err(ERR.NOT_FOUND);
      case 'logout':
        this.#connections.delete(hex(cmd.pubKey));
        return this.#ok();
      case 'getChannel': {
        const ch = this.#channels[cmd.index];
        if (cmd.index >= this.maxChannels || !ch) return this.#err(ERR.NOT_FOUND);
        this.#write({ kind: 'channelInfo', code: 0x12, channel: { index: cmd.index, name: ch.name, secret: ch.secret } });
        return;
      }
      case 'setChannel':
        if (cmd.index >= this.maxChannels) return this.#err(ERR.NOT_FOUND);
        this.setChannelSlot(cmd.index, cmd.name, cmd.secret);
        return this.#ok();
      case 'signStart':
        this.#write({ kind: 'signStart', code: 0x13, maxLen: MAX_SIGN_DATA_LEN });
        this.#sign = { chunks: [], len: 0 };
        return;
      case 'signData':
        if (!this.#sign) return this.#err(ERR.BAD_STATE);
        if (this.#sign.len + cmd.chunk.length > MAX_SIGN_DATA_LEN) return this.#err(ERR.TABLE_FULL);
        this.#sign.chunks.push(cmd.chunk);
        this.#sign.len += cmd.chunk.length;
        return this.#ok();
      case 'signFinish': {
        if (!this.#sign) return this.#err(ERR.BAD_STATE);
        // real Ed25519 signature with the device's expanded key (orlp ed25519_sign)
        const signature = ed25519SignExpanded(this.#privateKey, this.#publicKey, concatBytes(...this.#sign.chunks));
        this.#sign = null;
        this.#write({ kind: 'signature', code: 0x14, signature });
        return;
      }
      case 'sendTracePath':
        return this.#sendTrace(cmd.tag, cmd.authCode, cmd.pathHashSize ?? 1, cmd.path);
      case 'setDevicePin':
        if (cmd.pin !== 0 && (cmd.pin < 100000 || cmd.pin > 999999)) return this.#err(ERR.ILLEGAL_ARG);
        this.#prefs.blePin = cmd.pin;
        return this.#ok();
      case 'getCustomVars': {
        let raw = '';
        let i = 0;
        for (const [k, v] of this.#customVars) {
          if (utf8Encode(raw).length >= CUSTOM_VARS_LIMIT) break;
          raw += `${i++ > 0 ? ',' : ''}${k}:${v}`;
        }
        this.#write({ kind: 'customVars', code: 0x15, raw, vars: [] });
        return;
      }
      case 'setCustomVar':
        if (!this.#customVars.has(cmd.name)) return this.#err(ERR.ILLEGAL_ARG);
        this.#customVars.set(cmd.name, cmd.value);
        return this.#ok();
      case 'getAdvertPath': {
        const p = this.#advertPaths.find((e) => startsWith(cmd.pubKey, e.prefix));
        if (!p) return this.#err(ERR.NOT_FOUND);
        this.#write({ kind: 'advertPath', code: 0x16, recvTimestamp: p.recvTimestamp, pathLen: p.pathLen, pathInfo: decodePathLen(p.pathLen), path: p.path });
        return;
      }
      case 'factoryReset':
        // interfaces are disabled first, so the OK is never seen by the app
        this.#factoryReset();
        return;
      case 'setFloodScopeKey':
        if (cmd.unscoped) {
          this.#sendUnscoped = true;
        } else {
          this.#sendScope = cmd.key ? cmd.key.slice() : new Uint8Array(16);
          this.#sendUnscoped = false;
        }
        return this.#ok();
      case 'sendControlData':
        this.#countSent(false);
        this.#transmit({ type: 'controlData', payload: cmd.payload }, envelope(PayloadType.CONTROL, cmd.payload, ZERO_HOP));
        return this.#ok();
      case 'getStats':
        // fw < v8 has no CMD_GET_STATS: the default branch answers ERR_CODE_UNSUPPORTED_CMD
        if (this.firmware.verCode < 8) return this.#err(ERR.UNSUPPORTED_CMD);
        return this.#getStats(cmd.statsType);
      case 'setAutoAddConfig':
        this.#prefs.autoAddConfig = cmd.config;
        if (cmd.maxHops !== undefined) this.#prefs.autoAddMaxHops = Math.min(cmd.maxHops, 64);
        return this.#ok();
      case 'getAutoAddConfig':
        this.#write({ kind: 'autoAddConfig', code: 0x19, config: this.#prefs.autoAddConfig, maxHops: this.#prefs.autoAddMaxHops });
        return;
      case 'getAllowedRepeatFreq':
        this.#write({ kind: 'allowedRepeatFreq', code: 0x1a, ranges: this.#options.allowedRepeatFreqs ?? DEFAULT_REPEAT_FREQS });
        return;
      case 'setDefaultFloodScope':
        this.#prefs.defaultScope = cmd.scope ? { name: cmd.scope.name, key: cmd.scope.key.slice() } : null;
        return this.#ok();
      case 'getDefaultFloodScope':
        this.#write({ kind: 'defaultFloodScope', code: 0x1c, scope: this.#prefs.defaultScope });
        return;
      case 'sendRawPacket':
        if (!tryParse(cmd.packet)) return this.#err(ERR.ILLEGAL_ARG);
        this.#countSent(false);
        this.#transmit({ type: 'rawPacket', priority: cmd.priority, packet: cmd.packet }, cmd.packet.slice());
        return this.#ok();
      case 'raw':
        return this.#err(ERR.UNSUPPORTED_CMD); // never produced by decodeCommand
    }
  }

  // =========================================================================
  // Contacts (§7)
  // =========================================================================

  /** lookupContactByPubKey: anon slots first (they come first in contacts[]), then contacts. */
  #lookup(prefix: Uint8Array, len = prefix.length): DeviceContact | undefined {
    const p = prefix.subarray(0, len);
    for (const c of this.#anon) if (c && startsWith(c.pubKey, p)) return c;
    return this.#contacts.find((c) => startsWith(c.pubKey, p));
  }

  /** allocateContactSlot + copy. Type NONE goes to an anon slot. */
  #storeContact(c: DeviceContact): boolean {
    if (c.type === ContactType.NONE) {
      let idx = this.#anon.findIndex((s) => s === null);
      if (idx < 0) {
        let oldest = Infinity;
        this.#anon.forEach((s, i) => {
          if (s && s.lastMod < oldest) {
            oldest = s.lastMod;
            idx = i;
          }
        });
      }
      if (idx < 0) return false;
      this.#anon[idx] = c;
      return true;
    }
    if (this.#contacts.length < this.maxContacts) {
      this.#contacts.push(c);
      return true;
    }
    if (this.#prefs.autoAddConfig & AutoAddFlag.OVERWRITE_OLDEST) {
      let idx = -1;
      let oldest = Infinity;
      this.#contacts.forEach((s, i) => {
        if ((s.flags & ContactFlag.FAVOURITE) === 0 && s.lastMod < oldest) {
          oldest = s.lastMod;
          idx = i;
        }
      });
      if (idx >= 0) {
        this.#write({ kind: 'contactDeleted', code: 0x8f, pubKey: this.#contacts[idx]!.pubKey });
        this.#contacts[idx] = c;
        return true;
      }
    }
    return false;
  }

  #addUpdateContact(input: ContactInput): void {
    const lastMod = input.lastMod ?? this.#rtcNow();
    const existing = this.#lookup(input.pubKey, PUB_KEY_SIZE);
    const pathLen = input.outPathLen;
    const target: DeviceContact = existing ?? {
      pubKey: input.pubKey.slice(),
      type: 0,
      flags: 0,
      outPathLen: PATH_LEN_UNKNOWN,
      outPathInfo: decodePathLen(PATH_LEN_UNKNOWN),
      outPath: new Uint8Array(0),
      name: '',
      lastAdvert: 0,
      lat: 0,
      lon: 0,
      lastMod: 0,
      syncSince: 0,
    };
    target.type = input.type;
    target.flags = input.flags;
    target.outPathLen = pathLen;
    target.outPathInfo = decodePathLen(pathLen);
    target.outPath = (input.outPath ?? new Uint8Array(0)).slice();
    target.name = input.name;
    target.lastAdvert = input.lastAdvert;
    if (input.lat !== undefined && input.lon !== undefined) {
      target.lat = input.lat;
      target.lon = input.lon;
    }
    target.lastMod = lastMod;
    if (existing) return this.#ok();
    return this.#storeContact(target) ? this.#ok() : this.#err(ERR.TABLE_FULL);
  }

  #getContacts(since: number): void {
    if (this.#iter) return this.#err(ERR.BAD_STATE);
    this.#write({ kind: 'contactsStart', code: 0x02, total: this.#contacts.length }); // total, NOT filtered
    this.#iter = { since, index: 0, mostRecent: 0 };
    this.#scheduleIterStep();
  }

  #scheduleIterStep(): void {
    this.#iterTimer = this.#schedule(() => this.#iterStep(), this.#options.contactIntervalMs ?? 0);
  }

  /** One main-loop visit of the ContactsIterator (`checkSerialInterface`). */
  #iterStep(): void {
    const it = this.#iter;
    if (!it) return;
    const c = this.#contacts[it.index];
    if (c) {
      it.index++;
      if (c.lastMod > it.since) {
        // strictly greater than
        this.#write({ kind: 'contact', code: 0x03, contact: c });
        if (c.lastMod > it.mostRecent) it.mostRecent = c.lastMod;
      }
      this.#scheduleIterStep();
      return;
    }
    this.#write({ kind: 'endOfContacts', code: 0x04, mostRecentLastMod: it.mostRecent });
    this.#iter = null;
  }

  #stopIteration(): void {
    this.#iter = null;
    if (this.#iterTimer !== undefined) {
      this.clock.clearTimeout(this.#iterTimer);
      this.#timers.delete(this.#iterTimer);
      this.#iterTimer = undefined;
    }
  }

  #setPath(c: DeviceContact, pathLen: number, path: Uint8Array): void {
    const info = decodePathLen(pathLen);
    c.outPathLen = pathLen;
    c.outPathInfo = info;
    c.outPath = path.slice(0, info.byteLength);
  }

  #pathUpdated(c: DeviceContact): void {
    c.lastMod = this.#rtcNow();
    // onContactPathUpdated writes even when the app is not connected (then dropped by the link)
    this.#write({ kind: 'pathUpdated', code: 0x81, pubKey: c.pubKey });
  }

  #shouldAutoAdd(type: number): boolean {
    if ((this.#prefs.manualAddContacts & 1) === 0) return true;
    const bit =
      type === ContactType.CHAT ? AutoAddFlag.CHAT
      : type === ContactType.REPEATER ? AutoAddFlag.REPEATER
      : type === ContactType.ROOM ? AutoAddFlag.ROOM
      : type === ContactType.SENSOR ? AutoAddFlag.SENSOR
      : 0;
    return bit !== 0 && (this.#prefs.autoAddConfig & bit) !== 0;
  }

  /** BaseChatMesh::onAdvertRecv + MyMesh::onDiscoveredContact (§7.3). */
  #onAdvertRecv(adv: RxAdvert): void {
    if (!adv.hasName) return;
    const env = adv.packet;
    let from = this.#lookup(adv.pubKey, PUB_KEY_SIZE);
    if (from && adv.timestamp <= from.lastAdvert) return; // replay protection, no push
    // stored as FLOOD without transport codes, keeping the path (`BCM onAdvertRecv`)
    const blob = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, path: env.path, pathHashSize: env.pathHashSize, payload: env.payload });
    if (from && from.type === ContactType.NONE) {
      const i = this.#anon.indexOf(from);
      if (i >= 0) this.#anon[i] = null; // clear the temporary anon slot, then normal add flow
      from = undefined;
    }
    const populate = (): DeviceContact => ({
      pubKey: adv.pubKey.slice(),
      type: adv.type,
      flags: 0,
      outPathLen: PATH_LEN_UNKNOWN,
      outPathInfo: decodePathLen(PATH_LEN_UNKNOWN),
      outPath: new Uint8Array(0),
      name: truncateUtf8(adv.name, MAX_NAME_LEN),
      lastAdvert: adv.timestamp,
      lat: adv.latE6 !== undefined ? adv.latE6 / 1e6 : 0,
      lon: adv.lonE6 !== undefined ? adv.lonE6 / 1e6 : 0,
      lastMod: this.#rtcNow(),
      syncSince: 0,
    });
    if (!from) {
      const hops = env.pathLen & 63;
      const maxHops = this.#prefs.autoAddMaxHops;
      if (!this.#shouldAutoAdd(adv.type) || (maxHops > 0 && hops >= maxHops)) {
        this.#discovered(populate(), true, env.pathLen, env.path);
        return;
      }
      const fresh = populate();
      if (!this.#storeContact(fresh)) {
        this.#discovered(fresh, true, env.pathLen, env.path);
        this.#write({ kind: 'contactsFull', code: 0x90 });
        return;
      }
      from = fresh;
    }
    from.advertPacket = blob;
    from.name = truncateUtf8(adv.name, MAX_NAME_LEN);
    from.type = adv.type;
    if (adv.latE6 !== undefined && adv.lonE6 !== undefined) {
      from.lat = adv.latE6 / 1e6;
      from.lon = adv.lonE6 / 1e6;
    }
    from.lastAdvert = adv.timestamp;
    from.lastMod = this.#rtcNow();
    this.#discovered(from, false, env.pathLen, env.path); // is_new stays false even for auto-added contacts
  }

  #discovered(c: DeviceContact, isNew: boolean, pathLen: number, path: Uint8Array): void {
    if (isNew) this.#write({ kind: 'newAdvert', code: 0x8a, contact: c });
    else this.#write({ kind: 'advert', code: 0x80, pubKey: c.pubKey });
    if (!isValidPathLen(pathLen)) return;
    const prefix = c.pubKey.slice(0, ADVERT_PATH_PREFIX);
    let entry = this.#advertPaths.find((e) => bytesEqual(e.prefix, prefix));
    if (!entry) {
      if (this.#advertPaths.length >= ADVERT_PATH_TABLE_SIZE) {
        let oldest = 0;
        this.#advertPaths.forEach((e, i) => {
          if (e.recvTimestamp < this.#advertPaths[oldest]!.recvTimestamp) oldest = i;
        });
        this.#advertPaths.splice(oldest, 1);
      }
      entry = { prefix, name: c.name, recvTimestamp: 0, pathLen: 0, path: new Uint8Array(0) };
      this.#advertPaths.push(entry);
    }
    entry.name = c.name;
    entry.recvTimestamp = this.#rtcNow();
    entry.pathLen = pathLen;
    entry.path = path.slice(0, decodePathLen(pathLen).byteLength);
  }

  // =========================================================================
  // Messages (§6.1-§6.5, §8)
  // =========================================================================

  #queueContactMessage(
    from: DeviceContact,
    txtType: number,
    pathLen: number,
    snr: number,
    senderTimestamp: number,
    text: string,
    authorPrefix?: Uint8Array,
  ): void {
    const v3 = this.#appTargetVer >= V3_MESSAGES_MIN_VERSION;
    const signed = txtType === TxtType.SIGNED_PLAIN;
    const header = (v3 ? 16 : 13) + (signed ? SIGNED_PLAIN_AUTHOR_PREFIX_SIZE : 0);
    const frame: DeviceFrame = {
      kind: 'contactMsg',
      code: v3 ? RESP.CONTACT_MSG_RECV_V3 : RESP.CONTACT_MSG_RECV,
      version: v3 ? 3 : 1,
      snr,
      senderPrefix: from.pubKey.slice(0, PUB_KEY_PREFIX_SIZE),
      route: routeOf(pathLen),
      txtType,
      senderTimestamp,
      text: truncateUtf8(text, MAX_FRAME_SIZE - header), // queueMessage truncates to the frame
    };
    if (signed) frame.authorPrefix = (authorPrefix ?? from.pubKey).slice(0, SIGNED_PLAIN_AUTHOR_PREFIX_SIZE);
    this.#queueFrame(encodeDeviceFrame(frame));
  }

  /** addToOfflineQueue + MSG_WAITING (§6.1). */
  #queueFrame(frame: Uint8Array): void {
    if (this.#queue.length >= this.offlineQueueSize) {
      const idx = this.#queue.findIndex((f) => CHANNEL_FRAME_CODES.has(f[0]!));
      if (idx >= 0) {
        this.#queue.splice(idx, 1); // evict the oldest channel frame
        this.#queue.push(frame);
      }
      // else: the new frame is silently dropped
    } else {
      this.#queue.push(frame);
    }
    this.#writeBytes(Uint8Array.of(0x83)); // MSG_WAITING, even if dropped
  }

  #sendTxtMsg(cmd: Command & { kind: 'sendTxtMsg' }): void {
    const recipient = this.#lookup(cmd.recipient, PUB_KEY_PREFIX_SIZE);
    const txtType = cmd.txtType ?? TxtType.PLAIN;
    if (!recipient) return this.#err(ERR.NOT_FOUND);
    if (txtType !== TxtType.PLAIN && txtType !== TxtType.CLI_DATA && txtType !== TxtType.CLI_COMMAND) {
      return this.#err(ERR.UNSUPPORTED_CMD);
    }
    const attempt = cmd.attempt ?? 0;
    const text = utf8Encode(cmd.text);
    const plain = txtType === TxtType.PLAIN;
    if (text.length > MAX_TEXT_LEN || (plain && attempt > 3 && text.length > MAX_TEXT_LEN - 2)) {
      return this.#err(ERR.TABLE_FULL); // composeMsgPacket fails → MSG_SEND_FAILED
    }
    // CLI types use the device's unique RTC time to avoid tripping replay protection
    const timestamp = plain ? cmd.timestamp : this.#rtcUnique();
    const ack = plain ? computeAckCode(timestamp, attempt, text, this.#publicKey) : 0;
    const flood = recipient.outPathLen === PATH_LEN_UNKNOWN;
    const plainLen = 5 + text.length + (plain && attempt > 3 ? 2 : 0);
    const est = this.#estTimeout(recipient, 4 + pad16(plainLen));
    if (ack) {
      this.#acks[this.#nextAckIdx] = { ack, sentMs: this.clock.now(), contactKey: recipient.pubKey.slice() };
      this.#nextAckIdx = (this.#nextAckIdx + 1) % EXPECTED_ACK_TABLE_SIZE;
    }
    this.#countSent(flood);
    this.#write({ kind: 'sent', code: 0x06, flood, tag: ack, tagBytes: u32le(ack), estTimeoutMs: est });
    const pt = buildTxtMsgPlaintext({ timestamp, text, txtType, attempt });
    this.#transmit(
      { type: 'txtMsg', to: recipient.pubKey.slice(), txtType, attempt, timestamp, text: cmd.text, flood, ackCode: ack },
      this.#peerPacket(PayloadType.TXT_MSG, recipient.pubKey, pt, this.#routeTo(recipient)),
    );

    // nodes on the mesh answer by themselves; everything else is simulated directly
    const node = this.#remoteNodes.get(hex(recipient.pubKey));
    if (!node && this.#onMesh(recipient.pubKey)) return;
    if (node) node.messages.push({ text: cmd.text, txtType, attempt, timestamp });
    if (node && !node.online) return;
    if (plain) {
      const policy: AckPolicy = node?.config.ackPolicy ?? this.#options.defaultAckPolicy ?? 'auto';
      const acked = policy === 'auto' || (typeof policy === 'object' && attempt >= policy.minAttempt);
      const delay = node?.config.ackDelayMs ?? this.#options.defaultAckDelayMs ?? 300;
      if (acked) {
        const key = recipient.pubKey.slice();
        this.#schedule(() => {
          const c = this.#lookup(key, PUB_KEY_SIZE);
          // a flood-sent message is ACKed inside a PATH packet: path update first, then the ACK
          if (c && flood && node?.config.returnPath !== null) {
            const rp = node?.config.returnPath ?? { pathLen: 0 };
            this.#setPath(c, rp.pathLen, rp.path ?? new Uint8Array(0));
            this.#pathUpdated(c);
          }
          this.#processAck(ack);
        }, delay);
      }
      const reply = node?.config.autoReply?.(cmd.text);
      if (node && reply) {
        this.#schedule(() => this.injectContactMessage(node.pubKey, reply), delay + node.responseDelayMs);
      }
    } else if (txtType === TxtType.CLI_COMMAND && node) {
      const reply = node.cliReply(cmd.text);
      if (reply !== null) {
        this.#schedule(
          () => this.injectContactMessage(node.pubKey, reply, { txtType: TxtType.CLI_DATA, senderTimestamp: this.#rtcNow() }),
          node.responseDelayMs,
        );
      }
    }
  }

  /** processAck: matches the 8-slot table, pushes SEND_CONFIRMED once per entry. */
  #processAck(ack: number): DeviceContact | null {
    for (let i = 0; i < this.#acks.length; i++) {
      const e = this.#acks[i];
      if (e && e.ack === ack) {
        this.#write({ kind: 'sendConfirmed', code: 0x82, ackCode: ack, ackBytes: u32le(ack), roundTripMs: Math.max(0, this.clock.now() - e.sentMs) });
        this.#acks[i] = null;
        return this.#lookup(e.contactKey, PUB_KEY_SIZE) ?? null;
      }
    }
    return null;
  }

  // =========================================================================
  // Remote requests (§4 notes, §6.6-§6.10)
  // =========================================================================

  #clearPending(): void {
    this.#pending = { login: 0, status: 0, telemetry: 0, discovery: 0, req: 0 };
  }

  #sendLogin(pubKey: Uint8Array, password: string): void {
    const c = this.#lookup(pubKey, PUB_KEY_SIZE);
    if (!c) return this.#err(ERR.NOT_FOUND);
    const pw = truncateUtf8(password, 15); // max 15 chars used
    const pwLen = utf8Encode(pw).length;
    const flood = c.outPathLen === PATH_LEN_UNKNOWN;
    // ANON_REQ: dest hash, sender pubkey, MAC, ciphertext of [ts][sync_since (room)][password]
    const est = this.#estTimeout(c, 1 + PUB_KEY_SIZE + 2 + pad16((c.type === ContactType.ROOM ? 8 : 4) + pwLen));
    this.#clearPending();
    this.#pending.login = readU32LE(c.pubKey, 0);
    this.#countSent(flood);
    this.#write({ kind: 'sent', code: 0x06, flood, tag: this.#pending.login, tagBytes: c.pubKey.slice(0, 4), estTimeoutMs: est });
    // BCM sendLogin: [now][sync_since (room)][password]
    const pt = buildLoginRequest({ timestamp: this.#rtcUnique(), password: pw, ...(c.type === ContactType.ROOM ? { syncSince: c.syncSince } : {}) });
    this.#transmit(
      { type: 'request', kind: 'login', to: c.pubKey.slice(), tag: this.#pending.login, flood, data: utf8Encode(pw) },
      envelope(PayloadType.ANON_REQ, anonReqPayload(c.pubKey, this.#publicKey, this.#secret(c.pubKey), pt), this.#routeTo(c)),
    );
    const node = this.#remoteNodes.get(hex(c.pubKey));
    node?.requests.push({ kind: 'login', data: utf8Encode(pw) });
    if (!node?.online) return;
    this.#schedule(() => {
      const resp = node.loginResponse(pw, this.#rtcNow(), this.rng);
      if (resp) this.#deliverResponse(c.pubKey, resp, flood, node);
    }, node.responseDelayMs);
  }

  #sendAnonReq(pubKey: Uint8Array, data: Uint8Array): void {
    let c = this.#lookup(pubKey, PUB_KEY_SIZE);
    if (!c) {
      // v13+: temporary anon contact, zero-hop direct
      const anon: DeviceContact = {
        pubKey: pubKey.slice(),
        type: ContactType.NONE,
        flags: 0,
        outPathLen: 0,
        outPathInfo: decodePathLen(0),
        outPath: new Uint8Array(0),
        name: '',
        lastAdvert: 0,
        lat: 0,
        lon: 0,
        lastMod: this.#rtcNow(),
        syncSince: 0,
      };
      if (!this.#storeContact(anon)) return this.#err(ERR.TABLE_FULL);
      c = anon;
    }
    this.#dispatchRequest('anon', c, data, 1 + PUB_KEY_SIZE + 2 + pad16(4 + data.length));
  }

  #sendRequest(kind: 'status' | 'telemetry' | 'binary' | 'discovery', pubKey: Uint8Array, data: Uint8Array): void {
    const c = this.#lookup(pubKey, PUB_KEY_SIZE);
    if (!c) return this.#err(ERR.NOT_FOUND);
    // sendRequest(type): 13-byte plaintext; sendRequest(data): 4 + data
    const plain = kind === 'binary' ? 4 + data.length : kind === 'discovery' ? 4 + 9 : 13;
    if (kind === 'binary' && data.length > 184 - 16) return this.#err(ERR.TABLE_FULL);
    this.#dispatchRequest(kind, c, data, 4 + pad16(plain));
  }

  #dispatchRequest(kind: 'status' | 'telemetry' | 'binary' | 'discovery' | 'anon', c: DeviceContact, data: Uint8Array, payloadLen: number): void {
    const forcedFlood = kind === 'discovery'; // path discovery temporarily forces flood
    if (kind === 'anon' && data.length + 4 > 184 - 33 - 2 - 15) return this.#err(ERR.TABLE_FULL); // createAnonDatagram guard
    const flood = forcedFlood || c.outPathLen === PATH_LEN_UNKNOWN;
    const tag = this.#rtcUnique();
    const est = this.#estTimeout(c, payloadLen, forcedFlood);
    this.#clearPending();
    switch (kind) {
      case 'status':
        this.#pending.status = readU32LE(c.pubKey, 0); // legacy matching by pubkey prefix
        break;
      case 'telemetry':
        this.#pending.telemetry = tag;
        break;
      case 'discovery':
        this.#pending.discovery = tag;
        break;
      default:
        this.#pending.req = tag;
    }
    this.#countSent(flood);
    this.#write({ kind: 'sent', code: 0x06, flood, tag, tagBytes: u32le(tag), estTimeoutMs: est });
    // plaintext: [tag][data]; GET_STATUS/TELEMETRY add [mask][3 reserved][4 random] (`BCM sendRequest`)
    const extra = kind === 'binary' || kind === 'anon' ? new Uint8Array(0) : concatBytes(new Uint8Array(Math.max(0, 5 - data.length)), randomBytes(this.rng, 4));
    const pt = concatBytes(u32le(tag), data, extra);
    const route = this.#routeTo(c, forcedFlood);
    const raw =
      kind === 'anon'
        ? envelope(PayloadType.ANON_REQ, anonReqPayload(c.pubKey, this.#publicKey, this.#secret(c.pubKey), pt), route)
        : this.#peerPacket(PayloadType.REQ, c.pubKey, pt, route);
    this.#transmit({ type: 'request', kind, to: c.pubKey.slice(), tag, flood, data: data.slice() }, raw);
    const node = this.#remoteNodes.get(hex(c.pubKey));
    node?.requests.push({ kind, data: data.slice() });
    if (!node?.online) return;
    const key = c.pubKey.slice();
    this.#schedule(() => {
      let body: Uint8Array | null;
      switch (kind) {
        case 'status':
          body = node.statusBody(Math.floor(this.uptimeMs / 1000));
          break;
        case 'telemetry':
        case 'discovery':
          body = node.config.type === 'chat' && !node.config.telemetry ? null : node.telemetryBody();
          break;
        default:
          body = node.binaryBody(data, Math.floor(this.uptimeMs / 1000));
      }
      if (body === null) return;
      const resp = concatBytes(u32le(tag), body);
      if (kind === 'discovery') this.#deliverDiscovery(key, resp, node);
      else this.#deliverResponse(key, resp, flood, node);
    }, node.responseDelayMs);
  }

  /** A RESPONSE arrives: in a flood PATH (path update first) or as a direct datagram. */
  #deliverResponse(key: Uint8Array, data: Uint8Array, viaFlood: boolean, node: RemoteNode): void {
    const c = this.#lookup(key, PUB_KEY_SIZE);
    if (!c) return;
    this.#countRecv(viaFlood, node.snr);
    if (viaFlood && node.config.returnPath !== null) {
      const rp = node.config.returnPath ?? { pathLen: 0 };
      // BaseChatMesh::onContactPathRecv: store out_path, PATH_UPDATED, then handle the extra
      this.#setPath(c, rp.pathLen, rp.path ?? new Uint8Array(0));
      this.#pathUpdated(c);
    }
    this.#onContactResponse(c, data);
  }

  #deliverDiscovery(key: Uint8Array, data: Uint8Array, node: RemoteNode): void {
    const c = this.#lookup(key, PUB_KEY_SIZE);
    if (!c) return;
    this.#countRecv(true, node.snr);
    const out = node.config.returnPath ?? { pathLen: 0 };
    const inn = node.config.discoveryInPath ?? out;
    const tag = readU32LE(data, 0);
    if (data.length > 4 && tag === this.#pending.discovery) {
      this.#pending.discovery = 0;
      if (!isValidPathLen(out.pathLen) || !isValidPathLen(inn.pathLen)) return;
      const outPath = (out.path ?? new Uint8Array(0)).slice(0, decodePathLen(out.pathLen).byteLength);
      const inPath = (inn.path ?? new Uint8Array(0)).slice(0, decodePathLen(inn.pathLen).byteLength);
      this.#write({
        kind: 'pathDiscoveryResponse',
        code: 0x8d,
        pubKeyPrefix: c.pubKey.slice(0, 6),
        outPathLen: out.pathLen,
        outPathInfo: decodePathLen(out.pathLen),
        outPath,
        inPathLen: inn.pathLen,
        inPathInfo: decodePathLen(inn.pathLen),
        inPath,
      });
      return; // reciprocal path suppressed, contact path NOT updated
    }
    // late/unmatched: normal PATH handling (path update + generic response)
    this.#setPath(c, out.pathLen, out.path ?? new Uint8Array(0));
    this.#pathUpdated(c);
    this.#onContactResponse(c, data);
  }

  /** MyMesh::onContactResponse matching rules (§6.10). */
  #onContactResponse(c: DeviceContact, data: Uint8Array): void {
    const len = data.length;
    const tag = len >= 4 ? readU32LE(data, 0) : 0;
    const prefix4 = readU32LE(c.pubKey, 0);
    const p6 = c.pubKey.slice(0, 6);
    if (this.#pending.login && this.#pending.login === prefix4) {
      this.#pending.login = 0;
      if (data[4] === 0x4f && data[5] === 0x4b) {
        // legacy "OK"
        this.#write({ kind: 'loginSuccess', code: 0x85, adminFlag: 0, isAdmin: false, pubKeyPrefix: p6, legacy: true });
      } else if (data[4] === 0) {
        // RESP_SERVER_LOGIN_OK; keep-alive (data[5] × 16 s) would start a connection
        if ((data[5] ?? 0) > 0) this.#connections.add(hex(c.pubKey));
        this.#write({
          kind: 'loginSuccess',
          code: 0x85,
          adminFlag: data[6] ?? 0,
          isAdmin: data[6] === 1,
          pubKeyPrefix: p6,
          legacy: false,
          serverTimestamp: tag,
          aclPermissions: data[7] ?? 0,
          firmwareVerLevel: data[12] ?? 0,
        });
      } else {
        this.#write({ kind: 'loginFail', code: 0x86, pubKeyPrefix: p6 });
      }
    } else if (len > 4 && this.#pending.status && this.#pending.status === prefix4) {
      this.#pending.status = 0;
      this.#write({ kind: 'statusResponse', code: 0x87, pubKeyPrefix: p6, raw: data.slice(4), stats: null });
    } else if (len > 4 && tag === this.#pending.telemetry) {
      this.#pending.telemetry = 0;
      this.#write({ kind: 'telemetryResponse', code: 0x8b, pubKeyPrefix: p6, lpp: data.slice(4) });
    } else if (len > 4 && tag === this.#pending.req) {
      this.#pending.req = 0;
      this.#write({ kind: 'binaryResponse', code: 0x8c, tag, data: data.slice(4) });
    } else {
      // unknown/unhandled response: [1]=0, [2..] = the whole response (its tag first)
      this.#writeBytes(concatBytes(Uint8Array.of(0x8c, 0), data));
    }
  }

  #sendTrace(tag: number, authCode: number, hashSize: number, path: Uint8Array): void {
    const pathSz = Math.log2(hashSize);
    const hops = path.length >> pathSz;
    const t = loraAirtimeMs(9 + path.length + 0 + 2, this.#prefs.radio.sf, this.#prefs.radio.bwHz, this.#prefs.radio.cr);
    const est = directTimeoutMs(t, hops);
    this.#countSent(false);
    this.#write({ kind: 'sent', code: 0x06, flood: false, tag, tagBytes: u32le(tag), estTimeoutMs: est });
    // Mesh::createTrace + sendDirect: DIRECT, empty SNR path, hop hashes in the payload
    this.#transmit(
      { type: 'trace', tag, authCode, flags: pathSz, path: path.slice() },
      envelope(PayloadType.TRACE, buildTracePayload({ tag, authCode, flags: pathSz, hashes: path }), ZERO_HOP),
    );
    // each hop must be an online emulated node whose key starts with the hop hash
    const nodes: RemoteNode[] = [];
    for (let i = 0; i < hops; i++) {
      const h = path.subarray(i * hashSize, (i + 1) * hashSize);
      const n = this.remoteNodes.find((r) => startsWith(r.pubKey, h) && r.online);
      if (!n) return; // trace lost
      nodes.push(n);
    }
    const delay = nodes.reduce((s, n) => s + n.responseDelayMs, 0) || 100;
    this.#schedule(() => {
      const snrs = nodes.map((n) => n.snr);
      const finalSnr = nodes.length > 0 ? nodes[nodes.length - 1]!.snr : 0;
      this.#write({
        kind: 'traceData',
        code: 0x89,
        pathLen: path.length,
        flags: pathSz,
        pathHashSize: hashSize,
        tag,
        authCode,
        pathHashes: path,
        hops: [],
        snrs,
        finalSnr,
      });
    }, delay);
  }

  // =========================================================================
  // Misc helpers
  // =========================================================================

  #selfInfoFrame(): DeviceFrame {
    const p = this.#prefs;
    return {
      kind: 'selfInfo',
      code: 0x05,
      info: {
        advType: ContactType.CHAT,
        txPowerDbm: p.radio.txPowerDbm,
        maxTxPowerDbm: p.radio.maxTxPowerDbm,
        pubKey: this.#publicKey,
        lat: p.latE6 / 1e6,
        lon: p.lonE6 / 1e6,
        multiAcks: p.multiAcks,
        advertLocPolicy: p.advertLocPolicy,
        telemetryModesRaw: p.telemetryModes,
        telemetryModes: { base: p.telemetryModes & 3, location: (p.telemetryModes >> 2) & 3, environment: (p.telemetryModes >> 4) & 3 },
        manualAddContacts: p.manualAddContacts,
        radioFreqKhz: p.radio.freqKhz,
        radioBwHz: p.radio.bwHz,
        radioSf: p.radio.sf,
        radioCr: p.radio.cr,
        name: truncateUtf8(p.name, MAX_FRAME_SIZE - 58),
      },
    };
  }

  /** Signed self advert as a FLOOD zero-hop packet (EXPORT_CONTACT form, header 0x11). */
  #selfAdvert(): Uint8Array {
    const p = this.#prefs;
    return this.#advertBlob(this.#publicKey, this.#rtcUnique(), {
      nodeType: ContactType.CHAT,
      name: p.name,
      ...(p.advertLocPolicy !== 0 ? { latitude: p.latE6 / 1e6, longitude: p.lonE6 / 1e6 } : {}),
    });
  }

  #selfTelemetry(): Uint8Array {
    const parts = [lppVoltage(this.#options.battery?.mv ?? 4100)];
    if (this.#options.mcuTemperature !== undefined) parts.push(lppTemperature(this.#options.mcuTemperature));
    return concatBytes(...parts);
  }

  /** Answers the companion's own telemetry permission rules (`onContactRequest`), for tests. */
  telemetryPermissionsFor(contactFlags: number, inverseMask = 0): number {
    const m = this.#prefs.telemetryModes;
    const cp = contactFlags >> 1;
    const perm = (mode: number, bit: number): number =>
      mode === TelemetryMode.ALLOW_ALL ? bit : mode === TelemetryMode.ALLOW_FLAGS ? cp & bit : 0;
    const p = perm(m & 3, TelemetryPerm.BASE) | perm((m >> 2) & 3, TelemetryPerm.LOCATION) | perm((m >> 4) & 3, TelemetryPerm.ENVIRONMENT);
    return p & ~inverseMask & 0xff;
  }

  /**
   * The reported noise floor: `options.radioStats.noiseFloorDbm` when set, else a deterministic
   * function of the clock wandering about −112 dBm (two slow sines, ±4 dB), so a noise-floor chart
   * of an emulated session is not a flat line.
   */
  #noiseFloorNow(): number {
    if (this.#noiseFloor !== undefined) return this.#noiseFloor;
    const min = this.clock.now() / 60_000;
    return Math.round(-112 + 2.5 * Math.sin((2 * Math.PI * min) / 47) + 1.5 * Math.sin((2 * Math.PI * min) / 11));
  }

  #getStats(type: number): void {
    const c = this.#counters;
    switch (type) {
      case StatsType.CORE:
        this.#write({
          kind: 'stats',
          code: 0x18,
          stats: { type: 'core', batteryMv: this.#options.battery?.mv ?? 4100, uptimeSecs: Math.floor(this.uptimeMs / 1000), errFlags: 0, outboundQueueLen: 0 },
        });
        return;
      case StatsType.RADIO:
        this.#write({
          kind: 'stats',
          code: 0x18,
          stats: {
            type: 'radio',
            noiseFloorDbm: this.#noiseFloorNow(),
            lastRssiDbm: this.#lastRssi,
            lastSnr: this.#lastSnr,
            txAirSecs: Math.floor(c.txAirMs / 1000),
            rxAirSecs: Math.floor(c.rxAirMs / 1000),
          },
        });
        return;
      case StatsType.PACKETS:
        this.#write({
          kind: 'stats',
          code: 0x18,
          stats: {
            type: 'packets',
            recv: c.recv,
            sent: c.sent,
            sentFlood: c.sentFlood,
            sentDirect: c.sentDirect,
            recvFlood: c.recvFlood,
            recvDirect: c.recvDirect,
            recvErrors: c.recvErrors,
          },
        });
        return;
      default:
        this.#err(ERR.ILLEGAL_ARG);
    }
  }

  #countSent(flood: boolean): void {
    this.#counters.sent++;
    if (flood) this.#counters.sentFlood++;
    else this.#counters.sentDirect++;
  }

  #countRecv(flood: boolean, snr: number | undefined): void {
    this.#counters.recv++;
    if (flood) this.#counters.recvFlood++;
    else this.#counters.recvDirect++;
    if (snr !== undefined) this.#lastSnr = snr;
  }

  /**
   * est_timeout (§10) for a datagram to `c` whose payload is `payloadLen` bytes (hashes, MAC and
   * ciphertext included).
   */
  #estTimeout(c: DeviceContact, payloadLen: number, forceFlood = false): number {
    const r = this.#prefs.radio;
    const flood = forceFlood || c.outPathLen === PATH_LEN_UNKNOWN;
    const scoped = flood && !this.#sendUnscoped && (this.#sendScope.some((b) => b !== 0) || (this.#prefs.defaultScope?.key.some((b) => b !== 0) ?? false));
    // header + [transport codes] + path_len + path + dest/src hashes + payload
    const rawLen = 1 + (scoped ? 4 : 0) + 1 + (flood ? 0 : c.outPathInfo.byteLength) + payloadLen;
    const t = loraAirtimeMs(rawLen, r.sf, r.bwHz, r.cr);
    this.#counters.txAirMs += t;
    return flood ? floodTimeoutMs(t) : directTimeoutMs(t, c.outPathLen);
  }

  #allowedRepeat(f: number): boolean {
    return (this.#options.allowedRepeatFreqs ?? DEFAULT_REPEAT_FREQS).some((r) => f >= r.lowerKhz && f <= r.upperKhz);
  }

  #rtcNow(): number {
    return (Math.floor(this.clock.now() / 1000) + this.#rtcOffsetSecs) >>> 0;
  }

  /** RTCClock::getCurrentTimeUnique. */
  #rtcUnique(): number {
    const t = this.#rtcNow();
    if (t <= this.#lastUnique) return ++this.#lastUnique;
    return (this.#lastUnique = t);
  }

  /** Companion CLI (`MyMesh::handleCommand`), the subset that makes sense without hardware. */
  #runCli(text: string): string {
    let command = text.replace(/^ +/, '');
    let reply = '';
    if (command.length > 4 && command[2] === '|') {
      reply = command.slice(0, 3); // reflect the optional prefix
      command = command.slice(3);
    }
    if (command === 'reboot') {
      this.#schedule(() => this.#reboot(false), 0);
      return reply;
    }
    if (command.startsWith('set name ')) {
      const name = command.slice(9);
      if (/[[\]\\:,?*]/.test(name)) return `${reply}Error, bad chars`;
      this.#prefs.name = truncateUtf8(name, MAX_NAME_LEN);
      return `${reply}OK`;
    }
    if (command === 'get name') return `${reply}> ${this.#prefs.name}`;
    if (command.startsWith('set pin ')) {
      this.#prefs.blePin = parseInt(command.slice(8), 10) || 0;
      return `${reply}> pin is now ${String(this.#prefs.blePin).padStart(6, '0')}`;
    }
    if (command === 'board') return `${reply}${this.firmware.manufacturer}`;
    if (command === 'ver') return `${reply}${this.firmware.version} (Build: ${this.firmware.buildDate})`;
    return `${reply}Unknown command`;
  }

  #reboot(factoryReset: boolean): void {
    // volatile state is lost; RTC keeps running (most boards have an RTC or bootstrap it)
    for (const h of this.#timers) this.clock.clearTimeout(h);
    this.#timers.clear();
    this.#iter = null;
    this.#iterTimer = undefined;
    this.#appTargetVer = 0;
    this.#queue = [];
    this.#acks.fill(null);
    this.#nextAckIdx = 0;
    this.#clearPending();
    this.#sign = null;
    this.#sendScope = new Uint8Array(16);
    this.#sendUnscoped = false;
    this.#advertPaths = [];
    this.#connections.clear();
    this.#anon.fill(null);
    this.#seen = [];
    this.#seenSet.clear();
    this.#counters = { recv: 0, sent: 0, sentFlood: 0, sentDirect: 0, recvFlood: 0, recvDirect: 0, recvErrors: 0, txAirMs: 0, rxAirMs: 0 };
    this.#offline = true;
    this.events.emit('reboot', { factoryReset });
    const t = this.#transport;
    if (t) {
      if (t instanceof LoopbackEndpoint && t.peer) void t.peer.disconnect(); // the host sees the link drop
      void t.disconnect();
    }
    this.clock.setTimeout(() => {
      this.#offline = false;
      this.#bootMs = this.clock.now();
      if (t && this.#transport === t) void t.connect().catch(() => undefined);
    }, this.#options.rebootDelayMs ?? 50);
  }

  #factoryReset(): void {
    [this.#publicKey, this.#privateKey] = this.#makeIdentity(undefined);
    this.#secrets.clear();
    this.#prefs = this.#defaultPrefs(true);
    this.#contacts = [];
    this.#channels = this.#initialChannels(true);
    this.#reboot(true);
  }

  /**
   * Identity as [publicKey, 64-byte expanded private key]. A seed (or a generated random seed) is
   * expanded like orlp `ed25519_create_keypair`; a lone private key gets its real public key.
   */
  #makeIdentity(id: CompanionEmulatorOptions['identity']): [Uint8Array, Uint8Array] {
    const derive = this.#options.derivePublicKey ?? derivePublicKeyReal;
    if (id?.seed && !id.privateKey) {
      const priv = expandSeedSync(id.seed);
      return [id.publicKey?.slice() ?? derive(priv).slice(0, PUB_KEY_SIZE), priv];
    }
    if (id?.publicKey && id.privateKey) return [id.publicKey.slice(), id.privateKey.slice()];
    if (id?.privateKey) return [derive(id.privateKey).slice(0, PUB_KEY_SIZE), id.privateKey.slice()];
    if (id?.publicKey) return [id.publicKey.slice(), randomBytes(this.rng, PRIVATE_KEY_SIZE)];
    // radio_new_identity, retried while the first byte is a reserved hash (0x00 / 0xFF)
    for (;;) {
      const priv = expandSeedSync(randomBytes(this.rng, 32));
      const pub = derive(priv).slice(0, PUB_KEY_SIZE);
      if (pub[0] !== 0x00 && pub[0] !== 0xff) return [pub, priv];
    }
  }

  // =========================================================================
  // Radio receive (Dispatcher::checkRecv → Mesh::onRecvPacket → BaseChatMesh / MyMesh)
  // =========================================================================

  /** Every packet heard: LOG_RX_DATA first, then de-dup and processing. `trusted` skips advert signature checks. */
  #receive(raw: Uint8Array, snr: number, rssi: number, trusted: boolean): void {
    if (this.#offline) return;
    this.#lastSnr = snr;
    this.#lastRssi = rssi;
    if ((this.#options.logRx ?? true) && raw.length + 3 <= MAX_FRAME_SIZE) {
      this.#write({ kind: 'logRxData', code: 0x88, snr, rssi, packet: raw });
    }
    const p = tryParse(raw);
    if (!p) {
      this.#counters.recvErrors++;
      return;
    }
    const direct = isDirectRoute(p.routeType);
    if (direct && p.payloadType === PayloadType.TRACE) {
      this.#countRecv(false, undefined);
      this.#rxTrace(p, snr);
      return;
    }
    if (direct && p.pathHashCount > 0) {
      // not for us yet (companions don't forward); but an overheard ACK counts ('early received')
      if (p.payloadType === PayloadType.ACK && p.payload.length >= 4) this.#processAck(readU32LE(p.payload, 0));
      return;
    }
    if (this.#markSeen(p)) return;
    this.#countRecv(!direct, undefined);
    switch (p.payloadType) {
      case PayloadType.ADVERT:
        this.#rxAdvert(p, trusted);
        break;
      case PayloadType.TXT_MSG:
      case PayloadType.REQ:
      case PayloadType.RESPONSE:
      case PayloadType.PATH:
        this.#rxPeer(p, snr);
        break;
      case PayloadType.ACK:
        if (p.payload.length >= 4) this.#processAck(readU32LE(p.payload, 0));
        break;
      case PayloadType.GRP_TXT:
      case PayloadType.GRP_DATA:
        this.#rxGroup(p, snr);
        break;
      case PayloadType.RAW_CUSTOM:
        if (direct) this.#write({ kind: 'rawData', code: 0x84, snr, rssi, payload: p.payload });
        break;
      case PayloadType.CONTROL:
        if (direct && p.pathLen === 0 && ((p.payload[0] ?? 0) & 0x80) !== 0) {
          this.#write({ kind: 'controlData', code: 0x8e, snr, rssi, pathLen: p.pathLen, payload: p.payload });
        }
        break;
      default:
        break;
    }
  }

  #rxAdvert(p: ParsedPacket, trusted: boolean): void {
    let a;
    try {
      a = parseAdvertPayload(p.payload);
    } catch {
      return;
    }
    if (!a.app.valid || bytesEqual(a.publicKey, this.#publicKey)) return;
    if (!trusted && !ed25519VerifySync(a.publicKey, advertSignedMessage(a.publicKey, a.timestamp, a.appData), a.signature)) return; // forged
    const adv: RxAdvert = { pubKey: a.publicKey, timestamp: a.timestamp, type: a.app.nodeType, name: a.app.name ?? '', hasName: !!a.app.name, packet: p };
    if (a.app.latitudeE6 !== undefined && a.app.longitudeE6 !== undefined) {
      adv.latE6 = a.app.latitudeE6;
      adv.lonE6 = a.app.longitudeE6;
    }
    this.#onAdvertRecv(adv);
  }

  /** REQ/RESPONSE/TXT_MSG/PATH: try every contact whose key starts with src_hash (§3.0). */
  #rxPeer(p: ParsedPacket, snr: number): void {
    const pl = p.payload;
    if (pl.length < 4 || pl[0] !== this.#publicKey[0]) return;
    const candidates = [...this.#anon.filter((c): c is DeviceContact => c !== null), ...this.#contacts];
    for (const c of candidates) {
      if (c.pubKey[0] !== pl[1]) continue;
      const pt = macThenDecryptSync(this.#secret(c.pubKey), pl.subarray(2));
      if (!pt) continue;
      switch (p.payloadType) {
        case PayloadType.TXT_MSG:
          this.#rxText(c, pt, p, snr);
          break;
        case PayloadType.RESPONSE:
          this.#onContactResponse(c, pt);
          break;
        case PayloadType.PATH:
          this.#rxPath(c, pt, p);
          break;
        case PayloadType.REQ:
          this.#rxRequest(c, pt, p);
          break;
      }
      return;
    }
  }

  #rxText(c: DeviceContact, pt: Uint8Array, p: ParsedPacket, snr: number): void {
    let m;
    try {
      m = parseTxtMsgPlaintext(pt);
    } catch {
      return;
    }
    const coverLen = (m.txtType === TxtType.SIGNED_PLAIN ? 9 : 5) + m.textBytes.length;
    const rx: RxText = { txtType: m.txtType, text: m.text, timestamp: m.timestamp, covered: pt.subarray(0, coverLen) };
    if (m.authorPrefix) rx.authorPrefix = m.authorPrefix;
    this.#acceptText(c, rx, p, isFlood(p) ? p.pathLen : PATH_LEN_UNKNOWN, snr);
  }

  /** PATH (`Mesh.cpp` L160-179, `BCM onContactPathRecv`, `MyMesh` path discovery). */
  #rxPath(c: DeviceContact, pt: Uint8Array, p: ParsedPacket): void {
    let pp;
    try {
      pp = parsePathPlaintext(pt);
    } catch {
      return;
    }
    const isResponse = pp.hasExtra && pp.extraType === PayloadType.RESPONSE;
    if (isResponse && this.#pending.discovery && pp.extra.length > 4 && readU32LE(pp.extra, 0) === this.#pending.discovery) {
      this.#pending.discovery = 0;
      this.#write({
        kind: 'pathDiscoveryResponse',
        code: 0x8d,
        pubKeyPrefix: c.pubKey.slice(0, 6),
        outPathLen: pp.pathLen,
        outPathInfo: decodePathLen(pp.pathLen),
        outPath: pp.path,
        inPathLen: p.pathLen,
        inPathInfo: decodePathLen(p.pathLen),
        inPath: p.path,
      });
      return; // reciprocal path suppressed, contact path NOT updated
    }
    this.#setPath(c, pp.pathLen, pp.path);
    this.#pathUpdated(c);
    if (pp.hasExtra && pp.extraType === PayloadType.ACK && pp.extra.length >= 4) this.#processAck(readU32LE(pp.extra, 0));
    else if (isResponse) this.#onContactResponse(c, pp.extra);
    if (isFlood(p)) this.#sendPathReturn(c, p, true); // reciprocal path, DIRECT
  }

  /** A contact asks us for telemetry (`MyMesh::onContactRequest`); other requests are ignored. */
  #rxRequest(c: DeviceContact, pt: Uint8Array, p: ParsedPacket): void {
    let r;
    try {
      r = parseReqPlaintext(pt);
    } catch {
      return;
    }
    if (r.reqType !== ReqType.GET_TELEMETRY_DATA) return;
    if ((this.telemetryPermissionsFor(c.flags, r.data[0] ?? 0) & TelemetryPerm.BASE) === 0) return;
    const resp = concatBytes(u32le(r.timestamp), this.#selfTelemetry());
    const raw = isFlood(p)
      ? this.#peerPacket(PayloadType.PATH, c.pubKey, buildPathPlaintext({ path: p.path, hashSize: p.pathHashSize, extraType: PayloadType.RESPONSE, extra: resp }), this.#floodRoute())
      : this.#peerPacket(PayloadType.RESPONSE, c.pubKey, resp, this.#routeTo(c));
    this.#countSent(isFlood(p) || c.outPathLen === PATH_LEN_UNKNOWN);
    this.#transmit({ type: 'response', to: c.pubKey.slice(), tag: r.timestamp }, raw);
  }

  /** GRP_TXT / GRP_DATA: the first channel slot whose hash matches and whose MAC checks (§3.6). */
  #rxGroup(p: ParsedPacket, snr: number): void {
    if (p.payload.length < 3) return;
    const pathLen = isFlood(p) ? p.pathLen : PATH_LEN_UNKNOWN;
    for (let i = 0; i < this.#channels.length; i++) {
      const ch = this.#channels[i]!;
      if (ch.secret.every((b) => b === 0) || channelHashSync(ch.secret) !== p.payload[0]) continue;
      const pt = macThenDecryptSync(ch.secret, p.payload.subarray(1));
      if (!pt) continue;
      try {
        if (p.payloadType === PayloadType.GRP_TXT) {
          const g = parseGrpTxtPlaintext(pt);
          if (g.txtType !== 0) return; // receivers drop non-plain group text
          this.#queueChannelText(i, g.text, g.message, g.timestamp, pathLen, snr);
        } else {
          const d = parseGrpDataPlaintext(pt);
          if (d.data.length > MAX_CHANNEL_DATA_LENGTH) return;
          this.#queueFrame(encodeDeviceFrame({ kind: 'channelData', code: RESP.CHANNEL_DATA_RECV, snr, channelIdx: i, route: routeOf(pathLen), dataType: d.dataType, data: d.data }));
        }
      } catch {
        // malformed plaintext: dropped
      }
      return;
    }
  }

  /** A completed TRACE (`MyMesh::onTraceRecv`): TRACE_DATA with each hop's SNR and our own. */
  #rxTrace(p: ParsedPacket, snr: number): void {
    const t = parseTraceSafe(p.payload);
    if (!t) return;
    const pathSz = t.flags & 3;
    if (p.pathHashCount << pathSz < t.hashes.length) return; // still travelling
    const hops = t.hashes.length >> pathSz;
    this.#write({
      kind: 'traceData',
      code: 0x89,
      pathLen: t.hashes.length,
      flags: t.flags,
      pathHashSize: 1 << pathSz,
      tag: t.tag,
      authCode: t.authCode,
      pathHashes: t.hashes,
      hops: [],
      snrs: [...p.path.subarray(0, hops)].map((b) => i8(b) / 4),
      finalSnr: snr,
    });
  }

  #defaultPrefs(factory = false): EmulatorPrefs {
    const o = factory ? {} : this.#options;
    const r = o.radio ?? {};
    const p = o.prefs ?? {};
    return {
      name: truncateUtf8(o.name ?? (factory ? 'NONAME' : 'Emulator'), MAX_NAME_LEN),
      latE6: Math.round((o.lat ?? 0) * 1e6),
      lonE6: Math.round((o.lon ?? 0) * 1e6),
      radio: {
        freqKhz: r.freqKhz ?? 869525,
        bwHz: r.bwHz ?? 250000,
        sf: r.sf ?? 11,
        cr: r.cr ?? 5,
        txPowerDbm: r.txPowerDbm ?? 22,
        maxTxPowerDbm: r.maxTxPowerDbm ?? this.#options.radio?.maxTxPowerDbm ?? 22,
        clientRepeat: r.clientRepeat ?? false,
      },
      multiAcks: p.multiAcks ?? 0,
      advertLocPolicy: p.advertLocPolicy ?? 0,
      telemetryModes: p.telemetryModes ?? 0,
      manualAddContacts: p.manualAddContacts ?? 0,
      autoAddConfig: p.autoAddConfig ?? 0,
      autoAddMaxHops: p.autoAddMaxHops ?? 0,
      rxDelayBaseMilli: p.rxDelayBaseMilli ?? 0,
      airtimeFactorMilli: p.airtimeFactorMilli ?? 1000,
      blePin: p.blePin ?? 0,
      pathHashMode: p.pathHashMode ?? 0,
      defaultScope: p.defaultScope ?? null,
    };
  }

  #initialChannels(factory = false): ChannelSlot[] {
    const slots: ChannelSlot[] = [];
    for (let i = 0; i < this.maxChannels; i++) slots.push({ name: '', secret: new Uint8Array(CHANNEL_SECRET_SIZE) });
    const given = factory ? undefined : this.#options.channels;
    if (given === undefined) {
      if (this.maxChannels > 0) slots[0] = publicChannel();
    } else {
      given.forEach((ch, i) => {
        if (ch && i < this.maxChannels) {
          const s = new Uint8Array(CHANNEL_SECRET_SIZE);
          s.set(ch.secret.subarray(0, CHANNEL_SECRET_SIZE));
          slots[i] = { name: truncateUtf8(ch.name, MAX_NAME_LEN), secret: s };
        }
      });
    }
    return slots;
  }
}

