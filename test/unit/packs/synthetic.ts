/** Synthetic runtime set for registry / generic-roller tests: 40 c, 20 u, 10 r, 3 m, 2 basics. */
import type { RuntimeSetData } from '@shared/packs/runtime';
import type { PackCard, Rarity } from '@shared/packs/types';

export const SYNTH_CODE = 'zzz';
export const SYNTH_NAME = 'Synthetic Set';

/** Deterministic fake Scryfall-ish uuid for card `n` of `code`. */
export const synthId = (code: string, n: number): string => `${code.padEnd(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export interface SynthOptions {
  code?: string;
  name?: string;
  counts?: Partial<Record<Rarity, number>>;
  basics?: number;
  packSize?: number;
  hasMythics?: boolean;
  released?: string;
}

export function makeSyntheticSet(opts: SynthOptions = {}): RuntimeSetData {
  const code = opts.code ?? SYNTH_CODE;
  const counts: Record<Rarity, number> = { c: 40, u: 20, r: 10, m: 3, ...opts.counts };
  const cards: PackCard[] = [];
  let n = 1;
  const push = (r: Rarity, i: number): void => {
    const word = { c: 'Common', u: 'Uncommon', r: 'Rare', m: 'Mythic' }[r];
    cards.push({
      id: synthId(code, n),
      name: `${word} ${i + 1}`,
      cn: String(n),
      r,
      t: i % 3 === 0 ? 'Creature — Spirit' : 'Instant',
      l: 'n',
      mana_cost: '{1}',
      cmc: 1,
      ci: ['W'],
    });
    n++;
  };
  // interleave so collector numbers are not rarity-sorted
  for (let i = 0; i < counts.c; i++) push('c', i);
  for (let i = 0; i < counts.u; i++) push('u', i);
  for (let i = 0; i < counts.r; i++) push('r', i);
  for (let i = 0; i < counts.m; i++) push('m', i);
  const basics: PackCard[] = [];
  const basicNames = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
  for (let i = 0; i < (opts.basics ?? 2); i++) {
    basics.push({ id: synthId(code, n), name: basicNames[i % 5] as string, cn: String(n), r: 'c', t: `Basic Land — ${basicNames[i % 5]}`, l: 'n' });
    n++;
  }
  return {
    code,
    name: opts.name ?? SYNTH_NAME,
    released: opts.released ?? '2005-01-01',
    cards,
    basics,
    hasMythics: opts.hasMythics ?? counts.m > 0,
    packSize: opts.packSize ?? 15,
    fetchedAt: 1_700_000_000_000,
  };
}
