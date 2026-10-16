/**
 * Ready-made emulator setups for client tests and the web UI's "Emulator" connection.
 * Keys are derived deterministically from names, so tests can refer to nodes by name.
 */

import { concatBytes, utf8Encode } from '../util/bytes.js';
import { ContactFlag, ContactType, TxtType, encodePathLen } from '../protocol/constants.js';
import { systemClock } from './clock.js';
import { CompanionEmulator } from './companion-emulator.js';
import { lppTemperature, lppVoltage } from './remote-node.js';
import { sha256Sync } from './sha256.js';
import type { CompanionEmulatorOptions, ContactSeed } from './types.js';

/** Deterministic 32-byte "public key" for a scenario node name (first byte never 0x00/0xFF). */
export function scenarioKey(name: string): Uint8Array {
  const k = sha256Sync(utf8Encode(`meshcore-web scenario key: ${name}`));
  if (k[0] === 0x00 || k[0] === 0xff) k[0] = 0x42;
  return k;
}

/** Hashtag channel secret: SHA256("#name")[0..16] (meshcore-open convention). */
export function hashtagChannelSecret(name: string): Uint8Array {
  return sha256Sync(utf8Encode(name.startsWith('#') ? name : `#${name}`)).slice(0, 16);
}

export interface BasicScenario {
  emulator: CompanionEmulator;
  keys: {
    self: Uint8Array;
    alice: Uint8Array;
    bob: Uint8Array;
    carol: Uint8Array;
    repeater: Uint8Array;
    room: Uint8Array;
    sensor: Uint8Array;
  };
  /** Device RTC when the scenario was built (unix secs). */
  startSecs: number;
}

export interface BasicScenarioOptions extends CompanionEmulatorOptions {
  /** Queue some message history (default true). */
  history?: boolean;
}

/**
 * Self ("Emulator") + 3 chat contacts (Alice, Bob, Carol) + 1 repeater + 1 room server + 1 sensor,
 * channels 0 "Public" and 1 "#test", and a few queued messages. Contacts have increasing lastmod
 * values (start − 600 … start − 100) for since-filter tests. app_target_ver defaults to 3.
 */
export function basicScenario(options: BasicScenarioOptions = {}): BasicScenario {
  const { history = true, ...emuOptions } = options;
  const keys = {
    self: scenarioKey('self'),
    alice: scenarioKey('alice'),
    bob: scenarioKey('bob'),
    carol: scenarioKey('carol'),
    repeater: scenarioKey('repeater'),
    room: scenarioKey('room'),
    sensor: scenarioKey('sensor'),
  };
  const start = emuOptions.rtcEpochSecs ?? Math.floor((emuOptions.clock ?? systemClock).now() / 1000);

  const chat = (name: string, key: Uint8Array, ageSecs: number, extra: Partial<ContactSeed> = {}): ContactSeed => ({
    pubKey: key,
    name,
    type: ContactType.CHAT,
    lastAdvert: start - ageSecs - 30,
    lastMod: start - ageSecs,
    ...extra,
  });

  const emulator = new CompanionEmulator({
    identity: { publicKey: keys.self, privateKey: concatBytes(sha256Sync(keys.self), sha256Sync(keys.self, keys.self)) },
    name: 'Emulator',
    lat: 47.6062,
    lon: -122.3321,
    appTargetVer: 3,
    seed: 1,
    customVars: { gps: '0', gps_interval: '60' },
    channels: [
      { name: 'Public', secret: Uint8Array.from([0x8b, 0x33, 0x87, 0xe9, 0xc5, 0xcd, 0xea, 0x6a, 0xc9, 0xe5, 0xed, 0xba, 0xa1, 0x15, 0xcd, 0x72]) },
      { name: '#test', secret: hashtagChannelSecret('#test') },
    ],
    contacts: [
      chat('Alice', keys.alice, 600, { flags: ContactFlag.FAVOURITE, outPathLen: encodePathLen(1), outPath: keys.repeater.slice(0, 1), lat: 47.61, lon: -122.33 }),
      chat('Bob', keys.bob, 500),
      chat('Carol', keys.carol, 400, { outPathLen: 0 }),
    ],
    remoteNodes: [
      {
        type: 'chat',
        pubKey: keys.alice,
        name: 'Alice',
        addContact: false,
        autoReply: (text) => (text.toLowerCase().startsWith('ping') ? 'pong' : null),
      },
      {
        type: 'repeater',
        pubKey: keys.repeater,
        name: 'Hilltop Repeater',
        password: 'password',
        guestPassword: 'guest',
        lat: 47.62,
        lon: -122.35,
        contact: { lastAdvert: start - 330, lastMod: start - 300, outPathLen: 0 },
        neighbours: [
          { pubKey: keys.alice, heardSecsAgo: 120, snr: 9.5 },
          { pubKey: keys.bob, heardSecsAgo: 3600, snr: -4.25 },
        ],
        acl: [{ prefix: keys.self.slice(0, 6), permissions: 3 }],
        ownerInfo: 'Emulated repeater',
      },
      {
        type: 'room',
        pubKey: keys.room,
        name: 'Town Square',
        password: 'password',
        guestPassword: '',
        contact: { lastAdvert: start - 230, lastMod: start - 200 },
      },
      {
        type: 'sensor',
        pubKey: keys.sensor,
        name: 'Weather Station',
        password: 'password',
        telemetry: concatBytes(lppVoltage(3950), lppTemperature(18.4), lppTemperature(12.5, 2)),
        contact: { lastAdvert: start - 130, lastMod: start - 100, outPathLen: encodePathLen(1), outPath: keys.repeater.slice(0, 1) },
      },
    ],
    ...emuOptions,
  });

  if (history) {
    emulator.injectContactMessage(keys.alice, 'Hi! Are you on the mesh today?', { senderTimestamp: start - 3600, snr: 6.5 });
    emulator.injectChannelMessage(0, 'Dave', 'Good morning everyone', { senderTimestamp: start - 1800, pathLen: encodePathLen(2) });
    emulator.injectContactMessage(keys.room, 'Welcome to Town Square', {
      txtType: TxtType.SIGNED_PLAIN,
      senderTimestamp: start - 900,
      authorPrefix: keys.carol.slice(0, 4),
      pathLen: 0xff,
    });
  }

  return { emulator, keys, startSecs: start };
}

/** An emulator with no contacts and only the Public channel (fresh device). */
export function emptyScenario(options: CompanionEmulatorOptions = {}): CompanionEmulator {
  return new CompanionEmulator({ name: 'Emulator', ...options });
}
