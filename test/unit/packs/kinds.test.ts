import { describe, expect, it } from 'vitest';
import { DATA_VERSION, SET_DATA } from '@shared/packs/data';
import { findCard, identityFor } from '@shared/packs/identity';
import { COLLECTOR_FOIL_SLOTS, PACK_SIZE, poolsFor, rollPack, rollPackOfKind, verifyPack } from '@shared/packs/roller';
import { AVAILABLE_PACKS, PACK_KINDS, SET_CODES, type CardRef, type PackCard, type PackKind, type RolledPack } from '@shared/packs/types';

const seedOf = (i: number): string => i.toString(16).padStart(16, '0');
const GOLDEN_SEEDS = ['0000000000000001', '0123456789abcdef', 'feedfacecafebeef'] as const;

const card = (ref: CardRef): PackCard => {
  const c = findCard(ref);
  if (!c) throw new Error(`unresolvable ref ${ref}`);
  return c;
};
const cardsOf = (pack: RolledPack): PackCard[] => pack.cards.map(card);
const isRM = (c: PackCard): boolean => c.r === 'r' || c.r === 'm';
const isCU = (c: PackCard): boolean => c.r === 'c' || c.r === 'u';
const isBasic = (c: PackCard): boolean => c.t.startsWith('Basic Land');

function expectWellFormed(pack: RolledPack, kind: PackKind): PackCard[] {
  expect(pack.set).toBe('neo');
  expect(pack.kind).toBe(kind);
  expect(pack.dataVersion).toBe(DATA_VERSION);
  expect(pack.cards).toHaveLength(PACK_SIZE[kind]);
  const cards = cardsOf(pack);
  const ids = new Set(cards.map((c) => c.id));
  expect(ids.size).toBe(cards.length);
  const names = new Set(cards.map((c) => c.name));
  expect(names.size).toBe(cards.length);
  for (const i of pack.foil) {
    expect(Number.isInteger(i)).toBe(true);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(cards.length);
  }
  expect(new Set(pack.foil).size).toBe(pack.foil.length);
  expect([...pack.foil].sort((a, b) => a - b)).toEqual(pack.foil);
  return cards;
}

describe('rollPackOfKind', () => {
  it('PACK_SIZE matches the products', () => {
    expect(PACK_SIZE).toEqual({ draft: 15, set: 12, collector: 15 });
  });

  it('only rolls kinds a set was sold in (AVAILABLE_PACKS)', () => {
    expect(() => rollPackOfKind('chk', 'collector', '0123456789abcdef')).toThrow(/chk has no collector/);
    expect(() => rollPackOfKind('bok', 'set', '0123456789abcdef')).toThrow();
    expect(() => rollPackOfKind('sok', 'collector', '0123456789abcdef')).toThrow();
    for (const set of SET_CODES) {
      for (const kind of PACK_KINDS) {
        if (AVAILABLE_PACKS[set].includes(kind)) {
          expect(rollPackOfKind(set, kind, '0123456789abcdef').cards).toHaveLength(PACK_SIZE[kind]);
        } else {
          expect(() => rollPackOfKind(set, kind, '0123456789abcdef')).toThrow();
        }
      }
    }
  });

  it('draft kind is byte-identical to rollPack', () => {
    for (const set of SET_CODES) {
      for (let i = 0; i < 50; i++) expect(rollPackOfKind(set, 'draft', seedOf(i))).toEqual(rollPack(set, seedOf(i)));
    }
  });

  it('exposes the variant sub-pools', () => {
    const pools = poolsFor('neo');
    const variants = SET_DATA.neo.variants!;
    expect(pools.variants).toBe(variants);
    expect(pools.variants.length).toBeGreaterThan(150);
    expect(pools.showcase.every((c) => c.v === 's')).toBe(true);
    expect(pools.extended.every((c) => c.v === 'e')).toBe(true);
    expect(pools.borderless.every((c) => c.v === 'b')).toBe(true);
    expect(pools.etched.every((c) => c.v === 'x')).toBe(true);
    expect(pools.showcase.length + pools.extended.length + pools.borderless.length + pools.etched.length).toBe(variants.length);
    expect(pools.etched.length).toBeGreaterThan(0);
    expect(pools.showcase.filter(isCU).length).toBeGreaterThan(10);
    // the regular draft pools ignore variants entirely
    expect([...pools.rare, ...pools.mythic, ...pools.uncommon, ...pools.common].some((c) => c.v)).toBe(false);
    for (const set of ['chk', 'bok', 'sok'] as const) expect(poolsFor(set).variants).toEqual([]);
  });
});

describe('NEO Set Booster', () => {
  const pools = poolsFor('neo');
  const landSlot = new Set([...pools.duals, ...pools.basics].map((c) => c.id));

  it('is deterministic and verifies', () => {
    const a = rollPackOfKind('neo', 'set', '0123456789abcdef');
    const b = rollPackOfKind('neo', 'set', '0123456789abcdef');
    expect(a).toEqual(b);
    expect(a.seed).toBe('0123456789abcdef');
    expect(verifyPack(a)).toBe(true);
    expect(rollPackOfKind('neo', 'set', '0123456789abcdee').cards).not.toEqual(a.cards);
    expect(rollPackOfKind('neo', 'draft', '0123456789abcdef').cards).not.toEqual(a.cards);
  });

  it('has 12 cards, land first, ≥1 rare/mythic, a showcase head-turner, no duplicates, resolvable refs', () => {
    for (let i = 0; i < 2000; i++) {
      const pack = rollPackOfKind('neo', 'set', seedOf(i));
      const cards = expectWellFormed(pack, 'set');
      expect(landSlot.has(cards[0]!.id)).toBe(true);
      expect(cards.slice(1).some(isBasic)).toBe(false);
      expect(cards.filter(isRM).length).toBeGreaterThanOrEqual(1);
      expect(cards.filter(isRM).length).toBeLessThanOrEqual(4);
      // 2–7 connected commons/uncommons, regular printings
      for (const c of cards.slice(1, 7)) {
        expect(isCU(c)).toBe(true);
        expect(c.v).toBeUndefined();
      }
      // 8 head-turner
      const head = cards[7]!;
      expect(head.v).toBe('s');
      expect(isCU(head)).toBe(true);
      // 11 rare/mythic, regular or an alternate frame of a regular card
      const rare = cards[10]!;
      expect(isRM(rare)).toBe(true);
      if (rare.v) {
        expect(['s', 'b', 'e']).toContain(rare.v);
        expect(SET_DATA.neo.cards.some((c) => c.name === rare.name)).toBe(true);
      }
      // wildcards and the foil slot are regular printings
      for (const c of [cards[8]!, cards[9]!, cards[11]!]) expect(c.v).toBeUndefined();
      // foil: the last slot, plus the land when its roll hit
      expect(pack.foil.includes(11)).toBe(true);
      expect(pack.foil.every((f) => f === 0 || f === 11)).toBe(true);
      for (const ref of pack.cards) expect(identityFor(ref)).not.toBeNull();
    }
  });

  it('odds over 5,000 packs: land foil 21% ± 3, mythic in slot 11 ≈ 13.5% ± 2.5, head-turner always showcase c/u', () => {
    const N = 5000;
    let landFoil = 0;
    let mythic = 0;
    let head = 0;
    let dual = 0;
    for (let i = 0; i < N; i++) {
      const pack = rollPackOfKind('neo', 'set', seedOf(i));
      const cards = cardsOf(pack);
      if (pack.foil.includes(0)) landFoil++;
      if (cards[10]!.r === 'm') mythic++;
      if (cards[7]!.v === 's' && isCU(cards[7]!)) head++;
      if (!isBasic(cards[0]!)) dual++;
    }
    expect(landFoil / N).toBeGreaterThan(0.18);
    expect(landFoil / N).toBeLessThan(0.24);
    expect(mythic / N).toBeGreaterThan(0.11);
    expect(mythic / N).toBeLessThan(0.16);
    expect(head).toBe(N);
    expect(dual / N).toBeGreaterThan(0.46);
    expect(dual / N).toBeLessThan(0.54);
  });

  it('golden seeds', () => {
    const GOLDEN: Record<(typeof GOLDEN_SEEDS)[number], { cards: string[]; foil: number[] }> = {
      '0000000000000001': {
        cards: ['neo:269', 'neo:176', 'neo:91', 'neo:146', 'neo:18', 'neo:243', 'neo:103', 'neo:344', 'neo:273', 'neo:279', 'neo:395', 'neo:24'],
        foil: [11],
      },
      '0123456789abcdef': {
        cards: ['neo:289', 'neo:52', 'neo:267', 'neo:40', 'neo:251', 'neo:44', 'neo:100', 'neo:312', 'neo:274', 'neo:71', 'neo:501', 'neo:70'],
        foil: [11],
      },
      feedfacecafebeef: {
        cards: ['neo:284', 'neo:180', 'neo:112', 'neo:163', 'neo:174', 'neo:207', 'neo:185', 'neo:311', 'neo:149', 'neo:147', 'neo:159', 'neo:43'],
        foil: [11],
      },
    };
    for (const seed of GOLDEN_SEEDS) {
      const pack = rollPackOfKind('neo', 'set', seed);
      expect(pack.cards).toEqual(GOLDEN[seed].cards);
      expect(pack.foil).toEqual(GOLDEN[seed].foil);
    }
  });
});

describe('NEO Collector Booster', () => {
  const pools = poolsFor('neo');
  const basics = new Set(pools.basics.map((c) => c.id));

  it('is deterministic and verifies', () => {
    const a = rollPackOfKind('neo', 'collector', '0123456789abcdef');
    expect(rollPackOfKind('neo', 'collector', '0123456789abcdef')).toEqual(a);
    expect(verifyPack(a)).toBe(true);
    expect(rollPackOfKind('neo', 'collector', '0123456789abcdee').cards).not.toEqual(a.cards);
    expect(rollPackOfKind('neo', 'set', '0123456789abcdef').cards).not.toEqual(a.cards);
  });

  it('follows the slot structure exactly', () => {
    expect(pools.etched.length).toBeGreaterThan(0);
    for (let i = 0; i < 2000; i++) {
      const pack = rollPackOfKind('neo', 'collector', seedOf(i));
      const cards = expectWellFormed(pack, 'collector');
      expect(basics.has(cards[0]!.id)).toBe(true);
      expect(cards[1]!.v).toBe('x');
      expect(isRM(cards[1]!)).toBe(true);
      expect(['b', 'e']).toContain(cards[2]!.v);
      expect(isRM(cards[2]!)).toBe(true);
      expect(cards[3]!.v).toBe('e');
      expect(isRM(cards[3]!)).toBe(true);
      expect(cards[4]!.v).toBe('s');
      expect(isRM(cards[4]!)).toBe(true);
      expect(cards[5]!.v).toBeUndefined();
      expect(isRM(cards[5]!)).toBe(true);
      for (const c of cards.slice(6, 8)) {
        expect(c.v).toBe('s');
        expect(isCU(c)).toBe(true);
        expect(c.t).toContain('Ninja');
      }
      for (const c of cards.slice(8, 10)) {
        expect(c.v).toBe('s');
        expect(isCU(c)).toBe(true);
        expect(c.t).toContain('Samurai');
      }
      for (const c of cards.slice(10)) {
        expect(c.v).toBeUndefined();
        expect(isCU(c)).toBe(true);
        expect(isBasic(c)).toBe(false);
      }
      expect(pack.foil).toEqual([0, 1, 2, 5, 6, 7, 10, 11, 12, 13, 14]);
      expect(pack.foil).toEqual([...COLLECTOR_FOIL_SLOTS]);
      // official composition: 5 R/M, 4–6 showcase, 1–3 extended art, 0–3 borderless, 0–1 etched/neon
      expect(cards.filter(isRM)).toHaveLength(5);
      const showcase = cards.filter((c) => c.v === 's').length;
      expect(showcase).toBeGreaterThanOrEqual(4);
      expect(showcase).toBeLessThanOrEqual(6);
      const extended = cards.filter((c) => c.v === 'e').length;
      expect(extended).toBeGreaterThanOrEqual(1);
      expect(extended).toBeLessThanOrEqual(3);
      expect(cards.filter((c) => c.v === 'b').length).toBeLessThanOrEqual(3);
      expect(cards.filter((c) => c.v === 'x')).toHaveLength(1);
      for (const ref of pack.cards) expect(identityFor(ref)).not.toBeNull();
    }
  });

  it('mythic odds in the regular rare slot ≈ 13.5% over 5,000 packs', () => {
    const N = 5000;
    let mythic = 0;
    for (let i = 0; i < N; i++) if (cardsOf(rollPackOfKind('neo', 'collector', seedOf(i)))[5]!.r === 'm') mythic++;
    expect(mythic / N).toBeGreaterThan(0.11);
    expect(mythic / N).toBeLessThan(0.16);
  });

  it('identityFor returns a real edhplay print id for ≥95% of variant printings', () => {
    const variants = SET_DATA.neo.variants!;
    let real = 0;
    for (const v of variants) {
      const id = identityFor(`neo:${v.cn}`)!;
      expect(id).not.toBeNull();
      if (v.ep && id.card_print_id === v.ep && !id.card_print_id.startsWith('hok-')) real++;
    }
    expect(real / variants.length).toBeGreaterThanOrEqual(0.95);
  });

  it('golden seeds', () => {
    const FOIL = [0, 1, 2, 5, 6, 7, 10, 11, 12, 13, 14];
    const GOLDEN: Record<(typeof GOLDEN_SEEDS)[number], string[]> = {
      '0000000000000001': ['neo:284', 'neo:422', 'neo:453', 'neo:449', 'neo:381', 'neo:122', 'neo:335', 'neo:341', 'neo:312', 'neo:310', 'neo:243', 'neo:105', 'neo:1', 'neo:112', 'neo:139'],
      '0123456789abcdef': ['neo:293', 'neo:421', 'neo:450', 'neo:441', 'neo:354', 'neo:268', 'neo:333', 'neo:332', 'neo:322', 'neo:325', 'neo:43', 'neo:100', 'neo:87', 'neo:104', 'neo:52'],
      feedfacecafebeef: ['neo:294', 'neo:418', 'neo:492', 'neo:494', 'neo:384', 'neo:124', 'neo:339', 'neo:342', 'neo:327', 'neo:321', 'neo:204', 'neo:185', 'neo:37', 'neo:265', 'neo:256'],
    };
    for (const seed of GOLDEN_SEEDS) {
      const pack = rollPackOfKind('neo', 'collector', seed);
      expect(pack.cards).toEqual(GOLDEN[seed]);
      expect(pack.foil).toEqual(FOIL);
    }
  });
});
