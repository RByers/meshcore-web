/** Public option / state types of the companion emulator. */

import type { Contact, RepeatFreqRange } from '../protocol/types.js';
import type { EmulatorClock } from './clock.js';
import type { AckPolicy, RemoteNodeConfig } from './remote-node.js';
import type { Rng } from './rng.js';
import type { VirtualMesh } from './virtual-mesh.js';

/** A contact as stored on the emulated device (protocol Contact plus device-only fields). */
export interface DeviceContact extends Contact {
  /** Room-server sync position (`ContactInfo.sync_since`). */
  syncSince: number;
  /** Last raw advert packet (as FLOOD), used by SHARE/EXPORT_CONTACT. */
  advertPacket?: Uint8Array;
}

/** Initial contact. Defaults: type CHAT, flags 0, unknown path (flood), lastAdvert/lastMod = RTC now. */
export interface ContactSeed {
  pubKey: Uint8Array;
  name: string;
  type?: number;
  flags?: number;
  /** Encoded out_path_len; 0xFF (default) = unknown. */
  outPathLen?: number;
  outPath?: Uint8Array;
  lastAdvert?: number;
  /** Degrees. */
  lat?: number;
  lon?: number;
  lastMod?: number;
  /** Stored advert blob; generated from the seed if omitted. */
  advertPacket?: Uint8Array;
}

export interface ChannelSlot {
  /** "" for an empty slot. */
  name: string;
  /** 16 bytes; zeros for an empty slot. */
  secret: Uint8Array;
}

export interface EmulatorRadio {
  /** kHz, as on the wire. */
  freqKhz: number;
  /** Hz, as on the wire. */
  bwHz: number;
  sf: number;
  cr: number;
  txPowerDbm: number;
  /** MAX_LORA_TX_POWER. */
  maxTxPowerDbm: number;
  /** Client repeat (v9+). */
  clientRepeat: boolean;
}

/** Persisted preferences (`NodePrefs`). */
export interface EmulatorPrefs {
  name: string;
  /** Micro-degrees (sensors.node_lat × 1e6). */
  latE6: number;
  lonE6: number;
  radio: EmulatorRadio;
  multiAcks: number;
  advertLocPolicy: number;
  /** Packed telemetry modes byte (SELF_INFO[46]). */
  telemetryModes: number;
  /** Raw byte; bit 0 = manual add. */
  manualAddContacts: number;
  autoAddConfig: number;
  autoAddMaxHops: number;
  /** Wire values (× 1000). */
  rxDelayBaseMilli: number;
  airtimeFactorMilli: number;
  blePin: number;
  pathHashMode: number;
  defaultScope: { name: string; key: Uint8Array } | null;
}

export interface FirmwareInfo {
  /** FIRMWARE_VER_CODE (default 14). */
  verCode: number;
  /** e.g. "v1.18.0". */
  version: string;
  /** e.g. "15 Oct 2026". */
  buildDate: string;
  /** Board/manufacturer name. */
  manufacturer: string;
}

export interface CompanionEmulatorOptions {
  /**
   * Device identity (real Ed25519). `privateKey` is the firmware's 64-byte *expanded* key; a
   * 32-byte `seed` is expanded like orlp `ed25519_create_keypair`. Missing parts are generated
   * from `rng`; when only the private key (or seed) is given the public key is derived from it.
   * Giving both keys uses them as-is (they need not match, but then nothing verifies).
   */
  identity?: { publicKey?: Uint8Array; privateKey?: Uint8Array; seed?: Uint8Array };
  /**
   * Maps a 64-byte private key to its public key (identity setup, IMPORT_PRIVATE_KEY). Default:
   * the real Ed25519 public key of the key's scalar half.
   */
  derivePublicKey?: (privateKey: Uint8Array) => Uint8Array;
  /**
   * Join this VirtualMesh: commands then transmit real packets on it and packets heard on it
   * are processed (LOG_RX_DATA, messages, ACKs, …). Must share `clock`.
   */
  mesh?: VirtualMesh;
  /** The device's meshId on `mesh` (default "self"). */
  meshId?: string;
  name?: string;
  /** Degrees. */
  lat?: number;
  lon?: number;
  radio?: Partial<EmulatorRadio>;
  prefs?: Partial<Omit<EmulatorPrefs, 'name' | 'latE6' | 'lonE6' | 'radio'>>;
  firmware?: Partial<FirmwareInfo>;
  /** MAX_CONTACTS (default 350; DEVICE_INFO reports /2). */
  maxContacts?: number;
  /** MAX_GROUP_CHANNELS (default 8). */
  maxChannels?: number;
  /** OFFLINE_QUEUE_SIZE (default 256; the firmware's own default is 16). */
  offlineQueueSize?: number;
  contacts?: ContactSeed[];
  /**
   * Channel slots by index (missing/null = empty). Default: slot 0 = "Public" with the
   * well-known PSK, the rest empty.
   */
  channels?: Array<{ name: string; secret: Uint8Array } | null>;
  /** Sensor settings exposed via GET/SET_CUSTOM_VAR (only existing names can be set). */
  customVars?: Record<string, string>;
  battery?: { mv?: number; storageUsedKb?: number; storageTotalKb?: number };
  /** MCU temperature for self telemetry (°C); omitted from LPP when undefined. */
  mcuTemperature?: number;
  /** Allowed client-repeat frequency ranges (kHz). */
  allowedRepeatFreqs?: RepeatFreqRange[];
  /** ENABLE_PRIVATE_KEY_EXPORT / IMPORT (default true). false → RESP DISABLED. */
  privateKeyExport?: boolean;
  privateKeyImport?: boolean;
  /** Emulated remote nodes (also added as contacts unless `addContact: false`). */
  remoteNodes?: RemoteNodeConfig[];
  /** ACK behaviour of contacts that have no RemoteNode entry. Default 'auto'. */
  defaultAckPolicy?: AckPolicy;
  /** ACK delay for contacts without a RemoteNode entry. Default 300 ms. */
  defaultAckDelayMs?: number;
  /**
   * app_target_ver at boot (default 0, like the firmware). Set to 3 to model a device whose app
   * already sent DEVICE_QUERY, so queued history is in V3 format.
   */
  appTargetVer?: number;
  clock?: EmulatorClock;
  /** Initial RTC (unix secs). Default: clock.now() / 1000. */
  rtcEpochSecs?: number;
  rng?: Rng;
  /** Seed for a deterministic RNG when `rng` is not given. */
  seed?: number;
  /** Delay between contact records while streaming GET_CONTACTS (default 0 = next tick). */
  contactIntervalMs?: number;
  /** How long a reboot keeps the device offline (default 50 ms). */
  rebootDelayMs?: number;
  /**
   * Emit LOG_RX_DATA for injected packets (default true). NOTE: firmware v1.18 has no host
   * command to toggle this; it always logs when connected.
   */
  logRx?: boolean;
  /** Device-side noise floor / last RSSI / SNR reported by GET_STATS radio. */
  radioStats?: { noiseFloorDbm?: number; lastRssiDbm?: number; lastSnr?: number };
}

/**
 * Something the emulated radio transmitted. `raw` holds the on-air packet bytes
 * (docs/mesh-packet-format.md) — the same bytes a joined VirtualMesh carries. It is a
 * non-enumerable property (so `toEqual` on the other fields keeps working; spreads drop it).
 */
export type AirEvent = AirEventBody & { raw?: Uint8Array };

export type AirEventBody =
  | {
      type: 'txtMsg';
      to: Uint8Array;
      txtType: number;
      attempt: number;
      timestamp: number;
      text: string;
      flood: boolean;
      ackCode: number;
    }
  | { type: 'grpTxt'; channelIdx: number; timestamp: number; text: string }
  | { type: 'grpData'; channelIdx: number; dataType: number; payload: Uint8Array; flood: boolean }
  | { type: 'advert'; flood: boolean; packet: Uint8Array }
  | { type: 'shareContact'; pubKey: Uint8Array; packet: Uint8Array }
  | { type: 'request'; kind: string; to: Uint8Array; tag: number; flood: boolean; data: Uint8Array }
  | { type: 'trace'; tag: number; authCode: number; flags: number; path: Uint8Array }
  | { type: 'rawData'; pathLen: number; path: Uint8Array; payload: Uint8Array }
  | { type: 'rawPacket'; priority: number; packet: Uint8Array }
  | { type: 'controlData'; payload: Uint8Array }
  /** ACK for a received message (inside a flood PATH return when the message came by flood). */
  | { type: 'ack'; to: Uint8Array; ackCode?: number }
  | { type: 'cliReply'; to: Uint8Array; text: string }
  /** PATH return without extra (reciprocal path, CLI message path). */
  | { type: 'path'; to: Uint8Array }
  /** RESPONSE to a contact's request (the device's own telemetry). */
  | { type: 'response'; to: Uint8Array; tag: number };

/** Options for injectContactMessage. */
export interface InjectMessageOptions {
  /** TxtType (default PLAIN). */
  txtType?: number;
  /** Sender clock (default device RTC now). */
  senderTimestamp?: number;
  /** dB (default 8). Only visible in V3 frames. */
  snr?: number;
  /** Encoded flood path_len the packet arrived with, or 0xFF = received DIRECT. Default 0. */
  pathLen?: number;
  /** SIGNED_PLAIN author prefix (4 bytes); default the sender's first 4 key bytes. */
  authorPrefix?: Uint8Array;
}

export interface InjectChannelOptions {
  senderTimestamp?: number;
  snr?: number;
  /** Encoded flood path_len, or 0xFF = received direct. Default 0. */
  pathLen?: number;
}

/** An advert to inject (as if received over the air). */
export interface InjectAdvertInput {
  pubKey: Uint8Array;
  name: string;
  /** ContactType, default CHAT. */
  type?: number;
  /** Sender clock; default device RTC now. Must exceed the stored one or it is ignored (replay). */
  timestamp?: number;
  /** Degrees. */
  lat?: number;
  lon?: number;
  /** Flood path the advert travelled (encoded path_len + bytes). Default zero-hop. */
  pathLen?: number;
  path?: Uint8Array;
  snr?: number;
  rssi?: number;
  /** 64-byte expanded private key to sign with (default: the mesh node's key, else unsigned). */
  privateKey?: Uint8Array;
}
