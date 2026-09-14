/**
 * Deterministic PRNG for pack rolling: xoshiro128** seeded via splitmix32.
 *
 * Everything is integer-only (`Math.imul`, `>>> 0`) so the same seed yields the
 * same stream in every JS engine (main world, content script, background, tests).
 *
 * Seeding
 * -------
 * The canonical seed is a 64-bit hex string (16 hex chars). Shorter all-hex
 * strings are left-padded with zeros. Any other string (e.g. `seed + ':pile'`)
 * is folded to 64 bits with two chained FNV-1a 32-bit passes over its UTF-16
 * code units: `hi = fnv1a(s, 0x811c9dc5)`, `lo = fnv1a(s, hi ^ 0x9e3779b9)`.
 *
 * The 128-bit xoshiro state is then filled from splitmix32: `s0, s1` come from
 * a splitmix32 stream started at `lo`; `s2, s3` from one started at `hi ^ s1`.
 */

export interface Rng {
  /** Uniform unsigned 32-bit integer. */
  nextU32(): number;
  /** Uniform integer in [0, nExclusive). Throws when nExclusive <= 0. */
  nextInt(nExclusive: number): number;
}

const HEX_RE = /^[0-9a-fA-F]{1,16}$/;

function fnv1a32(s: string, basis: number): number {
  let h = basis >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Fold any seed string to a (hi, lo) pair of u32s as documented above. */
export function seedWords(seedHex: string): { hi: number; lo: number } {
  if (HEX_RE.test(seedHex)) {
    const padded = seedHex.padStart(16, '0');
    return { hi: parseInt(padded.slice(0, 8), 16) >>> 0, lo: parseInt(padded.slice(8), 16) >>> 0 };
  }
  const hi = fnv1a32(seedHex, 0x811c9dc5);
  const lo = fnv1a32(seedHex, (hi ^ 0x9e3779b9) >>> 0);
  return { hi, lo };
}

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export function makeRng(seedHex: string): Rng {
  const { hi, lo } = seedWords(seedHex);
  const g1 = splitmix32(lo);
  let s0 = g1();
  let s1 = g1();
  const g2 = splitmix32((hi ^ s1) >>> 0);
  let s2 = g2();
  let s3 = g2();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1; // xoshiro must never sit at the all-zero state

  const nextU32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result;
  };

  return {
    nextU32,
    nextInt(nExclusive: number): number {
      if (!(nExclusive > 0)) throw new RangeError(`nextInt: n must be > 0, got ${nExclusive}`);
      return Math.floor((nextU32() / 4294967296) * nExclusive);
    },
  };
}

/** Fresh 64-bit seed as 16 lowercase hex chars from the platform CSPRNG. */
export function newSeed(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Fisher–Yates shuffle driven by `rng`; returns a new array, input untouched. */
export function fisherYates<T>(arr: readonly T[], rng: Rng): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i >= 1; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}
