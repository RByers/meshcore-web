/**
 * CompanionClient: a typed client for a MeshCore companion radio over any FrameTransport.
 *
 * Protocol facts used here (docs/companion-protocol.md):
 *  - §2 handshake: DEVICE_QUERY (the only command that sets app_target_ver) → APP_START.
 *  - The device has no request ids, so commands are strictly serialized: one in flight; every
 *    non-push frame (code < 0x80) answers the in-flight command. Pushes (≥ 0x80) are dispatched
 *    out-of-band at any time.
 *  - §6.1 messages are queued on the device; MSG_WAITING → SYNC_NEXT_MESSAGE until NO_MORE_MESSAGES.
 *  - §6.5 SEND_CONFIRMED is matched by ack code; the device never reports a timeout, so retries
 *    are the host's job.
 *  - §4 notes / §6.10 only one remote request can be outstanding on the device; remote requests
 *    are therefore serialized client-side and resolved from their matching push.
 *  - §7.2 GET_CONTACTS streams CONTACTS_START, CONTACT×k, END_OF_CONTACTS.
 */

import { decodeLpp } from '../packet/lpp.js';
import { bytesEqual, toHex } from '../util/bytes.js';
import { systemClock, type Clock } from '../util/clock.js';
import { Deferred } from '../util/deferred.js';
import { TypedEmitter } from '../util/events.js';
import {
  APP_PROTOCOL_VERSION,
  ERR,
  MANUAL_ADD_CONTACTS_BIT,
  MAX_SIGN_DATA_LEN,
  MAX_TEXT_LEN,
  PATH_LEN_UNKNOWN,
  PUB_KEY_PREFIX_SIZE,
  PUB_KEY_SIZE,
  StatsType,
  TxtType,
  decodePathLen,
  isPushCode,
} from '../protocol/constants.js';
import { decodeFrame } from '../protocol/decode.js';
import { encodeCommand } from '../protocol/encode.js';
import type {
  AdvertPathFrame,
  BattAndStorage,
  ChannelInfo,
  Command,
  Contact,
  ContactInput,
  CustomVar,
  DecodeContext,
  DeviceFrame,
  DeviceFrameKind,
  DeviceInfo,
  LoginSuccessPush,
  PathDiscoveryResponsePush,
  PushFrame,
  RepeatFreqRange,
  SelfInfo,
  SendConfirmedPush,
  SentFrame,
  Stats,
  TraceDataPush,
} from '../protocol/types.js';
import type { FrameTransport, TransportState } from '../transport/transport.js';
import { DeviceError, DisconnectedError, LoginFailedError, RemoteTimeoutError, RequestTimeoutError } from './errors.js';
import {
  type ClientState,
  type CompanionClientEvents,
  type CompanionClientOptions,
  type ConnectedEvent,
  type ConnectOptions,
  type ContactsSnapshot,
  type ConnectStep,
  type ContactRef,
  type ContactsResult,
  type OtherParams,
  type RadioParams,
  type RemoteRequestOptions,
  type RetryOptions,
  type RetrySendResult,
  type SendProgress,
  type SendTextOptions,
  type SentInfo,
  type StatusResult,
  type TelemetryResult,
  type TraceOptions,
} from './types.js';

type FrameOfKind<K extends DeviceFrameKind> = Extract<DeviceFrame, { kind: K }>;

interface RequestControl<T> {
  resolve(value: T): void;
  reject(err: Error): void;
  /** Restarts the inactivity timer (multi-frame replies). */
  touch(): void;
}

/** Offered every incoming frame while its command is in flight; returns true if it consumed it. */
type FrameHandler<T> = (frame: DeviceFrame, ctl: RequestControl<T>) => boolean;

interface Job {
  cmd: Command;
  bytes: Uint8Array;
  timeoutMs: number;
  /** Resolve as soon as the frame is written (REBOOT has no reply). */
  noReply: boolean;
  /** Resolve with undefined instead of rejecting on timeout (FACTORY_RESET). */
  timeoutOk: boolean;
  onFrame: (frame: DeviceFrame) => boolean;
  deferred: Deferred<unknown>;
  timer?: unknown;
  done: boolean;
}

interface Waiter {
  reject(err: Error): void;
}

interface RemotePending {
  statusFrom?: 'repeater' | 'room';
  onPush(push: PushFrame): void;
}

type RemoteMatch<T> = { value: T } | { error: Error } | undefined;

const MESSAGE_KINDS = ['contactMsg', 'channelMsg', 'channelData', 'noMoreMessages'] as const;
const RECENT_ACKS = 64;
/** Upper bound for a single transport write (covers an OS BLE pairing prompt). */
const WRITE_TIMEOUT_MS = 60_000;
/** SIGN_DATA chunk size: frame = 1 code byte + chunk ≤ 176. */
const DEFAULT_SIGN_CHUNK = 160;
/** FIRMWARE_VER_CODE that added SET_FLOOD_SCOPE_KEY `[1]=1` (force an unscoped flood). companion-protocol.md §11 */
export const FLOOD_UNSCOPED_MIN_VER = 12;

function prefixMatches(key: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length === 0 || prefix.length > key.length) return false;
  for (let i = 0; i < prefix.length; i++) if (key[i] !== prefix[i]) return false;
  return true;
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

export class CompanionClient {
  readonly events = new TypedEmitter<CompanionClientEvents>();
  readonly clock: Clock;

  readonly #opts: Required<Omit<CompanionClientOptions, 'clock'>>;
  #transport: FrameTransport | undefined;
  #unsubs: Array<() => void> = [];
  #state: ClientState = 'disconnected';
  #selfInfo: SelfInfo | undefined;
  #deviceInfo: DeviceInfo | undefined;
  #protocolVersion = 0;

  // command queue
  #queue: Job[] = [];
  #active: Job | null = null;

  // message drain
  #drain: Promise<number> | null = null;
  #drainAgain = false;
  /** MSG_WAITING seen during the handshake outside a drain. */
  #waitingDuringHandshake = false;
  /** Steps of the running connect() (for connectProgress); empty when not connecting. */
  #connectSteps: ConnectStep[] = [];

  // contacts cache
  #contacts = new Map<string, Contact>();
  #contactsSince = 0;
  /** Device RTC read during this connect's time sync (before any SET_DEVICE_TIME). */
  #rtcAtConnect: number | undefined;
  #refreshing = new Set<string>();

  // acks
  #recentAcks = new Map<number, SendConfirmedPush>();
  #ackListeners = new Set<(p: SendConfirmedPush) => void>();
  #perContactSend = new Map<string, Promise<unknown>>();

  // remote requests (single outstanding) and traces
  #remoteChain: Promise<unknown> = Promise.resolve();
  /** Serialises {@link withFloodScope} sections (the session scope is one sticky device setting). */
  #scopeChain: Promise<unknown> = Promise.resolve();
  #remote: RemotePending | null = null;
  #traceWaiters = new Map<number, (p: TraceDataPush) => void>();
  #signChain: Promise<unknown> = Promise.resolve();

  /** Everything that must be rejected on disconnect. */
  #waiters = new Set<Waiter>();
  #timers = new Set<unknown>();

  constructor(options: CompanionClientOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.#opts = {
      appName: options.appName ?? 'meshcore-web',
      appVersion: options.appVersion ?? 1,
      protocolVersion: options.protocolVersion ?? APP_PROTOCOL_VERSION,
      requestTimeoutMs: options.requestTimeoutMs ?? 5000,
      timeSync: options.timeSync ?? 'auto',
      timeSyncThresholdSecs: options.timeSyncThresholdSecs ?? 30,
      syncContactsOnConnect: options.syncContactsOnConnect ?? true,
      syncMessagesOnConnect: options.syncMessagesOnConnect ?? true,
      autoSyncMessages: options.autoSyncMessages ?? true,
      autoRefreshContacts: options.autoRefreshContacts ?? true,
      remoteTimeoutGraceMs: options.remoteTimeoutGraceMs ?? 3000,
    };
  }

  // =========================================================================
  // State
  // =========================================================================

  get state(): ClientState {
    return this.#state;
  }
  get connected(): boolean {
    return this.#state === 'connected';
  }
  get transport(): FrameTransport | undefined {
    return this.#transport;
  }
  get selfInfo(): SelfInfo | undefined {
    return this.#selfInfo;
  }
  /** Undefined when DEVICE_QUERY failed (very old firmware). */
  get deviceInfo(): DeviceInfo | undefined {
    return this.#deviceInfo;
  }
  /** app_target_ver accepted by the device (0 if DEVICE_QUERY failed: V1 message frames). */
  get protocolVersion(): number {
    return this.#protocolVersion;
  }
  /** Contact cache (from syncContacts and pushes), in device order of first sighting. */
  get contacts(): Contact[] {
    return [...this.#contacts.values()];
  }
  /** Looks up a cached contact by full key or prefix. */
  findContact(keyOrPrefix: Uint8Array): Contact | undefined {
    if (keyOrPrefix.length === PUB_KEY_SIZE) return this.#contacts.get(toHex(keyOrPrefix));
    for (const c of this.#contacts.values()) if (prefixMatches(c.pubKey, keyOrPrefix)) return c;
    return undefined;
  }
  /** True while a command is in flight or queued. */
  get busy(): boolean {
    return this.#active !== null || this.#queue.length > 0;
  }

  // =========================================================================
  // Connection
  // =========================================================================

  /**
   * Opens `transport` (if needed) and performs the session start (§2): DEVICE_QUERY, APP_START,
   * optional time sync, contacts sync and message drain. Resolves with the connection info.
   * Emits `connectProgress` as each step starts and while contacts / messages stream in.
   *
   * With `opts.contactsSnapshot` the contacts step starts from the saved contacts and only asks for
   * those modified since (see {@link ConnectOptions.contactsSnapshot} and {@link syncContacts}).
   */
  async connect(transport: FrameTransport, opts: ConnectOptions = {}): Promise<ConnectedEvent> {
    if (this.#state !== 'disconnected') throw new Error(`cannot connect while ${this.#state}`);
    this.#transport = transport;
    this.#contacts.clear();
    this.#contactsSince = 0;
    this.#rtcAtConnect = undefined;
    this.#recentAcks.clear();
    this.#selfInfo = undefined;
    this.#deviceInfo = undefined;
    this.#protocolVersion = 0;
    this.#waitingDuringHandshake = false;
    this.#unsubs = [
      transport.events.on('frame', (b) => this.#onFrame(b)),
      transport.events.on('state', (s) => this.#onTransportState(s)),
      transport.events.on('error', (e) => this.#emit('error', e)),
    ];
    this.#setState('connecting');
    const steps: ConnectStep[] = ['deviceQuery', 'appStart'];
    if (this.#opts.timeSync !== 'never') steps.push('timeSync');
    if (this.#opts.syncContactsOnConnect) steps.push('contacts');
    if (this.#opts.syncMessagesOnConnect) steps.push('messages');
    this.#connectSteps = steps;
    try {
      if (transport.state !== 'connected') await transport.connect();
      this.#assertSession(transport);

      this.#connectProgress('deviceQuery');
      try {
        const di = await this.request({ kind: 'deviceQuery', appTargetVer: this.#opts.protocolVersion }, ['deviceInfo']);
        this.#deviceInfo = di.info;
        this.#protocolVersion = this.#opts.protocolVersion;
      } catch (err) {
        // Very old firmware: no DEVICE_QUERY. Messages arrive as V1 frames.
        if (!(err instanceof DeviceError || err instanceof RequestTimeoutError)) throw err;
      }

      this.#connectProgress('appStart');
      const si = await this.request({ kind: 'appStart', appName: this.#opts.appName, appVersion: this.#opts.appVersion }, ['selfInfo']);
      this.#selfInfo = si.info;

      if (this.#opts.timeSync !== 'never') {
        this.#connectProgress('timeSync');
        await this.#syncTimeOnConnect(opts.contactsSnapshot !== undefined);
      }
      if (this.#opts.syncContactsOnConnect) {
        this.#connectProgress('contacts');
        if (opts.contactsSnapshot) await this.#seedContacts(opts.contactsSnapshot);
        await this.syncContacts();
      }
      if (this.#opts.syncMessagesOnConnect) {
        this.#connectProgress('messages', 0);
        await this.syncMessages();
      }
      this.#assertSession(transport);
    } catch (err) {
      this.#connectSteps = [];
      const e = err instanceof Error ? err : new Error(String(err));
      if (this.#transport === transport && this.#state !== 'disconnected') {
        this.#teardown(e);
        await transport.disconnect().catch(() => undefined);
      }
      throw e;
    }
    this.#connectSteps = [];
    this.#setState('connected');
    if (this.#waitingDuringHandshake && this.#opts.autoSyncMessages) this.#background(this.syncMessages());
    this.#waitingDuringHandshake = false;
    const ev: ConnectedEvent = { selfInfo: this.#selfInfo, deviceInfo: this.#deviceInfo, protocolVersion: this.#protocolVersion };
    this.#emit('connected', ev);
    return ev;
  }

  /** Closes the link. Pending operations reject with DisconnectedError. */
  async disconnect(): Promise<void> {
    const t = this.#transport;
    if (this.#state !== 'disconnected') this.#teardown(undefined);
    if (t) await t.disconnect().catch(() => undefined);
  }

  /** Emits connectProgress while connect() runs (no-op otherwise, e.g. a later syncContacts()). */
  #connectProgress(step: ConnectStep, done?: number, total?: number): void {
    if (this.#state !== 'connecting' || !this.#connectSteps.includes(step)) return;
    this.#emit('connectProgress', {
      step,
      steps: this.#connectSteps,
      ...(done !== undefined ? { done } : {}),
      ...(total !== undefined ? { total } : {}),
    });
  }

  #assertSession(transport: FrameTransport): void {
    if (this.#transport !== transport || this.#state === 'disconnected') throw new DisconnectedError();
  }

  #onTransportState(s: TransportState): void {
    if (s === 'disconnected' && this.#state !== 'disconnected') this.#teardown(new DisconnectedError('link lost'));
  }

  #setState(s: ClientState): void {
    if (s === this.#state) return;
    this.#state = s;
    this.#emit('state', s);
  }

  #teardown(error: Error | undefined): void {
    for (const off of this.#unsubs) off();
    this.#unsubs = [];
    this.#setState('disconnected');
    const dis = (): DisconnectedError => new DisconnectedError(error ? `disconnected: ${error.message}` : 'disconnected', { cause: error });
    const jobs = [...(this.#active ? [this.#active] : []), ...this.#queue];
    this.#active = null;
    this.#queue = [];
    for (const j of jobs) this.#settle(j, dis());
    for (const w of [...this.#waiters]) w.reject(dis());
    this.#waiters.clear();
    for (const t of this.#timers) this.clock.clearTimeout(t);
    this.#timers.clear();
    this.#remote = null;
    this.#traceWaiters.clear();
    this.#ackListeners.clear();
    this.#perContactSend.clear();
    this.#refreshing.clear();
    this.#drainAgain = false;
    this.#emit('disconnected', error ? { error } : {});
  }

  // =========================================================================
  // Events
  // =========================================================================

  #emit<K extends keyof CompanionClientEvents>(event: K, payload: CompanionClientEvents[K]): void {
    try {
      this.events.emit(event, payload);
    } catch (err) {
      if (event === 'error') return;
      try {
        this.events.emit('error', err instanceof Error ? err : new Error(String(err)));
      } catch {
        // a throwing error listener must not break the client
      }
    }
  }

  /** Runs a background operation, reporting failures other than disconnects on `error`. */
  #background(p: Promise<unknown>): void {
    p.catch((err: unknown) => {
      if (err instanceof DisconnectedError) return;
      this.#emit('error', err instanceof Error ? err : new Error(String(err)));
    });
  }

  #setTimer(fn: () => void, ms: number): unknown {
    const h = this.clock.setTimeout(() => {
      this.#timers.delete(h);
      fn();
    }, ms);
    this.#timers.add(h);
    return h;
  }

  #clearTimer(h: unknown): void {
    if (h === undefined) return;
    this.clock.clearTimeout(h);
    this.#timers.delete(h);
  }

  /**
   * Waits up to `ms` for `register`'s callback to fire. Resolves with its value, or null on
   * timeout. Rejects with DisconnectedError on disconnect.
   */
  #waitFor<T>(ms: number, register: (resolve: (v: T) => void) => () => void): Promise<T | null> {
    if (this.#state === 'disconnected') return Promise.reject(new DisconnectedError());
    const d = new Deferred<T | null>();
    let timer: unknown;
    let unregister = (): void => undefined;
    const w: Waiter = { reject: (e) => finish(() => d.reject(e)) };
    const finish = (settle: () => void): void => {
      if (d.settled) return;
      this.#clearTimer(timer);
      unregister();
      this.#waiters.delete(w);
      settle();
    };
    this.#waiters.add(w);
    unregister = register((v) => finish(() => d.resolve(v)));
    if (!d.settled) timer = this.#setTimer(() => finish(() => d.resolve(null)), Math.max(0, ms));
    return d.promise;
  }

  // =========================================================================
  // Frame I/O and request correlation
  // =========================================================================

  #onFrame(bytes: Uint8Array): void {
    const ctx: DecodeContext = {};
    if (this.#active) ctx.expecting = this.#active.cmd.kind;
    const statusFrom = this.#remote?.statusFrom;
    if (statusFrom) ctx.statusFrom = statusFrom;
    let frame: DeviceFrame;
    try {
      frame = decodeFrame(bytes, ctx);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.#emit('frame', { direction: 'in', bytes, timestamp: this.clock.now(), decodeError: e });
      this.#emit('error', e);
      return;
    }
    this.#emit('frame', { direction: 'in', bytes, timestamp: this.clock.now(), frame });
    const job = this.#active;
    if (job && !job.done) {
      try {
        job.onFrame(frame);
      } catch (err) {
        this.#settle(job, err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (isPushCode(frame.code)) this.#dispatchPush(frame as PushFrame);
  }

  /**
   * Sends one command and resolves with the first reply whose kind is in `expect`. ERR becomes
   * a DeviceError, DISABLED a DeviceError named 'DISABLED'. Commands are queued and sent one at a
   * time. `expect` may include push kinds (e.g. self telemetry answers with a push).
   */
  request<K extends DeviceFrameKind>(cmd: Command, expect: readonly K[], timeoutMs?: number): Promise<FrameOfKind<K>> {
    return this.#exchange<FrameOfKind<K>>(
      cmd,
      (f, ctl) => {
        if ((expect as readonly DeviceFrameKind[]).includes(f.kind)) {
          ctl.resolve(f as FrameOfKind<K>);
          return true;
        }
        return this.#rejectOnError(cmd, f, ctl);
      },
      timeoutMs !== undefined ? { timeoutMs } : {},
    );
  }

  /** OK-only command. */
  async #ok(cmd: Command, timeoutMs?: number): Promise<void> {
    await this.request(cmd, ['ok'], timeoutMs);
  }

  #rejectOnError(cmd: Command, f: DeviceFrame, ctl: RequestControl<never>): boolean {
    if (f.kind === 'err') {
      ctl.reject(new DeviceError(cmd.kind, f.errCode, f.errName));
      return true;
    }
    if (f.kind === 'disabled') {
      ctl.reject(new DeviceError(cmd.kind, -1, 'DISABLED'));
      return true;
    }
    return false;
  }

  #exchange<T>(
    cmd: Command,
    handler: FrameHandler<T>,
    opts: { timeoutMs?: number; noReply?: boolean; timeoutOk?: boolean } = {},
  ): Promise<T> {
    if (this.#state === 'disconnected' || !this.#transport) return Promise.reject(new DisconnectedError('not connected'));
    let bytes: Uint8Array;
    try {
      bytes = encodeCommand(cmd);
    } catch (err) {
      return Promise.reject(err);
    }
    const deferred = new Deferred<unknown>();
    const job: Job = {
      cmd,
      bytes,
      timeoutMs: opts.timeoutMs ?? this.#opts.requestTimeoutMs,
      noReply: opts.noReply ?? false,
      timeoutOk: opts.timeoutOk ?? false,
      deferred,
      done: false,
      onFrame: () => false,
    };
    const ctl: RequestControl<T> = {
      resolve: (v) => this.#settle(job, undefined, v),
      reject: (e) => this.#settle(job, e),
      touch: () => this.#armTimer(job),
    };
    job.onFrame = (f) => handler(f, ctl);
    this.#queue.push(job);
    this.#pump();
    return deferred.promise as Promise<T>;
  }

  #pump(): void {
    if (this.#active || this.#queue.length === 0) return;
    const job = this.#queue.shift()!;
    const transport = this.#transport;
    if (!transport) {
      this.#settle(job, new DisconnectedError('not connected'));
      return;
    }
    this.#active = job;
    // The reply timeout runs from write completion, not from queueing: a BLE write-with-response
    // to a not-yet-bonded device blocks while the OS pairing (PIN) dialog is open, which easily
    // exceeds the reply timeout. Until the write completes only a long write timeout applies.
    this.#armTimer(job, Math.max(job.timeoutMs, WRITE_TIMEOUT_MS));
    this.#emit('frame', { direction: 'out', bytes: job.bytes, timestamp: this.clock.now(), command: job.cmd.kind });
    transport.send(job.bytes).then(
      () => {
        if (job.noReply) this.#settle(job, undefined, undefined);
        else this.#armTimer(job);
      },
      (err: unknown) => this.#settle(job, err instanceof Error ? err : new Error(String(err))),
    );
  }

  #armTimer(job: Job, ms = job.timeoutMs): void {
    if (job.done) return;
    this.#clearTimer(job.timer);
    job.timer = this.#setTimer(() => {
      if (job.timeoutOk) this.#settle(job, undefined, undefined);
      else this.#settle(job, new RequestTimeoutError(job.cmd.kind, ms));
    }, ms);
  }

  #settle(job: Job, err: Error | undefined, value?: unknown): void {
    if (job.done) return;
    job.done = true;
    this.#clearTimer(job.timer);
    if (err) job.deferred.reject(err);
    else job.deferred.resolve(value);
    if (this.#active === job) {
      this.#active = null;
      this.#pump();
    } else {
      const i = this.#queue.indexOf(job);
      if (i >= 0) this.#queue.splice(i, 1);
    }
  }

  // =========================================================================
  // Push dispatch
  // =========================================================================

  #dispatchPush(p: PushFrame): void {
    this.#remote?.onPush(p);
    switch (p.kind) {
      case 'advert':
        this.#emit('advert', p);
        this.#autoRefresh(p.pubKey);
        break;
      case 'pathUpdated':
        this.#emit('pathUpdated', p);
        this.#autoRefresh(p.pubKey);
        break;
      case 'sendConfirmed':
        this.#recentAcks.set(p.ackCode, p);
        if (this.#recentAcks.size > RECENT_ACKS) {
          const first = this.#recentAcks.keys().next();
          if (!first.done) this.#recentAcks.delete(first.value);
        }
        for (const l of [...this.#ackListeners]) l(p);
        this.#emit('sendConfirmed', p);
        break;
      case 'msgWaiting':
        this.#emit('msgWaiting', undefined);
        if (this.#opts.autoSyncMessages && this.#state === 'connected') this.#background(this.syncMessages());
        else if (this.#drain) this.#drainAgain = true;
        else this.#waitingDuringHandshake = true;
        break;
      case 'rawData':
        this.#emit('rawData', p);
        break;
      case 'loginSuccess':
        this.#emit('loginSuccess', p);
        break;
      case 'loginFail':
        this.#emit('loginFail', p);
        break;
      case 'statusResponse':
        this.#emit('statusResponse', p);
        break;
      case 'logRxData':
        this.#emit('logRxData', p);
        break;
      case 'traceData': {
        const w = this.#traceWaiters.get(p.tag);
        if (w) w(p);
        this.#emit('traceData', p);
        break;
      }
      case 'newAdvert':
        this.#emit('newAdvert', p);
        break;
      case 'telemetryResponse':
        this.#emit('telemetryResponse', p);
        break;
      case 'binaryResponse':
        this.#emit('binaryResponse', p);
        break;
      case 'pathDiscoveryResponse':
        this.#emit('pathDiscovery', p);
        break;
      case 'controlData':
        this.#emit('controlData', p);
        break;
      case 'contactDeleted': {
        const k = toHex(p.pubKey);
        if (this.#contacts.delete(k)) this.#contactsChanged([], [p.pubKey], false);
        this.#emit('contactDeleted', p);
        break;
      }
      case 'contactsFull':
        this.#emit('contactsFull', p);
        break;
    }
  }

  #autoRefresh(pubKey: Uint8Array): void {
    if (!this.#opts.autoRefreshContacts || this.#state === 'disconnected') return;
    const k = toHex(pubKey);
    if (this.#refreshing.has(k)) return;
    this.#refreshing.add(k);
    this.#background(
      this.refreshContact(pubKey).finally(() => {
        this.#refreshing.delete(k);
      }),
    );
  }

  // =========================================================================
  // Contacts (§7)
  // =========================================================================

  #contactsChanged(updated: Contact[], removed: Uint8Array[], full: boolean): void {
    this.#emit('contactsChanged', { contacts: this.contacts, updated, removed, full, since: this.#contactsSince });
  }

  #fullKey(ref: ContactRef): Uint8Array {
    const key = ref instanceof Uint8Array ? ref : ref.pubKey;
    if (key.length === PUB_KEY_SIZE) return key;
    const c = this.findContact(key);
    if (!c) throw new Error(`unknown contact ${toHex(key)}`);
    return c.pubKey;
  }

  /** GET_CONTACTS (§7.2) as one request. Does not touch the cache; see syncContacts. */
  getContacts(since?: number): Promise<ContactsResult> {
    const cmd: Command = since !== undefined ? { kind: 'getContacts', since } : { kind: 'getContacts' };
    let total: number | undefined;
    const contacts: Contact[] = [];
    return this.#exchange<ContactsResult>(cmd, (f, ctl) => {
      switch (f.kind) {
        case 'contactsStart':
          total = f.total;
          this.#connectProgress('contacts', 0, total);
          ctl.touch();
          return true;
        case 'contact':
          if (total === undefined) return false;
          contacts.push(f.contact);
          this.#connectProgress('contacts', contacts.length, total);
          ctl.touch();
          return true;
        case 'endOfContacts':
          if (total === undefined) return false;
          ctl.resolve({ total, contacts, mostRecentLastMod: f.mostRecentLastMod });
          return true;
        default:
          return this.#rejectOnError(cmd, f, ctl);
      }
    });
  }

  /**
   * Updates the contact cache. Incremental (since = largest lastmod seen) unless `full`, or on
   * the first sync. A full sync also drops cached contacts the device no longer has.
   *
   * An incremental reply cannot report deletions, so it is checked against CONTACTS_START's total
   * (all contacts on the device, §5.2): additions always carry a fresh lastmod and are in the
   * reply, so if the merged cache's size differs from the total something was removed (or the
   * cache is stale) and a full sync follows at once. The result is then the full sync's.
   */
  async syncContacts(opts: { full?: boolean } = {}): Promise<ContactsResult> {
    let full = opts.full === true || this.#contactsSince === 0;
    // The firmware filter is strict (`lastmod > since`, MyMesh.cpp L2397) at 1 s resolution, so a
    // contact modified later in the same second as the previous mostRecentLastMod would be missed;
    // re-ask for that boundary second (re-sent contacts just overwrite the cache).
    let r = await this.getContacts(full ? undefined : this.#contactsSince - 1);
    if (!full) {
      const merged = new Set(this.#contacts.keys());
      for (const c of r.contacts) merged.add(toHex(c.pubKey));
      if (merged.size !== r.total) {
        full = true;
        r = await this.getContacts();
      }
    }
    const removed: Uint8Array[] = [];
    if (full) {
      const keep = new Set(r.contacts.map((c) => toHex(c.pubKey)));
      for (const [k, c] of this.#contacts) {
        if (!keep.has(k)) {
          this.#contacts.delete(k);
          removed.push(c.pubKey);
        }
      }
    }
    for (const c of r.contacts) this.#contacts.set(toHex(c.pubKey), c);
    // a full reply's max lastmod is the true cursor (it may be lower after an RTC regression)
    if (full || r.mostRecentLastMod > this.#contactsSince) this.#contactsSince = r.mostRecentLastMod;
    this.#contactsChanged(r.contacts, removed, full);
    return r;
  }

  /**
   * Seeds the cache and cursor from a saved snapshot (connect, before the first syncContacts)
   * unless it is unusable: none, another radio's, or newer than the device clock, which means the
   * RTC went backwards (e.g. a reboot without an RTC battery) and contacts changed since then may
   * carry a lastmod below the cursor. The seed emits nothing: the snapshot's owner already has it.
   */
  async #seedContacts(load: NonNullable<ConnectOptions['contactsSnapshot']>): Promise<void> {
    const self = this.#selfInfo;
    if (!self) return;
    let snap: ContactsSnapshot | undefined;
    try {
      snap = await load(self);
    } catch (err) {
      this.#emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!snap || snap.since <= 0 || !bytesEqual(snap.selfPubKey, self.pubKey)) return;
    let rtc = this.#rtcAtConnect;
    if (rtc === undefined) {
      try {
        rtc = await this.getDeviceTime();
      } catch (err) {
        if (err instanceof DeviceError || err instanceof RequestTimeoutError) return;
        throw err;
      }
    }
    if (rtc < snap.since) return;
    for (const c of snap.contacts) this.#contacts.set(toHex(c.pubKey), c);
    this.#contactsSince = snap.since;
  }

  /** The `since` value the next incremental syncContacts() will use. */
  get contactsSince(): number {
    return this.#contactsSince;
  }

  /** GET_CONTACT_BY_KEY. Undefined if the device does not have it (ERR NOT_FOUND). */
  async getContactByKey(pubKey: Uint8Array): Promise<Contact | undefined> {
    try {
      return (await this.request({ kind: 'getContactByKey', pubKey: this.#fullKey(pubKey) }, ['contact'])).contact;
    } catch (err) {
      if (err instanceof DeviceError && err.errCode === ERR.NOT_FOUND) return undefined;
      throw err;
    }
  }

  /** Re-reads one contact into the cache (removing it if the device no longer has it). */
  async refreshContact(pubKey: Uint8Array): Promise<Contact | undefined> {
    const key = this.#fullKey(pubKey);
    const c = await this.getContactByKey(key);
    const k = toHex(key);
    if (c) {
      this.#contacts.set(k, c);
      this.#contactsChanged([c], [], false);
    } else if (this.#contacts.delete(k)) {
      this.#contactsChanged([], [key], false);
    }
    return c;
  }

  /**
   * ADD_UPDATE_CONTACT. lat/lon are always sent (the firmware leaves a new contact's coordinates
   * uninitialised otherwise); when not given they are taken from the cached contact, else 0.
   */
  async addOrUpdateContact(contact: ContactInput): Promise<void> {
    if (contact.lat === undefined || contact.lon === undefined) {
      const cached = this.#contacts.get(toHex(contact.pubKey));
      contact = { ...contact, lat: contact.lat ?? cached?.lat ?? 0, lon: contact.lon ?? cached?.lon ?? 0 };
    }
    await this.#ok({ kind: 'addUpdateContact', contact });
    await this.refreshContact(contact.pubKey);
  }

  async removeContact(ref: ContactRef): Promise<void> {
    const key = this.#fullKey(ref);
    await this.#ok({ kind: 'removeContact', pubKey: key });
    if (this.#contacts.delete(toHex(key))) this.#contactsChanged([], [key], false);
  }

  /** RESET_PATH: out_path_len = 0xFF, so the next send floods. */
  async resetPath(ref: ContactRef): Promise<void> {
    const key = this.#fullKey(ref);
    await this.#ok({ kind: 'resetPath', pubKey: key });
    const k = toHex(key);
    const c = this.#contacts.get(k);
    if (c) {
      const u: Contact = { ...c, outPathLen: PATH_LEN_UNKNOWN, outPathInfo: decodePathLen(PATH_LEN_UNKNOWN), outPath: new Uint8Array(0) };
      this.#contacts.set(k, u);
      this.#contactsChanged([u], [], false);
    }
  }

  /** SHARE_CONTACT: re-broadcasts the stored advert zero-hop. */
  async shareContact(ref: ContactRef): Promise<void> {
    return this.#ok({ kind: 'shareContact', pubKey: this.#fullKey(ref) });
  }

  /** EXPORT_CONTACT: raw advert packet; no argument = self. */
  async exportContact(ref?: ContactRef): Promise<Uint8Array> {
    const cmd: Command = ref === undefined ? { kind: 'exportContact' } : { kind: 'exportContact', pubKey: this.#fullKey(ref) };
    return (await this.request(cmd, ['exportContact'])).packet;
  }

  importContact(packet: Uint8Array): Promise<void> {
    return this.#ok({ kind: 'importContact', packet });
  }

  async hasConnection(ref: ContactRef): Promise<boolean> {
    const cmd: Command = { kind: 'hasConnection', pubKey: this.#fullKey(ref) };
    return this.request(cmd, ['ok']).then(
      () => true,
      (err: unknown) => {
        if (err instanceof DeviceError && err.errCode === ERR.NOT_FOUND) return false;
        throw err;
      },
    );
  }

  async getAdvertPath(ref: ContactRef): Promise<AdvertPathFrame | undefined> {
    try {
      return await this.request({ kind: 'getAdvertPath', pubKey: this.#fullKey(ref) }, ['advertPath']);
    } catch (err) {
      if (err instanceof DeviceError && err.errCode === ERR.NOT_FOUND) return undefined;
      throw err;
    }
  }

  // =========================================================================
  // Messages (§6.1-§6.5, §8)
  // =========================================================================

  /**
   * Drains the device's offline queue (SYNC_NEXT_MESSAGE until NO_MORE_MESSAGES), emitting
   * contactMessage / channelMessage / channelData. Concurrent calls (and MSG_WAITING pushes
   * during a drain) are coalesced into the running drain, which makes one more pass if needed.
   * Resolves with the number of frames drained.
   */
  syncMessages(): Promise<number> {
    if (this.#drain) {
      this.#drainAgain = true;
      return this.#drain;
    }
    const run = async (): Promise<number> => {
      let n = 0;
      try {
        do {
          for (;;) {
            this.#drainAgain = false;
            const f = await this.request({ kind: 'syncNextMessage' }, MESSAGE_KINDS);
            if (f.kind === 'noMoreMessages') break;
            n++;
            this.#dispatchMessage(f);
            this.#connectProgress('messages', n);
          }
        } while (this.#drainAgain);
      } finally {
        this.#drain = null;
        this.#drainAgain = false;
      }
      return n;
    };
    this.#drain = run();
    return this.#drain;
  }

  #dispatchMessage(f: FrameOfKind<'contactMsg' | 'channelMsg' | 'channelData'>): void {
    // the connect-time drain empties the backlog heard while no app was attached
    const queued = this.#state === 'connecting';
    switch (f.kind) {
      case 'contactMsg':
        this.#emit('contactMessage', { message: f, contact: this.findContact(f.senderPrefix), queued });
        break;
      case 'channelMsg':
        this.#emit('channelMessage', { message: f, queued });
        break;
      case 'channelData':
        this.#emit('channelData', { message: f });
        break;
    }
  }

  #nowSecs(): number {
    return Math.floor(this.clock.now() / 1000);
  }

  /** SEND_TXT_MSG → SENT. Use waitForAck / sendTextMessageWithRetry for delivery. */
  async sendTextMessage(ref: ContactRef, text: string, opts: SendTextOptions = {}): Promise<SentInfo> {
    const key = ref instanceof Uint8Array ? ref : ref.pubKey;
    const timestamp = opts.timestamp ?? this.#nowSecs();
    const attempt = opts.attempt ?? 0;
    const cmd: Command = { kind: 'sendTxtMsg', recipient: key, text, timestamp, attempt };
    if (opts.txtType !== undefined) cmd.txtType = opts.txtType;
    const sent = await this.request(cmd, ['sent']);
    return { ackCode: sent.tag, estTimeoutMs: sent.estTimeoutMs, flood: sent.flood, timestamp, attempt };
  }

  /**
   * Resolves with the SEND_CONFIRMED push for `ackCode` (also if it already arrived recently),
   * or null after `timeoutMs`.
   */
  waitForAck(ackCode: number, timeoutMs: number): Promise<SendConfirmedPush | null> {
    const seen = this.#recentAcks.get(ackCode);
    if (seen) return Promise.resolve(seen);
    return this.#waitFor<SendConfirmedPush>(timeoutMs, (resolve) => {
      const l = (p: SendConfirmedPush): void => {
        if (p.ackCode === ackCode) resolve(p);
      };
      this.#ackListeners.add(l);
      return () => this.#ackListeners.delete(l);
    });
  }

  /**
   * Sends a direct message and retries until a SEND_CONFIRMED matches any of its ACK codes
   * (feature-inventory.md §3.3): `attempt` increments each time; after `floodAfterAttempts`
   * direct attempts the path is reset (RESET_PATH) so the remaining attempts flood. Messages to
   * the same contact are sent one at a time.
   */
  sendTextMessageWithRetry(ref: ContactRef, text: string, opts: RetryOptions = {}): Promise<RetrySendResult> {
    let k: string;
    try {
      k = toHex((ref instanceof Uint8Array ? ref : ref.pubKey).subarray(0, PUB_KEY_PREFIX_SIZE));
    } catch (err) {
      return Promise.reject(err);
    }
    const prev = this.#perContactSend.get(k) ?? Promise.resolve();
    const run = prev.then(
      () => this.#sendWithRetry(ref, text, opts),
      () => this.#sendWithRetry(ref, text, opts),
    );
    this.#perContactSend.set(k, run);
    run
      .finally(() => {
        if (this.#perContactSend.get(k) === run) this.#perContactSend.delete(k);
      })
      .catch(() => undefined);
    return run;
  }

  async #sendWithRetry(ref: ContactRef, text: string, opts: RetryOptions): Promise<RetrySendResult> {
    const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
    const floodAfter = Math.max(1, opts.floodAfterAttempts ?? maxAttempts - 2);
    const resetPathOnFlood = opts.resetPathOnFlood ?? true;
    const timestamp = opts.timestamp ?? this.#nowSecs();
    const grace = opts.ackGraceMs ?? 1000;
    const retryDelay = opts.retryDelayMs ?? ((n: number) => Math.min(1000 * 2 ** (n - 1), 16000));
    const progress = (p: SendProgress): void => {
      try {
        opts.onProgress?.(p);
      } catch (err) {
        this.#emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    };
    // attempt > 3 adds 2 bytes to the ciphertext (§8); keep long texts within 160 bytes
    const long = utf8Length(text) > MAX_TEXT_LEN - 2;

    const codes = new Set<number>();
    const result: RetrySendResult = { status: 'failed', attempts: 0, ackCodes: [], pathReset: false };
    let confirmed: SendConfirmedPush | undefined;
    let wake: (() => void) | undefined;
    const listener = (p: SendConfirmedPush): void => {
      if (!confirmed && codes.has(p.ackCode)) {
        confirmed = p;
        wake?.();
      }
    };
    this.#ackListeners.add(listener);
    const waitAck = async (ms: number): Promise<boolean> => {
      if (confirmed) return true;
      await this.#waitFor<true>(ms, (resolve) => {
        wake = () => resolve(true);
        return () => {
          wake = undefined;
        };
      });
      return confirmed !== undefined;
    };

    let lastFlood: boolean | undefined;
    let lastAttempt = 0;
    try {
      for (let i = 0; i < maxAttempts; i++) {
        lastAttempt = i;
        if (i > 0 && i >= floodAfter && lastFlood === false && resetPathOnFlood && !result.pathReset) {
          await this.resetPath(ref).catch((err: unknown) => {
            if (err instanceof DisconnectedError) throw err;
          });
          result.pathReset = true;
          if (confirmed) break;
        }
        const attempt = long ? Math.min(i, 3) : i;
        progress({ status: 'pending', attempt: i });
        const sent = await this.sendTextMessage(ref, text, { attempt, timestamp });
        result.attempts = i + 1;
        result.ackCodes.push(sent.ackCode);
        codes.add(sent.ackCode);
        lastFlood = sent.flood;
        const recent = this.#recentAcks.get(sent.ackCode);
        if (recent && !confirmed) confirmed = recent;
        progress({ status: 'sent', attempt: i, ackCode: sent.ackCode, flood: sent.flood, estTimeoutMs: sent.estTimeoutMs });
        if (await waitAck(opts.ackTimeoutMs ?? sent.estTimeoutMs + grace)) break;
        if (i + 1 < maxAttempts && (await waitAck(Math.max(0, retryDelay(i + 1))))) break;
      }
    } catch (err) {
      result.error = err instanceof Error ? err : new Error(String(err));
    }

    if (confirmed) {
      this.#ackListeners.delete(listener);
      const which = result.ackCodes.indexOf(confirmed.ackCode);
      result.status = 'delivered';
      result.confirmedAck = confirmed.ackCode;
      result.roundTripMs = confirmed.roundTripMs;
      delete result.error;
      progress({ status: 'delivered', attempt: which >= 0 ? which : lastAttempt, ackCode: confirmed.ackCode, roundTripMs: confirmed.roundTripMs });
      return result;
    }
    const failed: SendProgress = { status: 'failed', attempt: lastAttempt };
    if (result.error) failed.error = result.error;
    progress(failed);
    const late = opts.lateAckGraceMs ?? 0;
    if (late > 0 && codes.size > 0 && !(result.error instanceof DisconnectedError)) {
      void waitAck(late)
        .then((ok) => {
          if (ok && confirmed) {
            const which = result.ackCodes.indexOf(confirmed.ackCode);
            progress({ status: 'delivered', attempt: which, ackCode: confirmed.ackCode, roundTripMs: confirmed.roundTripMs, late: true });
          }
        })
        .catch(() => undefined)
        .finally(() => this.#ackListeners.delete(listener));
    } else {
      this.#ackListeners.delete(listener);
    }
    return result;
  }

  /** SEND_CHANNEL_TXT_MSG → OK (§4 CMD 3; the docs' MSG_SENT is wrong). The device prefixes "name: ". */
  sendChannelMessage(channelIdx: number, text: string, opts: { timestamp?: number } = {}): Promise<void> {
    return this.#ok({ kind: 'sendChannelTxtMsg', channelIdx, text, timestamp: opts.timestamp ?? this.#nowSecs() });
  }

  /** SEND_CHANNEL_DATA. Flood unless pathLen/path are given. */
  sendChannelData(channelIdx: number, dataType: number, payload: Uint8Array, route: { pathLen?: number; path?: Uint8Array } = {}): Promise<void> {
    const cmd: Command = { kind: 'sendChannelData', channelIdx, dataType, payload };
    if (route.pathLen !== undefined) cmd.pathLen = route.pathLen;
    if (route.path !== undefined) cmd.path = route.path;
    return this.#ok(cmd);
  }

  // =========================================================================
  // Self / device settings
  // =========================================================================

  #updateSelf(patch: Partial<SelfInfo>): void {
    if (!this.#selfInfo) return;
    this.#selfInfo = { ...this.#selfInfo, ...patch };
    this.#emit('selfInfo', this.#selfInfo);
  }

  /** Re-reads SELF_INFO (APP_START). */
  async refreshSelfInfo(): Promise<SelfInfo> {
    const si = await this.request({ kind: 'appStart', appName: this.#opts.appName, appVersion: this.#opts.appVersion }, ['selfInfo']);
    this.#selfInfo = si.info;
    this.#emit('selfInfo', si.info);
    return si.info;
  }

  /** SEND_SELF_ADVERT. Default zero-hop. */
  sendSelfAdvert(mode: 'flood' | 'zeroHop' = 'zeroHop'): Promise<void> {
    return this.#ok({ kind: 'sendSelfAdvert', flood: mode === 'flood' });
  }

  async setAdvertName(name: string): Promise<void> {
    await this.#ok({ kind: 'setAdvertName', name });
    this.#updateSelf({ name });
  }

  /** Degrees. */
  async setAdvertLatLon(lat: number, lon: number, alt?: number): Promise<void> {
    const cmd: Command = { kind: 'setAdvertLatLon', lat, lon };
    if (alt !== undefined) cmd.alt = alt;
    await this.#ok(cmd);
    this.#updateSelf({ lat, lon });
  }

  async getDeviceTime(): Promise<number> {
    return (await this.request({ kind: 'getDeviceTime' }, ['currTime'])).epochSecs;
  }

  /** SET_DEVICE_TIME. ERR ILLEGAL_ARG if earlier than the device RTC (it can't go backwards). */
  setDeviceTime(epochSecs: number): Promise<void> {
    return this.#ok({ kind: 'setDeviceTime', epochSecs: Math.floor(epochSecs) });
  }

  /**
   * Sets the device clock to the host clock if it is behind by more than `thresholdSecs`.
   * Returns true if it was set.
   */
  async syncDeviceTime(thresholdSecs = this.#opts.timeSyncThresholdSecs): Promise<boolean> {
    return this.#syncDeviceTime(await this.getDeviceTime(), thresholdSecs);
  }

  async #syncDeviceTime(dev: number, thresholdSecs: number): Promise<boolean> {
    const host = this.#nowSecs();
    if (dev >= host - thresholdSecs) return false;
    await this.setDeviceTime(host);
    return true;
  }

  /** `readRtc`: also read the RTC before setting it in 'always' mode (to vet a contacts snapshot). */
  async #syncTimeOnConnect(readRtc: boolean): Promise<void> {
    try {
      if (this.#opts.timeSync === 'always') {
        if (readRtc) this.#rtcAtConnect = await this.getDeviceTime();
        await this.setDeviceTime(this.#nowSecs());
      } else {
        this.#rtcAtConnect = await this.getDeviceTime();
        await this.#syncDeviceTime(this.#rtcAtConnect, this.#opts.timeSyncThresholdSecs);
      }
    } catch (err) {
      if (err instanceof DeviceError) return; // device clock ahead of ours: it cannot go backwards
      throw err;
    }
  }

  /**
   * SET_RADIO_PARAMS. The firmware (MyMesh.cpp L1424-1458) sets client repeat from byte [11] on
   * every call, treating an absent byte as "off", so an omitted `clientRepeat` keeps the device's
   * current setting (DEVICE_INFO[80]) instead of silently disabling it.
   */
  async setRadioParams(p: RadioParams): Promise<void> {
    const clientRepeat = p.clientRepeat ?? this.#deviceInfo?.clientRepeat ?? false;
    await this.#ok({ kind: 'setRadioParams', freqKhz: p.freqKhz, bwHz: p.bwHz, sf: p.sf, cr: p.cr, clientRepeat });
    if (this.#deviceInfo?.clientRepeat !== undefined) this.#deviceInfo = { ...this.#deviceInfo, clientRepeat };
    this.#updateSelf({ radioFreqKhz: p.freqKhz, radioBwHz: p.bwHz, radioSf: p.sf, radioCr: p.cr });
  }

  async setTxPower(dbm: number): Promise<void> {
    await this.#ok({ kind: 'setRadioTxPower', dbm });
    this.#updateSelf({ txPowerDbm: dbm });
  }

  /** There is no GET for these: they come from SELF_INFO (re-read here). */
  async getOtherParams(): Promise<OtherParams> {
    const si = await this.refreshSelfInfo();
    return { manualAddContacts: si.manualAddContacts, telemetryModes: si.telemetryModes, advertLocPolicy: si.advertLocPolicy, multiAcks: si.multiAcks };
  }

  /** SET_OTHER_PARAMS, always sending all fields (missing ones from the cached SELF_INFO). */
  async setOtherParams(p: Partial<OtherParams>): Promise<void> {
    const si = this.#selfInfo;
    const full: OtherParams = {
      manualAddContacts: p.manualAddContacts ?? si?.manualAddContacts ?? 0,
      telemetryModes: p.telemetryModes ?? si?.telemetryModes ?? { base: 0, location: 0, environment: 0 },
      advertLocPolicy: p.advertLocPolicy ?? si?.advertLocPolicy ?? 0,
      multiAcks: p.multiAcks ?? si?.multiAcks ?? 0,
    };
    await this.#ok({ kind: 'setOtherParams', ...full });
    this.#updateSelf({ ...full });
  }

  /** Manual-add mode (SELF_INFO[47] bit 0) via SET_OTHER_PARAMS. */
  setManualAddContacts(manual: boolean): Promise<void> {
    const cur = this.#selfInfo?.manualAddContacts ?? 0;
    return this.setOtherParams({ manualAddContacts: manual ? cur | MANUAL_ADD_CONTACTS_BIT : cur & ~MANUAL_ADD_CONTACTS_BIT });
  }

  async getTuningParams(): Promise<{ rxDelayBase: number; airtimeFactor: number }> {
    const f = await this.request({ kind: 'getTuningParams' }, ['tuningParams']);
    return { rxDelayBase: f.rxDelayBase, airtimeFactor: f.airtimeFactor };
  }

  setTuningParams(rxDelayBase: number, airtimeFactor: number): Promise<void> {
    return this.#ok({ kind: 'setTuningParams', rxDelayBase, airtimeFactor });
  }

  async getChannel(index: number): Promise<ChannelInfo> {
    return (await this.request({ kind: 'getChannel', index }, ['channelInfo'])).channel;
  }

  /** All channel slots (including empty ones) up to DEVICE_INFO max_channels. */
  async getChannels(): Promise<ChannelInfo[]> {
    const max = this.#deviceInfo?.maxChannels ?? 8;
    const out: ChannelInfo[] = [];
    for (let i = 0; i < max; i++) {
      try {
        out.push(await this.getChannel(i));
      } catch (err) {
        if (err instanceof DeviceError && err.errCode === ERR.NOT_FOUND) break;
        throw err;
      }
    }
    return out;
  }

  setChannel(index: number, name: string, secret: Uint8Array): Promise<void> {
    return this.#ok({ kind: 'setChannel', index, name, secret });
  }

  async getBattAndStorage(): Promise<BattAndStorage> {
    return (await this.request({ kind: 'getBattAndStorage' }, ['battAndStorage'])).batt;
  }

  async getStats(type: 'core' | 'radio' | 'packets' | number): Promise<Stats> {
    const statsType = typeof type === 'number' ? type : type === 'core' ? StatsType.CORE : type === 'radio' ? StatsType.RADIO : StatsType.PACKETS;
    return (await this.request({ kind: 'getStats', statsType }, ['stats'])).stats;
  }

  async getCustomVars(): Promise<CustomVar[]> {
    return (await this.request({ kind: 'getCustomVars' }, ['customVars'])).vars;
  }

  setCustomVar(name: string, value: string): Promise<void> {
    return this.#ok({ kind: 'setCustomVar', name, value });
  }

  setAutoAddConfig(config: number, maxHops?: number): Promise<void> {
    const cmd: Command = { kind: 'setAutoAddConfig', config };
    if (maxHops !== undefined) cmd.maxHops = maxHops;
    return this.#ok(cmd);
  }

  async getAutoAddConfig(): Promise<{ config: number; maxHops: number }> {
    const f = await this.request({ kind: 'getAutoAddConfig' }, ['autoAddConfig']);
    return { config: f.config, maxHops: f.maxHops };
  }

  async getAllowedRepeatFreq(): Promise<RepeatFreqRange[]> {
    return (await this.request({ kind: 'getAllowedRepeatFreq' }, ['allowedRepeatFreq'])).ranges;
  }

  setDevicePin(pin: number): Promise<void> {
    return this.#ok({ kind: 'setDevicePin', pin });
  }

  setPathHashMode(mode: number): Promise<void> {
    return this.#ok({ kind: 'setPathHashMode', mode });
  }

  /** Session flood scope: a 16-byte key, `'unscoped'`, or undefined to clear. */
  setFloodScopeKey(key?: Uint8Array | 'unscoped'): Promise<void> {
    const cmd: Command = key === 'unscoped' ? { kind: 'setFloodScopeKey', unscoped: true } : key ? { kind: 'setFloodScopeKey', key } : { kind: 'setFloodScopeKey' };
    return this.#ok(cmd);
  }

  /**
   * Runs `fn` (typically one channel send) with the session flood scope set to `scope`, then
   * resets it (`SET_FLOOD_SCOPE_KEY [54,0]`) so the radio default applies again. The session
   * scope is sticky and applies to every flood send (companion-protocol.md §4 CMD 54), so
   * sections are serialised; `null` runs `fn` in turn without touching the scope (the radio
   * default applies). `'unscoped'` needs firmware v12+ ({@link FLOOD_UNSCOPED_MIN_VER}); older
   * firmware treats it as `null`. Flood sends outside these sections while one is running (e.g. a
   * DM retry) go out with that section's scope.
   */
  withFloodScope<T>(scope: Uint8Array | 'unscoped' | null, fn: () => Promise<T>): Promise<T> {
    const s = scope === 'unscoped' && (this.#deviceInfo?.firmwareVerCode ?? 0) < FLOOD_UNSCOPED_MIN_VER ? null : scope;
    const run = async (): Promise<T> => {
      if (s === null) return fn();
      await this.setFloodScopeKey(s);
      try {
        return await fn();
      } finally {
        // best effort: a failed reset leaves the override until the next SET or reboot
        if (this.connected) await this.setFloodScopeKey().catch(() => undefined);
      }
    };
    const p = this.#scopeChain.then(run, run);
    this.#scopeChain = p.catch(() => undefined);
    return p;
  }

  setDefaultFloodScope(scope?: { name: string; key: Uint8Array }): Promise<void> {
    return this.#ok(scope ? { kind: 'setDefaultFloodScope', scope } : { kind: 'setDefaultFloodScope' });
  }

  async getDefaultFloodScope(): Promise<{ name: string; key: Uint8Array } | null> {
    return (await this.request({ kind: 'getDefaultFloodScope' }, ['defaultFloodScope'])).scope;
  }

  /** 64-byte expanded private key. DeviceError 'DISABLED' when compiled out. */
  async exportPrivateKey(): Promise<Uint8Array> {
    return (await this.request({ kind: 'exportPrivateKey' }, ['privateKey'])).privateKey;
  }

  async importPrivateKey(privateKey: Uint8Array): Promise<void> {
    await this.#ok({ kind: 'importPrivateKey', privateKey });
    await this.refreshSelfInfo();
  }

  /** SIGN_START / SIGN_DATA × n / SIGN_FINISH (§9). Returns the 64-byte signature. */
  sign(data: Uint8Array, opts: { chunkSize?: number } = {}): Promise<Uint8Array> {
    const chunk = Math.max(1, Math.min(opts.chunkSize ?? DEFAULT_SIGN_CHUNK, 175));
    const run = async (): Promise<Uint8Array> => {
      const start = await this.request({ kind: 'signStart' }, ['signStart']);
      const max = start.maxLen || MAX_SIGN_DATA_LEN;
      if (data.length > max) throw new RangeError(`data is ${data.length} bytes, device accepts at most ${max}`);
      for (let o = 0; o < data.length; o += chunk) await this.#ok({ kind: 'signData', chunk: data.subarray(o, o + chunk) });
      return (await this.request({ kind: 'signFinish' }, ['signature'])).signature;
    };
    const p = this.#signChain.then(run, run);
    this.#signChain = p.catch(() => undefined);
    return p;
  }

  /** REBOOT: no reply; the link usually drops. */
  async reboot(): Promise<void> {
    if (this.#state === 'disconnected') throw new DisconnectedError('not connected');
    try {
      await this.#exchange<undefined>({ kind: 'reboot' }, () => false, { noReply: true });
    } catch (err) {
      // the link may drop before the write completes
      if (!(err instanceof DisconnectedError)) throw err;
    }
  }

  /** FACTORY_RESET: the device usually reboots before an OK can be seen; a timeout counts as success. */
  async factoryReset(timeoutMs = 1000): Promise<void> {
    if (this.#state === 'disconnected') throw new DisconnectedError('not connected');
    const cmd: Command = { kind: 'factoryReset' };
    await this.#exchange<undefined>(
      cmd,
      (f, ctl) => {
        if (f.kind === 'ok') {
          ctl.resolve(undefined);
          return true;
        }
        return this.#rejectOnError(cmd, f, ctl);
      },
      { timeoutMs, timeoutOk: true },
    ).catch((err: unknown) => {
      if (!(err instanceof DisconnectedError)) throw err;
    });
  }

  /** Companion CLI (v14+): CLI_REPLY text. */
  async runCliCommand(command: string): Promise<string> {
    return (await this.request({ kind: 'runCliCommand', command }, ['cliReply'])).text;
  }

  /** SEND_RAW_DATA (direct only). */
  sendRawData(pathLen: number, path: Uint8Array, payload: Uint8Array): Promise<void> {
    return this.#ok({ kind: 'sendRawData', pathLen, path, payload });
  }

  sendRawPacket(packet: Uint8Array, priority = 0): Promise<void> {
    return this.#ok({ kind: 'sendRawPacket', priority, packet });
  }

  sendControlData(payload: Uint8Array): Promise<void> {
    return this.#ok({ kind: 'sendControlData', payload });
  }

  // =========================================================================
  // Remote requests (§4 notes, §6.6-§6.10)
  // =========================================================================

  /**
   * Holds the client-side remote-request mutex: issue `cmd`, take its SENT, then wait for the
   * matching push (est_timeout + grace).
   */
  #remoteRequest<T>(
    operation: string,
    cmd: Command,
    match: (push: PushFrame, sent: SentFrame) => RemoteMatch<T>,
    opts: RemoteRequestOptions & { statusFrom?: 'repeater' | 'room' } = {},
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const d = new Deferred<T>();
      d.promise.catch(() => undefined); // may be rejected (disconnect) before it is awaited
      let sent: SentFrame | undefined;
      // SENT is taken synchronously in the frame handler, so every push after it is offered here;
      // pushes before SENT cannot answer this request (the device writes SENT first).
      const pending: RemotePending = {
        onPush: (p) => {
          if (d.settled || !sent) return;
          const m = match(p, sent);
          if (m === undefined) return;
          if ('error' in m) d.reject(m.error);
          else d.resolve(m.value);
        },
      };
      if (opts.statusFrom) pending.statusFrom = opts.statusFrom;
      const waiter: Waiter = { reject: (e) => d.reject(e) };
      this.#remote = pending;
      this.#waiters.add(waiter);
      let timer: unknown;
      try {
        sent = await this.#exchange<SentFrame>(cmd, (f, ctl) => {
          if (f.kind === 'sent') {
            sent = f;
            ctl.resolve(f);
            return true;
          }
          return this.#rejectOnError(cmd, f, ctl);
        });
        const ms = opts.timeoutMs ?? sent.estTimeoutMs + this.#opts.remoteTimeoutGraceMs;
        if (!d.settled) timer = this.#setTimer(() => d.reject(new RemoteTimeoutError(operation, ms)), ms);
        return await d.promise;
      } finally {
        this.#clearTimer(timer);
        this.#waiters.delete(waiter);
        if (this.#remote === pending) this.#remote = null;
      }
    };
    const p = this.#remoteChain.then(run, run);
    this.#remoteChain = p.catch(() => undefined);
    return p;
  }

  #contactType(key: Uint8Array): 'repeater' | 'room' | undefined {
    const t = this.findContact(key)?.type;
    return t === 2 ? 'repeater' : t === 3 ? 'room' : undefined;
  }

  /** SEND_LOGIN → LOGIN_SUCCESS (resolves) / LOGIN_FAIL (LoginFailedError) / silence (RemoteTimeoutError). */
  async login(ref: ContactRef, password: string, opts: RemoteRequestOptions = {}): Promise<LoginSuccessPush> {
    const key = this.#fullKey(ref);
    return this.#remoteRequest<LoginSuccessPush>(
      'login',
      { kind: 'sendLogin', pubKey: key, password },
      (p) => {
        if (p.kind === 'loginSuccess' && prefixMatches(key, p.pubKeyPrefix)) return { value: p };
        if (p.kind === 'loginFail' && prefixMatches(key, p.pubKeyPrefix)) return { error: new LoginFailedError(p.pubKeyPrefix) };
        return undefined;
      },
      opts,
    );
  }

  /** LOGOUT: always OK. */
  async logout(ref: ContactRef): Promise<void> {
    return this.#ok({ kind: 'logout', pubKey: this.#fullKey(ref) });
  }

  /** SEND_STATUS_REQ → STATUS_RESPONSE (matched by pubkey prefix). */
  async getStatus(ref: ContactRef, opts: RemoteRequestOptions = {}): Promise<StatusResult> {
    const key = this.#fullKey(ref);
    const from = this.#contactType(key);
    return this.#remoteRequest<StatusResult>(
      'status',
      { kind: 'sendStatusReq', pubKey: key },
      (p) => (p.kind === 'statusResponse' && prefixMatches(key, p.pubKeyPrefix) ? { value: { pubKeyPrefix: p.pubKeyPrefix, raw: p.raw, stats: p.stats } } : undefined),
      from ? { ...opts, statusFrom: from } : opts,
    );
  }

  /**
   * SEND_TELEMETRY_REQ → TELEMETRY_RESPONSE. Without a contact, asks for the device's own
   * telemetry (answered immediately with a push, no SENT).
   */
  async getTelemetry(ref?: ContactRef, opts: RemoteRequestOptions = {}): Promise<TelemetryResult> {
    if (ref === undefined) {
      const cmd: Command = { kind: 'sendTelemetryReq' };
      const self = this.#selfInfo?.pubKey;
      return this.#exchange<TelemetryResult>(cmd, (f, ctl) => {
        if (f.kind === 'telemetryResponse' && (!self || prefixMatches(self, f.pubKeyPrefix))) {
          ctl.resolve({ pubKeyPrefix: f.pubKeyPrefix, lpp: f.lpp, decoded: decodeLpp(f.lpp) });
          return true;
        }
        return this.#rejectOnError(cmd, f, ctl);
      });
    }
    const key = this.#fullKey(ref);
    return this.#remoteRequest<TelemetryResult>(
      'telemetry',
      { kind: 'sendTelemetryReq', pubKey: key },
      (p) =>
        p.kind === 'telemetryResponse' && prefixMatches(key, p.pubKeyPrefix)
          ? { value: { pubKeyPrefix: p.pubKeyPrefix, lpp: p.lpp, decoded: decodeLpp(p.lpp) } }
          : undefined,
      opts,
    );
  }

  /** SEND_BINARY_REQ (data[0] = ReqType) → BINARY_RESPONSE data with the same tag. */
  async binaryRequest(ref: ContactRef, data: Uint8Array, opts: RemoteRequestOptions = {}): Promise<Uint8Array> {
    const key = this.#fullKey(ref);
    return this.#remoteRequest<Uint8Array>(
      'binary request',
      { kind: 'sendBinaryReq', pubKey: key, data },
      (p, sent) => (p.kind === 'binaryResponse' && p.tag === sent.tag ? { value: p.data } : undefined),
      opts,
    );
  }

  /** SEND_ANON_REQ (v13+: also to non-contacts) → BINARY_RESPONSE data with the same tag. */
  anonRequest(pubKey: Uint8Array, data: Uint8Array, opts: RemoteRequestOptions = {}): Promise<Uint8Array> {
    return this.#remoteRequest<Uint8Array>(
      'anon request',
      { kind: 'sendAnonReq', pubKey, data },
      (p, sent) => (p.kind === 'binaryResponse' && p.tag === sent.tag ? { value: p.data } : undefined),
      opts,
    );
  }

  /** SEND_PATH_DISCOVERY_REQ (always flood) → PATH_DISCOVERY_RESPONSE. */
  async pathDiscovery(ref: ContactRef, opts: RemoteRequestOptions = {}): Promise<PathDiscoveryResponsePush> {
    const key = this.#fullKey(ref);
    return this.#remoteRequest<PathDiscoveryResponsePush>(
      'path discovery',
      { kind: 'sendPathDiscoveryReq', pubKey: key },
      (p) => (p.kind === 'pathDiscoveryResponse' && prefixMatches(key, p.pubKeyPrefix) ? { value: p } : undefined),
      opts,
    );
  }

  /**
   * Remote CLI: sends `command` as a text message of `txtType` (default CLI_DATA, what repeaters
   * and room servers expect) and resolves with the next CLI_DATA message from that contact.
   */
  async sendRemoteCliCommand(ref: ContactRef, command: string, opts: RemoteRequestOptions & { txtType?: number } = {}): Promise<string> {
    const key = this.#fullKey(ref);
    const prefix = key.subarray(0, PUB_KEY_PREFIX_SIZE);
    let reply: string | undefined;
    let wake: ((s: string) => void) | undefined;
    const off = this.events.on('contactMessage', (e) => {
      if (reply === undefined && e.message.txtType === TxtType.CLI_DATA && bytesEqual(e.message.senderPrefix, prefix)) {
        reply = e.message.text;
        wake?.(reply);
      }
    });
    try {
      const sent = await this.sendTextMessage(key, command, { txtType: opts.txtType ?? TxtType.CLI_DATA });
      if (reply !== undefined) return reply;
      const ms = opts.timeoutMs ?? sent.estTimeoutMs + this.#opts.remoteTimeoutGraceMs;
      const r = await this.#waitFor<string>(ms, (resolve) => {
        wake = resolve;
        return () => {
          wake = undefined;
        };
      });
      if (r === null) throw new RemoteTimeoutError('cli command', ms);
      return r;
    } finally {
      off();
    }
  }

  /** SEND_TRACE_PATH → TRACE_DATA with the same tag. `path` = concatenated hop hashes. */
  async tracePath(path: Uint8Array, opts: TraceOptions = {}): Promise<TraceDataPush> {
    const tag = opts.tag ?? (Math.floor(Math.random() * 0x100000000) >>> 0);
    let got: TraceDataPush | undefined;
    let wake: ((p: TraceDataPush) => void) | undefined;
    this.#traceWaiters.set(tag, (p) => {
      got ??= p;
      wake?.(p);
    });
    try {
      const cmd: Command = { kind: 'sendTracePath', tag, authCode: opts.authCode ?? 0, path };
      if (opts.pathHashSize !== undefined) cmd.pathHashSize = opts.pathHashSize;
      const sent = await this.request(cmd, ['sent']);
      if (got) return got;
      const ms = opts.timeoutMs ?? sent.estTimeoutMs + this.#opts.remoteTimeoutGraceMs;
      const r = await this.#waitFor<TraceDataPush>(ms, (resolve) => {
        wake = resolve;
        return () => {
          wake = undefined;
        };
      });
      if (r === null) throw new RemoteTimeoutError('trace', ms);
      return r;
    } finally {
      this.#traceWaiters.delete(tag);
    }
  }
}

