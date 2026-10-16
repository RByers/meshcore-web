import { describe, expect, it } from 'vitest';
import { fromHex, toHex, utf8Encode } from '../util/bytes.js';
import {
  X25519_BASE_POINT,
  aes128DecryptBlock,
  aes128EcbDecrypt,
  aes128EcbEncrypt,
  aes128EncryptBlock,
  calcSharedSecret,
  computeMac,
  ed25519KeyPairFromSeed,
  ed25519Sign,
  ed25519Verify,
  edwardsToMontgomery,
  encryptThenMac,
  expandEd25519Seed,
  generateEd25519KeyPair,
  hmacSha256,
  macThenDecrypt,
  sha256,
  sha512,
  x25519,
} from './crypto.js';

describe('AES-128 (FIPS-197)', () => {
  it('Appendix C.1 example vector', () => {
    const key = fromHex('000102030405060708090a0b0c0d0e0f');
    const pt = fromHex('00112233445566778899aabbccddeeff');
    expect(toHex(aes128EncryptBlock(key, pt))).toBe('69c4e0d86a7b0430d8cdb78070b4c55a');
    expect(toHex(aes128DecryptBlock(key, fromHex('69c4e0d86a7b0430d8cdb78070b4c55a')))).toBe(toHex(pt));
  });

  it('Appendix B cipher example', () => {
    const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c');
    const pt = fromHex('3243f6a8885a308d313198a2e0370734');
    expect(toHex(aes128EncryptBlock(key, pt))).toBe('3925841d02dc09fbdc118597196a0b32');
  });

  it('uses only key[0..16] (secret is 32 bytes, Utils::encrypt CIPHER_KEY_SIZE)', () => {
    const key32 = fromHex('000102030405060708090a0b0c0d0e0f' + 'ff'.repeat(16));
    expect(toHex(aes128EncryptBlock(key32, fromHex('00112233445566778899aabbccddeeff')))).toBe(
      '69c4e0d86a7b0430d8cdb78070b4c55a',
    );
  });

  it('ECB zero-pads the final partial block only (Utils::encrypt)', () => {
    const key = fromHex('000102030405060708090a0b0c0d0e0f');
    expect(aes128EcbEncrypt(key, new Uint8Array(0)).length).toBe(0);
    expect(aes128EcbEncrypt(key, new Uint8Array(16)).length).toBe(16);
    const ct = aes128EcbEncrypt(key, fromHex('00112233445566778899aabbccddeeff' + 'aa'));
    expect(ct.length).toBe(32);
    expect(toHex(ct.subarray(0, 16))).toBe('69c4e0d86a7b0430d8cdb78070b4c55a');
    expect(toHex(aes128EcbDecrypt(key, ct))).toBe('00112233445566778899aabbccddeeff' + 'aa' + '00'.repeat(15));
    expect(() => aes128EcbDecrypt(key, new Uint8Array(15))).toThrow(RangeError);
  });

  it('matches an openssl aes-128-ecb vector (public channel PSK)', () => {
    const psk = fromHex('8b3387e9c5cdea6ac9e5edbaa115cd72');
    const pt = fromHex('00f1536500616c6963653a2068656c6c6f20776f726c64000000000000000000');
    expect(toHex(aes128EcbEncrypt(psk, pt))).toBe('48f4884524f1fdd7ead13790fca6e1ec5137e5c307f366ad713e36f60ca29221');
  });
});

describe('hashes', () => {
  it('sha256 known answers (FIPS 180-2)', async () => {
    expect(toHex(await sha256(new Uint8Array(0)))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(toHex(await sha256(utf8Encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(toHex(await sha256(utf8Encode('a'), utf8Encode('bc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('sha512("abc")', async () => {
    expect(toHex(await sha512(utf8Encode('abc')))).toBe(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    );
  });

  it('HMAC-SHA256 RFC 4231 test case 2', async () => {
    expect(toHex(await hmacSha256(utf8Encode('Jefe'), utf8Encode('what do ya want for nothing?')))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});

describe('encrypt-then-MAC (Utils::encryptThenMAC / MACThenDecrypt, mesh-packet-format.md §2)', () => {
  const psk = fromHex('8b3387e9c5cdea6ac9e5edbaa115cd72');
  const pt = fromHex('00f1536500616c6963653a2068656c6c6f20776f726c64');

  it('MAC = HMAC-SHA256(psk zero-padded to 32, ciphertext)[0..2] (openssl/python vector)', async () => {
    const out = await encryptThenMac(psk, pt);
    expect(toHex(out)).toBe('21d3' + '48f4884524f1fdd7ead13790fca6e1ec5137e5c307f366ad713e36f60ca29221');
    expect(toHex(await computeMac(psk, out.subarray(2)))).toBe('21d3');
  });

  it('round trip keeps the zero padding; tampering or misalignment → null', async () => {
    const secret = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    const out = await encryptThenMac(secret, utf8Encode('hi'));
    const dec = await macThenDecrypt(secret, out);
    expect(dec && toHex(dec)).toBe('6869' + '00'.repeat(14));
    const bad = out.slice();
    bad[5] = bad[5]! ^ 1;
    expect(await macThenDecrypt(secret, bad)).toBeNull();
    expect(await macThenDecrypt(secret, out.subarray(0, 2))).toBeNull();
    expect(await macThenDecrypt(secret, out.subarray(0, 17))).toBeNull();
    const wrongKey = secret.slice();
    wrongKey[31] = wrongKey[31]! ^ 1; // only in the HMAC half
    expect(await macThenDecrypt(wrongKey, out)).toBeNull();
  });
});

describe('Ed25519', () => {
  // RFC 8032 §7.1 TEST 1
  const seed = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  const pub = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
  const sig =
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

  it('RFC 8032 test 1: key from seed, sign, verify', async () => {
    const kp = await ed25519KeyPairFromSeed(seed);
    expect(toHex(kp.publicKey)).toBe(pub);
    expect(toHex(await ed25519Sign(seed, new Uint8Array(0)))).toBe(sig);
    expect(await ed25519Verify(kp.publicKey, new Uint8Array(0), fromHex(sig))).toBe(true);
    expect(await ed25519Verify(kp.publicKey, Uint8Array.of(1), fromHex(sig))).toBe(false);
    expect(await ed25519Verify(new Uint8Array(31), new Uint8Array(0), fromHex(sig))).toBe(false);
  });

  it('expanded private key = clamp(SHA512(seed)) (orlp ed25519_create_keypair)', async () => {
    const kp = await ed25519KeyPairFromSeed(seed);
    const h = await sha512(seed);
    expect(kp.privateKey.length).toBe(64);
    expect(kp.privateKey[0]).toBe(h[0]! & 248);
    expect(kp.privateKey[31]).toBe((h[31]! & 63) | 64);
    expect(toHex(kp.privateKey.subarray(32))).toBe(toHex(h.subarray(32)));
    expect(toHex(await expandEd25519Seed(seed))).toBe(toHex(kp.privateKey));
  });

  it('generated key pairs sign/verify round trip and avoid 00/FF prefixes', async () => {
    const kp = await generateEd25519KeyPair();
    expect(kp.publicKey[0]).not.toBe(0);
    expect(kp.publicKey[0]).not.toBe(0xff);
    const msg = utf8Encode('advert');
    const s = await ed25519Sign(kp.seed, msg);
    expect(await ed25519Verify(kp.publicKey, msg, s)).toBe(true);
  });
});

describe('X25519 / calcSharedSecret (ed25519_key_exchange)', () => {
  it('RFC 7748 §5.2 vector 1', async () => {
    const k = fromHex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4');
    const u = fromHex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c');
    expect(toHex(await x25519(k, u))).toBe('c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552');
  });

  it("firmware test client key pair (Identity.cpp validatePrivateKey): x25519(prv, 9) = mont(pub)", async () => {
    const prv = fromHex(
      '7065e18fd9fabb70c1ed90dca19907de698c88b709ea146eafd93d9b830c7b60c4681193c79bbc39945ba8064104bb618f8fd7a84a0af6f57033d6e8ddcd6471',
    );
    const pub = fromHex('1ec77175b0918ed206f9ae04ec136d6d5d4315bb26305427f645b492e9350c10');
    expect(toHex(await x25519(prv, X25519_BASE_POINT))).toBe(toHex(edwardsToMontgomery(pub)));
  });

  it('RFC 8032 key converts to the RFC 7748-derived Montgomery key', async () => {
    const kp = await ed25519KeyPairFromSeed(fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'));
    expect(toHex(edwardsToMontgomery(kp.publicKey))).toBe(toHex(await x25519(kp.privateKey, X25519_BASE_POINT)));
  });

  it('is symmetric between two generated identities', async () => {
    const a = await generateEd25519KeyPair();
    const b = await generateEd25519KeyPair();
    const ab = await calcSharedSecret(a.privateKey, b.publicKey);
    const ba = await calcSharedSecret(b.privateKey, a.publicKey);
    expect(ab.length).toBe(32);
    expect(toHex(ab)).toBe(toHex(ba));
    await expect(calcSharedSecret(new Uint8Array(10), b.publicKey)).rejects.toThrow(RangeError);
  });
});
