/**
 * Deterministic booster rolling. Given a set and a 64-bit seed the same pack
 * comes out on every client, so any player can `verifyPack` what another rolled.
 */
import { DATA_VERSION, SET_DATA } from './data';
import { fisherYates, makeRng, type Rng } from './rng';
import { makeRef, type CardRef, type PackCard, type RolledPack, type SetCode, type SetData } from './types';

export type SlotKind = 'rare' | 'uncommon' | 'common' | 'flex' | 'land';

/** `[numerator, denominator]` odds, evaluated as `rng.nextInt(den) < num`. */
export type Odds = readonly [number, number];

export interface PackTemplate {
  slots: readonly SlotKind[];
  /** Chance the rare slot is a mythic instead. Absent → the set has no mythics. */
  mythicOdds?: Odds;
  /** Chance the flex slot is an uncommon instead of a common. */
  flexUncommonOdds?: Odds;
  /** Chance the land slot is a common dual instead of a basic. */
  landDualOdds?: Odds;
}

const rep = (kind: SlotKind, n: number): SlotKind[] => Array.from({ length: n }, () => kind);
const CLASSIC: PackTemplate = { slots: ['rare', ...rep('uncommon', 3), ...rep('common', 11)] };

export const TEMPLATES: Record<SetCode, PackTemplate> = {
  chk: CLASSIC,
  bok: CLASSIC,
  sok: CLASSIC,
  neo: {
    slots: ['rare', ...rep('uncommon', 3), ...rep('common', 9), 'flex', 'land'],
    mythicOdds: [10, 74],
    flexUncommonOdds: [1, 3],
    landDualOdds: [1, 2],
  },
};

export interface Pools {
  rare: PackCard[];
  mythic: PackCard[];
  uncommon: PackCard[];
  /** Every common, including NEO's common dual lands (they do show up in common slots). */
  common: PackCard[];
  /** Common cards whose type line starts with "Land" (NEO gain lands). */
  duals: PackCard[];
  basics: PackCard[];
}

const isLand = (c: PackCard): boolean => c.t.startsWith('Land');

export function buildPools(data: SetData): Pools {
  const cards = data.cards;
  return {
    rare: cards.filter((c) => c.r === 'r'),
    mythic: cards.filter((c) => c.r === 'm'),
    uncommon: cards.filter((c) => c.r === 'u'),
    common: cards.filter((c) => c.r === 'c'),
    duals: cards.filter((c) => c.r === 'c' && isLand(c)),
    basics: data.basics ?? [],
  };
}

const poolCache = new WeakMap<SetData, Pools>();

export function poolsFor(set: SetCode, data: SetData = SET_DATA[set]): Pools {
  let pools = poolCache.get(data);
  if (!pools) {
    pools = buildPools(data);
    poolCache.set(data, pools);
  }
  return pools;
}

const odds = (rng: Rng, o: Odds): boolean => rng.nextInt(o[1]) < o[0];

/**
 * Roll a pack. Every slot draws exactly one `nextInt` over the not-yet-used
 * members of its pool (even when only one candidate remains), so the RNG stream
 * consumed is a pure function of the template and the data.
 */
export function rollPack(set: SetCode, seedHex: string, data: SetData = SET_DATA[set]): RolledPack {
  const template = TEMPLATES[set];
  const pools = poolsFor(set, data);
  const rng = makeRng(seedHex);
  const used = new Set<string>();

  const pick = (pool: PackCard[]): PackCard => {
    const avail = pool.filter((c) => !used.has(c.cn));
    if (avail.length === 0) throw new Error(`rollPack(${set}): pool exhausted`);
    const card = avail[rng.nextInt(avail.length)] as PackCard;
    used.add(card.cn);
    return card;
  };

  const cards: CardRef[] = [];
  for (const slot of template.slots) {
    let card: PackCard;
    switch (slot) {
      case 'rare':
        card = template.mythicOdds && odds(rng, template.mythicOdds) ? pick(pools.mythic) : pick(pools.rare);
        break;
      case 'uncommon':
        card = pick(pools.uncommon);
        break;
      case 'common':
        card = pick(pools.common);
        break;
      case 'flex':
        card = template.flexUncommonOdds && odds(rng, template.flexUncommonOdds) ? pick(pools.uncommon) : pick(pools.common);
        break;
      case 'land':
        card = template.landDualOdds && odds(rng, template.landDualOdds) ? pick(pools.duals) : pick(pools.basics);
        break;
    }
    cards.push(makeRef(set, card.cn));
  }

  return { set, seed: seedHex, dataVersion: DATA_VERSION, cards };
}

/**
 * Shuffle a freshly opened pack into an existing pile. Seeded with
 * `seedHex + ':pile'`, which `makeRng` folds via FNV-1a (see rng.ts), so the
 * pile order is derived from — but independent of — the pack's own draw stream.
 */
export function shuffleIntoPile(pile: CardRef[], pack: CardRef[], seedHex: string): CardRef[] {
  return fisherYates([...pile, ...pack], makeRng(seedHex + ':pile'));
}

/**
 * Re-roll `pack` from its seed and compare. Returns true when the data version
 * differs (we cannot verify against data we do not have).
 */
export function verifyPack(pack: RolledPack): boolean {
  if (pack.dataVersion !== DATA_VERSION) return true;
  let again: RolledPack;
  try {
    again = rollPack(pack.set, pack.seed);
  } catch {
    return false;
  }
  if (again.cards.length !== pack.cards.length) return false;
  for (let i = 0; i < again.cards.length; i++) if (again.cards[i] !== pack.cards[i]) return false;
  return true;
}
