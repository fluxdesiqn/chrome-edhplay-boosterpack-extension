import { describe, expect, it } from 'vitest';
import {
  HELLO_TRAILER,
  chunkMapPairs,
  decodeSync,
  encodeSync,
  isSyncLine,
  syncMajorVersion,
} from '@shared/sync/codec';
import { SYNC_MAX_CHARS, SYNC_PREFIX } from '@shared/sync/types';
import type { SyncMessage } from '@shared/sync/types';
import type { CardRef } from '@shared/packs/types';

const uuid = (i: number) => `0000${i.toString(16).padStart(4, '0')}-1111-4222-8333-444444444444`;
const ref = (i: number) => `neo:${String(100 + i)}` as CardRef; // 7 chars

const samples: SyncMessage[] = [
  { t: 'hello', v: 1, n: '0.1.0', dv: 'abc123', role: 'p' },
  { t: 'state', ph: 'print-1', res: 12, pile: 30, act: 2, dv: 'abc123' },
  { t: 'state', ph: null, res: 0, pile: 0, act: 0, dv: 'abc123' },
  { t: 'pack', n: 1, set: 'neo', seed: 'seed-1', dv: 'abc123' },
  { t: 'map', m: [[uuid(1), ref(1)], [uuid(2), 'chk:12' as CardRef]] },
  { t: 'tok', m: [[uuid(3), 'sok:1' as CardRef]] },
  { t: 'need' },
  { t: 'need', from: 'player-9' },
];

describe('encodeSync / decodeSync', () => {
  it('round-trips every message type', () => {
    for (const msg of samples) {
      const line = encodeSync(msg);
      expect(line.startsWith(`${SYNC_PREFIX} {`)).toBe(true);
      expect(decodeSync(line)).toEqual(msg);
    }
  });

  it('decodes hello with the human-readable trailer', () => {
    const msg = samples[0]!;
    const line = encodeSync(msg, HELLO_TRAILER);
    expect(line.endsWith(HELLO_TRAILER)).toBe(true);
    expect(decodeSync(line)).toEqual(msg);
  });

  it('ignores trailing junk, including braces and quotes inside the trailer', () => {
    const msg = samples[3]!;
    const line = `${encodeSync(msg)} hey } { "unbalanced`;
    expect(decodeSync(line)).toEqual(msg);
  });

  it('handles escaped quotes and braces inside JSON strings', () => {
    const msg: SyncMessage = { t: 'need', from: 'we\\ird "}{" id' };
    expect(decodeSync(encodeSync(msg))).toEqual(msg);
  });

  it('returns null for malformed JSON', () => {
    expect(decodeSync(`${SYNC_PREFIX} {"t":"need",`)).toBeNull();
    expect(decodeSync(`${SYNC_PREFIX} {t:'need'}`)).toBeNull();
    expect(decodeSync(`${SYNC_PREFIX} no json here`)).toBeNull();
    expect(decodeSync('hello world')).toBeNull();
  });

  it('returns null for unknown t and bad shapes', () => {
    expect(decodeSync(`${SYNC_PREFIX} {"t":"bogus"}`)).toBeNull();
    expect(decodeSync(`${SYNC_PREFIX} {"t":"hello","v":2,"n":"x","dv":"y","role":"p"}`)).toBeNull();
    expect(decodeSync(`${SYNC_PREFIX} {"t":"hello","v":1,"n":"x","dv":"y","role":"z"}`)).toBeNull();
    expect(decodeSync(`${SYNC_PREFIX} {"t":"pack","n":1,"set":"not-a-set!","seed":"s","dv":"d"}`)).toBeNull();
    expect(decodeSync(`${SYNC_PREFIX} {"t":"pack","n":"1","set":"neo","seed":"s","dv":"d"}`)).toBeNull();
    expect(decodeSync(`${SYNC_PREFIX} {"t":"map","m":[["id","bad-ref"]]}`)).toBeNull();
    expect(decodeSync(`${SYNC_PREFIX} {"t":"map","m":[["id"]]}`)).toBeNull();
    expect(decodeSync(`${SYNC_PREFIX} {"t":"map","m":"nope"}`)).toBeNull();
    expect(decodeSync(`${SYNC_PREFIX} {"t":"state","ph":null,"res":"1","pile":0,"act":0,"dv":"d"}`)).toBeNull();
    expect(decodeSync(`${SYNC_PREFIX} {"t":"need","from":3}`)).toBeNull();
    expect(decodeSync(`${SYNC_PREFIX} []`)).toBeNull();
  });

  it('rejects other protocol versions but still flags them as sync lines', () => {
    const line = '[HoK2] {"t":"need"}';
    expect(decodeSync(line)).toBeNull();
    expect(isSyncLine(line)).toBe(true);
    expect(syncMajorVersion(line)).toBe(2);
    expect(syncMajorVersion('[HoK1] {"t":"need"}')).toBe(1);
    expect(syncMajorVersion('[HoK12]')).toBe(12);
    expect(syncMajorVersion('[HoK]')).toBeNull();
    expect(syncMajorVersion('gg')).toBeNull();
    expect(isSyncLine('gg')).toBe(false);
  });

  it('throws when the encoded line exceeds the chat limit', () => {
    const m: [string, CardRef][] = Array.from({ length: 12 }, (_, i) => [uuid(i), ref(i)]);
    expect(() => encodeSync({ t: 'map', m })).toThrow(/too long/);
    expect(() => encodeSync({ t: 'need' }, 'x'.repeat(SYNC_MAX_CHARS))).toThrow(/too long/);
  });
});

describe('chunkMapPairs', () => {
  it('8 pairs of 36-char uuids with 7-char refs fit in one line', () => {
    const m: [string, CardRef][] = Array.from({ length: 8 }, (_, i) => [uuid(i), ref(i)]);
    for (const [id, r] of m) {
      expect(id).toHaveLength(36);
      expect(r).toHaveLength(7);
    }
    const line = encodeSync({ t: 'map', m });
    expect(line.length).toBeLessThanOrEqual(SYNC_MAX_CHARS);
    expect(chunkMapPairs(m)).toEqual([m]);
  });

  it('splits 20 pairs into chunks of ≤8 that each encode ≤500 chars', () => {
    const m: [string, CardRef][] = Array.from({ length: 20 }, (_, i) => [uuid(i), ref(i)]);
    const chunks = chunkMapPairs(m);
    expect(chunks.map((c) => c.length)).toEqual([8, 8, 4]);
    expect(chunks.flat()).toEqual(m);
    for (const c of chunks) expect(encodeSync({ t: 'map', m: c }).length).toBeLessThanOrEqual(SYNC_MAX_CHARS);
  });

  it('shrinks chunks below maxPairs when ids are long', () => {
    const longId = (i: number) => `${'x'.repeat(120)}${i}`;
    const m: [string, CardRef][] = Array.from({ length: 8 }, (_, i) => [longId(i), ref(i)]);
    const chunks = chunkMapPairs(m);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(m);
    for (const c of chunks) expect(encodeSync({ t: 'map', m: c }).length).toBeLessThanOrEqual(SYNC_MAX_CHARS);
  });

  it('honours a custom maxPairs and returns [] for no pairs', () => {
    const m: [string, CardRef][] = Array.from({ length: 5 }, (_, i) => [uuid(i), ref(i)]);
    expect(chunkMapPairs(m, 2).map((c) => c.length)).toEqual([2, 2, 1]);
    expect(chunkMapPairs([])).toEqual([]);
  });
});
