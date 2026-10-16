// Explicit lists where a module exports names that also exist in packet/ or protocol/ (e.g.
// `computeAckCode`, `AclEntry`), so the root barrel can `export *` from here without clashes.
export {
  CompanionEmulator,
  MAX_ANON_CONTACTS,
  emulatorAckCode,
  fakeDerivePublicKey,
  type EmulatorEvents,
} from './companion-emulator.js';
export * from './types.js';
export {
  RemoteNode,
  contactTypeOf,
  lppTemperature,
  lppVoltage,
  type AckPolicy,
  type NeighbourEntry,
  type RemoteAclEntry,
  type RemoteNodeConfig,
  type RemoteNodeType,
} from './remote-node.js';
export * from './clock.js';
export * from './rng.js';
export * from './scenarios.js';
export * from './virtual-mesh.js';
export {
  contactRoute,
  envelope,
  type MeshIdentity,
  type SendRoute,
} from './mesh-packets.js';
export {
  calcSharedSecretSync,
  ed25519KeyPairFromSeedSync,
  ed25519PublicKeySync,
  ed25519SignExpanded,
  ed25519VerifySync,
  sha256Sync,
  sha512Sync,
  type SyncKeyPair,
} from './crypto-sync.js';
export { loraAirtimeMs } from './airtime.js';
