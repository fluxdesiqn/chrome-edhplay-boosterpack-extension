import { beforeEach, describe, expect, it } from 'vitest';
import { cacheGet } from '../../../src/background/cache';
import {
  SCRYFALL_BASE,
  SETS_CACHE_KEY,
  cnCompare,
  fetchSetCards,
  fetchSetList,
  isBoosterSet,
  loadSetCards,
  packSizeFor,
  setCardsCacheKey,
  toPackCard,
  toSetSummary,
} from '../../../src/background/scryfall';
import type { PackCard } from '../../../src/shared/packs/types';
import { installChromeStorage, installFetch, type Route } from './stubs';

const SEARCH = `${SCRYFALL_BASE}/cards/search?q=`;
const nonBasicUrl = (code: string): string => `${SEARCH}set:${code}+is:booster+-t:basic&unique=prints&order=set`;
const basicUrl = (code: string): string => `${SEARCH}set:${code}+is:booster+t:basic&unique=prints&order=set`;
const fallbackUrl = (code: string): string => `${SEARCH}set:${code}+-t:basic+-is:promo+-is:digital&unique=prints&order=set`;
const fallbackBasicUrl = (code: string): string => `${SEARCH}set:${code}+t:basic+-is:promo+-is:digital&unique=prints&order=set`;
const PAGE2 = `${SCRYFALL_BASE}/cards/search?format=json&page=2&q=set%3Azzz`;

const card = (over: Record<string, unknown>): Record<string, unknown> => ({
  object: 'card',
  layout: 'normal',
  rarity: 'common',
  type_line: 'Instant',
  set: 'zzz',
  set_name: 'Zeta Zone',
  released_at: '2005-06-03',
  ...over,
});

const SETS_LIST = {
  object: 'list',
  has_more: false,
  data: [
    { code: 'zzz', name: 'Zeta Zone', set_type: 'expansion', released_at: '2005-06-03', card_count: 165, digital: false, icon_svg_uri: 'https://svgs.scryfall.io/sets/zzz.svg' },
    { code: 'mkm', name: 'Murders at Karlov Manor', set_type: 'expansion', released_at: '2024-02-09', card_count: 286, digital: false },
    { code: 'm21', name: 'Core Set 2021', set_type: 'core', released_at: '2020-07-03', card_count: 397 },
    { code: '2xm', name: 'Double Masters', set_type: 'masters', released_at: '2020-08-07', card_count: 384 },
    { code: 'cmr', name: 'Commander Legends', set_type: 'draft_innovation', released_at: '2020-11-20', card_count: 722 },
    { code: 'unf', name: 'Unfinity', set_type: 'funny', released_at: '2022-10-07', card_count: 244 },
    // excluded: digital, wrong type, too small
    { code: 'ymid', name: 'Alchemy: Innistrad', set_type: 'alchemy', released_at: '2021-12-09', card_count: 63, digital: true },
    { code: 'yneo', name: 'Alchemy: Kamigawa', set_type: 'expansion', released_at: '2022-03-17', card_count: 30, digital: true },
    { code: 'tzzz', name: 'Zeta Zone Tokens', set_type: 'token', released_at: '2005-06-03', card_count: 12 },
    { code: 'c21', name: 'Commander 2021', set_type: 'commander', released_at: '2021-04-23', card_count: 300 },
    { code: 'tiny', name: 'Tiny Expansion', set_type: 'expansion', released_at: '2001-01-01', card_count: 59 },
    { code: 'dg', name: 'Digital Core', set_type: 'core', released_at: '2010-01-01', card_count: 200, digital: true },
  ],
};

const PAGE1 = {
  object: 'list',
  total_cards: 6,
  has_more: true,
  next_page: PAGE2,
  data: [
    card({ id: 'id-010', name: 'Late Common', collector_number: '10', rarity: 'common', cmc: 2, mana_cost: '{1}{U}', color_identity: ['U'] }),
    card({ id: 'id-002', name: 'Early Rare', collector_number: '2', rarity: 'rare', type_line: 'Creature — Dragon', power: '4', toughness: '4', cmc: 5, mana_cost: '{3}{R}{R}', color_identity: ['R'] }),
    card({ id: 'id-bonus', name: 'Bonus Sheet Card', collector_number: '300', rarity: 'bonus' }),
    card({ id: 'id-special', name: 'Special Card', collector_number: '301', rarity: 'special' }),
  ],
};

const PAGE2_BODY = {
  object: 'list',
  has_more: false,
  data: [
    card({
      id: 'id-003',
      name: 'Front Face // Back Face',
      collector_number: '3',
      rarity: 'mythic',
      layout: 'transform',
      type_line: 'Creature — Human // Creature — Werewolf',
      cmc: 3,
      color_identity: ['G'],
      card_faces: [
        { name: 'Front Face', type_line: 'Creature — Human', power: '2', toughness: '2', mana_cost: '{2}{G}' },
        { name: 'Back Face', type_line: 'Creature — Werewolf', power: '4', toughness: '4' },
      ],
    }),
    card({ id: 'id-001', name: 'First Uncommon', collector_number: '1', rarity: 'uncommon', cmc: 0, color_identity: [] }),
    card({ id: 'id-010a', name: 'Alt Common', collector_number: '10a', rarity: 'common', layout: 'flip', card_faces: [{ name: 'Alt Common', type_line: 'Creature — Fox' }, { name: 'Other', type_line: 'Creature — Kitsune' }] }),
  ],
};

function routes(): Record<string, Route> {
  return {
    [`${SCRYFALL_BASE}/sets`]: { status: 200, body: SETS_LIST },
    [`${SCRYFALL_BASE}/sets/zzz`]: { status: 200, body: SETS_LIST.data[0] },
    [`${SCRYFALL_BASE}/sets/mkm`]: { status: 200, body: SETS_LIST.data[1] },
    [`${SCRYFALL_BASE}/sets/nope`]: { status: 404, body: { object: 'error', code: 'not_found', status: 404 } },
    [nonBasicUrl('zzz')]: { status: 200, body: PAGE1 },
    [PAGE2]: { status: 200, body: PAGE2_BODY },
    [basicUrl('zzz')]: { status: 404, body: { object: 'error', code: 'not_found', status: 404 } },
    [nonBasicUrl('mkm')]: {
      status: 200,
      body: { object: 'list', has_more: false, data: [card({ id: 'mkm-1', name: 'Clue', collector_number: '1', set: 'mkm', rarity: 'rare' }), card({ id: 'mkm-2', name: 'Dagger', collector_number: '2', set: 'mkm' })] },
    },
    [basicUrl('mkm')]: {
      status: 200,
      body: {
        object: 'list',
        has_more: false,
        data: [
          card({ id: 'mkm-b2', name: 'Island', collector_number: '272', set: 'mkm', type_line: 'Basic Land — Island', rarity: 'common' }),
          card({ id: 'mkm-b1', name: 'Plains', collector_number: '271', set: 'mkm', type_line: 'Basic Land — Plains', rarity: 'common' }),
        ],
      },
    },
    [nonBasicUrl('empty')]: { status: 404, body: { object: 'error', code: 'not_found', status: 404 } },
    [fallbackUrl('empty')]: { status: 404, body: { object: 'error', code: 'not_found', status: 404 } },
    [fallbackBasicUrl('empty')]: { status: 404, body: { object: 'error', code: 'not_found', status: 404 } },
    [`${SCRYFALL_BASE}/sets/empty`]: { status: 200, body: { code: 'empty', name: 'Empty', set_type: 'expansion', card_count: 0 } },
    // A brand-new set: Scryfall has not flagged booster contents yet.
    [`${SCRYFALL_BASE}/sets/tmt`]: { status: 200, body: { code: 'tmt', name: 'Teenage Mutant Ninja Turtles', set_type: 'expansion', card_count: 320, released_at: '2026-03-06' } },
    [nonBasicUrl('tmt')]: { status: 404, body: { object: 'error', code: 'not_found', status: 404 } },
    [fallbackUrl('tmt')]: {
      status: 200,
      body: {
        object: 'list',
        has_more: false,
        data: [
          card({ id: 'tmt-1', name: 'Leonardo', collector_number: '1', set: 'tmt', rarity: 'mythic' }),
          card({ id: 'tmt-1s', name: 'Leonardo', collector_number: '301', set: 'tmt', rarity: 'mythic', frame_effects: ['showcase'] }),
          card({ id: 'tmt-2', name: 'Pizza', collector_number: '2', set: 'tmt', rarity: 'common' }),
          card({ id: 'tmt-2e', name: 'Pizza', collector_number: '355', set: 'tmt', rarity: 'common', frame_effects: ['extendedart'] }),
          card({ id: 'tmt-3', name: 'Sewer Lair', collector_number: '3', set: 'tmt', rarity: 'uncommon' }),
        ],
      },
    },
    [fallbackBasicUrl('tmt')]: {
      status: 200,
      body: { object: 'list', has_more: false, data: [card({ id: 'tmt-b', name: 'Forest', collector_number: '310', set: 'tmt', type_line: 'Basic Land — Forest', rarity: 'common' })] },
    },
  };
}

describe('scryfall background client', () => {
  beforeEach(() => {
    installChromeStorage();
  });

  it('fetchSetList keeps paper booster sets with ≥60 cards, maps SetSummary, and caches for 7 days', async () => {
    const { calls, headers } = installFetch(routes());
    const sets = await fetchSetList();
    expect(calls).toEqual([`${SCRYFALL_BASE}/sets`]);
    expect(headers[0]).toMatchObject({ Accept: 'application/json', 'User-Agent': 'HoK-edhplay-extension/0.2' });
    expect(sets.map((s) => s.code)).toEqual(['zzz', 'mkm', 'm21', '2xm', 'cmr', 'unf']);
    expect(sets[0]).toEqual({ code: 'zzz', name: 'Zeta Zone', released: '2005-06-03', cardCount: 165, type: 'expansion', iconSvg: 'https://svgs.scryfall.io/sets/zzz.svg' });
    expect(sets[1]).toEqual({ code: 'mkm', name: 'Murders at Karlov Manor', released: '2024-02-09', cardCount: 286, type: 'expansion' });
    expect('iconSvg' in sets[1]!).toBe(false);

    const cached = await cacheGet<unknown>(SETS_CACHE_KEY);
    expect(cached).toEqual(sets);
    const raw = (await chrome.storage.local.get('hok:cache:sets:list'))['hok:cache:sets:list'] as { exp: number };
    expect(raw.exp - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(raw.exp - Date.now()).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);

    // second call: served from cache, no fetch
    const again = await fetchSetList();
    expect(again).toEqual(sets);
    expect(calls).toHaveLength(1);
  });

  it('isBoosterSet / toSetSummary / packSizeFor rules', () => {
    expect(isBoosterSet({ code: 'a', name: 'a', set_type: 'expansion', card_count: 60 } as never)).toBe(true);
    expect(isBoosterSet({ code: 'a', name: 'a', set_type: 'expansion', card_count: 59 } as never)).toBe(false);
    expect(isBoosterSet({ code: 'a', name: 'a', set_type: 'expansion', card_count: 300, digital: true } as never)).toBe(false);
    expect(isBoosterSet({ code: 'a', name: 'a', set_type: 'commander', card_count: 300 } as never)).toBe(false);
    expect(isBoosterSet({ code: 'a', name: 'a', set_type: 'alchemy', card_count: 300 } as never)).toBe(false);
    for (const t of ['core', 'expansion', 'masters', 'draft_innovation', 'funny']) {
      expect(isBoosterSet({ code: 'a', name: 'a', set_type: t, card_count: 100 } as never)).toBe(true);
    }
    expect(toSetSummary({ code: 'a', name: 'A', set_type: 'core', card_count: 1 } as never)).toEqual({ code: 'a', name: 'A', released: '', cardCount: 1, type: 'core' });
    expect(packSizeFor('2024-02-01')).toBe(14);
    expect(packSizeFor('2024-02-09')).toBe(14);
    expect(packSizeFor('2025-01-01')).toBe(14);
    expect(packSizeFor('2024-01-31')).toBe(15);
    expect(packSizeFor('2005-06-03')).toBe(15);
    expect(packSizeFor('')).toBe(15);
  });

  it('fetchSetCards follows pagination, skips non c/u/r/m rarities, maps like the build script, sorts by collector number', async () => {
    const { calls } = installFetch(routes());
    const data = await fetchSetCards('ZZZ');
    // set meta (list not cached → /sets/zzz), page 1, page 2, basics (404)
    expect(calls).toEqual([`${SCRYFALL_BASE}/sets/zzz`, nonBasicUrl('zzz'), PAGE2, basicUrl('zzz')]);

    expect(data.code).toBe('zzz');
    expect(data.name).toBe('Zeta Zone');
    expect(data.released).toBe('2005-06-03');
    expect(data.packSize).toBe(15);
    expect(data.hasMythics).toBe(true);
    expect(data.basics).toEqual([]);
    expect(typeof data.fetchedAt).toBe('number');
    expect(data.cards.map((c) => c.cn)).toEqual(['1', '2', '3', '10', '10a']);
    expect(data.cards.map((c) => c.name)).not.toContain('Bonus Sheet Card');
    expect(data.cards.map((c) => c.name)).not.toContain('Special Card');

    const rare = data.cards[1]!;
    expect(rare).toEqual({ id: 'id-002', name: 'Early Rare', cn: '2', r: 'r', t: 'Creature — Dragon', l: 'n', p: '4', q: '4', mana_cost: '{3}{R}{R}', cmc: 5, ci: ['R'] });
    const dfc = data.cards[2]!;
    expect(dfc).toEqual({
      id: 'id-003',
      name: 'Front Face // Back Face',
      cn: '3',
      r: 'm',
      t: 'Creature — Human // Creature — Werewolf',
      l: 't',
      p: '2',
      q: '2',
      b: { t: 'Creature — Werewolf', p: '4', q: '4' },
      mana_cost: '{2}{G}',
      cmc: 3,
      ci: ['G'],
    });
    const flip = data.cards[4]!;
    expect(flip.l).toBe('f');
    expect(flip.b).toBeUndefined();
    const unc = data.cards[0]!;
    expect(unc).toEqual({ id: 'id-001', name: 'First Uncommon', cn: '1', r: 'u', t: 'Instant', l: 'n', cmc: 0, ci: [] });
    // no edhplay ids are resolved here
    for (const c of data.cards) {
      expect(c.ep).toBeUndefined();
      expect(c.ec).toBeUndefined();
    }

    // cached 30 days; second call makes no fetch and returns the same shape
    const raw = (await chrome.storage.local.get('hok:cache:' + setCardsCacheKey('zzz')))['hok:cache:sets:cards:zzz'] as { exp: number; v: unknown };
    expect(raw.v).toEqual(data);
    expect(raw.exp - Date.now()).toBeGreaterThan(29.9 * 24 * 3600 * 1000);
    const n = calls.length;
    expect(await fetchSetCards('zzz')).toEqual(data);
    expect(calls).toHaveLength(n);
  });

  it('uses the cached set list for meta, applies the Play Booster size rule and sorts basics', async () => {
    const { calls } = installFetch(routes());
    await fetchSetList();
    const before = calls.length;
    const data = await fetchSetCards('mkm');
    expect(calls.slice(before)).toEqual([nonBasicUrl('mkm'), basicUrl('mkm')]);
    expect(data.name).toBe('Murders at Karlov Manor');
    expect(data.released).toBe('2024-02-09');
    expect(data.packSize).toBe(14);
    expect(data.hasMythics).toBe(false);
    expect(data.basics.map((c) => c.cn)).toEqual(['271', '272']);
    expect(data.cards.map((c) => c.r)).toEqual(['r', 'c']);
  });

  it('loadSetCards reports failures as {data: null, error} (unknown set, no booster cards)', async () => {
    installFetch(routes());
    const unknown = await loadSetCards('nope');
    expect(unknown.data).toBeNull();
    expect(unknown.error).toMatch(/unknown set "nope"/);
    const empty = await loadSetCards('empty');
    expect(empty.data).toBeNull();
    expect(empty.error).toMatch(/no cards on Scryfall yet/);
    // nothing cached for failures
    expect(await cacheGet(setCardsCacheKey('nope'))).toBeNull();
    expect(await cacheGet(setCardsCacheKey('empty'))).toBeNull();
    // and a real network error surfaces as an error string too
    const ok = await loadSetCards('zzz');
    expect(ok.error).toBeUndefined();
    expect(ok.data?.cards).toHaveLength(5);
  });

  it('falls back to regular printings when Scryfall has no booster flags for a new set', async () => {
    const f = installFetch(routes());
    const r = await loadSetCards('tmt');
    expect(r.error).toBeUndefined();
    const data = r.data!;
    // one printing per name, lowest collector number wins (showcase/extended variants dropped)
    expect(data.cards.map((c) => c.cn)).toEqual(['1', '2', '3']);
    expect(data.cards.map((c) => c.id)).toEqual(['tmt-1', 'tmt-2', 'tmt-3']);
    expect(data.basics).toHaveLength(1);
    expect(data.hasMythics).toBe(true);
    expect(data.packSize).toBe(14);
    expect(f.calls.some((u) => u === fallbackUrl('tmt'))).toBe(true);
  });

  it('toPackCard / cnCompare helpers', () => {
    expect(toPackCard({ id: 'x', name: 'X', collector_number: '1', rarity: 'special', layout: 'normal' })).toBeNull();
    expect(toPackCard({ id: 'x', name: 'X', collector_number: '1', rarity: 'bonus', layout: 'normal' })).toBeNull();
    expect(toPackCard({ id: 'x', name: 'X', collector_number: '1', rarity: 'common', layout: 'modal_dfc' })?.l).toBe('t');
    const mk = (cn: string): PackCard => ({ id: cn, name: cn, cn, r: 'c', t: '', l: 'n' });
    expect(['10', '2', '1a', '1', 'A-3', '100'].map(mk).sort(cnCompare).map((c) => c.cn)).toEqual(['1', '1a', '2', '10', '100', 'A-3']);
  });
});
