import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, toHex } from '../util/bytes.js';
import {
  MAX_FRAME_SIZE,
  SERIAL_MARKER_DEVICE_TO_HOST,
  SerialDeframer,
  encodeSerialFrame,
} from './serial-framer.js';

/** Deterministic PRNG so fuzz failures are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomBytes(rand: () => number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

const dev = (payload: Uint8Array) => encodeSerialFrame(payload, { marker: SERIAL_MARKER_DEVICE_TO_HOST });

describe('encodeSerialFrame (companion-protocol.md §1.1)', () => {
  it('host→device: "<" + u16le length + payload', () => {
    // CMD_DEVICE_QUERY (0x16) with app protocol version 3
    expect(toHex(encodeSerialFrame(fromHex('1603')))).toBe('3c02001603');
  });

  it('device→host marker ">" when requested', () => {
    expect(toHex(dev(fromHex('00')))).toBe('3e010000');
  });

  it('encodes a max-length (176) frame with length 0x00b0', () => {
    const f = encodeSerialFrame(new Uint8Array(MAX_FRAME_SIZE).fill(7));
    expect(f.length).toBe(179);
    expect(toHex(f.subarray(0, 3))).toBe('3cb000');
  });

  it('rejects empty and oversize frames', () => {
    expect(() => encodeSerialFrame(new Uint8Array(0))).toThrow(RangeError);
    expect(() => encodeSerialFrame(new Uint8Array(177))).toThrow(RangeError);
    expect(() => encodeSerialFrame(new Uint8Array(300), { maxFrameLength: 300 })).not.toThrow();
  });
});

describe('SerialDeframer', () => {
  it('decodes a single device→host frame', () => {
    const d = new SerialDeframer();
    expect(d.push(fromHex('3e03000102ff')).map(toHex)).toEqual(['0102ff']);
    expect(d.bufferedBytes).toBe(0);
  });

  it('decodes several frames in one chunk', () => {
    const d = new SerialDeframer();
    const chunk = concatBytes(dev(fromHex('01')), dev(fromHex('0203')), dev(fromHex('040506')));
    expect(d.push(chunk).map(toHex)).toEqual(['01', '0203', '040506']);
  });

  it('handles byte-at-a-time delivery including split headers', () => {
    const d = new SerialDeframer();
    const bytes = concatBytes(dev(fromHex('aabbcc')), dev(fromHex('dd')));
    const out: string[] = [];
    for (const b of bytes) out.push(...d.push(Uint8Array.of(b)).map(toHex));
    expect(out).toEqual(['aabbcc', 'dd']);
  });

  it('ignores host→device "<" frames by default (e.g. echo) but accepts them when configured', () => {
    const host = encodeSerialFrame(fromHex('0102'));
    expect(new SerialDeframer().push(host)).toEqual([]);
    const deviceSide = new SerialDeframer({ markers: [0x3c] });
    expect(deviceSide.push(host).map(toHex)).toEqual(['0102']);
  });

  it('skips leading garbage and noise between frames', () => {
    const d = new SerialDeframer();
    const noise = new TextEncoder().encode('boot log\r\nhello');
    const chunk = concatBytes(noise, dev(fromHex('05')), fromHex('00ff1234'), dev(fromHex('0607')));
    expect(d.push(chunk).map(toHex)).toEqual(['05', '0607']);
    expect(d.stats.skippedBytes).toBe(noise.length + 4);
  });

  it('resyncs after a stray marker with a zero or oversize length', () => {
    const d = new SerialDeframer();
    // '>' 00 00 (N=0), '>' ff ff (N=65535), then a real frame
    const chunk = concatBytes(fromHex('3e0000'), fromHex('3effff'), dev(fromHex('0a0b')));
    expect(d.push(chunk).map(toHex)).toEqual(['0a0b']);
    expect(d.stats.badHeaders).toBe(2);
  });

  it('enforces maxFrameLength (177 rejected, 176 accepted)', () => {
    const d = new SerialDeframer();
    const tooBig = concatBytes(fromHex('3eb100'), new Uint8Array(177).fill(1));
    expect(d.push(tooBig)).toEqual([]);
    const ok = new Uint8Array(176).fill(2);
    expect(d.push(dev(ok))).toEqual([ok]);
    const small = new SerialDeframer({ maxFrameLength: 4 });
    expect(small.push(concatBytes(fromHex('3e0500'), new Uint8Array(5), dev(fromHex('0102'))))).toEqual([
      fromHex('0102'),
    ]);
  });

  it('a stray marker in noise that looks like a valid header delays but does not lose later frames', () => {
    // '>' 02 00 claims a 2-byte payload; it swallows two bytes of what follows. The real frame
    // after it must still be found because only well-formed bytes are consumed.
    const d = new SerialDeframer();
    const out = d.push(concatBytes(fromHex('3e0200aabb'), dev(fromHex('cc'))));
    expect(out.map(toHex)).toEqual(['aabb', 'cc']);
  });

  it('keeps a partial frame across pushes and reset() drops it', () => {
    const d = new SerialDeframer();
    expect(d.push(fromHex('3e0400aabb'))).toEqual([]);
    expect(d.bufferedBytes).toBe(5);
    d.reset();
    expect(d.bufferedBytes).toBe(0);
    expect(d.push(dev(fromHex('01'))).map(toHex)).toEqual(['01']);
  });

  it('returned frames are independent copies', () => {
    const d = new SerialDeframer();
    const [a] = d.push(dev(fromHex('0102')));
    d.push(dev(fromHex('0304')));
    expect(toHex(a!)).toBe('0102');
  });

  it('fuzz: random frames with random noise and random chunk boundaries', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      const expected: Uint8Array[] = [];
      const parts: Uint8Array[] = [];
      const count = 1 + Math.floor(rand() * 20);
      for (let i = 0; i < count; i++) {
        if (rand() < 0.3) {
          // Noise that never contains the marker, so it cannot fake a header.
          const noise = randomBytes(rand, Math.floor(rand() * 10)).map((b) => (b === 0x3e ? 0x00 : b));
          parts.push(noise);
        }
        const payload = randomBytes(rand, 1 + Math.floor(rand() * MAX_FRAME_SIZE));
        expected.push(payload);
        parts.push(dev(payload));
      }
      const stream = concatBytes(...parts);
      const d = new SerialDeframer();
      const got: Uint8Array[] = [];
      let off = 0;
      while (off < stream.length) {
        const size = 1 + Math.floor(rand() * 400);
        got.push(...d.push(stream.subarray(off, off + size)));
        off += size;
      }
      expect(got.map(toHex), `seed ${seed}`).toEqual(expected.map(toHex));
      expect(d.bufferedBytes).toBe(0);
    }
  });

  it('fuzz: arbitrary random input never throws and never yields an invalid-length frame', () => {
    const rand = rng(99);
    const d = new SerialDeframer();
    for (let i = 0; i < 500; i++) {
      for (const f of d.push(randomBytes(rand, Math.floor(rand() * 64)))) {
        expect(f.length).toBeGreaterThan(0);
        expect(f.length).toBeLessThanOrEqual(MAX_FRAME_SIZE);
      }
      expect(d.bufferedBytes).toBeLessThanOrEqual(MAX_FRAME_SIZE + 3);
    }
  });
});
