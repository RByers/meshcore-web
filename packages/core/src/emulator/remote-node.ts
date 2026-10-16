/**
 * Behaviour of emulated remote nodes (repeater / room server / sensor / chat peer): how they answer
 * logins, requests and CLI commands. They build RESPONSE plaintexts as the real server firmwares
 * do (mesh-packet-format.md §3.2: `[tag u32][body]`).
 *
 * Two drivers use it: `MeshNode` (virtual-mesh.ts) exchanges real packets over a `VirtualMesh`;
 * nodes registered with `CompanionEmulator.addRemoteNode` (no mesh) are simulated directly with
 * timers, feeding the same matching rules as `MyMesh::onContactResponse` (companion-protocol.md §6.10).
 */

import { concatBytes, u16le, u32le, utf8Encode } from '../util/bytes.js';
import { AclRole, ContactType, ReqType, TELEM_CHANNEL_SELF } from '../protocol/constants.js';
import { encodeRepeaterStats, encodeServerStats } from '../protocol/encode-frame.js';
import type { CommonNodeStats } from '../protocol/types.js';
import type { Rng } from './rng.js';
import { randomBytes } from './rng.js';

export type RemoteNodeType = 'chat' | 'repeater' | 'room' | 'sensor';

/** How a chat peer acknowledges plain text messages sent to it. */
export type AckPolicy =
  /** ACK every message. */
  | 'auto'
  /** Never ACK (the host's retries all time out). */
  | 'never'
  /** ACK only sends whose `attempt` ≥ minAttempt (earlier attempts are "lost"). */
  | { minAttempt: number };

export interface NeighbourEntry {
  pubKey: Uint8Array;
  heardSecsAgo: number;
  /** dB */
  snr: number;
}

export interface RemoteAclEntry {
  /** 6-byte pubkey prefix. */
  prefix: Uint8Array;
  /** ACL permission byte (bits 0-1 role, AclRole). */
  permissions: number;
}

/**
 * @deprecated Use {@link RemoteAclEntry}; `AclEntry` is also the name of the decoded ACL record in
 * `packet/` (not re-exported from emulator/index.ts).
 */
export type AclEntry = RemoteAclEntry;

export interface RemoteNodeConfig {
  type: RemoteNodeType;
  pubKey: Uint8Array;
  name: string;
  /** Admin password (repeater/room/sensor). Default "password". */
  password?: string;
  /** Guest password; guests get role GUEST. Default: none (guests rejected). */
  guestPassword?: string;
  /**
   * Firmware servers do not answer a wrong password at all (no LOGIN_FAIL). Set this to answer
   * with a non-OK response instead, which the companion turns into LOGIN_FAIL.
   */
  rejectWithResponse?: boolean;
  /** Answer logins with the legacy `"OK"` body (8-byte LOGIN_SUCCESS). */
  legacyLogin?: boolean;
  /** FIRMWARE_VER_LEVEL in the login reply. Default: repeater 2, others 1. */
  firmwareVerLevel?: number;
  /** Fields of RepeaterStats / ServerStats (defaults are plausible values). */
  stats?: Partial<CommonNodeStats> & { rxAirTimeSecs?: number; recvErrors?: number; posted?: number; postPush?: number };
  /** Raw CayenneLPP telemetry. Default: battery voltage on channel 1. */
  telemetry?: Uint8Array;
  acl?: RemoteAclEntry[];
  neighbours?: NeighbourEntry[];
  /** Owner info text for GET_OWNER_INFO. */
  ownerInfo?: string;
  firmwareVersion?: string;
  /**
   * Custom BINARY_REQ handler: return the response body (after the tag), `null` for no response,
   * or `undefined` to fall back to the built-in handling.
   */
  onBinaryRequest?: (reqType: number, data: Uint8Array) => Uint8Array | null | undefined;
  /** Chat peers: reply text for a plain message (sent back after ackDelayMs + responseDelayMs). */
  autoReply?: (text: string) => string | null | undefined;
  /** CLI handler for CLI_COMMAND text messages; returns the reply text, or null for none. */
  onCliCommand?: (command: string) => string | null;
  /** Delay before the node's reply arrives. Default 300 ms. */
  responseDelayMs?: number;
  /** When false the node never answers anything. Default true. */
  online?: boolean;
  /**
   * Path the companion learns from a flood-routed reply (PATH packet). Default zero-hop
   * `{pathLen: 0}`. Set to null to model replies that arrive without a path update.
   */
  returnPath?: { pathLen: number; path?: Uint8Array } | null;
  /** In-path reported in PATH_DISCOVERY_RESPONSE. Default = returnPath. */
  discoveryInPath?: { pathLen: number; path?: Uint8Array };
  /** dB, used for messages, trace hops and neighbour lists. Default 8. */
  snr?: number;
  /** Chat peers: ACK behaviour for plain messages. Default 'auto'. */
  ackPolicy?: AckPolicy;
  /** Chat peers: ACK delay. Default 300 ms. */
  ackDelayMs?: number;
  /** Degrees, for the contact record. */
  lat?: number;
  lon?: number;
  /** Also add the node to the device's contacts (default true). */
  addContact?: boolean;
  /** Contact record overrides when added. */
  contact?: { flags?: number; outPathLen?: number; outPath?: Uint8Array; lastAdvert?: number; lastMod?: number };
  /** Battery in mV for the default telemetry/stats. Default 4100. */
  batteryMv?: number;
}

export function contactTypeOf(t: RemoteNodeType): number {
  switch (t) {
    case 'chat':
      return ContactType.CHAT;
    case 'repeater':
      return ContactType.REPEATER;
    case 'room':
      return ContactType.ROOM;
    case 'sensor':
      return ContactType.SENSOR;
  }
}

/** LPP voltage (type 116, u16 BE /100 V) on channel 1. mesh-packet-format.md §4 */
export function lppVoltage(mv: number, channel = TELEM_CHANNEL_SELF): Uint8Array {
  const v = Math.round(mv / 10);
  return Uint8Array.of(channel, 116, (v >> 8) & 0xff, v & 0xff);
}

/** LPP temperature (type 103, i16 BE /10 °C). */
export function lppTemperature(celsius: number, channel = TELEM_CHANNEL_SELF): Uint8Array {
  const v = Math.round(celsius * 10) & 0xffff;
  return Uint8Array.of(channel, 103, (v >> 8) & 0xff, v & 0xff);
}

/** Built-in request handling for one emulated node. */
export class RemoteNode {
  readonly config: RemoteNodeConfig;
  /** Requests received, newest last (for assertions). */
  readonly requests: Array<{ kind: string; data: Uint8Array }> = [];
  /** Text messages received from the companion. */
  readonly messages: Array<{ text: string; txtType: number; attempt: number; timestamp: number }> = [];

  constructor(config: RemoteNodeConfig) {
    this.config = config;
  }

  get pubKey(): Uint8Array {
    return this.config.pubKey;
  }
  get online(): boolean {
    return this.config.online ?? true;
  }
  get responseDelayMs(): number {
    return this.config.responseDelayMs ?? 300;
  }
  get snr(): number {
    return this.config.snr ?? 8;
  }
  get batteryMv(): number {
    return this.config.batteryMv ?? 4100;
  }

  /**
   * Login reply plaintext (`RPT handleLoginReq`, mesh-packet-format.md §3.2), or null when the
   * server stays silent (wrong password).
   */
  loginResponse(password: string, serverTime: number, rng: Rng): Uint8Array | null {
    const c = this.config;
    const admin = password === (c.password ?? 'password');
    const guest = !admin && c.guestPassword !== undefined && password === c.guestPassword;
    const tag = u32le(serverTime);
    if (!admin && !guest) {
      return c.rejectWithResponse ? concatBytes(tag, Uint8Array.of(0xff)) : null;
    }
    if (c.legacyLogin) return concatBytes(tag, utf8Encode('OK'));
    // [6] is_admin: repeater 1/0; room server 1 admin, 2 guest-with-perms-0
    const isAdmin = admin ? 1 : c.type === 'room' ? 2 : 0;
    const perms = admin ? AclRole.ADMIN : AclRole.GUEST;
    const level = c.firmwareVerLevel ?? (c.type === 'repeater' ? 2 : 1);
    return concatBytes(tag, Uint8Array.of(0, 0, isAdmin, perms), randomBytes(rng, 4), Uint8Array.of(level));
  }

  /**
   * Status body: RepeaterStats (56 B) or room ServerStats (52 B); sensors don't answer. `live`
   * values (a mesh node's real counters) are used where `config.stats` does not override them.
   */
  statusBody(uptimeSecs: number, live: Partial<CommonNodeStats> = {}): Uint8Array | null {
    const c = this.config;
    if (c.type === 'sensor' || c.type === 'chat') return null;
    const s = { ...live, ...(c.stats ?? {}) };
    const common: CommonNodeStats = {
      batteryMv: s.batteryMv ?? this.batteryMv,
      txQueueLen: s.txQueueLen ?? 0,
      noiseFloorDbm: s.noiseFloorDbm ?? -112,
      lastRssiDbm: s.lastRssiDbm ?? -70,
      packetsRecv: s.packetsRecv ?? 1234,
      packetsSent: s.packetsSent ?? 567,
      airTimeSecs: s.airTimeSecs ?? 89,
      upTimeSecs: s.upTimeSecs ?? uptimeSecs,
      sentFlood: s.sentFlood ?? 300,
      sentDirect: s.sentDirect ?? 267,
      recvFlood: s.recvFlood ?? 1000,
      recvDirect: s.recvDirect ?? 234,
      errEvents: s.errEvents ?? 0,
      lastSnr: s.lastSnr ?? this.snr,
      directDups: s.directDups ?? 3,
      floodDups: s.floodDups ?? 45,
    };
    if (c.type === 'room') {
      return encodeServerStats({ kind: 'room', ...common, posted: s.posted ?? 10, postPush: s.postPush ?? 20 });
    }
    return encodeRepeaterStats({
      kind: 'repeater',
      ...common,
      rxAirTimeSecs: s.rxAirTimeSecs ?? 456,
      recvErrors: s.recvErrors ?? 2,
    });
  }

  telemetryBody(): Uint8Array {
    return this.config.telemetry ?? lppVoltage(this.batteryMv);
  }

  /** Body for a BINARY_REQ / ANON_REQ (data[0] = req type), or null for no response. */
  binaryBody(data: Uint8Array, uptimeSecs: number): Uint8Array | null {
    const reqType = data[0] ?? -1;
    const custom = this.config.onBinaryRequest?.(reqType, data);
    if (custom !== undefined) return custom;
    switch (reqType) {
      case ReqType.GET_STATUS:
        return this.statusBody(uptimeSecs);
      case ReqType.GET_TELEMETRY_DATA:
        return this.telemetryBody();
      case ReqType.GET_ACCESS_LIST:
        return concatBytes(...(this.config.acl ?? []).map((e) => concatBytes(e.prefix.slice(0, 6), Uint8Array.of(e.permissions))));
      case ReqType.GET_NEIGHBOURS: {
        if (this.config.type !== 'repeater') return null;
        // [ver][count u8][offset u16][order_by u8][prefix_len u8][4 random]
        const count = data[2] ?? 0;
        const offset = (data[3] ?? 0) | ((data[4] ?? 0) << 8);
        const prefixLen = Math.min(Math.max(data[6] ?? 6, 1), 32);
        const all = this.config.neighbours ?? [];
        const page = all.slice(offset, offset + count);
        return concatBytes(
          u16le(all.length),
          u16le(page.length),
          ...page.map((n) =>
            concatBytes(n.pubKey.slice(0, prefixLen), u32le(n.heardSecsAgo), Uint8Array.of(Math.trunc(n.snr * 4) & 0xff)),
          ),
        );
      }
      case ReqType.GET_OWNER_INFO:
        if (this.config.type !== 'repeater') return null;
        return utf8Encode(`${this.config.firmwareVersion ?? 'v1.18.0'}\n${this.config.name}\n${this.config.ownerInfo ?? ''}`);
      default:
        return null;
    }
  }

  /** Reply to a CLI_COMMAND message (sent back as a CLI_DATA message), or null. */
  cliReply(command: string): string | null {
    if (this.config.onCliCommand) return this.config.onCliCommand(command);
    if (this.config.type === 'chat') return null;
    const cmd = command.trim();
    if (cmd === 'ver') return `${this.config.firmwareVersion ?? 'v1.18.0'} (Build: 15 Oct 2026)`;
    if (cmd === 'get name') return `> ${this.config.name}`;
    if (cmd.startsWith('set name ')) {
      this.config.name = cmd.slice(9);
      return 'OK';
    }
    if (cmd === 'clock') return 'OK';
    return 'Unknown command';
  }
}
