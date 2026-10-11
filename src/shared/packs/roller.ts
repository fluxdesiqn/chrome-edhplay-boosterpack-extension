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
import { DATA_VERSION } from './data';
import { type AnySetData, getSetData, isRuntimeSetData } from './registry';
import { fisherYates, makeRng, type Rng } from './rng';
import type { RuntimeSetData } from './runtime';
import { type BundledSet, type CardRef, type PackCard, type PackKind, type Rarity, type RolledPack, type SetCode, availablePacks, isBundledSet, makeRef } from './types';

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
export const TEMPLATES: Record<BundledSet, PackTemplate> = {
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

/** Card counts of the bundled products (runtime sets: see `packSize`). */
export const PACK_SIZE: Record<PackKind, number> = { draft: 15, set: 12, collector: 15 };

/** Generic draft template: 15 cards, or 14 for Play Booster era sets. */
export const GENERIC_PACK_SIZE = 15;
/** Generic draft template: chance the rare slot is a mythic. */
export const GENERIC_MYTHIC_ODDS: Odds = [1, 8];
/** Generic Collector Booster (runtime sets): 15 cards. */
export const GENERIC_COLLECTOR_SIZE = 15;

/**
 * Number of cards `rollPackOfKind(set, kind, …)` produces. Bundled sets use the
 * product sizes; runtime sets use the `packSize` hint of their data for the
 * draft-style pack (15 when the set is not registered yet) and 15 for a
 * Collector Booster.
 */
export function packSize(set: SetCode, kind: PackKind, data: AnySetData | undefined = getSetData(set)): number {
  if (isBundledSet(set) || !data || !isRuntimeSetData(data)) return PACK_SIZE[kind];
  if (kind === 'collector') return GENERIC_COLLECTOR_SIZE;
  return data.packSize === 14 ? 14 : GENERIC_PACK_SIZE;
}

/**
 * Draft template for a set without a hand-written one (runtime sets), derived
 * from the data alone so peers rebuild the same template from the same cards:
 *
 *   slot 0            rare — or a mythic with odds 1/8 when the set has mythics
 *                     (`hasMythics` and a non-empty mythic pool);
 *   slots 1–3         three uncommons;
 *   next slots        commons, as many as needed to fill the pack;
 *   last slot         a basic land when the data carries `basics`, otherwise
 *                     one more common.
 *
 * Total = `packSize` (14 when the data says 14, else 15). Every slot is drawn
 * with one `nextInt` over the not-yet-used members of its pool (`Drawer.pick`),
 * plus one `nextInt` for the mythic roll when the set has mythics, so the RNG
 * stream is a pure function of the data. No card (by Scryfall id or by name)
 * appears twice.
 */
export function genericTemplate(data: RuntimeSetData, pools: Pools = poolsFor(data.code, data)): PackTemplate {
  const size = data.packSize === 14 ? 14 : GENERIC_PACK_SIZE;
  const hasLand = pools.basics.length > 0;
  const commons = size - 1 - 3 - (hasLand ? 1 : 0);
  const template: PackTemplate = { slots: ['rare', ...rep('uncommon', 3), ...rep('common', commons), ...(hasLand ? (['land'] as const) : [])] };
  if (data.hasMythics && pools.mythic.length > 0) template.mythicOdds = GENERIC_MYTHIC_ODDS;
  return template;
}

const templateCache = new WeakMap<RuntimeSetData, PackTemplate>();

/** The draft template a set rolls with: hand-written for bundled sets, derived for runtime sets. */
export function templateFor(set: SetCode, data: AnySetData | undefined = getSetData(set)): PackTemplate {
  if (isBundledSet(set)) return TEMPLATES[set];
  if (!data || !isRuntimeSetData(data)) throw new Error(`templateFor: no set data for ${set}`);
  let t = templateCache.get(data);
  if (!t) {
    t = genericTemplate(data, poolsFor(set, data));
    templateCache.set(data, t);
  }
  return t;
}

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
  /** Alternate-frame printings (bundled NEO data, or the `variants` of a runtime set). Empty for other sets. */
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

export function buildPools(data: AnySetData): Pools {
  const cards = data.cards;
  const variants = ('variants' in data ? data.variants : undefined) ?? [];
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

const poolCache = new WeakMap<AnySetData, Pools>();

function requireData(set: SetCode, data: AnySetData | undefined): AnySetData {
  if (!data) throw new Error(`no set data for ${set} (fetch and registerSetData it first)`);
  return data;
}

export function poolsFor(set: SetCode, data: AnySetData | undefined = getSetData(set)): Pools {
  data = requireData(set, data);
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

function rollDraft(set: SetCode, rng: Rng, pools: Pools, template: PackTemplate): PackCard[] {
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
// Generic Collector Booster (runtime sets, 15 cards)
// ---------------------------------------------------------------------------

/** 0-based indices of the foil slots in a generic Collector Booster. */
export const GENERIC_COLLECTOR_FOIL_SLOTS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 11, 12, 13, 14];

/**
 * A Collector Booster for a set without a hand-written template, modelled on
 * the premier-set layout since Throne of Eldraine and derived from the data
 * alone so peers re-roll the same pack from the same Scryfall snapshot:
 *
 *   0        foil basic land
 *   1–4      foil regular commons/uncommons (1/2 uncommon each)
 *   5–6      foil showcase/borderless commons/uncommons
 *   7–8      showcase/borderless commons/uncommons
 *   9        extended-art rare/mythic
 *   10       showcase/borderless rare/mythic
 *   11       foil extended-art rare/mythic
 *   12       foil showcase/borderless rare/mythic
 *   13       foil-etched rare/mythic
 *   14       foil regular rare/mythic (mythic with the generic 1/8 odds)
 *
 * Every slot falls back through the next-best pools (other alternate frames,
 * then the regular printing of that rarity band, then uncommons and commons) so
 * a set with few or no alternate printings still yields 15 distinct cards. Each
 * slot is exactly one `nextInt` (plus one for each 1/2 or mythic roll), so the
 * RNG stream is a pure function of the data.
 */
function rollGenericCollector(set: SetCode, rng: Rng, pools: Pools, template: PackTemplate): { cards: PackCard[]; foil: number[] } {
  const draw = new Drawer(rng, `${set}/collector`);
  const cards: PackCard[] = [];

  const altCU = pools.variants.filter(isCommonOrUncommon);
  const altRM = pools.variants.filter(isRareOrMythic);
  const framedCU = altCU.filter((c) => c.v === 's' || c.v === 'b');
  const framedRM = altRM.filter((c) => c.v === 's' || c.v === 'b');
  const extendedRM = pools.extended.filter(isRareOrMythic);
  const etchedRM = pools.etched.filter(isRareOrMythic);
  const regularCU = [...pools.uncommon, ...pools.common];
  const regularRM = [...pools.rare, ...pools.mythic];

  // 0. foil basic
  cards.push(draw.pick(pools.basics, pools.common, pools.uncommon, regularRM));
  // 1–4. foil regular commons/uncommons
  for (let i = 0; i < 4; i++) cards.push(odds(rng, [1, 2]) ? draw.pick(pools.uncommon, pools.common, regularRM) : draw.pick(pools.common, pools.uncommon, regularRM));
  // 5–6. foil showcase/borderless commons/uncommons; 7–8. the same, non-foil
  for (let i = 0; i < 4; i++) cards.push(draw.pick(framedCU, altCU, pools.uncommon, pools.common, regularRM));
  // 9. extended-art rare/mythic
  cards.push(draw.pick(extendedRM, altRM, regularRM, regularCU));
  // 10. showcase/borderless rare/mythic
  cards.push(draw.pick(framedRM, altRM, regularRM, regularCU));
  // 11. foil extended-art rare/mythic
  cards.push(draw.pick(extendedRM, altRM, regularRM, regularCU));
  // 12. foil showcase/borderless rare/mythic
  cards.push(draw.pick(framedRM, altRM, regularRM, regularCU));
  // 13. foil-etched rare/mythic
  cards.push(draw.pick(etchedRM, altRM, regularRM, regularCU));
  // 14. foil regular rare/mythic
  cards.push(template.mythicOdds && odds(rng, template.mythicOdds) ? draw.pick(pools.mythic, pools.rare, regularCU) : draw.pick(pools.rare, pools.mythic, regularCU));

  if (cards.length !== GENERIC_COLLECTOR_SIZE) throw new Error(`rollPack(${set}/collector): ${cards.length} cards`);
  return { cards, foil: [...GENERIC_COLLECTOR_FOIL_SLOTS] };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Data version stamped on packs of `set`: the bundled `DATA_VERSION` for bundled
 * sets; for runtime sets a fingerprint (FNV-1a over code, pack size, mythic flag
 * and every card id in order) so two peers holding the same Scryfall snapshot
 * verify each other's packs and differing snapshots are treated as unverifiable.
 */
export function dataVersionFor(set: SetCode, data: AnySetData | undefined = getSetData(set)): string {
  if (isBundledSet(set) || !data || !isRuntimeSetData(data)) return DATA_VERSION;
  let v = versionCache.get(data);
  if (!v) {
    let h = 0x811c9dc5;
    const mix = (str: string): void => {
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      h ^= 0x7c;
      h = Math.imul(h, 0x01000193) >>> 0;
    };
    mix(data.code);
    mix(String(data.packSize));
    mix(data.hasMythics ? '1' : '0');
    for (const c of data.cards) mix(c.id);
    mix('basics');
    for (const c of data.basics) mix(c.id);
    if (data.variants?.length || data.setType !== undefined) {
      mix('variants');
      for (const c of data.variants ?? []) mix(c.id + (c.v ?? ''));
      mix(data.setType ?? '');
    }
    v = 'rt' + h.toString(16).padStart(8, '0');
    versionCache.set(data, v);
  }
  return v;
}
const versionCache = new WeakMap<RuntimeSetData, string>();

/**
 * Roll a pack of the given kind. Throws when `kind` is not sold for `set`
 * (see `availablePacks`) or when no data is known for `set`.
 */
export function rollPackOfKind(set: SetCode, kind: PackKind, seedHex: string, data: AnySetData | undefined = getSetData(set)): RolledPack {
  if (!availablePacks(set).includes(kind)) {
    throw new Error(`rollPackOfKind: ${set} has no ${kind} boosters`);
  }
  data = requireData(set, data);
  const pools = poolsFor(set, data);
  const rng = makeRng(seedHex);

  let cards: PackCard[];
  let foil: number[];
  switch (kind) {
    case 'draft':
      cards = rollDraft(set, rng, pools, templateFor(set, data));
      foil = [];
      break;
    case 'set':
      ({ cards, foil } = rollSet(set, rng, pools));
      break;
    case 'collector':
      ({ cards, foil } = isBundledSet(set) ? rollCollector(set, rng, pools) : rollGenericCollector(set, rng, pools, templateFor(set, data)));
      break;
  }

  return { set, kind, seed: seedHex, dataVersion: dataVersionFor(set, data), cards: cards.map((c) => makeRef(set, c.cn)), foil };
}

/** Roll a Draft Booster. Equivalent to `rollPackOfKind(set, 'draft', seedHex, data)`. */
export function rollPack(set: SetCode, seedHex: string, data: AnySetData | undefined = getSetData(set)): RolledPack {
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
 * (unverifiable) when we hold no data for the set or when the data version
 * differs from ours — we cannot verify against data we do not have.
 */
export function verifyPack(pack: RolledPack): boolean {
  const data = getSetData(pack.set);
  if (!data) return true;
  if (pack.dataVersion !== dataVersionFor(pack.set, data)) return true;
  let again: RolledPack;
  try {
    again = rollPackOfKind(pack.set, pack.kind ?? 'draft', pack.seed, data);
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
