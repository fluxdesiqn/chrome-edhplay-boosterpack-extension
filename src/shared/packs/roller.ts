/**
 * Deterministic booster rolling. Given a set, a pack kind and a 64-bit seed the
 * same pack comes out on every client, so any player can `verifyPack` what
 * another rolled.
 *
 * Every random decision is exactly one `nextInt` taken in a fixed order, and a
 * `pick` over a pool always draws one `nextInt` over the not-yet-used members of
 * that pool (even when only one candidate remains), so the RNG stream consumed is
 * a pure function of the pack kind and the data.
 */
import { DATA_VERSION, SET_DATA } from './data';
import { fisherYates, makeRng, type Rng } from './rng';
import {
  AVAILABLE_PACKS,
  makeRef,
  type CardRef,
  type PackCard,
  type PackKind,
  type Rarity,
  type RolledPack,
  type SetCode,
  type SetData,
} from './types';

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

/** Draft booster templates. */
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

export const PACK_SIZE: Record<PackKind, number> = { draft: 15, set: 12, collector: 15 };

/** Mythic-instead-of-rare odds for NEO (10 mythics over 74 rare-slot printings' worth of sheets). */
const NEO_MYTHIC_ODDS: Odds = [10, 74];
/** Set Booster land-slot foil chance. */
const SET_LAND_FOIL_ODDS: Odds = [21, 100];

export interface Pools {
  rare: PackCard[];
  mythic: PackCard[];
  uncommon: PackCard[];
  /** Every common, including NEO's common dual lands (they do show up in common slots). */
  common: PackCard[];
  /** Common cards whose type line starts with "Land" (NEO gain lands). */
  duals: PackCard[];
  basics: PackCard[];
  /** Collector-booster-only alternate printings (NEO). Empty for other sets. */
  variants: PackCard[];
  /** `variants` with `v === 's'` */
  showcase: PackCard[];
  /** `variants` with `v === 'e'` */
  extended: PackCard[];
  /** `variants` with `v === 'b'` */
  borderless: PackCard[];
  /** `variants` with `v === 'x'` (foil-etched / neon ink) */
  etched: PackCard[];
}

const isLand = (c: PackCard): boolean => c.t.startsWith('Land');

export function buildPools(data: SetData): Pools {
  const cards = data.cards;
  const variants = data.variants ?? [];
  return {
    rare: cards.filter((c) => c.r === 'r'),
    mythic: cards.filter((c) => c.r === 'm'),
    uncommon: cards.filter((c) => c.r === 'u'),
    common: cards.filter((c) => c.r === 'c'),
    duals: cards.filter((c) => c.r === 'c' && isLand(c)),
    basics: data.basics ?? [],
    variants,
    showcase: variants.filter((c) => c.v === 's'),
    extended: variants.filter((c) => c.v === 'e'),
    borderless: variants.filter((c) => c.v === 'b'),
    etched: variants.filter((c) => c.v === 'x'),
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

const isRareOrMythic = (c: PackCard): boolean => c.r === 'r' || c.r === 'm';
const isCommonOrUncommon = (c: PackCard): boolean => c.r === 'c' || c.r === 'u';

/**
 * Per-pack drawing state. A card is "used" by Scryfall id and by name, so a
 * regular printing and an alternate-frame printing of the same card never share
 * a pack (the Set Booster rare upgrade, which deliberately swaps one for the
 * other, goes through `swap`).
 */
class Drawer {
  private readonly usedIds = new Set<string>();
  private readonly usedNames = new Set<string>();
  constructor(
    private readonly rng: Rng,
    private readonly label: string,
  ) {}

  available(pool: readonly PackCard[]): PackCard[] {
    return pool.filter((c) => !this.usedIds.has(c.id) && !this.usedNames.has(c.name));
  }

  /** Draw one card from the first pool that still has unused members. Always one `nextInt`. */
  pick(...pools: readonly (readonly PackCard[])[]): PackCard {
    for (const pool of pools) {
      const avail = this.available(pool);
      if (avail.length === 0) continue;
      const card = avail[this.rng.nextInt(avail.length)] as PackCard;
      this.mark(card);
      return card;
    }
    throw new Error(`rollPack(${this.label}): pool exhausted`);
  }

  /** Replace `card` by one of `alternatives` (same name allowed). One `nextInt`. */
  swap(alternatives: readonly PackCard[]): PackCard {
    const card = alternatives[this.rng.nextInt(alternatives.length)] as PackCard;
    this.usedIds.add(card.id);
    return card;
  }

  private mark(card: PackCard): void {
    this.usedIds.add(card.id);
    this.usedNames.add(card.name);
  }
}

/** Set Booster "wildcard" rarity roll: 55% common, 30% uncommon, 12% rare, 3% mythic. */
function wildcardRarity(rng: Rng): Rarity {
  const r = rng.nextInt(100);
  if (r < 55) return 'c';
  if (r < 85) return 'u';
  if (r < 97) return 'r';
  return 'm';
}

const byRarity = (pools: Pools, r: Rarity): PackCard[] =>
  r === 'c' ? pools.common : r === 'u' ? pools.uncommon : r === 'r' ? pools.rare : pools.mythic;

// ---------------------------------------------------------------------------
// Draft booster
// ---------------------------------------------------------------------------

function rollDraft(set: SetCode, rng: Rng, pools: Pools): PackCard[] {
  const template = TEMPLATES[set];
  const draw = new Drawer(rng, `${set}/draft`);
  const cards: PackCard[] = [];
  for (const slot of template.slots) {
    switch (slot) {
      case 'rare':
        cards.push(template.mythicOdds && odds(rng, template.mythicOdds) ? draw.pick(pools.mythic) : draw.pick(pools.rare));
        break;
      case 'uncommon':
        cards.push(draw.pick(pools.uncommon));
        break;
      case 'common':
        cards.push(draw.pick(pools.common));
        break;
      case 'flex':
        cards.push(template.flexUncommonOdds && odds(rng, template.flexUncommonOdds) ? draw.pick(pools.uncommon) : draw.pick(pools.common));
        break;
      case 'land':
        cards.push(template.landDualOdds && odds(rng, template.landDualOdds) ? draw.pick(pools.duals) : draw.pick(pools.basics));
        break;
    }
  }
  return cards;
}

// ---------------------------------------------------------------------------
// NEO Set Booster (12 cards)
// ---------------------------------------------------------------------------

function rollSet(set: SetCode, rng: Rng, pools: Pools): { cards: PackCard[]; foil: number[] } {
  const draw = new Drawer(rng, `${set}/set`);
  const cards: PackCard[] = [];
  const foil: number[] = [];

  // 1. land: dual or ukiyo-e basic; 21% foil
  cards.push(odds(rng, [1, 2]) ? draw.pick(pools.duals) : draw.pick(pools.basics));
  if (odds(rng, SET_LAND_FOIL_ODDS)) foil.push(0);

  // 2–7. six "connected" commons/uncommons (1/3 uncommon)
  for (let i = 0; i < 6; i++) cards.push(odds(rng, [1, 3]) ? draw.pick(pools.uncommon) : draw.pick(pools.common));

  // 8. head-turner: showcase common/uncommon, else an uncommon
  cards.push(draw.pick(pools.showcase.filter(isCommonOrUncommon), pools.uncommon));

  // 9–10. wildcards of any rarity
  for (let i = 0; i < 2; i++) cards.push(draw.pick(byRarity(pools, wildcardRarity(rng))));

  // 11. rare/mythic, 1/3 upgraded to an alternate-frame printing of the same card when one exists
  let rare = odds(rng, NEO_MYTHIC_ODDS) ? draw.pick(pools.mythic) : draw.pick(pools.rare);
  if (odds(rng, [1, 3])) {
    const alts = pools.variants.filter((c) => c.name === rare.name && (c.v === 's' || c.v === 'b' || c.v === 'e'));
    if (alts.length > 0) rare = draw.swap(alts);
  }
  cards.push(rare);

  // 12. foil of any rarity
  cards.push(draw.pick(byRarity(pools, wildcardRarity(rng))));
  foil.push(cards.length - 1);

  return { cards, foil };
}

// ---------------------------------------------------------------------------
// NEO Collector Booster (15 cards)
// ---------------------------------------------------------------------------

/** 0-based indices of the foil slots in a Collector Booster. */
export const COLLECTOR_FOIL_SLOTS: readonly number[] = [0, 1, 2, 5, 6, 7, 10, 11, 12, 13, 14];

function rollCollector(set: SetCode, rng: Rng, pools: Pools): { cards: PackCard[]; foil: number[] } {
  const draw = new Drawer(rng, `${set}/collector`);
  const cards: PackCard[] = [];

  const showcaseRM = pools.showcase.filter(isRareOrMythic);
  const showcaseCU = pools.showcase.filter(isCommonOrUncommon);
  const extendedRM = pools.extended.filter(isRareOrMythic);
  const borderlessOrExtendedRM = pools.variants.filter((c) => (c.v === 'b' || c.v === 'e') && isRareOrMythic(c));
  const etchedRM = pools.etched.filter(isRareOrMythic);
  const ninjaCU = showcaseCU.filter((c) => c.t.includes('Ninja'));
  const samuraiCU = showcaseCU.filter((c) => c.t.includes('Samurai'));

  // 1. foil ukiyo-e basic
  cards.push(draw.pick(pools.basics));
  // 2. foil-etched / neon-ink rare or mythic (fallback: foil showcase rare/mythic)
  cards.push(draw.pick(etchedRM, showcaseRM));
  // 3. foil borderless-or-extended rare/mythic
  cards.push(draw.pick(borderlessOrExtendedRM));
  // 4. extended-art rare/mythic
  cards.push(draw.pick(extendedRM));
  // 5. showcase rare/mythic
  cards.push(draw.pick(showcaseRM));
  // 6. foil regular rare/mythic
  cards.push(odds(rng, NEO_MYTHIC_ODDS) ? draw.pick(pools.mythic) : draw.pick(pools.rare));
  // 7–8. foil showcase Ninja commons/uncommons
  for (let i = 0; i < 2; i++) cards.push(draw.pick(ninjaCU, showcaseCU));
  // 9–10. showcase Samurai commons/uncommons
  for (let i = 0; i < 2; i++) cards.push(draw.pick(samuraiCU, showcaseCU));
  // 11–15. five foil regular commons/uncommons (1/2 uncommon)
  for (let i = 0; i < 5; i++) cards.push(odds(rng, [1, 2]) ? draw.pick(pools.uncommon) : draw.pick(pools.common));

  return { cards, foil: [...COLLECTOR_FOIL_SLOTS] };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Roll a pack of the given kind. Throws when `kind` is not sold for `set`
 * (see `AVAILABLE_PACKS`).
 */
export function rollPackOfKind(set: SetCode, kind: PackKind, seedHex: string, data: SetData = SET_DATA[set]): RolledPack {
  if (!AVAILABLE_PACKS[set].includes(kind)) {
    throw new Error(`rollPackOfKind: ${set} has no ${kind} boosters`);
  }
  const pools = poolsFor(set, data);
  const rng = makeRng(seedHex);

  let cards: PackCard[];
  let foil: number[];
  switch (kind) {
    case 'draft':
      cards = rollDraft(set, rng, pools);
      foil = [];
      break;
    case 'set':
      ({ cards, foil } = rollSet(set, rng, pools));
      break;
    case 'collector':
      ({ cards, foil } = rollCollector(set, rng, pools));
      break;
  }

  return { set, kind, seed: seedHex, dataVersion: DATA_VERSION, cards: cards.map((c) => makeRef(set, c.cn)), foil };
}

/** Roll a Draft Booster. Equivalent to `rollPackOfKind(set, 'draft', seedHex, data)`. */
export function rollPack(set: SetCode, seedHex: string, data: SetData = SET_DATA[set]): RolledPack {
  return rollPackOfKind(set, 'draft', seedHex, data);
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
 * Re-roll `pack` from its seed and compare cards and foil indices. Returns true
 * when the data version differs (we cannot verify against data we do not have).
 */
export function verifyPack(pack: RolledPack): boolean {
  if (pack.dataVersion !== DATA_VERSION) return true;
  let again: RolledPack;
  try {
    again = rollPackOfKind(pack.set, pack.kind ?? 'draft', pack.seed);
  } catch {
    return false;
  }
  if (again.cards.length !== pack.cards.length) return false;
  for (let i = 0; i < again.cards.length; i++) if (again.cards[i] !== pack.cards[i]) return false;
  const foil = pack.foil ?? [];
  if (again.foil.length !== foil.length) return false;
  for (let i = 0; i < again.foil.length; i++) if (again.foil[i] !== foil[i]) return false;
  return true;
}
