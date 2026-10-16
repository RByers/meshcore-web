/** Random byte sources for the emulator. */

/** Fills `out` with random bytes. */
export type Rng = (out: Uint8Array) => void;

/** crypto.getRandomValues when available, else Math.random. */
export const defaultRng: Rng = (out) => {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) {
    for (let i = 0; i < out.length; i += 65536) c.getRandomValues(out.subarray(i, i + 65536));
    return;
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.floor(Math.random() * 256);
};

/** Deterministic PRNG (mulberry32) for reproducible tests. */
export function createSeededRng(seed: number): Rng {
  let a = seed >>> 0;
  return (out) => {
    for (let i = 0; i < out.length; i++) {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
    }
  };
}

export function randomBytes(rng: Rng, n: number): Uint8Array {
  const out = new Uint8Array(n);
  rng(out);
  return out;
}
