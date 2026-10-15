import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  bytesEqual,
  concatBytes,
  fromHex,
  readU16LE,
  readU32LE,
  toHex,
  u16le,
  u32le,
  utf8Decode,
  utf8Encode,
  writeU32LE,
} from './bytes.js';
import { VERSION } from '../index.js';

describe('bytes', () => {
  it('round-trips hex', () => {
    const b = new Uint8Array([0x00, 0x01, 0xab, 0xff]);
    expect(toHex(b)).toBe('0001abff');
    expect(bytesEqual(fromHex('0001ABFF'), b)).toBe(true);
    expect(bytesEqual(fromHex('0x0001abff'), b)).toBe(true);
  });

  it('rejects bad hex', () => {
    expect(() => fromHex('abc')).toThrow();
    expect(() => fromHex('zz')).toThrow();
  });

  it('concats and compares', () => {
    const c = concatBytes(new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2, 3]));
    expect(Array.from(c)).toEqual([1, 2, 3]);
    expect(bytesEqual(c, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(bytesEqual(c, new Uint8Array([1, 2]))).toBe(false);
    expect(bytesEqual(c, new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('reads and writes little-endian ints, honoring subarray offsets', () => {
    expect(Array.from(u16le(0x1234))).toEqual([0x34, 0x12]);
    expect(Array.from(u32le(0xdeadbeef))).toEqual([0xef, 0xbe, 0xad, 0xde]);
    const buf = new Uint8Array(8);
    const sub = buf.subarray(2);
    writeU32LE(sub, 1, 0x01020304);
    expect(Array.from(buf)).toEqual([0, 0, 0, 4, 3, 2, 1, 0]);
    expect(readU32LE(sub, 1)).toBe(0x01020304);
    expect(readU16LE(buf, 3)).toBe(0x0304);
  });

  it('encodes and decodes utf-8', () => {
    const b = utf8Encode('héllo');
    expect(b.length).toBe(6);
    expect(utf8Decode(b)).toBe('héllo');
    expect(utf8Decode(new Uint8Array([0x68, 0x69, 0, 0x7a]), true)).toBe('hi');
  });

  it('has a VERSION and IndexedDB is available via fake-indexeddb', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof indexedDB.open).toBe('function');
  });
});
