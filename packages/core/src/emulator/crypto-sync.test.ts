import { describe, expect, it } from 'vitest';
import { fromHex, toHex, utf8Encode } from '../util/bytes.js';
import {
  calcSharedSecret,
  ed25519KeyPairFromSeed,
  ed25519Sign,
  ed25519Verify,
  encryptThenMac,
  hmacSha256,
  macThenDecrypt,
  sha256,
  sha512,
} from '../packet/crypto.js';
import { calcTransportCode, packetHash } from '../packet/packet.js';
import { channelHash, computeAckCode } from '../packet/payloads.js';
import {
  ackCodeSync,
  calcSharedSecretSync,
  channelHashSync,
  ed25519KeyPairFromSeedSync,
  ed25519PublicKeySync,
  ed25519SignExpanded,
  ed25519VerifySync,
  encryptThenMacSync,
  hmacSha256Sync,
  macThenDecryptSync,
  packetHashSync,
  sha256Sync,
  sha512Sync,
  transportCodeSync,
} from './crypto-sync.js';
import { readU32LE } from '../util/bytes.js';

const bytes = (n: number, f: (i: number) => number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xff);

describe('sync hashes (FIPS 180-4 vectors, and equal to packet/crypto)', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ])('sha256 %j', (msg, digest) => {
    expect(toHex(sha256Sync(utf8Encode(msg)))).toBe(digest);
  });

  it('sha512 "abc" and padding boundaries agree with WebCrypto', async () => {
    expect(toHex(sha512Sync(utf8Encode('abc')))).toBe(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    );
    for (const n of [0, 1, 55, 56, 63, 64, 111, 112, 127, 128, 129, 300]) {
      const b = bytes(n, (i) => i * 7 + 3);
      expect(sha256Sync(b.subarray(0, n >> 1), b.subarray(n >> 1))).toEqual(await sha256(b));
      expect(sha512Sync(b)).toEqual(await sha512(b));
    }
  });

  it('HMAC-SHA256 equals WebCrypto (16-, 32- and 80-byte keys)', async () => {
    for (const k of [bytes(16, (i) => i), bytes(32, (i) => 255 - i), bytes(80, (i) => i * 3)]) {
      const m = utf8Encode('The quick brown fox');
      expect(hmacSha256Sync(k, m)).toEqual(await hmacSha256(k, m));
    }
  });
});

describe('sync Ed25519 / X25519', () => {
  // RFC 8032 §7.1 test 1
  const SEED = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  const PUB = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
  const SIG =
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

  it('RFC 8032 test 1: key, signature, verification', () => {
    const kp = ed25519KeyPairFromSeedSync(SEED);
    expect(toHex(kp.publicKey)).toBe(PUB);
    expect(toHex(ed25519PublicKeySync(kp.privateKey))).toBe(PUB);
    const sig = ed25519SignExpanded(kp.privateKey, kp.publicKey, new Uint8Array(0));
    expect(toHex(sig)).toBe(SIG);
    expect(ed25519VerifySync(kp.publicKey, new Uint8Array(0), sig)).toBe(true);
    const bad = sig.slice();
    bad[3] = bad[3]! ^ 1;
    expect(ed25519VerifySync(kp.publicKey, new Uint8Array(0), bad)).toBe(false);
    expect(ed25519VerifySync(new Uint8Array(32).fill(0xff), new Uint8Array(0), sig)).toBe(false);
  });

  it('matches packet/crypto (WebCrypto) for keys, signatures and verification', async () => {
    for (let n = 1; n <= 3; n++) {
      const seed = bytes(32, (i) => i * n + 11);
      const a = await ed25519KeyPairFromSeed(seed);
      const s = ed25519KeyPairFromSeedSync(seed);
      expect(s.publicKey).toEqual(a.publicKey);
      expect(s.privateKey).toEqual(a.privateKey);
      const msg = utf8Encode(`message ${n}`);
      const sig = ed25519SignExpanded(s.privateKey, s.publicKey, msg);
      expect(sig).toEqual(await ed25519Sign(seed, msg));
      expect(await ed25519Verify(a.publicKey, msg, sig)).toBe(true);
    }
  });

  it('ECDH secret equals packet/crypto calcSharedSecret and is symmetric', async () => {
    const a = ed25519KeyPairFromSeedSync(bytes(32, (i) => i + 1));
    const b = ed25519KeyPairFromSeedSync(bytes(32, (i) => 200 - i));
    const ab = calcSharedSecretSync(a.privateKey, b.publicKey);
    expect(ab).toEqual(calcSharedSecretSync(b.privateKey, a.publicKey));
    expect(ab).toEqual(await calcSharedSecret(a.privateKey, b.publicKey));
  });
});

describe('sync MeshCore helpers equal their packet/ counterparts', () => {
  it('encrypt-then-MAC / MAC-then-decrypt', async () => {
    const secret = bytes(32, (i) => i * 5);
    const pt = utf8Encode('hello mesh, this is longer than a block');
    const ct = encryptThenMacSync(secret, pt);
    expect(ct).toEqual(await encryptThenMac(secret, pt));
    expect(macThenDecryptSync(secret, ct)).toEqual(await macThenDecrypt(secret, ct));
    const bad = ct.slice();
    bad[0] = bad[0]! ^ 1;
    expect(macThenDecryptSync(secret, bad)).toBeNull();
  });

  it('packet hash (incl. TRACE path_len), channel hash, transport code, ack code', async () => {
    const payload = utf8Encode('payload bytes');
    for (const p of [{ payloadType: 2, pathLen: 3, payload }, { payloadType: 9, pathLen: 2, payload }]) {
      expect(packetHashSync(p)).toEqual(await packetHash(p));
    }
    const psk = fromHex('8b3387e9c5cdea6ac9e5edbaa115cd72');
    expect(channelHashSync(psk)).toBe(await channelHash(psk));
    const key = bytes(16, (i) => i);
    expect(transportCodeSync(key, 5, payload)).toBe(await calcTransportCode(key, 5, payload));
    const pub = bytes(32, (i) => i);
    expect(ackCodeSync(payload, pub)).toBe(readU32LE(await computeAckCode(payload, pub), 0));
  });
});
