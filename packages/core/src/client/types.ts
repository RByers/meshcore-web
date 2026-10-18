/** Public option, event and result types of CompanionClient. */

import type { LppDecodeResult } from '../packet/lpp.js';
import type {
  AdvertPush,
  ChannelDataFrame,
  ChannelMsgFrame,
  CommandKind,
  Contact,
  ContactDeletedPush,
  ContactMsgFrame,
  ContactsFullPush,
  ControlDataPush,
  DeviceFrame,
  DeviceInfo,
  LoginFailPush,
  LoginSuccessPush,
  LogRxDataPush,
  NewAdvertPush,
  NodeStats,
  PathDiscoveryResponsePush,
  PathUpdatedPush,
  RawDataPush,
  SelfInfo,
  SendConfirmedPush,
  StatusResponsePush,
  TelemetryResponsePush,
  BinaryResponsePush,
  TraceDataPush,
} from '../protocol/types.js';
import type { TelemetryModes } from '../protocol/constants.js';
import { systemClock, type Clock } from '../util/clock.js';

/** @deprecated alias kept for existing imports; use {@link Clock}. */
export type ClientClock = Clock;

/** @deprecated alias; use {@link systemClock}. */
export const systemClientClock: Clock = systemClock;

export type ClientState = 'disconnected' | 'connecting' | 'connected';

/** A contact given by record or by public key (a ≥6-byte prefix is resolved via the contact cache). */
export type ContactRef = Contact | Uint8Array;

export interface CompanionClientOptions {
  /** APP_START app name (default "meshcore-web"). */
  appName?: string;
  /** APP_START [1] (default 1). */
  appVersion?: number;
  /** app_target_ver sent in DEVICE_QUERY (default 3 → V3 message frames with SNR). */
  protocolVersion?: number;
  /** Time source + timers (default {@link systemClock}). */
  clock?: Clock;
  /** Per-command reply timeout (default 5000 ms). For GET_CONTACTS it is an inactivity timeout. */
  requestTimeoutMs?: number;
  /**
   * Device clock handling on connect: 'auto' (default) sets the device time if it is more than
   * `timeSyncThresholdSecs` behind the host; 'always' always tries (the device refuses to go
   * backwards, ERR 6, which is ignored); 'never' skips it.
   */
  timeSync?: 'auto' | 'always' | 'never';
  /** Default 30 s. */
  timeSyncThresholdSecs?: number;
  /** Run syncContacts() during connect (default true). */
  syncContactsOnConnect?: boolean;
  /** Drain the offline message queue during connect (default true). */
  syncMessagesOnConnect?: boolean;
  /** Drain the queue whenever MSG_WAITING arrives (default true). */
  autoSyncMessages?: boolean;
  /** Re-read a contact (GET_CONTACT_BY_KEY) after ADVERT / PATH_UPDATED pushes (default true). */
  autoRefreshContacts?: boolean;
  /** Added to the SENT est_timeout when waiting for a remote response (default 3000 ms). */
  remoteTimeoutGraceMs?: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** One host↔device frame, for the packet log. Emitted in wire order. */
export interface FrameLogEntry {
  direction: 'in' | 'out';
  bytes: Uint8Array;
  /** clock.now() when sent / received. */
  timestamp: number;
  /** Decoded device frame (direction 'in'). */
  frame?: DeviceFrame;
  /** Command kind (direction 'out'). */
  command?: CommandKind;
  /** Set if an incoming frame could not be decoded. */
  decodeError?: Error;
}

export interface ConnectedEvent {
  selfInfo: SelfInfo;
  deviceInfo: DeviceInfo | undefined;
  protocolVersion: number;
}

export interface DisconnectedEvent {
  /** Set when the link was lost rather than closed by `disconnect()`. */
  error?: Error;
}

export interface ContactMessageEvent {
  message: ContactMsgFrame;
  /** The sender from the contact cache, if known. */
  contact: Contact | undefined;
  /** Drained from the device's offline queue while connecting (see `ChannelMessageEvent.queued`). */
  queued: boolean;
}

export interface ChannelMessageEvent {
  message: ChannelMsgFrame;
  /**
   * Drained from the device's offline queue while connecting: heard while no app was attached, so
   * it arrives now but was received earlier. The frame carries no device receive time, only the
   * sender's timestamp (companion-protocol.md §6.1).
   */
  queued: boolean;
}

export interface ChannelDataEvent {
  message: ChannelDataFrame;
}

export interface ContactsChangedEvent {
  /** Whole cache after the change. */
  contacts: readonly Contact[];
  /** Records added or changed. */
  updated: readonly Contact[];
  /** Public keys removed. */
  removed: readonly Uint8Array[];
  /** True after a full (since = 0) sync. */
  full: boolean;
  /**
   * The client's {@link CompanionClient.contactsSince} after the change: persist it with
   * `contacts` to seed the next connect's incremental sync ({@link ContactsSnapshot}).
   */
  since: number;
}

/** A step of {@link CompanionClient.connect}, in the order they run. */
export type ConnectStep = 'deviceQuery' | 'appStart' | 'timeSync' | 'contacts' | 'messages';

/**
 * Handshake progress (`connectProgress` event). Emitted when each step starts and, during the
 * contacts sync, once CONTACTS_START gives the total and per CONTACT (`done`/`total`); during the
 * message drain per message received (`done` only: the queue length is unknown).
 */
export interface ConnectProgressEvent {
  step: ConnectStep;
  /** The steps this connect runs (disabled options are left out), in order. */
  steps: readonly ConnectStep[];
  done?: number;
  total?: number;
}

export interface CompanionClientEvents {
  connected: ConnectedEvent;
  connectProgress: ConnectProgressEvent;
  disconnected: DisconnectedEvent;
  state: ClientState;
  selfInfo: SelfInfo;
  contactMessage: ContactMessageEvent;
  channelMessage: ChannelMessageEvent;
  channelData: ChannelDataEvent;
  msgWaiting: undefined;
  advert: AdvertPush;
  newAdvert: NewAdvertPush;
  pathUpdated: PathUpdatedPush;
  sendConfirmed: SendConfirmedPush;
  loginSuccess: LoginSuccessPush;
  loginFail: LoginFailPush;
  statusResponse: StatusResponsePush;
  telemetryResponse: TelemetryResponsePush;
  binaryResponse: BinaryResponsePush;
  traceData: TraceDataPush;
  pathDiscovery: PathDiscoveryResponsePush;
  logRxData: LogRxDataPush;
  rawData: RawDataPush;
  controlData: ControlDataPush;
  contactDeleted: ContactDeletedPush;
  contactsFull: ContactsFullPush;
  contactsChanged: ContactsChangedEvent;
  frame: FrameLogEntry;
  error: Error;
}

// ---------------------------------------------------------------------------
// Results / options
// ---------------------------------------------------------------------------

/**
 * A saved copy of a radio's contact list, offered to {@link CompanionClient.connect} so the
 * connect-time sync can be incremental (only contacts changed since `since` cross the wire).
 */
export interface ContactsSnapshot {
  /** Public key of the radio the contacts came from (must match SELF_INFO, else ignored). */
  selfPubKey: Uint8Array;
  /** The device contacts as last synced (device fields only). */
  contacts: readonly Contact[];
  /** {@link ContactsChangedEvent.since} the contacts reflect (≤ 0: none, full sync). */
  since: number;
}

export interface ConnectOptions {
  /**
   * Called once SELF_INFO is known (before the contacts sync) to load the saved contacts of that
   * radio. Ignored (full sync) when it returns undefined, throws, belongs to another radio, or the
   * device clock is earlier than its `since`. Only used with `syncContactsOnConnect`.
   */
  contactsSnapshot?: (self: SelfInfo) => Promise<ContactsSnapshot | undefined> | ContactsSnapshot | undefined;
}

export interface ContactsResult {
  /** CONTACTS_START total (all contacts on the device, not the filtered count). */
  total: number;
  contacts: Contact[];
  /** END_OF_CONTACTS: largest lastmod among the records sent (0 if none). */
  mostRecentLastMod: number;
}

export interface SendTextOptions {
  /** Retry counter (low 2 bits change the ACK code). Default 0. */
  attempt?: number;
  /** Sender timestamp, unix secs. Default clock now. */
  timestamp?: number;
  /** TxtType, default PLAIN. */
  txtType?: number;
}

export interface SentInfo {
  /** Expected ACK code (0 for CLI types). */
  ackCode: number;
  estTimeoutMs: number;
  flood: boolean;
  timestamp: number;
  attempt: number;
}

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'failed';

export interface SendProgress {
  status: MessageStatus;
  /** 0-based attempt this update refers to. */
  attempt: number;
  ackCode?: number;
  flood?: boolean;
  estTimeoutMs?: number;
  roundTripMs?: number;
  /** True for a delivery confirmed after the result was already reported as failed. */
  late?: boolean;
  error?: Error;
}

export interface RetryOptions {
  /** Total attempts (default 5, like meshcore-open). */
  maxAttempts?: number;
  /**
   * Attempts sent over a known direct path before the path is reset and the rest go flood
   * (default maxAttempts - 2, at least 1). Has no effect when the contact is already flood.
   */
  floodAfterAttempts?: number;
  /** RESET_PATH before falling back to flood (default true). */
  resetPathOnFlood?: boolean;
  /** Sender timestamp, reused for every attempt. Default clock now. */
  timestamp?: number;
  /** Added to est_timeout when waiting for SEND_CONFIRMED (default 1000 ms). */
  ackGraceMs?: number;
  /** Replaces est_timeout + ackGraceMs. */
  ackTimeoutMs?: number;
  /** Extra wait before retry n (1-based); ACKs are still accepted. Default 1000·2^(n-1), max 16 s. */
  retryDelayMs?: (retry: number) => number;
  /** After failing, keep listening this long and report a late delivery via onProgress (default 0). */
  lateAckGraceMs?: number;
  onProgress?: (p: SendProgress) => void;
}

export interface RetrySendResult {
  status: 'delivered' | 'failed';
  /** Number of sends made. */
  attempts: number;
  /** Every ACK code used, by attempt. */
  ackCodes: number[];
  /** The ACK that confirmed delivery. */
  confirmedAck?: number;
  roundTripMs?: number;
  /** True if RESET_PATH was issued to fall back to flood. */
  pathReset: boolean;
  error?: Error;
}

export interface OtherParams {
  manualAddContacts: number;
  telemetryModes: TelemetryModes;
  advertLocPolicy: number;
  multiAcks: number;
}

export interface RadioParams {
  freqKhz: number;
  bwHz: number;
  sf: number;
  cr: number;
  clientRepeat?: boolean;
}

export interface StatusResult {
  pubKeyPrefix: Uint8Array;
  raw: Uint8Array;
  stats: NodeStats | null;
}

export interface TelemetryResult {
  pubKeyPrefix: Uint8Array;
  lpp: Uint8Array;
  decoded: LppDecodeResult;
}

export interface RemoteRequestOptions {
  /** Overrides est_timeout + remoteTimeoutGraceMs. */
  timeoutMs?: number;
}

export interface TraceOptions extends RemoteRequestOptions {
  /** Default: random u32. */
  tag?: number;
  authCode?: number;
  /** Bytes per hop hash: 1 (default), 2, 4 or 8. */
  pathHashSize?: number;
}
