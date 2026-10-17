/**
 * Repeater / room server / sensor administration (Phase 10).
 *
 * `RemoteAdminModel.node(key)` returns a per-node {@link RemoteNodeModel} (cached) that holds the
 * session state of one remote node: login, status (RepeaterStats / ServerStats), telemetry
 * (CayenneLPP), neighbours, ACL, owner info, trace / path discovery results and a CLI transcript.
 *
 * Protocol (docs/companion-protocol.md §6.6-6.10, docs/mesh-packet-format.md §3.1-3.2, §4):
 *  - login: SEND_LOGIN → LOGIN_SUCCESS (is_admin / ACL perms) or silence for a wrong password;
 *  - status: SEND_STATUS_REQ → STATUS_RESPONSE; telemetry: SEND_TELEMETRY_REQ → TELEMETRY_RESPONSE;
 *  - neighbours / ACL / owner info / sensor min-max: SEND_BINARY_REQ with REQ types 0x06 / 0x05 /
 *    0x07 / 0x04 (these need a login on real servers);
 *  - CLI: TXT_MSG CLI_DATA to the node, reply is the next CLI_DATA message from it (admin only);
 *  - trace: SEND_TRACE_PATH (DIRECT; only repeaters forward), TRACE_DATA has per-hop SNRs;
 *  - path discovery: SEND_PATH_DISCOVERY_REQ (flood) → PATH_DISCOVERY_RESPONSE.
 * All remote requests are serialized by the CompanionClient (one outstanding on the device).
 * Session state is cleared when the connection drops.
 */

import { LoginFailedError, RemoteTimeoutError } from '../client/errors.js';
import type { CompanionClient } from '../client/companion-client.js';
import { decodeAvgMinMax, type AvgMinMaxEntry, type LppDecodeResult, type LppReading, type LppTypeName } from '../packet/lpp.js';
import { parseAccessList, parseNeighbours, parseOwnerInfo } from '../packet/payloads.js';
import { AclRole, ReqType, TELEM_CHANNEL_SELF } from '../protocol/constants.js';
import type { NodeStats } from '../protocol/types.js';
import type { RadioStore } from '../store/radio-store.js';
import type { ContactRecord } from '../store/schema.js';
import { concatBytes, fromHex, toHex, u16le, u32le } from '../util/bytes.js';
import type { Clock } from '../util/clock.js';
import type { ConnectionModel } from './connection.js';
import type { ContactsModel, ContactView } from './contacts-model.js';
import { contactTypeName, type ContactKind } from './messaging.js';
import type { CliNodeKind } from './remote-cli-commands.js';
import { computed, effect, signal, type ReadonlySignal } from './signal.js';
import { historyPoints, isHistoryFrameFor, loadTelemetryHistory, mergeInto, type TelemetryHistory } from './telemetry-history.js';

export * from './remote-cli-commands.js';
export * from './telemetry-history.js';

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export type RemoteRole = 'guest' | 'readOnly' | 'readWrite' | 'admin';

export type LoginState =
  | { state: 'loggedOut' }
  | { state: 'loggingIn' }
  | { state: 'admin' | 'guest'; since: number; role?: RemoteRole; aclPermissions?: number; firmwareVerLevel?: number; legacy: boolean }
  | { state: 'failed'; reason: string; timedOut: boolean };

export type RemoteAction =
  | 'login'
  | 'status'
  | 'telemetry'
  | 'avgMinMax'
  | 'neighbours'
  | 'acl'
  | 'owner'
  | 'cli'
  | 'trace'
  | 'discovery'
  | 'resetPath';

export interface StatusField {
  id: string;
  label: string;
  group: 'system' | 'radio' | 'packets' | 'room';
  value: number;
  unit: string;
  /** Human-readable value with unit. */
  display: string;
}

export interface NodeStatus {
  /** Epoch ms. */
  at: number;
  stats: NodeStats;
  fields: StatusField[];
}

export interface TelemetryItem {
  channel: number;
  type: number;
  name: LppTypeName;
  /** "Battery", "MCU temperature", "Temperature (ch 2)" … */
  label: string;
  display: string;
  unit: string;
  /** Scalar value (undefined for GPS / xyz / colour). */
  value?: number;
  reading: LppReading;
}

export interface NodeTelemetry {
  at: number;
  items: TelemetryItem[];
  /** Decoder stopped early (unknown LPP type, truncation). */
  error?: string;
}

export interface NodeAvgMinMax {
  at: number;
  /** Requested window, seconds ago. */
  startSecsAgo: number;
  endSecsAgo: number;
  entries: Array<AvgMinMaxEntry & { label: string; unit: string }>;
}

export interface HopRef {
  /** Hop hash hex (1-8 bytes). */
  hash: string;
  /** Contact name when the hash matches a known contact (repeaters preferred). */
  name?: string;
  /** More than one known contact matches. */
  ambiguous: boolean;
  /** The matching contact's public key hex, when exactly one matches (never for this radio). */
  key?: string;
}

export interface NeighbourItem extends HopRef {
  heardSecsAgo: number;
  snr: number;
}

export interface NodeNeighbours {
  at: number;
  total: number;
  items: NeighbourItem[];
}

export interface AclItem extends HopRef {
  permissions: number;
  role: RemoteRole;
}

export interface NodeAcl {
  at: number;
  items: AclItem[];
}

export interface OwnerInfo {
  at: number;
  firmwareVersion: string;
  nodeName: string;
  ownerInfo: string;
}

export interface TraceHop extends HopRef {
  /** SNR (dB) with which this hop heard the trace. */
  snr: number;
}

export interface TraceResult {
  at: number;
  hops: TraceHop[];
  /** SNR (dB) with which our radio heard the last hop. */
  finalSnr: number;
  roundTripMs: number;
}

export interface PathDiscoveryResult {
  at: number;
  /** Our route to the node (as the node reports it). */
  outPath: HopRef[];
  /** The node's route back to us. */
  inPath: HopRef[];
  roundTripMs: number;
}

export interface CliEntry {
  /** Epoch ms. */
  ts: number;
  direction: 'out' | 'in' | 'error';
  text: string;
}

export interface RemoteAdminOptions {
  /** Overrides the device's estimated timeout (+ grace) for every remote request. */
  timeoutMs?: number;
  /** Time source for timestamps / round trips. Default: the connection's clock. */
  clock?: Clock;
  /** Max CLI transcript entries kept per node. Default 500. */
  transcriptLimit?: number;
}

/** SettingsRepo key of a remembered password. */
export function rememberedPasswordKey(nodeKey: string): string {
  return `remoteAdmin.password.${nodeKey.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Pure formatting helpers (exported for the UI and tests)
// ---------------------------------------------------------------------------

/** "3d 4h 5m", "4h 5m", "5m 6s", "42s". */
export function formatSeconds(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${r}s`;
  return `${r}s`;
}

function fmtNum(v: number, digits = 0): string {
  return digits ? v.toFixed(digits) : v.toLocaleString('en-US');
}

/** Status struct → labelled fields with units (mesh-packet-format.md §3.2 STATUS). */
export function statusFields(stats: NodeStats): StatusField[] {
  const f: StatusField[] = [];
  const add = (id: string, label: string, group: StatusField['group'], value: number, unit: string, display?: string): void => {
    f.push({ id, label, group, value, unit, display: display ?? `${fmtNum(value)}${unit ? ` ${unit}` : ''}` });
  };
  add('battery', 'Battery', 'system', stats.batteryMv, 'mV', `${(stats.batteryMv / 1000).toFixed(2)} V (${stats.batteryMv} mV)`);
  add('uptime', 'Uptime', 'system', stats.upTimeSecs, 's', formatSeconds(stats.upTimeSecs));
  add('txQueue', 'TX queue', 'system', stats.txQueueLen, '');
  add('errors', 'Error flags', 'system', stats.errEvents, '', stats.errEvents ? `0x${stats.errEvents.toString(16).padStart(4, '0')}` : 'none');
  add('noiseFloor', 'Noise floor', 'radio', stats.noiseFloorDbm, 'dBm');
  add('lastRssi', 'Last RSSI', 'radio', stats.lastRssiDbm, 'dBm');
  add('lastSnr', 'Last SNR', 'radio', stats.lastSnr, 'dB', `${Number.isInteger(stats.lastSnr) ? stats.lastSnr : stats.lastSnr.toFixed(2)} dB`);
  add('txAirtime', 'TX airtime', 'radio', stats.airTimeSecs, 's', formatSeconds(stats.airTimeSecs));
  if (stats.kind === 'repeater') {
    if (stats.rxAirTimeSecs !== undefined) add('rxAirtime', 'RX airtime', 'radio', stats.rxAirTimeSecs, 's', formatSeconds(stats.rxAirTimeSecs));
    if (stats.recvErrors !== undefined) add('recvErrors', 'RX errors', 'radio', stats.recvErrors, '');
  }
  add('recv', 'Received', 'packets', stats.packetsRecv, '');
  add('sent', 'Sent', 'packets', stats.packetsSent, '');
  add('recvFlood', 'Received flood', 'packets', stats.recvFlood, '');
  add('recvDirect', 'Received direct', 'packets', stats.recvDirect, '');
  add('sentFlood', 'Sent flood', 'packets', stats.sentFlood, '');
  add('sentDirect', 'Sent direct', 'packets', stats.sentDirect, '');
  add('floodDups', 'Flood duplicates', 'packets', stats.floodDups, '');
  add('directDups', 'Direct duplicates', 'packets', stats.directDups, '');
  if (stats.kind === 'room') {
    add('posted', 'Posts', 'room', stats.posted, '');
    add('postPush', 'Posts pushed', 'room', stats.postPush, '');
  }
  return f;
}

const LPP_LABEL: Partial<Record<LppTypeName, string>> = {
  DIGITAL_INPUT: 'Digital input',
  DIGITAL_OUTPUT: 'Digital output',
  ANALOG_INPUT: 'Analog input',
  ANALOG_OUTPUT: 'Analog output',
  GENERIC_SENSOR: 'Generic sensor',
  LUMINOSITY: 'Luminosity',
  PRESENCE: 'Presence',
  TEMPERATURE: 'Temperature',
  RELATIVE_HUMIDITY: 'Humidity',
  ACCELEROMETER: 'Accelerometer',
  BAROMETRIC_PRESSURE: 'Pressure',
  VOLTAGE: 'Voltage',
  CURRENT: 'Current',
  FREQUENCY: 'Frequency',
  PERCENTAGE: 'Percentage',
  ALTITUDE: 'Altitude',
  LOAD: 'Load',
  CONCENTRATION: 'Concentration',
  POWER: 'Power',
  DISTANCE: 'Distance',
  ENERGY: 'Energy',
  DIRECTION: 'Direction',
  UNIXTIME: 'Time',
  GYROMETER: 'Gyrometer',
  COLOUR: 'Colour',
  GPS: 'Location',
  SWITCH: 'Switch',
};

const LPP_DIGITS: Partial<Record<LppTypeName, number>> = {
  ANALOG_INPUT: 2,
  ANALOG_OUTPUT: 2,
  TEMPERATURE: 1,
  RELATIVE_HUMIDITY: 1,
  BAROMETRIC_PRESSURE: 1,
  VOLTAGE: 2,
  CURRENT: 3,
  DISTANCE: 3,
  ENERGY: 3,
  LOAD: 3,
};

/** Label for an LPP reading; channel 1 (TELEM_CHANNEL_SELF) voltage = battery, temperature = MCU. */
export function lppLabel(name: LppTypeName, channel: number): string {
  if (channel === TELEM_CHANNEL_SELF && name === 'VOLTAGE') return 'Battery';
  if (channel === TELEM_CHANNEL_SELF && name === 'TEMPERATURE') return 'MCU temperature';
  const base = LPP_LABEL[name] ?? name;
  return channel === TELEM_CHANNEL_SELF ? base : `${base} (ch ${channel})`;
}

function lppScalarDisplay(name: LppTypeName, value: number, unit: string): string {
  const d = LPP_DIGITS[name];
  const v = name === 'UNIXTIME' ? new Date(value * 1000).toISOString() : d !== undefined ? value.toFixed(d) : String(value);
  return name === 'UNIXTIME' || !unit ? v : `${v} ${unit}`;
}

/** Decoded LPP → labelled items with display strings. */
export function telemetryItems(decoded: LppDecodeResult): TelemetryItem[] {
  return decoded.readings.map((r): TelemetryItem => {
    const base = { channel: r.channel, type: r.type, name: r.name, label: lppLabel(r.name, r.channel), reading: r };
    switch (r.kind) {
      case 'scalar':
        return { ...base, value: r.value, unit: r.unit, display: lppScalarDisplay(r.name, r.value, r.unit) };
      case 'xyz':
        return { ...base, unit: r.unit, display: `${r.x}, ${r.y}, ${r.z} ${r.unit}` };
      case 'gps':
        return { ...base, unit: '', display: `${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)} (${r.altitude} m)` };
      case 'colour':
        return { ...base, unit: '', display: `#${[r.r, r.g, r.b].map((c) => c.toString(16).padStart(2, '0')).join('')}` };
    }
  });
}

/** ACL permission byte → role (bits 0-1, AclRole). */
export function aclRole(permissions: number): RemoteRole {
  switch (permissions & 3) {
    case AclRole.ADMIN:
      return 'admin';
    case AclRole.READ_WRITE:
      return 'readWrite';
    case AclRole.READ_ONLY:
      return 'readOnly';
    default:
      return 'guest';
  }
}

/** Splits a concatenated hash list into hops of `size` bytes. */
export function splitHops(path: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const s = Math.max(1, size);
  for (let i = 0; i + s <= path.length; i += s) out.push(path.slice(i, i + s));
  return out;
}

/** Parses "a1,b2 c3" / "a1b2c3" (1-byte hashes) into a hash list. */
export function parseHopList(text: string): Uint8Array {
  const t = text.trim();
  if (!t) return new Uint8Array(0);
  const parts = /[\s,>-]/.test(t) ? t.split(/[\s,>-]+/).filter(Boolean) : (t.match(/.{1,2}/g) ?? []);
  const sizes = new Set(parts.map((p) => p.length));
  if (sizes.size !== 1 || ![2, 4, 8, 16].includes([...sizes][0]!)) throw new Error('Hops must be hex hashes of equal size (e.g. "a1,b2")');
  return concatBytes(...parts.map((p) => fromHex(p)));
}

function errorMessage(err: unknown): string {
  if (err instanceof RemoteTimeoutError) return 'No response from the node (timed out)';
  if (err instanceof LoginFailedError) return 'Login rejected';
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

interface Deps {
  connection: ConnectionModel;
  contacts: ContactsModel | undefined;
  opts: RemoteAdminOptions;
}

export class RemoteNodeModel {
  readonly key: string;
  readonly pubKey: Uint8Array;

  readonly #login = signal<LoginState>({ state: 'loggedOut' });
  readonly #status = signal<NodeStatus | null>(null);
  readonly #telemetry = signal<NodeTelemetry | null>(null);
  readonly #avgMinMax = signal<NodeAvgMinMax | null>(null);
  readonly #neighbours = signal<NodeNeighbours | null>(null);
  readonly #acl = signal<NodeAcl | null>(null);
  readonly #owner = signal<OwnerInfo | null>(null);
  readonly #trace = signal<TraceResult | null>(null);
  readonly #discovery = signal<PathDiscoveryResult | null>(null);
  readonly #transcript = signal<readonly CliEntry[]>([]);
  readonly #busy = signal<ReadonlySet<RemoteAction>>(new Set());
  readonly #errors = signal<Readonly<Partial<Record<RemoteAction, string>>>>({});
  readonly #savedPassword = signal<string | null>(null);
  readonly #history = signal<TelemetryHistory | null>(null);
  #historyWatch: (() => void) | undefined;
  #historyLoad: Promise<TelemetryHistory | null> = Promise.resolve(null);

  /** The contact (from the contacts model), undefined while unknown / loading. */
  readonly contact: ReadonlySignal<ContactView | undefined>;
  /** Contact type, from the contact record. */
  readonly kind: ReadonlySignal<ContactKind | undefined>;
  readonly loginState: ReadonlySignal<LoginState> = this.#login.readonly;
  readonly lastStatus: ReadonlySignal<NodeStatus | null> = this.#status.readonly;
  readonly telemetry: ReadonlySignal<NodeTelemetry | null> = this.#telemetry.readonly;
  readonly avgMinMax: ReadonlySignal<NodeAvgMinMax | null> = this.#avgMinMax.readonly;
  readonly neighbours: ReadonlySignal<NodeNeighbours | null> = this.#neighbours.readonly;
  readonly acl: ReadonlySignal<NodeAcl | null> = this.#acl.readonly;
  readonly ownerInfo: ReadonlySignal<OwnerInfo | null> = this.#owner.readonly;
  readonly lastTrace: ReadonlySignal<TraceResult | null> = this.#trace.readonly;
  readonly pathDiscovery: ReadonlySignal<PathDiscoveryResult | null> = this.#discovery.readonly;
  readonly transcript: ReadonlySignal<readonly CliEntry[]> = this.#transcript.readonly;
  /** Actions in progress. */
  readonly busy: ReadonlySignal<ReadonlySet<RemoteAction>> = this.#busy.readonly;
  /** Last error per action (cleared when the action next succeeds). */
  readonly errors: ReadonlySignal<Readonly<Partial<Record<RemoteAction, string>>>> = this.#errors.readonly;
  /** Remembered password (SettingsRepo, opt-in), null when none. */
  readonly savedPassword: ReadonlySignal<string | null> = this.#savedPassword.readonly;
  /**
   * Battery / temperature history from every archived status and telemetry response of this
   * node (see telemetry-history.ts). Null until {@link loadTelemetryHistory} has been called and
   * has loaded, and while no radio store is open.
   */
  readonly telemetryHistory: ReadonlySignal<TelemetryHistory | null> = this.#history.readonly;
  readonly loggedIn: ReadonlySignal<boolean>;
  readonly isAdmin: ReadonlySignal<boolean>;

  readonly #deps: Deps;

  constructor(key: string, deps: Deps) {
    this.key = key.toLowerCase();
    this.pubKey = fromHex(this.key);
    this.#deps = deps;
    this.contact = computed(() => {
      const c = deps.contacts;
      if (!c) return undefined;
      void c.views.value;
      return c.view(this.key);
    });
    this.kind = computed(() => this.contact.value?.typeName);
    this.loggedIn = computed(() => {
      const s = this.#login.value.state;
      return s === 'admin' || s === 'guest';
    });
    this.isAdmin = computed(() => this.#login.value.state === 'admin');
  }

  get #now(): number {
    return (this.#deps.opts.clock ?? this.#deps.connection.clock).now();
  }

  get #reqOpts(): { timeoutMs?: number } {
    const t = this.#deps.opts.timeoutMs;
    return t === undefined ? {} : { timeoutMs: t };
  }

  #client(): CompanionClient {
    const c = this.#deps.connection.client.peek();
    if (!c || !this.#deps.connection.connected.peek()) throw new Error('Not connected');
    return c;
  }

  isBusy(action: RemoteAction): boolean {
    return this.#busy.peek().has(action);
  }

  async #run<T>(action: RemoteAction, fn: (client: CompanionClient) => Promise<T>): Promise<T> {
    this.#busy.value = new Set([...this.#busy.peek(), action]);
    try {
      const r = await fn(this.#client());
      if (this.#errors.peek()[action] !== undefined) {
        const { [action]: _gone, ...rest } = this.#errors.peek();
        this.#errors.value = rest;
      }
      return r;
    } catch (err) {
      this.#errors.value = { ...this.#errors.peek(), [action]: errorMessage(err) };
      throw err;
    } finally {
      const b = new Set(this.#busy.peek());
      b.delete(action);
      this.#busy.value = b;
    }
  }

  // ---- hop name resolution ----

  #contacts(): readonly ContactRecord[] {
    return this.#deps.contacts?.contacts.peek() ?? [];
  }

  /** Resolves a hop hash / pubkey prefix to a known contact (repeaters first; self = "You"). */
  resolveHop(hash: Uint8Array): HopRef {
    const hex = toHex(hash);
    const self = this.#deps.connection.selfInfo.peek();
    if (self && hash.length > 0 && toHex(self.pubKey.subarray(0, hash.length)) === hex) return { hash: hex, name: 'You', ambiguous: false };
    const matches = this.#contacts().filter((c) => c.key.startsWith(hex));
    const repeaters = matches.filter((c) => c.type === 2);
    const pick = repeaters.length ? repeaters : matches;
    const first = pick[0];
    const ref: HopRef = { hash: hex, ambiguous: pick.length > 1 };
    if (first) ref.name = first.name || first.key.slice(0, 12);
    if (first && pick.length === 1) ref.key = first.key;
    return ref;
  }

  // ---- password memory ----

  /** Loads the remembered password from the radio's SettingsRepo. */
  async loadSavedPassword(): Promise<string | null> {
    const store = this.#deps.connection.store.peek();
    const v = store ? await store.settings.get<string>(rememberedPasswordKey(this.key)) : undefined;
    this.#savedPassword.value = typeof v === 'string' ? v : null;
    return this.#savedPassword.peek();
  }

  async rememberPassword(password: string | null): Promise<void> {
    const store = this.#deps.connection.store.peek();
    if (store) {
      if (password === null) await store.settings.delete(rememberedPasswordKey(this.key));
      else await store.settings.set(rememberedPasswordKey(this.key), password);
    }
    this.#savedPassword.value = password;
  }

  forgetPassword(): Promise<void> {
    return this.rememberPassword(null);
  }

  // ---- actions ----

  /**
   * SEND_LOGIN. `remember: true` stores the password for this node (SettingsRepo, per radio);
   * `false` forgets any stored one; undefined leaves it alone. Resolves with the new state (never
   * rejects for a rejected / unanswered login: see `loginState`).
   */
  async login(password: string, opts: { remember?: boolean } = {}): Promise<LoginState> {
    this.#login.value = { state: 'loggingIn' };
    try {
      const ok = await this.#run('login', (c) => c.login(this.pubKey, password, this.#reqOpts));
      const role = ok.aclPermissions !== undefined ? aclRole(ok.aclPermissions) : undefined;
      const s: LoginState = { state: ok.isAdmin ? 'admin' : 'guest', since: this.#now, legacy: ok.legacy };
      if (role) s.role = role;
      if (ok.aclPermissions !== undefined) s.aclPermissions = ok.aclPermissions;
      if (ok.firmwareVerLevel !== undefined) s.firmwareVerLevel = ok.firmwareVerLevel;
      this.#login.value = s;
      if (opts.remember === true) await this.rememberPassword(password);
      else if (opts.remember === false && this.#savedPassword.peek() !== null) await this.forgetPassword();
    } catch (err) {
      const timedOut = err instanceof RemoteTimeoutError;
      this.#login.value = {
        state: 'failed',
        timedOut,
        reason: timedOut ? 'No response: wrong password, or the node is out of range' : err instanceof LoginFailedError ? 'Wrong password' : errorMessage(err),
      };
    }
    return this.#login.peek();
  }

  /** LOGOUT (ends the device-side session; local state back to loggedOut). */
  async logout(): Promise<void> {
    try {
      await this.#client().logout(this.pubKey);
    } finally {
      this.#login.value = { state: 'loggedOut' };
    }
  }

  async refreshStatus(): Promise<NodeStatus> {
    return this.#run('status', async (c) => {
      const r = await c.getStatus(this.pubKey, this.#reqOpts);
      if (!r.stats) throw new Error(`Unrecognised status (${r.raw.length} bytes)`);
      const s: NodeStatus = { at: this.#now, stats: r.stats, fields: statusFields(r.stats) };
      this.#status.value = s;
      return s;
    });
  }

  async refreshTelemetry(): Promise<NodeTelemetry> {
    return this.#run('telemetry', async (c) => {
      const r = await c.getTelemetry(this.pubKey, this.#reqOpts);
      const t: NodeTelemetry = { at: this.#now, items: telemetryItems(r.decoded) };
      if (r.decoded.error) t.error = r.decoded.error;
      this.#telemetry.value = t;
      return t;
    });
  }

  /**
   * Sensor GET_AVG_MIN_MAX (REQ 0x04, `[start secs ago u32][end secs ago u32][2 reserved]`,
   * mesh-packet-format.md §3.1 / §4 end). The BINARY_RESPONSE data is the body after the tag
   * (`[now u32][entries]`).
   */
  async fetchAvgMinMax(startSecsAgo = 3600, endSecsAgo = 0): Promise<NodeAvgMinMax> {
    return this.#run('avgMinMax', async (c) => {
      const req = concatBytes(Uint8Array.of(ReqType.GET_AVG_MIN_MAX), u32le(startSecsAgo), u32le(endSecsAgo), Uint8Array.of(0, 0));
      const body = await c.binaryRequest(this.pubKey, req, this.#reqOpts);
      const d = decodeAvgMinMax(concatBytes(new Uint8Array(4), body));
      if (!d) throw new Error('Malformed min/max reply');
      const entries = d.entries.map((e) => ({ ...e, label: e.name ? lppLabel(e.name, e.channel) : `Type ${e.type} (ch ${e.channel})`, unit: lppUnit(e.type) }));
      const r: NodeAvgMinMax = { at: this.#now, startSecsAgo, endSecsAgo, entries };
      this.#avgMinMax.value = r;
      return r;
    });
  }

  /** Repeater GET_NEIGHBOURS (REQ 0x06): newest first, 6-byte prefixes. */
  async fetchNeighbours(opts: { count?: number; offset?: number; orderBy?: 0 | 1 | 2 | 3 } = {}): Promise<NodeNeighbours> {
    const prefixLen = 6;
    return this.#run('neighbours', async (c) => {
      // [req][ver=0][count u8][offset u16][order_by u8][pubkey_prefix_len u8][4 random]
      const rnd = u32le((Math.random() * 0x100000000) >>> 0);
      const req = concatBytes(Uint8Array.of(ReqType.GET_NEIGHBOURS, 0, opts.count ?? 15), u16le(opts.offset ?? 0), Uint8Array.of(opts.orderBy ?? 0, prefixLen), rnd);
      const body = await c.binaryRequest(this.pubKey, req, this.#reqOpts);
      const p = parseNeighbours(body, prefixLen);
      const r: NodeNeighbours = {
        at: this.#now,
        total: p.total,
        items: p.results.map((n) => ({ ...this.resolveHop(n.pubKeyPrefix), heardSecsAgo: n.heardSecsAgo, snr: n.snr })),
      };
      this.#neighbours.value = r;
      return r;
    });
  }

  /** GET_ACCESS_LIST (REQ 0x05, admin only). */
  async fetchAcl(): Promise<NodeAcl> {
    return this.#run('acl', async (c) => {
      const body = await c.binaryRequest(this.pubKey, Uint8Array.of(ReqType.GET_ACCESS_LIST, 0, 0), this.#reqOpts);
      const r: NodeAcl = {
        at: this.#now,
        items: parseAccessList(body).map((e) => ({ ...this.resolveHop(e.pubKeyPrefix), permissions: e.permissions, role: aclRole(e.permissions) })),
      };
      this.#acl.value = r;
      return r;
    });
  }

  /** GET_OWNER_INFO (REQ 0x07, repeaters with FIRMWARE_VER_LEVEL ≥ 2). */
  async fetchOwnerInfo(): Promise<OwnerInfo> {
    return this.#run('owner', async (c) => {
      const body = await c.binaryRequest(this.pubKey, Uint8Array.of(ReqType.GET_OWNER_INFO), this.#reqOpts);
      const r: OwnerInfo = { at: this.#now, ...parseOwnerInfo(body) };
      this.#owner.value = r;
      return r;
    });
  }

  #append(e: CliEntry): void {
    const limit = this.#deps.opts.transcriptLimit ?? 500;
    const next = [...this.#transcript.peek(), e];
    this.#transcript.value = next.length > limit ? next.slice(next.length - limit) : next;
  }

  /** Remote CLI: appends the command and its reply (or an error entry) to the transcript. */
  async runCli(command: string): Promise<string | null> {
    const cmd = command.trim();
    if (!cmd) return null;
    this.#append({ ts: this.#now, direction: 'out', text: cmd });
    try {
      const reply = await this.#run('cli', (c) => c.sendRemoteCliCommand(this.pubKey, cmd, this.#reqOpts));
      this.#append({ ts: this.#now, direction: 'in', text: reply });
      return reply;
    } catch (err) {
      this.#append({ ts: this.#now, direction: 'error', text: errorMessage(err) });
      return null;
    }
  }

  clearTranscript(): void {
    this.#transcript.value = [];
  }

  /** Asks the node to advertise (CLI `advert` / `advert.zerohop`; there is no REQ type for it). */
  requestAdvert(zeroHop = false): Promise<string | null> {
    return this.runCli(zeroHop ? 'advert.zerohop' : 'advert');
  }

  /**
   * Default trace path: the stored out_path, then the node itself if it is a repeater (only
   * repeaters forward TRACE), then the out_path reversed back to us.
   */
  defaultTracePath(): { path: Uint8Array; hashSize: number } {
    const c = this.contact.peek()?.record;
    const hashSize = c && !c.outPathInfo.isFlood ? c.outPathInfo.hashSize || 1 : 1;
    const size = [1, 2, 4, 8].includes(hashSize) ? hashSize : 1;
    const hops = c && !c.outPathInfo.isFlood ? splitHops(c.outPath, hashSize).map((h) => h.slice(0, size)) : [];
    const self = c?.type === 2 ? [this.pubKey.slice(0, size)] : [];
    return { path: concatBytes(...hops, ...self, ...[...hops].reverse()), hashSize: size };
  }

  /** SEND_TRACE_PATH along `path` (concatenated hop hashes; default {@link defaultTracePath}). */
  async tracePath(path?: Uint8Array, hashSize?: number): Promise<TraceResult> {
    const def = this.defaultTracePath();
    const p = path ?? def.path;
    const size = path ? (hashSize ?? 1) : def.hashSize;
    return this.#run('trace', async (c) => {
      if (p.length === 0) throw new Error('No path to trace (the node is not reachable via repeaters)');
      const t0 = this.#now;
      const r = await c.tracePath(p, { ...this.#reqOpts, pathHashSize: size });
      const hops = r.hops.map((h, i): TraceHop => ({ ...this.resolveHop(h), snr: r.snrs[i] ?? Number.NaN }));
      const res: TraceResult = { at: this.#now, hops, finalSnr: r.finalSnr, roundTripMs: this.#now - t0 };
      this.#trace.value = res;
      return res;
    });
  }

  /** SEND_PATH_DISCOVERY_REQ (flood); does not change the stored path (§6.10). */
  async discoverPath(): Promise<PathDiscoveryResult> {
    return this.#run('discovery', async (c) => {
      const t0 = this.#now;
      const r = await c.pathDiscovery(this.pubKey, this.#reqOpts);
      const hops = (path: Uint8Array, size: number): HopRef[] => splitHops(path, size).map((h) => this.resolveHop(h));
      const res: PathDiscoveryResult = {
        at: this.#now,
        outPath: hops(r.outPath, r.outPathInfo.hashSize),
        inPath: hops(r.inPath, r.inPathInfo.hashSize),
        roundTripMs: this.#now - t0,
      };
      this.#discovery.value = res;
      return res;
    });
  }

  /** RESET_PATH: the next message to the node floods and learns a new path. */
  async resetPath(): Promise<void> {
    await this.#run('resetPath', async (c) => {
      const contacts = this.#deps.contacts;
      if (contacts) await contacts.resetPath(this.key);
      else await c.resetPath(this.pubKey);
    });
  }

  // ---- telemetry history ----

  /**
   * Starts tracking {@link telemetryHistory} (idempotent): loads it from the frame log now and
   * whenever a radio store opens, appends points as new responses from the node are archived, and
   * reloads after the frame log is cleared / pruned / imported. Resolves with the latest load
   * (null when not connected); rejects if that load failed.
   */
  loadTelemetryHistory(): Promise<TelemetryHistory | null> {
    this.#historyWatch ??= effect(() => {
      const store = this.#deps.connection.store.value;
      if (!store) {
        this.#history.value = null;
        this.#historyLoad = Promise.resolve(null);
        return;
      }
      return this.#bindHistory(store);
    });
    return this.#historyLoad;
  }

  #bindHistory(store: RadioStore): () => void {
    let stopped = false;
    let loading = false;
    let dirty = false;
    const reload = async (): Promise<TelemetryHistory | null> => {
      if (loading) {
        dirty = true;
        return this.#historyLoad;
      }
      loading = true;
      try {
        // a response archived while the query ran may or may not be in it: query again
        for (;;) {
          dirty = false;
          const h = await loadTelemetryHistory(store.frames, this.pubKey);
          if (stopped) return null;
          if (!dirty) {
            this.#history.value = h;
            return h;
          }
        }
      } finally {
        loading = false;
      }
    };
    const offs = [
      store.events.on('frame', (r) => {
        if (!isHistoryFrameFor(r, this.pubKey)) return;
        if (loading) {
          dirty = true;
          return;
        }
        const cur = this.#history.peek();
        if (!cur) return;
        const add = historyPoints(r, this.pubKey);
        if (add.battery.length || add.temperature.length) {
          this.#history.value = mergeInto({ battery: [...cur.battery], temperature: [...cur.temperature] }, add);
        }
      }),
      store.events.on('logChanged', (e) => {
        if (e.store !== 'frames') return;
        this.#historyLoad = reload();
        this.#historyLoad.catch(() => undefined);
      }),
    ];
    this.#historyLoad = reload();
    this.#historyLoad.catch(() => undefined);
    return () => {
      stopped = true;
      offs.forEach((off) => off());
    };
  }

  /** Stops tracking the telemetry history. */
  dispose(): void {
    this.#historyWatch?.();
    this.#historyWatch = undefined;
  }

  /** Clears session state (the connection dropped). */
  reset(): void {
    this.#login.value = { state: 'loggedOut' };
    this.#status.value = null;
    this.#telemetry.value = null;
    this.#avgMinMax.value = null;
    this.#neighbours.value = null;
    this.#acl.value = null;
    this.#owner.value = null;
    this.#trace.value = null;
    this.#discovery.value = null;
    this.#busy.value = new Set();
    this.#errors.value = {};
    this.#savedPassword.value = null;
  }
}

function lppUnit(type: number): string {
  return LPP_UNITS[type] ?? '';
}

const LPP_UNITS: Readonly<Record<number, string>> = {
  101: 'lux',
  103: '°C',
  104: '%',
  115: 'hPa',
  116: 'V',
  117: 'A',
  118: 'Hz',
  120: '%',
  121: 'm',
  125: 'ppm',
  128: 'W',
  130: 'm',
  131: 'kWh',
  132: '°',
};

/** The CLI kind of a contact kind (chat nodes have no CLI). */
export function cliKindOf(kind: ContactKind | undefined): CliNodeKind | undefined {
  return kind === 'repeater' || kind === 'room' || kind === 'sensor' ? kind : undefined;
}

export class RemoteAdminModel {
  readonly #nodes = new Map<string, RemoteNodeModel>();
  readonly #dispose: () => void;
  readonly #deps: Deps;

  constructor(connection: ConnectionModel, opts: RemoteAdminOptions & { contacts?: ContactsModel } = {}) {
    const { contacts, ...rest } = opts;
    this.#deps = { connection, contacts, opts: rest };
    // sessions end with the connection; remembered passwords are per radio, reload on (re)connect
    this.#dispose = effect(() => {
      const store = connection.store.value;
      if (!connection.connected.value || !store) {
        for (const n of this.#nodes.values()) n.reset();
        return;
      }
      for (const n of this.#nodes.values()) void n.loadSavedPassword().catch(() => undefined);
    });
  }

  /** The per-node model (created on first use; loads its remembered password). */
  node(key: string): RemoteNodeModel {
    const k = key.toLowerCase();
    let n = this.#nodes.get(k);
    if (!n) {
      n = new RemoteNodeModel(k, this.#deps);
      this.#nodes.set(k, n);
      void n.loadSavedPassword().catch(() => undefined);
    }
    return n;
  }

  /** Nodes with a model so far. */
  nodes(): RemoteNodeModel[] {
    return [...this.#nodes.values()];
  }

  dispose(): void {
    this.#dispose();
    for (const n of this.#nodes.values()) n.dispose();
  }
}

/** Contact kind of a record (re-export convenience for the UI). */
export function remoteKindOf(c: Pick<ContactRecord, 'type'>): ContactKind {
  return contactTypeName(c.type);
}
