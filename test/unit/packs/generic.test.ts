import { beforeEach, describe, expect, it } from 'vitest';
import { DATA_VERSION } from '@shared/packs/data';
import { findCard } from '@shared/packs/identity';
import { _resetRegistry, registerSetData } from '@shared/packs/registry';
import {
  GENERIC_MYTHIC_ODDS,
  PACK_SIZE,
  dataVersionFor,
  genericTemplate,
  packSize,
  poolsFor,
  rollPack,
  rollPackOfKind,
  templateFor,
  verifyPack,
} from '@shared/packs/roller';
import type { PackCard, RolledPack } from '@shared/packs/types';
import { SYNTH_CODE, makeSyntheticSet } from './synthetic';

const seedOf = (i: number): string => i.toString(16).padStart(16, '0');
const cardsOf = (pack: RolledPack): PackCard[] =>
  pack.cards.map((ref) => {
    const c = findCard(ref);
    if (!c) throw new Error(`unresolvable ${ref}`);
    return c;
  });
const isRM = (c: PackCard): boolean => c.r === 'r' || c.r === 'm';
const isBasic = (c: PackCard): boolean => c.t.startsWith('Basic Land');

describe('generic draft template (runtime sets)', () => {
  beforeEach(() => _resetRegistry());

  it('derives 1 rare / 3 uncommons / commons / land from the data', () => {
    const data = makeSyntheticSet();
    registerSetData(data);
    const t = templateFor(SYNTH_CODE);
    expect(t.slots).toEqual(['rare', 'uncommon', 'uncommon', 'uncommon', ...Array(10).fill('common'), 'land']);
    expect(t.mythicOdds).toEqual(GENERIC_MYTHIC_ODDS);
    expect(t.landDualOdds).toBeUndefined();
    expect(t.flexUncommonOdds).toBeUndefined();
    expect(templateFor(SYNTH_CODE)).toBe(t); // cached per data object

    const noBasics = makeSyntheticSet({ code: 'yyy', basics: 0 });
    expect(genericTemplate(noBasics).slots).toEqual(['rare', 'uncommon', 'uncommon', 'uncommon', ...Array(11).fill('common')]);

    const noMythics = makeSyntheticSet({ code: 'yyx', counts: { m: 0 } });
    expect(noMythics.hasMythics).toBe(false);
    expect(genericTemplate(noMythics).mythicOdds).toBeUndefined();
    // hasMythics flag alone is not enough: the pool must be non-empty
    const flagOnly = makeSyntheticSet({ code: 'yyw', counts: { m: 0 }, hasMythics: true });
    expect(genericTemplate(flagOnly).mythicOdds).toBeUndefined();

    const play = makeSyntheticSet({ code: 'yyv', packSize: 14 });
    expect(genericTemplate(play).slots).toHaveLength(14);
    expect(genericTemplate(play).slots.filter((s) => s === 'common')).toHaveLength(9);
  });

  it('packSize: bundled products, runtime data hint, 15 when unknown', () => {
    expect(packSize('neo', 'draft')).toBe(15);
    expect(packSize('neo', 'set')).toBe(12);
    expect(packSize('neo', 'collector')).toBe(15);
    expect(packSize('chk', 'draft')).toBe(PACK_SIZE.draft);
    expect(packSize(SYNTH_CODE, 'draft')).toBe(15);
    registerSetData(makeSyntheticSet({ packSize: 14 }));
    expect(packSize(SYNTH_CODE, 'draft')).toBe(14);
    registerSetData(makeSyntheticSet({ packSize: 15 }));
    expect(packSize(SYNTH_CODE, 'draft')).toBe(15);
    // anything but 14 is treated as the classic 15
    registerSetData(makeSyntheticSet({ packSize: 12 }));
    expect(packSize(SYNTH_CODE, 'draft')).toBe(15);
  });

  it('rolls 15 well-formed cards: slot 0 rare/mythic, 1–3 uncommon, 4–13 common, 14 basic, no dupes', () => {
    const data = makeSyntheticSet();
    registerSetData(data);
    const pools = poolsFor(SYNTH_CODE);
    expect(pools.rare).toHaveLength(10);
    expect(pools.mythic).toHaveLength(3);
    expect(pools.uncommon).toHaveLength(20);
    expect(pools.common).toHaveLength(40);
    expect(pools.basics).toHaveLength(2);
    expect(pools.variants).toEqual([]);
    for (let i = 0; i < 2000; i++) {
      const pack = rollPackOfKind(SYNTH_CODE, 'draft', seedOf(i));
      expect(pack.set).toBe(SYNTH_CODE);
      expect(pack.kind).toBe('draft');
      expect(pack.foil).toEqual([]);
      expect(pack.cards).toHaveLength(15);
      expect(pack.dataVersion).toBe(dataVersionFor(SYNTH_CODE));
      const cards = cardsOf(pack);
      expect(isRM(cards[0]!)).toBe(true);
      for (const c of cards.slice(1, 4)) expect(c.r).toBe('u');
      for (const c of cards.slice(4, 14)) {
        expect(c.r).toBe('c');
        expect(isBasic(c)).toBe(false);
      }
      expect(isBasic(cards[14]!)).toBe(true);
      expect(cards.filter(isRM)).toHaveLength(1);
      expect(new Set(cards.map((c) => c.id)).size).toBe(15);
      expect(new Set(cards.map((c) => c.name)).size).toBe(15);
    }
  });

  it('14-card Play Booster sets drop one common; sets without basics swap the land for a common', () => {
    registerSetData(makeSyntheticSet({ code: 'yyy', packSize: 14 }));
    registerSetData(makeSyntheticSet({ code: 'yyx', basics: 0 }));
    for (let i = 0; i < 300; i++) {
      const p14 = rollPackOfKind('yyy', 'draft', seedOf(i));
      expect(p14.cards).toHaveLength(14);
      const c14 = cardsOf(p14);
      expect(isBasic(c14[13]!)).toBe(true);
      expect(c14.filter((c) => c.r === 'c' && !isBasic(c))).toHaveLength(9);

      const pNoLand = rollPackOfKind('yyx', 'draft', seedOf(i));
      expect(pNoLand.cards).toHaveLength(15);
      const cNoLand = cardsOf(pNoLand);
      expect(cNoLand.some(isBasic)).toBe(false);
      expect(cNoLand.filter((c) => c.r === 'c')).toHaveLength(11);
      expect(cNoLand.filter((c) => c.r === 'u')).toHaveLength(3);
    }
  });

  it('mythic odds ≈ 1/8 over 8,000 packs; never a mythic when the set has none', () => {
    registerSetData(makeSyntheticSet());
    registerSetData(makeSyntheticSet({ code: 'yyy', counts: { m: 0 } }));
    const N = 8000;
    let mythic = 0;
    for (let i = 0; i < N; i++) if (cardsOf(rollPackOfKind(SYNTH_CODE, 'draft', seedOf(i)))[0]!.r === 'm') mythic++;
    expect(mythic / N).toBeGreaterThan(0.105);
    expect(mythic / N).toBeLessThan(0.145);
    for (let i = 0; i < 500; i++) expect(cardsOf(rollPackOfKind('yyy', 'draft', seedOf(i)))[0]!.r).toBe('r');
  });

  it('is deterministic, seed-sensitive, and rollPack is the draft alias', () => {
    registerSetData(makeSyntheticSet());
    const a = rollPackOfKind(SYNTH_CODE, 'draft', '0123456789abcdef');
    expect(rollPackOfKind(SYNTH_CODE, 'draft', '0123456789abcdef')).toEqual(a);
    expect(rollPack(SYNTH_CODE, '0123456789abcdef')).toEqual(a);
    expect(rollPackOfKind(SYNTH_CODE, 'draft', '0123456789abcdee').cards).not.toEqual(a.cards);
    // explicit data argument bypasses the registry
    _resetRegistry();
    expect(rollPackOfKind(SYNTH_CODE, 'draft', '0123456789abcdef', makeSyntheticSet())).toEqual(a);
  });

  it('golden seeds (the generic draw stream is frozen: peers re-roll with the same data)', () => {
    registerSetData(makeSyntheticSet());
    const GOLDEN: Record<string, string[]> = {
      '0000000000000001': ['zzz:72', 'zzz:49', 'zzz:45', 'zzz:54', 'zzz:30', 'zzz:14', 'zzz:11', 'zzz:21', 'zzz:8', 'zzz:3', 'zzz:10', 'zzz:37', 'zzz:33', 'zzz:17', 'zzz:75'],
      '0123456789abcdef': ['zzz:64', 'zzz:48', 'zzz:43', 'zzz:46', 'zzz:36', 'zzz:38', 'zzz:6', 'zzz:5', 'zzz:27', 'zzz:34', 'zzz:11', 'zzz:7', 'zzz:35', 'zzz:16', 'zzz:74'],
      feedfacecafebeef: ['zzz:61', 'zzz:57', 'zzz:56', 'zzz:53', 'zzz:29', 'zzz:17', 'zzz:18', 'zzz:26', 'zzz:39', 'zzz:27', 'zzz:3', 'zzz:30', 'zzz:6', 'zzz:25', 'zzz:74'],
    };
    for (const [seed, cards] of Object.entries(GOLDEN)) {
      const pack = rollPackOfKind(SYNTH_CODE, 'draft', seed);
      expect(pack.cards).toEqual(cards);
      expect(pack.dataVersion).toBe('rtc246ea6f');
    }
    registerSetData(makeSyntheticSet({ code: 'yyy', packSize: 14 }));
    expect(rollPackOfKind('yyy', 'draft', '0123456789abcdef').cards).toEqual([
      'yyy:64', 'yyy:48', 'yyy:43', 'yyy:46', 'yyy:36', 'yyy:38', 'yyy:6', 'yyy:5', 'yyy:27', 'yyy:34', 'yyy:11', 'yyy:7', 'yyy:35', 'yyy:74',
    ]);
  });

  it('dataVersionFor fingerprints runtime data and is DATA_VERSION for bundled sets', () => {
    expect(dataVersionFor('neo')).toBe(DATA_VERSION);
    expect(dataVersionFor('chk')).toBe(DATA_VERSION);
    const a = makeSyntheticSet();
    const b = makeSyntheticSet();
    expect(dataVersionFor(SYNTH_CODE, a)).toBe(dataVersionFor(SYNTH_CODE, b));
    expect(dataVersionFor(SYNTH_CODE, a)).toMatch(/^rt[0-9a-f]{8}$/);
    expect(dataVersionFor(SYNTH_CODE, makeSyntheticSet({ packSize: 14 }))).not.toBe(dataVersionFor(SYNTH_CODE, a));
    expect(dataVersionFor(SYNTH_CODE, makeSyntheticSet({ counts: { c: 41 } }))).not.toBe(dataVersionFor(SYNTH_CODE, a));
    // unregistered set: falls back to the bundled version string
    expect(dataVersionFor(SYNTH_CODE)).toBe(DATA_VERSION);
  });

  it('verifyPack: true with data, false when tampered, true (unverifiable) without data or with a foreign version', () => {
    registerSetData(makeSyntheticSet());
    const pack = rollPackOfKind(SYNTH_CODE, 'draft', 'feedfacecafebeef');
    expect(verifyPack(pack)).toBe(true);
    const tampered = { ...pack, cards: [...pack.cards] };
    tampered.cards[0] = 'zzz:1';
    expect(verifyPack(tampered)).toBe(false);
    expect(verifyPack({ ...pack, foil: [2] })).toBe(false);
    expect(verifyPack({ ...tampered, dataVersion: 'rt00000000' })).toBe(true);
    // a different snapshot of the set (extra common) → different version → unverifiable, not rejected
    _resetRegistry();
    registerSetData(makeSyntheticSet({ counts: { c: 41 } }));
    expect(verifyPack(tampered)).toBe(true);
    // no data for the set at all → unverifiable
    _resetRegistry();
    expect(verifyPack(pack)).toBe(true);
    expect(verifyPack(tampered)).toBe(true);
    expect(verifyPack({ ...pack, set: 'qqq' })).toBe(true);
  });

  it('throws for kinds a runtime set does not have and for sets without data', () => {
    registerSetData(makeSyntheticSet());
    expect(() => rollPackOfKind(SYNTH_CODE, 'collector', '0123456789abcdef')).toThrow(/zzz has no collector/);
    expect(() => rollPackOfKind(SYNTH_CODE, 'set', '0123456789abcdef')).toThrow(/zzz has no set/);
    expect(() => rollPackOfKind('qqq', 'draft', '0123456789abcdef')).toThrow(/no set data for qqq/);
    expect(() => poolsFor('qqq')).toThrow(/no set data for qqq/);
    expect(() => templateFor('qqq')).toThrow(/no set data for qqq/);
  });
});
