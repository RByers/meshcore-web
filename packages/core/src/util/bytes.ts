/** Small byte-manipulation helpers built only on standard Web APIs. */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

const HEX = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length % 2 !== 0) {
    throw new Error(`fromHex: odd-length hex string (${clean.length})`);
  }
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error('fromHex: invalid hex character');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function readU16LE(bytes: Uint8Array, offset = 0): number {
  return view(bytes).getUint16(offset, true);
}

export function readU32LE(bytes: Uint8Array, offset = 0): number {
  return view(bytes).getUint32(offset, true);
}

export function writeU16LE(bytes: Uint8Array, offset: number, value: number): void {
  view(bytes).setUint16(offset, value, true);
}

export function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
  view(bytes).setUint32(offset, value >>> 0, true);
}

export function u16le(value: number): Uint8Array {
  const out = new Uint8Array(2);
  writeU16LE(out, 0, value);
  return out;
}

export function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  writeU32LE(out, 0, value);
  return out;
}

export function utf8Encode(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/** Decodes UTF-8, stopping at the first NUL byte (C-string style) if present. */
export function utf8Decode(bytes: Uint8Array, stopAtNul = false): string {
  let slice = bytes;
  if (stopAtNul) {
    const nul = bytes.indexOf(0);
    if (nul >= 0) slice = bytes.subarray(0, nul);
  }
  return textDecoder.decode(slice);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes standard or URL-safe base64 (padding optional); null if malformed. */
export function base64Decode(s: string): Uint8Array | null {
  const t = s.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(t) || t.length % 4 === 1) return null;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of t) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function base64Encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    s += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=';
    s += i + 2 < bytes.length ? B64[n & 63]! : '=';
  }
  return s;
}
