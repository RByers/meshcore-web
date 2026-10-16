/**
 * MeshCore cryptographic primitives. docs/mesh-packet-format.md §2.
 *
 * Hashes, HMAC, Ed25519 and X25519 use `globalThis.crypto.subtle` (Node ≥ 20 and Chrome ≥ 133
 * support Ed25519/X25519), so they are async. AES-128-ECB is not offered by WebCrypto, so a small
 * pure-TS block cipher is used (FIPS-197); it is synchronous.
 *
 * Private-key caveat (docs/companion-protocol.md §9): the firmware (orlp/ed25519) stores only the
 * 64-byte *expanded* key `SHA512(seed)` with the first half clamped; the seed is discarded.
 * WebCrypto Ed25519 signing needs the 32-byte seed, so a key exported from a real device
 * (EXPORT_PRIVATE_KEY) can be used for ECDH here (only `prv[0..32]` matters) but NOT for signing.
 * {@link generateEd25519KeyPair} keeps the seed so emulated nodes can do both.
 */

import { bytesEqual, concatBytes } from '../util/bytes.js';
import { CIPHER_BLOCK_SIZE, CIPHER_KEY_SIZE, CIPHER_MAC_SIZE, SHARED_SECRET_SIZE } from './constants.js';

/** Copies into a fresh ArrayBuffer-backed array (WebCrypto's BufferSource excludes SharedArrayBuffer). */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto (crypto.subtle) is not available');
  return s;
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

/** SHA-256 of the concatenation of `parts`. */
export async function sha256(...parts: readonly Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', buf(concatBytes(...parts))));
}

/** SHA-512 of the concatenation of `parts`. */
export async function sha512(...parts: readonly Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-512', buf(concatBytes(...parts))));
}

/** HMAC-SHA256(key, concat(parts)). Full 32-byte tag. */
export async function hmacSha256(key: Uint8Array, ...parts: readonly Uint8Array[]): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, buf(concatBytes(...parts))));
}

// ---------------------------------------------------------------------------
// AES-128 (FIPS-197), pure TS
// ---------------------------------------------------------------------------

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
(() => {
  // Generate the S-box from GF(2^8) inverses + affine transform (FIPS-197 §5.1.1).
  let p = 1;
  let q = 1;
  do {
    // p ← p·3, q ← q/3 (so q = p⁻¹)
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63;
    SBOX[p] = x;
    INV_SBOX[x] = p;
  } while (p !== 1);
  SBOX[0] = 0x63;
  INV_SBOX[0x63] = 0;
})();

function rotl8(x: number, s: number): number {
  return ((x << s) | (x >> (8 - s))) & 0xff;
}

function xtime(x: number): number {
  return ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
}

function gmul(a: number, b: number): number {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return r;
}

/** AES-128 key expansion → 176-byte round-key schedule (FIPS-197 §5.2). */
function expandKey(key: Uint8Array): Uint8Array {
  if (key.length < CIPHER_KEY_SIZE) throw new RangeError(`AES-128 key must be ≥16 bytes (got ${key.length})`);
  const w = new Uint8Array(176);
  w.set(key.subarray(0, 16));
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4]!;
    let t1 = w[i - 3]!;
    let t2 = w[i - 2]!;
    let t3 = w[i - 1]!;
    if (i % 16 === 0) {
      const tmp = t0;
      t0 = SBOX[t1]! ^ rcon;
      t1 = SBOX[t2]!;
      t2 = SBOX[t3]!;
      t3 = SBOX[tmp]!;
      rcon = xtime(rcon);
    }
    w[i] = w[i - 16]! ^ t0;
    w[i + 1] = w[i - 15]! ^ t1;
    w[i + 2] = w[i - 14]! ^ t2;
    w[i + 3] = w[i - 13]! ^ t3;
  }
  return w;
}

function addRoundKey(s: Uint8Array, w: Uint8Array, round: number): void {
  for (let i = 0; i < 16; i++) s[i] = s[i]! ^ w[round * 16 + i]!;
}

/** State is column-major: s[r + 4c]. */
function shiftRows(s: Uint8Array, inverse: boolean): void {
  const t = s.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const src = inverse ? (c - r + 4) % 4 : (c + r) % 4;
      s[r + 4 * c] = t[r + 4 * src]!;
    }
  }
}

function mixColumns(s: Uint8Array, inverse: boolean): void {
  for (let c = 0; c < 4; c++) {
    const a0 = s[4 * c]!;
    const a1 = s[4 * c + 1]!;
    const a2 = s[4 * c + 2]!;
    const a3 = s[4 * c + 3]!;
    if (!inverse) {
      s[4 * c] = xtime(a0) ^ xtime(a1) ^ a1 ^ a2 ^ a3;
      s[4 * c + 1] = a0 ^ xtime(a1) ^ xtime(a2) ^ a2 ^ a3;
      s[4 * c + 2] = a0 ^ a1 ^ xtime(a2) ^ xtime(a3) ^ a3;
      s[4 * c + 3] = xtime(a0) ^ a0 ^ a1 ^ a2 ^ xtime(a3);
    } else {
      s[4 * c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
      s[4 * c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
      s[4 * c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
      s[4 * c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
    }
  }
}

function encryptBlockWith(w: Uint8Array, block: Uint8Array): Uint8Array {
  const s = block.slice(0, 16);
  addRoundKey(s, w, 0);
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]!]!;
    shiftRows(s, false);
    if (round !== 10) mixColumns(s, false);
    addRoundKey(s, w, round);
  }
  return s;
}

function decryptBlockWith(w: Uint8Array, block: Uint8Array): Uint8Array {
  const s = block.slice(0, 16);
  addRoundKey(s, w, 10);
  for (let round = 9; round >= 0; round--) {
    shiftRows(s, true);
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]!]!;
    addRoundKey(s, w, round);
    if (round !== 0) mixColumns(s, true);
  }
  return s;
}

/** Encrypts one 16-byte block with AES-128 (key = first 16 bytes of `key`). */
export function aes128EncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  if (block.length !== 16) throw new RangeError('AES block must be 16 bytes');
  return encryptBlockWith(expandKey(key), block);
}

/** Decrypts one 16-byte block with AES-128 (key = first 16 bytes of `key`). */
export function aes128DecryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  if (block.length !== 16) throw new RangeError('AES block must be 16 bytes');
  return decryptBlockWith(expandKey(key), block);
}

/**
 * AES-128-ECB encrypt exactly like `Utils::encrypt`: key = `key[0..16]`, the final partial block
 * is zero-padded; an already block-aligned input gets no extra block; empty input → empty output.
 */
export function aes128EcbEncrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const w = expandKey(key);
  const n = Math.ceil(plaintext.length / CIPHER_BLOCK_SIZE);
  const out = new Uint8Array(n * CIPHER_BLOCK_SIZE);
  const block = new Uint8Array(16);
  for (let i = 0; i < n; i++) {
    block.fill(0);
    block.set(plaintext.subarray(i * 16, i * 16 + 16));
    out.set(encryptBlockWith(w, block), i * 16);
  }
  return out;
}

/**
 * AES-128-ECB decrypt like `Utils::decrypt`. The result keeps the zero padding. Throws if the
 * ciphertext is not block-aligned (the firmware's MACThenDecrypt rejects such input).
 */
export function aes128EcbDecrypt(key: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (ciphertext.length % CIPHER_BLOCK_SIZE !== 0) {
    throw new RangeError(`AES-ECB ciphertext must be a multiple of 16 bytes (got ${ciphertext.length})`);
  }
  const w = expandKey(key);
  const out = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i += 16) out.set(decryptBlockWith(w, ciphertext.subarray(i, i + 16)), i);
  return out;
}

// ---------------------------------------------------------------------------
// MeshCore encrypt-then-MAC (`Utils::encryptThenMAC` / `MACThenDecrypt`). §2
// ---------------------------------------------------------------------------

/**
 * Normalises a secret to the 32-byte form the firmware uses as the HMAC key: a 16-byte channel PSK
 * is zero-padded (`BCM addChannel`), a 32-byte ECDH secret is used as-is.
 */
export function normalizeSecret(secret: Uint8Array): Uint8Array {
  if (secret.length === SHARED_SECRET_SIZE) return secret;
  if (secret.length === CIPHER_KEY_SIZE) {
    const out = new Uint8Array(SHARED_SECRET_SIZE);
    out.set(secret);
    return out;
  }
  throw new RangeError(`secret must be 16 or 32 bytes (got ${secret.length})`);
}

/** The 2-byte MAC: HMAC-SHA256(key = secret[0..32], msg = ciphertext)[0..2]. §2 */
export async function computeMac(secret: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  return (await hmacSha256(normalizeSecret(secret), ciphertext)).slice(0, CIPHER_MAC_SIZE);
}

/** `MAC(2) ‖ AES-128-ECB(secret[0..16], zero-padded plaintext)`. §2 */
export async function encryptThenMac(secret: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const s = normalizeSecret(secret);
  const ct = aes128EcbEncrypt(s, plaintext);
  return concatBytes(await computeMac(s, ct), ct);
}

/**
 * Verifies the MAC and decrypts `MAC(2) ‖ ciphertext`. Returns `null` (like the firmware's 0
 * return) for a bad MAC, ≤ 2 input bytes or a non-block-aligned ciphertext. Padding is kept.
 */
export async function macThenDecrypt(secret: Uint8Array, macAndCiphertext: Uint8Array): Promise<Uint8Array | null> {
  if (macAndCiphertext.length <= CIPHER_MAC_SIZE) return null;
  const ct = macAndCiphertext.subarray(CIPHER_MAC_SIZE);
  if (ct.length % CIPHER_BLOCK_SIZE !== 0) return null;
  const s = normalizeSecret(secret);
  const mac = await computeMac(s, ct);
  if (!bytesEqual(mac, macAndCiphertext.subarray(0, CIPHER_MAC_SIZE))) return null;
  return aes128EcbDecrypt(s, ct);
}

// ---------------------------------------------------------------------------
// Ed25519
// ---------------------------------------------------------------------------

const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const X25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

export interface Ed25519KeyPair {
  /** 32-byte RFC 8032 seed (needed for WebCrypto signing; the firmware never stores it). */
  seed: Uint8Array;
  /** 32-byte public key. */
  publicKey: Uint8Array;
  /** 64-byte orlp/firmware expanded private key: clamp(SHA512(seed)[0..32]) ‖ SHA512(seed)[32..64]. */
  privateKey: Uint8Array;
}

/** orlp `ed25519_create_keypair` private-key expansion. */
export async function expandEd25519Seed(seed: Uint8Array): Promise<Uint8Array> {
  if (seed.length !== 32) throw new RangeError('Ed25519 seed must be 32 bytes');
  const h = await sha512(seed);
  h[0] = h[0]! & 248;
  h[31] = (h[31]! & 63) | 64;
  return h;
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function importEd25519Seed(seed: Uint8Array, extractable: boolean): Promise<CryptoKey> {
  if (seed.length !== 32) throw new RangeError('Ed25519 seed must be 32 bytes');
  return subtle().importKey('pkcs8', buf(concatBytes(ED25519_PKCS8_PREFIX, seed)), { name: 'Ed25519' }, extractable, [
    'sign',
  ]);
}

/** Derives the key pair (public key + firmware-format expanded private key) from a 32-byte seed. */
export async function ed25519KeyPairFromSeed(seed: Uint8Array): Promise<Ed25519KeyPair> {
  const key = await importEd25519Seed(seed, true);
  const jwk = await subtle().exportKey('jwk', key);
  if (typeof jwk.x !== 'string') throw new Error('Ed25519 JWK export lacks the public key');
  return { seed: seed.slice(), publicKey: base64UrlDecode(jwk.x), privateKey: await expandEd25519Seed(seed) };
}

/**
 * Generates a fresh identity for tests / emulated nodes. Like `LocalIdentity::validatePrivateKey`,
 * keys whose public key starts with 0x00 or 0xFF are rejected (reserved hash values) and retried.
 */
export async function generateEd25519KeyPair(): Promise<Ed25519KeyPair> {
  for (;;) {
    const seed = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const kp = await ed25519KeyPairFromSeed(seed);
    const first = kp.publicKey[0];
    if (first !== 0x00 && first !== 0xff) return kp;
  }
}

/** Ed25519 signature (64 bytes) of `message` using the 32-byte seed. */
export async function ed25519Sign(seed: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await importEd25519Seed(seed, false);
  return new Uint8Array(await subtle().sign({ name: 'Ed25519' }, key, buf(message)));
}

/** Verifies an Ed25519 signature. Returns false (never throws) for malformed keys/signatures. */
export async function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await subtle().importKey('raw', buf(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await subtle().verify({ name: 'Ed25519' }, key, buf(signature), buf(message));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// X25519 / ECDH (`ed25519_key_exchange`, `Identity::calcSharedSecret`). §2
// ---------------------------------------------------------------------------

const P = (1n << 255n) - 19n;

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let r = 1n;
  let b = base % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

function leToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

function bigIntToLe32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * Converts an Ed25519 public key to its X25519 (Montgomery u) form: u = (1 + y) / (1 − y) mod p,
 * y = the key with the sign bit cleared (orlp `fe_frombytes` ignores bit 255). y = 1 maps to 0 as
 * in the firmware (`fe_invert(0) = 0`).
 */
export function edwardsToMontgomery(edPublicKey: Uint8Array): Uint8Array {
  if (edPublicKey.length !== 32) throw new RangeError('Ed25519 public key must be 32 bytes');
  const yBytes = edPublicKey.slice();
  yBytes[31] = yBytes[31]! & 0x7f;
  const y = leToBigInt(yBytes) % P;
  const num = (1n + y) % P;
  const den = (1n - y + P) % P;
  const u = (num * modPow(den, P - 2n, P)) % P;
  return bigIntToLe32(u);
}

/** RFC 7748 X25519(scalar, u) via WebCrypto. The scalar is clamped. Throws on an all-zero result. */
export async function x25519(scalar: Uint8Array, u: Uint8Array): Promise<Uint8Array> {
  if (scalar.length < 32 || u.length !== 32) throw new RangeError('x25519: scalar and u must be 32 bytes');
  const k = scalar.slice(0, 32);
  k[0] = k[0]! & 248;
  k[31] = (k[31]! & 63) | 64;
  const s = subtle();
  const priv = await s.importKey('pkcs8', buf(concatBytes(X25519_PKCS8_PREFIX, k)), { name: 'X25519' }, false, [
    'deriveBits',
  ]);
  const pub = await s.importKey('raw', buf(u), { name: 'X25519' }, false, []);
  return new Uint8Array(await s.deriveBits({ name: 'X25519', public: pub }, priv, 256));
}

/**
 * The 32-byte peer shared secret, identical to the firmware's `ed25519_key_exchange(peerPub, prv)`:
 * X25519(clamp(privateKey[0..32]), edwardsToMontgomery(peerPublicKey)). `privateKey` is the 64-byte
 * expanded key (only the first 32 bytes are used). Symmetric between the two peers.
 */
export async function calcSharedSecret(privateKey: Uint8Array, peerPublicKey: Uint8Array): Promise<Uint8Array> {
  if (privateKey.length !== 64 && privateKey.length !== 32) {
    throw new RangeError('privateKey must be the 64-byte expanded key (or its 32-byte scalar half)');
  }
  return x25519(privateKey.subarray(0, 32), edwardsToMontgomery(peerPublicKey));
}

/** The X25519 base point u = 9, for deriving Montgomery public keys in tests. */
export const X25519_BASE_POINT: Uint8Array = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 9 : 0));
