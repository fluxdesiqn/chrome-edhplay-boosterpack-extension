/**
 * Map pack `CardRef`s back to card data and to the identity fields the rewrite
 * engine overlays on a blank edhplay card.
 */
import type { CardIdentity } from '@shared/protocol';
import { SET_DATA } from './data';
import { type AnySetData, _resetRegistryIndexes, cardByCn, getSetData } from './registry';
import { type CardRef, type PackCard, type Rarity, SET_CODES, type SetCode, parseRef, setName } from './types';

/**
 * Card behind a ref, from bundled data or a registered runtime set (see
 * registry.ts). Null for unknown sets, unknown collector numbers and bad refs.
 */
export function findCard(ref: CardRef | string): PackCard | null {
  const parsed = parseRef(ref);
  if (!parsed) return null;
  return cardByCn(parsed.set, parsed.cn);
}

/** Booster-eligible non-basic cards of a set (empty when no data is known). */
export function cardsInSet(set: SetCode): PackCard[] {
  return getSetData(set)?.cards ?? [];
}

/**
 * NEO's only neon-ink printings are the three Hidetsugu, Devouring Chaos
 * collector-booster variants; every other `v: 'x'` printing is foil-etched showcase.
 */
const NEON_INK_NAME = 'Hidetsugu, Devouring Chaos';

/** Human label for an alternate-frame printing, or null for a regular one. */
export function variantLabel(card: PackCard): string | null {
  switch (card.v) {
    case 's':
      return 'Showcase';
    case 'b':
      return 'Borderless';
    case 'e':
      return 'Extended art';
    case 'x':
      return card.name === NEON_INK_NAME ? 'Neon ink' : 'Foil etched';
    default:
      return null;
  }
}

const RARITY_WORD: Record<Rarity, string> = { c: 'common', u: 'uncommon', r: 'rare', m: 'mythic' };

export function scryfallImage(id: string, face: 'front' | 'back'): string {
  return `https://cards.scryfall.io/normal/${face}/${id[0]}/${id[1]}/${id}.jpg`;
}

/**
 * Identity overlay for a card. Bundled cards (and runtime cards once
 * `registerPrints` filled their `ep`/`ec`) carry real edhplay ids; a runtime
 * card that is not resolved yet gets the synthetic `hok-<scryfallId>` /
 * `hok-card-<scryfallId>` pair.
 */
export function identityFor(ref: CardRef | string): CardIdentity | null {
  const parsed = parseRef(ref);
  const card = findCard(ref);
  if (!parsed || !card) return null;
  const identity: CardIdentity = {
    card_id: card.ec ?? `hok-card-${card.id}`,
    card_print_id: card.ep ?? `hok-${card.id}`,
    name: card.name,
    type_line: card.t,
    front_image_uri: scryfallImage(card.id, 'front'),
    back_image_uri: card.l === 't' ? scryfallImage(card.id, 'back') : null,
    can_rotate: card.l === 'f',
    power: card.p ?? null,
    toughness: card.q ?? null,
    rarity: RARITY_WORD[card.r],
    set_name: setName(parsed.set),
  };
  if (card.mana_cost !== undefined) identity.mana_cost = card.mana_cost;
  if (card.cmc !== undefined) identity.cmc = card.cmc;
  if (card.ci !== undefined) identity.color_identity = card.ci;
  return identity;
}

let nameSet: Set<string> | null = null;
const setNameCache = new WeakMap<AnySetData, Set<string>>();

/** Test hook: drop the lazily built per-set indexes and the name sets. */
export function _resetIdentityCaches(): void {
  _resetRegistryIndexes();
  nameSet = null;
}

function namesOf(data: AnySetData): Set<string> {
  let names = setNameCache.get(data);
  if (!names) {
    names = new Set();
    for (const c of [...data.cards, ...(data.basics ?? [])]) {
      names.add(c.name);
      const front = c.name.split(' // ')[0];
      if (front) names.add(front);
    }
    setNameCache.set(data, names);
  }
  return names;
}

/** True when `name` is the full or front-face name of a card in `set` (false when the set has no data). */
export function isNameInSet(set: SetCode, name: string): boolean {
  const data = getSetData(set);
  return data ? namesOf(data).has(name) : false;
}

/** True when `name` is the full or front-face name of any card in the four Kamigawa sets. */
export function isKamigawaName(name: string): boolean {
  if (!nameSet) {
    nameSet = new Set();
    for (const set of SET_CODES) {
      const data = SET_DATA[set];
      for (const c of [...data.cards, ...(data.basics ?? [])]) {
        nameSet.add(c.name);
        const front = c.name.split(' // ')[0];
        if (front) nameSet.add(front);
      }
    }
  }
  return nameSet.has(name);
}
