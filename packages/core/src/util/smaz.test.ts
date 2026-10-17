/**
 * SMAZ byte-exact vectors. Layout (feature-inventory.md §2.4a, MeshCore Open
 * lib/helpers/smaz.dart): bytes 0..253 = codebook index, 254 b = one verbatim byte,
 * 255 n b0..bn = n+1 verbatim bytes; envelope = "s:" + base64(stream), only when shorter.
 */
import { describe, expect, it } from 'vitest';
import { utf8Encode } from './bytes.js';
import {
  SMAZ_CODEBOOK,
  smazCompress,
  smazCompressBytes,
  smazDecompress,
  smazDecompressBytes,
  smazEncodeIfSmaller,
  smazSizes,
  smazTryDecode,
} from './smaz.js';

const b = (...xs: number[]) => Uint8Array.from(xs);

describe('SMAZ codebook', () => {
  it('is the 254-entry antirez table MeshCore Open uses', () => {
    expect(SMAZ_CODEBOOK).toHaveLength(254);
    expect(new Set(SMAZ_CODEBOOK).size).toBe(254);
    expect(SMAZ_CODEBOOK.slice(0, 5)).toEqual([' ', 'the', 'e', 't', 'a']);
    expect(SMAZ_CODEBOOK[67]).toBe('http://');
    expect(SMAZ_CODEBOOK[76]).toBe('his');
    expect(SMAZ_CODEBOOK[253]).toBe('.com');
    expect(Math.max(...SMAZ_CODEBOOK.map((s) => s.length))).toBe(7);
  });
});

describe('smazCompress / smazDecompress', () => {
  const vectors: Array<[string, number[]]> = [
    // antirez's README example: 22 → 11 bytes (50%)
    ['This is a small string', [254, 0x54, 76, 56, 172, 62, 173, 152, 62, 195, 70]],
    // "h", then the 2 UTF-8 bytes of é as a verbatim run, "ll", "o"
    ['héllo', [18, 255, 1, 0xc3, 0xa9, 152, 6]],
    ['QQq', [255, 2, 0x51, 0x51, 0x71]],
    ['Hello world', [254, 0x48, 178, 22, 96, 65, 42, 22, 24]],
    ['ok', [6, 254, 0x6b]],
    ['Meet at the station at 10', [254, 0x4d, 235, 35, 135, 1, 62, 200, 141, 41, 135, 255, 1, 0x31, 0x30]],
    ['', []],
  ];
  for (const [text, bytes] of vectors) {
    it(`${JSON.stringify(text)}`, () => {
      expect([...smazCompress(text)]).toEqual(bytes);
      expect(smazDecompress(b(...bytes))).toBe(text);
    });
  }

  it('splits verbatim runs at 256 bytes', () => {
    const input = new Uint8Array(300).fill(0x51); // 'Q' is not in the codebook
    const out = smazCompressBytes(input);
    expect(out.length).toBe(2 + 256 + 2 + 44);
    expect([out[0], out[1]]).toEqual([255, 255]);
    expect([out[258], out[259]]).toEqual([255, 43]);
    expect([...smazDecompressBytes(out)]).toEqual([...input]);
  });

  it('round-trips arbitrary bytes', () => {
    const input = Uint8Array.from({ length: 512 }, (_, i) => (i * 37 + 11) & 0xff);
    expect([...smazDecompressBytes(smazCompressBytes(input))]).toEqual([...input]);
  });

  it('rejects malformed streams', () => {
    expect(() => smazDecompressBytes(b(254))).toThrow(/verbatim byte/);
    expect(() => smazDecompressBytes(b(255))).toThrow(/verbatim length/);
    expect(() => smazDecompressBytes(b(255, 3, 1, 2))).toThrow(/verbatim run/);
    expect(() => smazDecompress(b(254, 0xff))).toThrow(); // not UTF-8
  });
});

describe('"s:" envelope', () => {
  it('encodes only when shorter', () => {
    expect(smazEncodeIfSmaller('This is a small string')).toBe('s:/lRMOKw+rZg+w0Y=');
    expect(smazEncodeIfSmaller('the quick brown fox jumps over the lazy dog')).toBe('s:AQD+cSaD/mtec0Ep3PoA/momLTyV5w0LidtHGAY7');
    expect(smazEncodeIfSmaller('Hello world')).toBe('Hello world'); // 14 ≥ 11
    expect(smazEncodeIfSmaller('héllo')).toBe('héllo');
    expect(smazEncodeIfSmaller('')).toBe('');
    // already looks like an envelope: never double-encoded
    const s = 's:the the the the the the the the';
    expect(smazEncodeIfSmaller(s)).toBe(s);
  });

  it('decodes canonical envelopes (what MeshCore Open and we send)', () => {
    expect(smazTryDecode('s:/lRMOKw+rZg+w0Y=')).toBe('This is a small string');
    expect(smazTryDecode('s:AQD+cSaD/mtec0Ep3PoA/momLTyV5w0LidtHGAY7')).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('rejects non-canonical envelopes (stricter than MeshCore Open)', () => {
    // leading whitespace, base64url, missing padding, embedded / trailing whitespace
    expect(smazTryDecode('  s:/lRMOKw+rZg+w0Y=')).toBeNull();
    expect(smazTryDecode('s:_lRMOKw-rZg-w0Y=')).toBeNull();
    expect(smazTryDecode('s:/lRMOKw+rZg+w0Y')).toBeNull();
    expect(smazTryDecode('s:/lRMOKw+rZg+w0Y= ')).toBeNull();
    expect(smazTryDecode('s:/lRMOKw+ rZg+w0Y=')).toBeNull();
    // words whose length is not a multiple of 4 are never canonical base64
    for (const w of ['abc', 'xpv', 'hello', 'shower', 'message', 'yesterday', 'everything']) {
      expect(smazTryDecode(`s:${w}`)).toBeNull();
    }
  });

  it('residual false positives: "s:" + a 4/8/12-letter word can still look canonical', () => {
    // valid base64 (no padding needed) of a stream the compressor reproduces, shorter than its text;
    // indistinguishable from a real envelope (~64% of random 4-letter, ~80% of 8-letter words)
    expect(smazTryDecode('s:note')).toBe('e\r\nne b');
    expect(smazTryDecode('s:home')).toBe('d tlae\r\n');
    expect(smazTryDecode('s:nice')).toBe('e\r\natd ');
    expect(smazTryDecode('s:yeah')).toBe(' ha>< co');
  });

  it('leaves plain text that merely starts with "s:" alone', () => {
    // "test" is valid base64 → b5 eb 2d → "e seem", but the 6-char envelope is not shorter
    expect(smazTryDecode('s:test')).toBeNull();
    expect(smazTryDecode('s:')).toBeNull();
    expect(smazTryDecode('s: hello there')).toBeNull(); // not base64
    expect(smazTryDecode('hello')).toBeNull();
    // valid stream, but the encoder would have produced different bytes (two single verbatims)
    expect(smazTryDecode(`s:${btoa(String.fromCharCode(254, 0x51, 254, 0x51, 254, 0x51, 254, 0x51, 254, 0x51, 254, 0x51))}`)).toBeNull();
    // decodes to invalid UTF-8
    expect(smazTryDecode(`s:${btoa(String.fromCharCode(255, 9, ...new Array<number>(10).fill(0xff)))}`)).toBeNull();
  });

  it('round-trips through the envelope', () => {
    for (const t of ['Meet at the station at 10', 'the weather is fine here, over', 'ok see you there at the ring road']) {
      const e = smazEncodeIfSmaller(t);
      expect(e.startsWith('s:')).toBe(true);
      expect(utf8Encode(e).length).toBeLessThan(utf8Encode(t).length);
      expect(smazTryDecode(e)).toBe(t);
    }
  });

  it('smazSizes reports plain and on-air UTF-8 sizes', () => {
    const t = 'the weather is fine here, over';
    expect(smazSizes(t)).toEqual({ plain: t.length, compressed: smazEncodeIfSmaller(t).length });
    expect(smazSizes(t).compressed).toBeLessThan(t.length);
    // not worth compressing: both sizes are the plain UTF-8 size
    expect(smazSizes('é')).toEqual({ plain: 2, compressed: 2 });
  });
});
