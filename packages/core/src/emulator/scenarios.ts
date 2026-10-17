/**
 * Ready-made emulator setups for client tests and the web UI's "Emulator" connection.
 * Identities are real Ed25519 key pairs derived deterministically from names, so tests can refer
 * to nodes by name and runs are reproducible.
 */

import { concatBytes, utf8Encode } from '../util/bytes.js';
import { ContactFlag, ContactType, PUBLIC_CHANNEL_SECRET_HEX, TxtType, encodePathLen } from '../protocol/constants.js';
import { systemClock } from './clock.js';
import { CompanionEmulator } from './companion-emulator.js';
import { sha256Sync } from './crypto-sync.js';
import type { MeshIdentity } from './mesh-packets.js';
import { lppTemperature, lppVoltage } from './remote-node.js';
import type { CompanionEmulatorOptions, ContactSeed } from './types.js';
import { VirtualMesh, meshIdentityFromSeed } from './virtual-mesh.js';
import type { MeshNode, MeshNodeConfig, VirtualMeshOptions } from './virtual-mesh.js';

const identities = new Map<string, MeshIdentity & { seed: Uint8Array }>();

/**
 * Deterministic real Ed25519 identity for a scenario node name: seed = SHA256("meshcore-web
 * scenario key: <name>"), re-hashed until the public key's first byte is not 0x00 / 0xFF.
 */
export function scenarioIdentity(name: string): MeshIdentity & { seed: Uint8Array } {
  let id = identities.get(name);
  if (!id) {
    id = meshIdentityFromSeed(`meshcore-web scenario key: ${name}`);
    identities.set(name, id);
  }
  return { seed: id.seed.slice(), publicKey: id.publicKey.slice(), privateKey: id.privateKey.slice() };
}

/** The public key of {@link scenarioIdentity} (first byte never 0x00/0xFF). */
export function scenarioKey(name: string): Uint8Array {
  return scenarioIdentity(name).publicKey;
}

/** Hashtag channel secret: SHA256("#name")[0..16] (meshcore-open convention). */
export function hashtagChannelSecret(name: string): Uint8Array {
  return sha256Sync(utf8Encode(name.startsWith('#') ? name : `#${name}`)).slice(0, 16);
}

/** The well-known Public channel PSK. */
export function publicChannelSecret(): Uint8Array {
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(PUBLIC_CHANNEL_SECRET_HEX.slice(i * 2, i * 2 + 2), 16));
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
  /** The shared air (the emulator is joined as "self"). */
  mesh: VirtualMesh;
  /** The emulated nodes on the mesh. */
  nodes: { alice: MeshNode; bob: MeshNode; carol: MeshNode; repeater: MeshNode; room: MeshNode; sensor: MeshNode };
}

/** Delays every node in a scenario uses (per-node config still wins). */
export interface ScenarioTiming {
  /** Delay before a node's reply arrives (default 300 ms). */
  responseDelayMs?: number;
  /** Chat peers' ACK delay (default 300 ms); also the emulator's `defaultAckDelayMs`. */
  ackDelayMs?: number;
  /** Delay before a repeater re-sends a forwarded packet (default 50 ms). */
  forwardDelayMs?: number;
}

/** Fast scenario timing for tests: a few ms per hop so real-time waits stay short but ordering is preserved. */
export const FAST_TIMING: Required<ScenarioTiming> = { responseDelayMs: 5, ackDelayMs: 5, forwardDelayMs: 2 };

export interface BasicScenarioOptions extends CompanionEmulatorOptions {
  /** Queue some message history (default true). */
  history?: boolean;
  /** Node delays applied to every node (tests pass `FAST_TIMING`). */
  timing?: ScenarioTiming;
  /** VirtualMesh options (the clock is always the emulator's). */
  meshOptions?: Omit<VirtualMeshOptions, 'clock'>;
}

/**
 * Self ("Emulator") + 3 chat contacts (Alice, Bob, Carol) + 1 repeater + 1 room server + 1 sensor,
 * channels 0 "Public" and 1 "#test", and a few queued messages. Contacts have increasing lastmod
 * values (start − 600 … start − 100) for since-filter tests. app_target_ver defaults to 3.
 *
 * Every node is a MeshNode on a VirtualMesh that the emulator joins as "self", so all traffic is
 * real packets. Topology: self hears Alice, Bob, the repeater and the room directly; Carol and
 * the sensor are only in range of the repeater ("Hilltop Repeater"), so their traffic arrives with
 * a 1-hop path. Alice and the sensor have a stored out_path via the repeater, the repeater is
 * zero-hop, Bob / Carol / the room have no path yet (flood; learned from the first PATH).
 * Alice auto-replies "pong" to "ping". Alice, Bob and Carol are members of both channels.
 */
export function basicScenario(options: BasicScenarioOptions = {}): BasicScenario {
  const { history = true, meshOptions, timing, ...emuOptions } = options;
  if (timing?.ackDelayMs !== undefined) emuOptions.defaultAckDelayMs ??= timing.ackDelayMs;
  const ids = {
    self: scenarioIdentity('self'),
    alice: scenarioIdentity('alice'),
    bob: scenarioIdentity('bob'),
    carol: scenarioIdentity('carol'),
    repeater: scenarioIdentity('repeater'),
    room: scenarioIdentity('room'),
    sensor: scenarioIdentity('sensor'),
  };
  const keys = {
    self: ids.self.publicKey,
    alice: ids.alice.publicKey,
    bob: ids.bob.publicKey,
    carol: ids.carol.publicKey,
    repeater: ids.repeater.publicKey,
    room: ids.room.publicKey,
    sensor: ids.sensor.publicKey,
  };
  const clock = emuOptions.clock ?? systemClock;
  const start = emuOptions.rtcEpochSecs ?? Math.floor(clock.now() / 1000);
  const channels = [
    { name: 'Public', secret: publicChannelSecret() },
    { name: '#test', secret: hashtagChannelSecret('#test') },
  ];
  const viaRepeater = keys.repeater.slice(0, 1);

  const mesh = new VirtualMesh({ ...meshOptions, clock });
  const addNode = (c: MeshNodeConfig): MeshNode => mesh.addNode({ ...timing, ...c });
  const nodes = {
    alice: addNode({
      id: 'alice',
      type: 'chat',
      name: 'Alice',
      privateKey: ids.alice.privateKey,
      lat: 47.61,
      lon: -122.33,
      channels,
      autoReply: (text) => (text.toLowerCase().startsWith('ping') ? 'pong' : null),
    }),
    bob: addNode({ id: 'bob', type: 'chat', name: 'Bob', privateKey: ids.bob.privateKey, channels }),
    carol: addNode({ id: 'carol', type: 'chat', name: 'Carol', privateKey: ids.carol.privateKey, channels }),
    repeater: addNode({
      id: 'repeater',
      type: 'repeater',
      name: 'Hilltop Repeater',
      privateKey: ids.repeater.privateKey,
      password: 'password',
      guestPassword: 'guest',
      lat: 47.62,
      lon: -122.35,
      neighbours: [
        { pubKey: keys.alice, heardSecsAgo: 120, snr: 9.5 },
        { pubKey: keys.bob, heardSecsAgo: 3600, snr: -4.25 },
      ],
      acl: [{ prefix: keys.self.slice(0, 6), permissions: 3 }],
      ownerInfo: 'Emulated repeater',
    }),
    room: addNode({ id: 'room', type: 'room', name: 'Town Square', privateKey: ids.room.privateKey, password: 'password', guestPassword: '' }),
    sensor: addNode({
      id: 'sensor',
      type: 'sensor',
      name: 'Weather Station',
      privateKey: ids.sensor.privateKey,
      password: 'password',
      telemetry: concatBytes(lppVoltage(3950), lppTemperature(18.4), lppTemperature(12.5, 2)),
    }),
  };
  // every link in range is the default 8 dB / -70 dBm; Carol and the sensor only reach the repeater
  for (const far of ['carol', 'sensor']) {
    for (const other of ['self', 'alice', 'bob', 'room', 'carol', 'sensor']) if (other !== far) mesh.isolate(far, other);
  }

  const chat = (name: string, key: Uint8Array, ageSecs: number, extra: Partial<ContactSeed> = {}): ContactSeed => ({
    pubKey: key,
    name,
    type: ContactType.CHAT,
    lastAdvert: start - ageSecs - 30,
    lastMod: start - ageSecs,
    ...extra,
  });

  const emulator = new CompanionEmulator({
    identity: { publicKey: keys.self, privateKey: ids.self.privateKey },
    name: 'Emulator',
    lat: 47.6062,
    lon: -122.3321,
    appTargetVer: 3,
    seed: 1,
    customVars: { gps: '0', gps_interval: '60' },
    channels,
    mesh,
    meshId: 'self',
    contacts: [
      chat('Alice', keys.alice, 600, { flags: ContactFlag.FAVOURITE, outPathLen: encodePathLen(1), outPath: viaRepeater, lat: 47.61, lon: -122.33 }),
      chat('Bob', keys.bob, 500),
      chat('Carol', keys.carol, 400),
      { pubKey: keys.repeater, name: 'Hilltop Repeater', type: ContactType.REPEATER, lastAdvert: start - 330, lastMod: start - 300, outPathLen: 0, lat: 47.62, lon: -122.35 },
      { pubKey: keys.room, name: 'Town Square', type: ContactType.ROOM, lastAdvert: start - 230, lastMod: start - 200 },
      {
        pubKey: keys.sensor,
        name: 'Weather Station',
        type: ContactType.SENSOR,
        lastAdvert: start - 130,
        lastMod: start - 100,
        outPathLen: encodePathLen(1),
        outPath: viaRepeater,
      },
    ],
    ...emuOptions,
  });

  // every node knows everyone (as if adverts had been heard); stored paths mirror the device's
  mesh.introduceAll();
  nodes.alice.setPath(keys.self, viaRepeater);
  nodes.repeater.setPath(keys.self, new Uint8Array(0));
  nodes.sensor.setPath(keys.self, viaRepeater);

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

  return { emulator, keys, startSecs: start, mesh, nodes };
}

/** An emulator with no contacts and only the Public channel (fresh device). */
export function emptyScenario(options: CompanionEmulatorOptions = {}): CompanionEmulator {
  return new CompanionEmulator({ name: 'Emulator', ...options });
}
