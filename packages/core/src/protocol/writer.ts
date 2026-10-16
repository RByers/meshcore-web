/**
 * Internal little-endian frame writer shared by the command encoder (encode.ts) and the
 * device-frame encoder (encode-frame.ts). Not exported from the package barrel.
 */

import { utf8Encode, writeU16LE, writeU32LE } from '../util/bytes.js';
import { MAX_FRAME_SIZE, MAX_NAME_LEN, MAX_NAME_SIZE, MAX_PATH_SIZE, PUB_KEY_SIZE, decodePathLen } from './constants.js';
import { ProtocolEncodeError } from './errors.js';
import type { ContactInput } from './types.js';

/** Growable little-endian byte writer. */
export class Writer {
  private buf = new Uint8Array(64);
  private len = 0;

  constructor(private readonly cmd: string) {}

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): this {
    this.int(v, 0, 0xff, 'u8');
    this.ensure(1);
    this.buf[this.len++] = v;
    return this;
  }

  i8(v: number): this {
    this.int(v, -128, 127, 'i8');
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.int(v, 0, 0xffff, 'u16');
    this.ensure(2);
    writeU16LE(this.buf, this.len, v);
    this.len += 2;
    return this;
  }

  i16(v: number): this {
    this.int(v, -0x8000, 0x7fff, 'i16');
    this.ensure(2);
    writeU16LE(this.buf, this.len, v & 0xffff);
    this.len += 2;
    return this;
  }

  u32(v: number): this {
    this.int(v, 0, 0xffffffff, 'u32');
    this.ensure(4);
    writeU32LE(this.buf, this.len, v);
    this.len += 4;
    return this;
  }

  i32(v: number): this {
    this.int(v, -0x80000000, 0x7fffffff, 'i32');
    this.ensure(4);
    writeU32LE(this.buf, this.len, v >>> 0);
    this.len += 4;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  zeros(n: number): this {
    this.ensure(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this;
  }

  /** Writes `b` into a fixed-size field, zero padding the rest. */
  fixed(b: Uint8Array, size: number, field: string): this {
    if (b.length > size) this.fail(`${field} is ${b.length} bytes, max ${size}`);
    this.bytes(b);
    return this.zeros(size - b.length);
  }

  finish(): Uint8Array {
    if (this.len > MAX_FRAME_SIZE) {
      this.fail(`frame is ${this.len} bytes, max ${MAX_FRAME_SIZE}`);
    }
    return this.buf.slice(0, this.len);
  }

  fail(msg: string): never {
    throw new ProtocolEncodeError(`${this.cmd}: ${msg}`, this.cmd);
  }

  private int(v: number, min: number, max: number, t: string): void {
    if (!Number.isInteger(v) || v < min || v > max) {
      this.fail(`value ${v} out of range for ${t}`);
    }
  }
}

export function needLen(w: Writer, b: Uint8Array, len: number, field: string): Uint8Array {
  if (b.length !== len) w.fail(`${field} must be ${len} bytes (got ${b.length})`);
  return b;
}

export function pubKey(w: Writer, b: Uint8Array): Uint8Array {
  return needLen(w, b, PUB_KEY_SIZE, 'pubKey');
}

/** UTF-8 name that must fit a NUL-terminated char[32] (≤ 31 bytes). */
export function nameBytes(w: Writer, name: string, field = 'name'): Uint8Array {
  const b = utf8Encode(name);
  if (b.length > MAX_NAME_LEN) w.fail(`${field} is ${b.length} bytes UTF-8, max ${MAX_NAME_LEN}`);
  if (b.includes(0)) w.fail(`${field} contains NUL`);
  return b;
}

export function degToMicro(deg: number): number {
  return Math.round(deg * 1e6);
}

/** Path bytes for an encoded path_len; checks the length matches. */
export function pathFor(w: Writer, pathLen: number, path: Uint8Array | undefined): Uint8Array {
  const info = decodePathLen(pathLen);
  const p = path ?? new Uint8Array(0);
  if (p.length !== info.byteLength) {
    w.fail(`path is ${p.length} bytes but path_len 0x${pathLen.toString(16)} implies ${info.byteLength}`);
  }
  return p;
}

/** Writes a contact record (§7.1) with the given code byte. */
export function writeContactRecord(w: Writer, code: number, c: ContactInput): void {
  w.u8(code).bytes(pubKey(w, c.pubKey)).u8(c.type).u8(c.flags).u8(c.outPathLen);
  w.fixed(c.outPath ?? new Uint8Array(0), MAX_PATH_SIZE, 'outPath');
  w.fixed(nameBytes(w, c.name), MAX_NAME_SIZE, 'name');
  w.u32(c.lastAdvert);
  const hasLoc = c.lat !== undefined || c.lon !== undefined;
  if (hasLoc || c.lastMod !== undefined) {
    w.i32(degToMicro(c.lat ?? 0)).i32(degToMicro(c.lon ?? 0));
    if (c.lastMod !== undefined) w.u32(c.lastMod);
  }
}
