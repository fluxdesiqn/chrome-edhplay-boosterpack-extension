import { describe, expect, it } from 'vitest';
import { DATA_VERSION, SET_DATA } from '@shared/packs/data';
import { poolsFor, rollPack, shuffleIntoPile, TEMPLATES, verifyPack } from '@shared/packs/roller';
import { makeRef, parseRef, SET_CODES, type CardRef, type PackCard, type SetCode } from '@shared/packs/types';

const seedOf = (i: number): string => i.toString(16).padStart(16, '0');

function cardOf(set: SetCode, ref: CardRef): PackCard {
  const { cn } = parseRef(ref)!;
  const data = SET_DATA[set];
  return (data.cards.find((c) => c.cn === cn) ?? data.basics?.find((c) => c.cn === cn)) as PackCard;
}

describe('roller', () => {
  it('is deterministic: same seed → identical pack', () => {
    for (const set of SET_CODES) {
      const a = rollPack(set, '0123456789abcdef');
      const b = rollPack(set, '0123456789abcdef');
      expect(a).toEqual(b);
      expect(a.set).toBe(set);
      expect(a.seed).toBe('0123456789abcdef');
      expect(a.dataVersion).toBe(DATA_VERSION);
      expect(a.cards).toHaveLength(TEMPLATES[set].slots.length);
    }
  });

  it('different seeds → different packs', () => {
    for (const set of SET_CODES) {
      const a = rollPack(set, '0123456789abcdef');
      const b = rollPack(set, '0123456789abcdee');
      expect(a.cards).not.toEqual(b.cards);
    }
  });

  it('never repeats a card inside a pack (10,000 packs per set)', () => {
    for (const set of SET_CODES) {
      for (let i = 0; i < 10_000; i++) {
        const cards = rollPack(set, seedOf(i)).cards;
        const seen = new Set<string>();
        for (const ref of cards) {
          if (seen.has(ref)) throw new Error(`${set} seed ${seedOf(i)} repeats ${ref}`);
          seen.add(ref);
        }
      }
    }
  });

  it('chk/bok/sok packs are 1 rare, 3 uncommons, 11 commons and never basics', () => {
    for (const set of ['chk', 'bok', 'sok'] as const) {
      for (let i = 0; i < 500; i++) {
        const cards = rollPack(set, seedOf(i)).cards.map((r) => cardOf(set, r));
        expect(cards.every(Boolean)).toBe(true);
        const count = (r: string) => cards.filter((c) => c.r === r).length;
        expect(count('r')).toBe(1);
        expect(count('u')).toBe(3);
        expect(count('c')).toBe(11);
        expect(count('m')).toBe(0);
        expect(cards[0]!.r).toBe('r');
        expect(cards.some((c) => c.t.startsWith('Basic Land'))).toBe(false);
      }
    }
  });

  it('neo packs follow the template slot structure', () => {
    const pools = poolsFor('neo');
    const landSlot = new Set([...pools.duals, ...pools.basics].map((c) => c.cn));
    for (let i = 0; i < 2000; i++) {
      const cards = rollPack('neo', seedOf(i)).cards.map((r) => cardOf('neo', r));
      expect(cards).toHaveLength(15);
      const first = cards[0]!;
      expect(first.r === 'r' || first.r === 'm').toBe(true);
      const nonLand = cards.slice(0, 14);
      expect(nonLand.filter((c) => c.r === 'r' || c.r === 'm')).toHaveLength(1);
      const u = nonLand.filter((c) => c.r === 'u').length;
      const c = nonLand.filter((c) => c.r === 'c').length;
      expect(u === 3 || u === 4).toBe(true);
      expect(c === 9 || c === 10).toBe(true);
      expect(u + c).toBe(13);
      // basics only ever appear in the land slot
      expect(nonLand.some((x) => x.t.startsWith('Basic Land'))).toBe(false);
      expect(landSlot.has(cards[14]!.cn)).toBe(true);
    }
  });

  it('neo odds over 20,000 packs match the template', () => {
    const pools = poolsFor('neo');
    const duals = new Set(pools.duals.map((c) => c.cn));
    const rares = new Set(pools.rare.map((c) => c.cn));
    const N = 20_000;
    let mythic = 0;
    let flexU = 0;
    let dual = 0;
    for (let i = 0; i < N; i++) {
      const cards = rollPack('neo', seedOf(i)).cards.map((r) => cardOf('neo', r));
      const first = cards[0]!;
      if (first.r === 'm') mythic++;
      else rares.delete(first.cn);
      if (cards[13]!.r === 'u') flexU++;
      if (duals.has(cards[14]!.cn)) dual++;
    }
    expect(mythic / N).toBeGreaterThan(0.115);
    expect(mythic / N).toBeLessThan(0.155);
    expect(flexU / N).toBeGreaterThan(0.30);
    expect(flexU / N).toBeLessThan(0.36);
    expect(dual / N).toBeGreaterThan(0.47);
    expect(dual / N).toBeLessThan(0.53);
    expect(rares.size).toBe(0); // every neo rare appeared at least once
  });

  it('shuffleIntoPile is a deterministic permutation of pile + pack', () => {
    const pile: CardRef[] = ['chk:1', 'chk:2', 'chk:3'];
    const pack = rollPack('neo', '0123456789abcdef').cards;
    const a = shuffleIntoPile(pile, pack, '0123456789abcdef');
    const b = shuffleIntoPile(pile, pack, '0123456789abcdef');
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([...pile, ...pack].sort());
    expect(pile).toEqual(['chk:1', 'chk:2', 'chk:3']);
    expect(shuffleIntoPile(pile, pack, '0123456789abcdee')).not.toEqual(a);
  });

  it('verifyPack accepts honest packs, rejects tampered ones, ignores foreign data versions', () => {
    const pack = rollPack('sok', 'feedfacecafebeef');
    expect(verifyPack(pack)).toBe(true);
    const tampered = { ...pack, cards: [...pack.cards] };
    tampered.cards[0] = makeRef('sok', '999');
    expect(verifyPack(tampered)).toBe(false);
    expect(verifyPack({ ...tampered, dataVersion: 'ffffffff' })).toBe(true);
  });

  // Golden snapshots generated once from the pinned RNG + data. If these change,
  // packs rolled by older clients will no longer verify: bump DATA_VERSION knowingly.
  it('golden snapshots', () => {
    const GOLDEN: Record<SetCode, Record<string, string[]>> = {
      chk: {
        '0000000000000001': ['chk:41', 'chk:93', 'chk:119', 'chk:63', 'chk:161', 'chk:191', 'chk:84', 'chk:68', 'chk:130', 'chk:53', 'chk:20', 'chk:55', 'chk:227', 'chk:199', 'chk:96'],
        '0123456789abcdef': ['chk:180', 'chk:93', 'chk:113', 'chk:36', 'chk:55', 'chk:225', 'chk:234', 'chk:32', 'chk:27', 'chk:168', 'chk:218', 'chk:68', 'chk:38', 'chk:224', 'chk:96'],
        feedfacecafebeef: ['chk:193', 'chk:22', 'chk:247', 'chk:245', 'chk:168', 'chk:174', 'chk:101', 'chk:106', 'chk:156', 'chk:240', 'chk:163', 'chk:16', 'chk:188', 'chk:27', 'chk:164'],
      },
      bok: {
        '0000000000000001': ['bok:18', 'bok:53', 'bok:69', 'bok:36', 'bok:95', 'bok:111', 'bok:51', 'bok:44', 'bok:76', 'bok:29', 'bok:11', 'bok:42', 'bok:140', 'bok:123', 'bok:59'],
        '0123456789abcdef': ['bok:96', 'bok:53', 'bok:66', 'bok:20', 'bok:42', 'bok:140', 'bok:143', 'bok:23', 'bok:22', 'bok:102', 'bok:128', 'bok:46', 'bok:24', 'bok:139', 'bok:59'],
        feedfacecafebeef: ['bok:107', 'bok:12', 'bok:135', 'bok:134', 'bok:102', 'bok:106', 'bok:59', 'bok:62', 'bok:91', 'bok:149', 'bok:98', 'bok:11', 'bok:109', 'bok:22', 'bok:95'],
      },
      sok: {
        '0000000000000001': ['sok:24', 'sok:56', 'sok:69', 'sok:43', 'sok:93', 'sok:112', 'sok:47', 'sok:38', 'sok:74', 'sok:30', 'sok:15', 'sok:33', 'sok:139', 'sok:127', 'sok:57'],
        '0123456789abcdef': ['sok:91', 'sok:56', 'sok:68', 'sok:12', 'sok:33', 'sok:139', 'sok:141', 'sok:22', 'sok:20', 'sok:105', 'sok:130', 'sok:40', 'sok:28', 'sok:137', 'sok:57'],
        feedfacecafebeef: ['sok:104', 'sok:10', 'sok:135', 'sok:134', 'sok:105', 'sok:109', 'sok:57', 'sok:64', 'sok:92', 'sok:144', 'sok:94', 'sok:15', 'sok:111', 'sok:20', 'sok:93'],
      },
      neo: {
        '0000000000000001': ['neo:102', 'neo:109', 'neo:52', 'neo:177', 'neo:190', 'neo:91', 'neo:72', 'neo:132', 'neo:64', 'neo:20', 'neo:67', 'neo:261', 'neo:205', 'neo:248', 'neo:282'],
        '0123456789abcdef': ['neo:111', 'neo:98', 'neo:37', 'neo:53', 'neo:259', 'neo:267', 'neo:38', 'neo:33', 'neo:179', 'neo:251', 'neo:71', 'neo:41', 'neo:258', 'neo:32', 'neo:282'],
        feedfacecafebeef: ['neo:25', 'neo:231', 'neo:229', 'neo:192', 'neo:183', 'neo:112', 'neo:119', 'neo:167', 'neo:279', 'neo:173', 'neo:19', 'neo:188', 'neo:33', 'neo:22', 'neo:274'],
      },
    };
    for (const set of SET_CODES) {
      for (const [seed, cards] of Object.entries(GOLDEN[set])) {
        expect(rollPack(set, seed).cards).toEqual(cards);
      }
    }
  });
});
