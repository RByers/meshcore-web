/**
 * Synchronous twins of the async primitives in `packet/crypto.ts` (SHA-256/512, HMAC-SHA256,
 * Ed25519 keygen/sign/verify, X25519 ECDH) plus sync versions of the few `packet/` helpers that
 * depend on them (encrypt-then-MAC, packet hash, channel hash, transport code, ack code).
 *
 * Why this exists: the emulator mirrors the firmware's single-threaded loop and must stay
 * deterministic under `ManualClock`: `clock.advance(ms)` runs every due timer synchronously, and
 * replies scheduled by those timers must be timed from the moment they were due. WebCrypto is
 * async-only, and in Node its promises resolve on the thread pool *after* a `setTimeout(0)`, so an
 * async emulator would make frame timing and ordering depend on the host scheduler. Everything
 * structural (envelopes, payload layouts, AES) comes from `packet/`; only the hash/curve maths is
 * duplicated here, and `crypto-sync.test.ts` checks every function against `packet/crypto`.
 *
 * Unlike WebCrypto, `ed25519SignExpanded` signs with the firmware's 64-byte *expanded* private key
 * (orlp `ed25519_sign`), so keys exported from a real device can sign here too. Pure BigInt maths:
 * not constant time, fine for an emulator, not for real secrets.
 */

import { concatBytes, bytesEqual, readU32LE, u32le, writeU16LE, readU16LE } from '../util/bytes.js';
import { aes128EcbDecrypt, aes128EcbEncrypt, edwardsToMontgomery, normalizeSecret } from '../packet/crypto.js';
import { CIPHER_BLOCK_SIZE, CIPHER_MAC_SIZE, PACKET_HASH_SIZE, PayloadType } from '../packet/constants.js';

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4)
// ---------------------------------------------------------------------------

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Message padding shared by SHA-256 (64-byte blocks) and SHA-512 (128-byte blocks). */
function pad(parts: readonly Uint8Array[], block: number, lenBytes: number): { m: Uint8Array; dv: DataView } {
  let len = 0;
  for (const p of parts) len += p.length;
  const total = Math.ceil((len + 1 + lenBytes) / block) * block;
  const m = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    m.set(p, o);
    o += p.length;
  }
  m[len] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, Math.floor(len / 0x20000000));
  dv.setUint32(total - 4, (len * 8) >>> 0);
  return { m, dv };
}

export function sha256Sync(...parts: readonly Uint8Array[]): Uint8Array {
  const { m, dv } = pad(parts, 64, 8);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!);
  return out;
}

// ---------------------------------------------------------------------------
// SHA-512 (FIPS 180-4), BigInt words
// ---------------------------------------------------------------------------

const K512 = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019',
  '923f82a4af194f9b', 'ab1c5ed5da6d8118', 'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2',
  '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694', 'e49b69c19ef14ad2', 'efbe4786384f25e3',
  '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725',
  '06ca6351e003826f', '142929670a0e6e70', '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df',
  '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b', 'a2bfe8a14cf10364', 'a81a664bbc423001',
  'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb',
  '5b9cca4f7763e373', '682e6ff3d6b2b8a3', '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec',
  '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b', 'ca273eceea26619c', 'd186b8c721c0c207',
  'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a',
  '5fcb6fab3ad6faec', '6c44198c4a475817',
].map((s) => BigInt(`0x${s}`));
const IV512 = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'].map(
  (s) => BigInt(`0x${s}`),
);
const M64 = (1n << 64n) - 1n;

export function sha512Sync(...parts: readonly Uint8Array[]): Uint8Array {
  const { m, dv } = pad(parts, 128, 16);
  const h = IV512.slice();
  const w = new Array<bigint>(80).fill(0n);
  const rotr = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & M64;
  for (let off = 0; off < m.length; off += 128) {
    for (let i = 0; i < 16; i++) w[i] = dv.getBigUint64(off + i * 8);
    for (let i = 16; i < 80; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 1n) ^ rotr(a, 8n) ^ (a >> 7n);
      const s1 = rotr(b, 19n) ^ rotr(b, 61n) ^ (b >> 6n);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) & M64;
    }
    let [a, b, c, d, e, f, g, hh] = h as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    for (let i = 0; i < 80; i++) {
      const S1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
      const ch = (e & f) ^ (~e & M64 & g);
      const t1 = (hh + S1 + ch + K512[i]! + w[i]!) & M64;
      const S0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & M64;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) & M64;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & M64;
    }
    const v = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + v[i]!) & M64;
  }
  const out = new Uint8Array(64);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setBigUint64(i * 8, h[i]!);
  return out;
}

/** HMAC-SHA256(key, concat(parts)) — RFC 2104. */
export function hmacSha256Sync(key: Uint8Array, ...parts: readonly Uint8Array[]): Uint8Array {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha256Sync(key) : key);
  const ipad = k.map((b) => b ^ 0x36);
  const opad = k.map((b) => b ^ 0x5c);
  return sha256Sync(opad, sha256Sync(ipad, ...parts));
}

// ---------------------------------------------------------------------------
// Curve25519 field / Ed25519 group (RFC 8032, extended coordinates)
// ---------------------------------------------------------------------------

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

const mod = (a: bigint, m = P): bigint => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};

function powMod(base: bigint, exp: bigint, m = P): bigint {
  let r = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

const inv = (a: bigint): bigint => powMod(a, P - 2n);

function leToBig(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}

function bigToLe(n: bigint, len = 32): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

const D = mod(-121665n * inv(121666n));
const D2 = mod(2n * D);
const SQRT_M1 = powMod(2n, (P - 1n) / 4n);

type Point = readonly [bigint, bigint, bigint, bigint]; // X, Y, Z, T

const BX = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const BY = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;
const BASE: Point = [BX, BY, 1n, mod(BX * BY)];
const IDENTITY: Point = [0n, 1n, 1n, 0n];

/** add-2008-hwcd-3 (a = −1). */
function ptAdd(p: Point, q: Point): Point {
  const [X1, Y1, Z1, T1] = p;
  const [X2, Y2, Z2, T2] = q;
  const A = mod((Y1 - X1) * (Y2 - X2));
  const B = mod((Y1 + X1) * (Y2 + X2));
  const C = mod(T1 * D2 * T2);
  const Dd = mod(2n * Z1 * Z2);
  const E = B - A;
  const F = Dd - C;
  const G = Dd + C;
  const H = B + A;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}

/** dbl-2008-hwcd (a = −1). */
function ptDouble(p: Point): Point {
  const [X1, Y1, Z1] = p;
  const A = mod(X1 * X1);
  const B = mod(Y1 * Y1);
  const C = mod(2n * Z1 * Z1);
  const Dd = P - A;
  const E = mod((X1 + Y1) * (X1 + Y1) - A - B);
  const G = Dd + B;
  const F = G - C;
  const H = Dd - B;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}

function ptMul(k: bigint, p: Point): Point {
  let r = IDENTITY;
  let q = p;
  while (k > 0n) {
    if (k & 1n) r = ptAdd(r, q);
    q = ptDouble(q);
    k >>= 1n;
  }
  return r;
}

function ptEncode(p: Point): Uint8Array {
  const zi = inv(p[2]);
  const x = mod(p[0] * zi);
  const y = mod(p[1] * zi);
  const out = bigToLe(y);
  if (x & 1n) out[31] = out[31]! | 0x80;
  return out;
}

function ptDecode(bytes: Uint8Array): Point | null {
  if (bytes.length !== 32) return null;
  const b = bytes.slice();
  const sign = (b[31]! >> 7) & 1;
  b[31] = b[31]! & 0x7f;
  const y = leToBig(b);
  if (y >= P) return null;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = mod(v * v * v);
  let x = mod(u * v3 * powMod(mod(u * v3 * v3 * v), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 !== u) {
    if (vx2 === mod(-u)) x = mod(x * SQRT_M1);
    else return null;
  }
  if (x === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) x = P - x;
  return [x, y, 1n, mod(x * y)];
}

function ptNegate(p: Point): Point {
  return [mod(-p[0]), p[1], p[2], mod(-p[3])];
}

// ---------------------------------------------------------------------------
// Ed25519 (orlp/ed25519 semantics: 64-byte expanded private key)
// ---------------------------------------------------------------------------

export interface SyncKeyPair {
  /** 32-byte RFC 8032 seed (absent when only the expanded key is known). */
  seed?: Uint8Array;
  publicKey: Uint8Array;
  /** 64-byte firmware-format expanded private key. */
  privateKey: Uint8Array;
}

/** orlp `ed25519_create_keypair` expansion: clamp(SHA512(seed)[0..32]) ‖ SHA512(seed)[32..64]. */
export function expandSeedSync(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new RangeError('Ed25519 seed must be 32 bytes');
  const h = sha512Sync(seed);
  h[0] = h[0]! & 248;
  h[31] = (h[31]! & 63) | 64;
  return h;
}

/** Public key of a 64-byte expanded private key (only the scalar half `prv[0..32]` is used). */
export function ed25519PublicKeySync(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length < 32) throw new RangeError('private key must be ≥ 32 bytes');
  return ptEncode(ptMul(mod(leToBig(privateKey.subarray(0, 32)), L), BASE));
}

/** Like `packet/crypto` `ed25519KeyPairFromSeed`, synchronously. */
export function ed25519KeyPairFromSeedSync(seed: Uint8Array): SyncKeyPair {
  const privateKey = expandSeedSync(seed);
  return { seed: seed.slice(), publicKey: ed25519PublicKeySync(privateKey), privateKey };
}

/** orlp `ed25519_sign(sig, msg, pub, prv64)`. Identical to RFC 8032 when prv = expand(seed). */
export function ed25519SignExpanded(privateKey: Uint8Array, publicKey: Uint8Array, message: Uint8Array): Uint8Array {
  if (privateKey.length !== 64) throw new RangeError('expanded private key must be 64 bytes');
  const a = leToBig(privateKey.subarray(0, 32));
  const r = mod(leToBig(sha512Sync(privateKey.subarray(32, 64), message)), L);
  const R = ptEncode(ptMul(r, BASE));
  const k = mod(leToBig(sha512Sync(R, publicKey, message)), L);
  const S = mod(r + k * a, L);
  return concatBytes(R, bigToLe(S));
}

/** Cofactorless RFC 8032 verification. Never throws. */
export function ed25519VerifySync(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const A = ptDecode(publicKey);
  if (!A) return false;
  const S = leToBig(signature.subarray(32, 64));
  if (S >= L) return false;
  const R = signature.subarray(0, 32);
  const k = mod(leToBig(sha512Sync(R, publicKey, message)), L);
  const Q = ptAdd(ptMul(S, BASE), ptMul(k, ptNegate(A)));
  return bytesEqual(ptEncode(Q), R);
}

// ---------------------------------------------------------------------------
// X25519 (RFC 7748) and the MeshCore peer secret
// ---------------------------------------------------------------------------

export function x25519Sync(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  const kb = scalar.slice(0, 32);
  kb[0] = kb[0]! & 248;
  kb[31] = (kb[31]! & 63) | 64;
  const k = leToBig(kb);
  const ub = u.slice(0, 32);
  ub[31] = ub[31]! & 0x7f;
  const x1 = mod(leToBig(ub));
  let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n;
  let swap = 0n;
  for (let t = 254n; t >= 0n; t--) {
    const kt = (k >> t) & 1n;
    swap ^= kt;
    if (swap) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = kt;
    const A = x2 + z2;
    const AA = mod(A * A);
    const B = x2 - z2;
    const BB = mod(B * B);
    const E = AA - BB;
    const C = x3 + z3;
    const Dd = x3 - z3;
    const DA = mod(Dd * A);
    const CB = mod(C * B);
    x3 = mod((DA + CB) * (DA + CB));
    z3 = mod(x1 * mod((DA - CB) * (DA - CB)));
    x2 = mod(AA * BB);
    z2 = mod(E * (AA + 121665n * E));
  }
  if (swap) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }
  return bigToLe(mod(x2 * inv(z2)));
}

/** `Identity::calcSharedSecret` / `ed25519_key_exchange` (see `packet/crypto` calcSharedSecret). */
export function calcSharedSecretSync(privateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return x25519Sync(privateKey.subarray(0, 32), edwardsToMontgomery(peerPublicKey));
}

// ---------------------------------------------------------------------------
// MeshCore helpers (sync versions of packet/ functions)
// ---------------------------------------------------------------------------

/** `encryptThenMac` (packet/crypto), synchronously: MAC(2) ‖ AES-128-ECB. */
export function encryptThenMacSync(secret: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const s = normalizeSecret(secret);
  const ct = aes128EcbEncrypt(s, plaintext);
  return concatBytes(hmacSha256Sync(s, ct).slice(0, CIPHER_MAC_SIZE), ct);
}

/** `macThenDecrypt` (packet/crypto), synchronously. null on a bad MAC / alignment. */
export function macThenDecryptSync(secret: Uint8Array, macAndCiphertext: Uint8Array): Uint8Array | null {
  if (macAndCiphertext.length <= CIPHER_MAC_SIZE) return null;
  const ct = macAndCiphertext.subarray(CIPHER_MAC_SIZE);
  if (ct.length % CIPHER_BLOCK_SIZE !== 0) return null;
  const s = normalizeSecret(secret);
  if (!bytesEqual(hmacSha256Sync(s, ct).subarray(0, CIPHER_MAC_SIZE), macAndCiphertext.subarray(0, CIPHER_MAC_SIZE))) return null;
  return aes128EcbDecrypt(s, ct);
}

/** `packetHash` (packet/packet), synchronously. mesh-packet-format.md §1.4 */
export function packetHashSync(p: { payloadType: number; pathLen: number; payload: Uint8Array }): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(p.payloadType)];
  if (p.payloadType === PayloadType.TRACE) {
    const pl = new Uint8Array(2);
    writeU16LE(pl, 0, p.pathLen);
    parts.push(pl);
  }
  parts.push(p.payload);
  return sha256Sync(...parts).slice(0, PACKET_HASH_SIZE);
}

/** `channelHash` (packet/payloads), synchronously. §2 */
export function channelHashSync(psk: Uint8Array): number {
  const is128 = psk.length === 16 || psk.subarray(16).every((b) => b === 0);
  return sha256Sync(is128 ? psk.subarray(0, 16) : psk)[0]!;
}

/** `calcTransportCode` (packet/packet), synchronously. §1.2 */
export function transportCodeSync(key: Uint8Array, payloadType: number, payload: Uint8Array): number {
  const code = readU16LE(hmacSha256Sync(key.subarray(0, 16), Uint8Array.of(payloadType), payload), 0);
  if (code === 0) return 1;
  if (code === 0xffff) return 0xfffe;
  return code;
}

/** ACK code SHA256(covered ‖ pubkey)[0..4] as a u32 LE (`computeAckCode` in packet/payloads). §3.4 */
export function ackCodeSync(covered: Uint8Array, publicKey: Uint8Array): number {
  return readU32LE(sha256Sync(covered, publicKey), 0);
}

/** Ack code bytes of a u32 (as in RESP_CODE_SENT). */
export const ackBytes = (ack: number): Uint8Array => u32le(ack);
