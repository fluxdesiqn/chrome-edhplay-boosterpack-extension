import { describe, expect, it } from 'vitest';
import { fisherYates, makeRng, newSeed, seedWords } from '@shared/packs/rng';

describe('rng', () => {
  // Known-answer values. These pin the exact algorithm (splitmix32 → xoshiro128**)
  // and the seed folding rules: change them only when deliberately breaking every
  // previously rolled pack.
  it('produces the pinned xoshiro128** stream for a 16-hex seed', () => {
    const r = makeRng('0123456789abcdef');
    expect(Array.from({ length: 6 }, () => r.nextU32())).toEqual([
      2169725804, 1407350147, 1591691854, 541759292, 958392126, 3832307912,
    ]);
  });

  it('handles the all-zero seed (state is never all-zero)', () => {
    const r = makeRng('0000000000000000');
    expect(Array.from({ length: 6 }, () => r.nextU32())).toEqual([
      1789933344, 2821606771, 1908128739, 1027911806, 3517690183, 1289113063,
    ]);
  });

  it('left-pads short hex seeds', () => {
    expect(seedWords('ff')).toEqual({ hi: 0, lo: 255 });
    const a = makeRng('ff');
    const b = makeRng('00000000000000ff');
    expect(a.nextU32()).toBe(1148565251);
    expect(b.nextU32()).toBe(1148565251);
  });

  it('folds non-hex strings with FNV-1a (used for ":pile" suffixed seeds)', () => {
    expect(seedWords('deadbeef00000000:pile')).toEqual({ hi: 2317040197, lo: 2670120118 });
    const r = makeRng('deadbeef00000000:pile');
    expect(Array.from({ length: 6 }, () => r.nextU32())).toEqual([
      3518524476, 3050694595, 1484631852, 4227587339, 164685987, 909824474,
    ]);
  });

  it('nextInt is pinned and bounded', () => {
    const r = makeRng('0123456789abcdef');
    expect(Array.from({ length: 8 }, () => r.nextInt(52))).toEqual([26, 17, 19, 6, 11, 46, 48, 7]);
  });

  it('nextInt stays inside [0, n) over 1e5 draws and hits both ends', () => {
    const r = makeRng('a5a5a5a5a5a5a5a5');
    for (const n of [1, 2, 7, 74, 1000]) {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < 100_000; i++) {
        const v = r.nextInt(n);
        expect(Number.isInteger(v)).toBe(true);
        if (v < min) min = v;
        if (v > max) max = v;
      }
      expect(min).toBe(0);
      expect(max).toBe(n - 1);
    }
  });

  it('nextInt throws on n <= 0', () => {
    const r = makeRng('01');
    expect(() => r.nextInt(0)).toThrow(RangeError);
    expect(() => r.nextInt(-3)).toThrow(RangeError);
  });

  it('same seed → same stream; different seed → different stream', () => {
    const a = makeRng('cafebabe12345678');
    const b = makeRng('cafebabe12345678');
    const c = makeRng('cafebabe12345679');
    const sa = Array.from({ length: 16 }, () => a.nextU32());
    const sb = Array.from({ length: 16 }, () => b.nextU32());
    const sc = Array.from({ length: 16 }, () => c.nextU32());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
  });

  it('fisherYates returns a permutation and leaves the input alone', () => {
    const input = Array.from({ length: 200 }, (_, i) => i);
    const frozen = input.slice();
    const out = fisherYates(input, makeRng('0011223344556677'));
    expect(input).toEqual(frozen);
    expect(out).not.toBe(input);
    expect(out).toHaveLength(200);
    expect([...out].sort((x, y) => x - y)).toEqual(input);
    expect(out).not.toEqual(input); // astronomically unlikely to be identity
    // deterministic
    expect(fisherYates(input, makeRng('0011223344556677'))).toEqual(out);
  });

  it('newSeed yields 16 lowercase hex chars and varies', () => {
    const a = newSeed();
    const b = newSeed();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});
