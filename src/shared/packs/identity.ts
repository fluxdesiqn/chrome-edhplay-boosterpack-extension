/**
 * Map pack `CardRef`s back to card data and to the identity fields the rewrite
 * engine overlays on a blank edhplay card.
 */
import type { CardIdentity } from '@shared/protocol';
import { SET_DATA } from './data';
import { SET_CODES, SET_NAMES, parseRef, type CardRef, type PackCard, type Rarity, type SetCode } from './types';

const indexCache = new Map<SetCode, Map<string, PackCard>>();

function indexFor(set: SetCode): Map<string, PackCard> {
  let idx = indexCache.get(set);
  if (!idx) {
    idx = new Map();
    const data = SET_DATA[set];
    for (const c of data.cards) idx.set(c.cn, c);
    for (const c of data.basics ?? []) if (!idx.has(c.cn)) idx.set(c.cn, c);
    for (const c of data.variants ?? []) if (!idx.has(c.cn)) idx.set(c.cn, c);
    indexCache.set(set, idx);
  }
  return idx;
}

export function findCard(ref: CardRef | string): PackCard | null {
  const parsed = parseRef(ref);
  if (!parsed) return null;
  return indexFor(parsed.set).get(parsed.cn) ?? null;
}

export function cardsInSet(set: SetCode): PackCard[] {
  return SET_DATA[set].cards;
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
    set_name: SET_NAMES[parsed.set],
  };
  if (card.mana_cost !== undefined) identity.mana_cost = card.mana_cost;
  if (card.cmc !== undefined) identity.cmc = card.cmc;
  if (card.ci !== undefined) identity.color_identity = card.ci;
  return identity;
}

let nameSet: Set<string> | null = null;

/** Test hook: drop the lazily built per-set indexes and the name set. */
export function _resetIdentityCaches(): void {
  indexCache.clear();
  nameSet = null;
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
