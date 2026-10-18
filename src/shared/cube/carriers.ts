/**
 * Carrier assignment. Every client must map the same custom card to the same
 * carrier, so the assignment is a pure function of (pool, baked table, cube):
 * baked entries win, and cards added to the cube after the build take the next
 * free pool slot in (addedAt, key) order. Adding cards never moves an existing
 * card; rebuilding the data (`npm run cube`) freezes the new ones.
 */
import type { Carrier, CubeCard } from './types';

/** Legendary creatures and planeswalkers may lead a deck, so they get a legendary carrier. */
export function wantsLegendaryCarrier(card: CubeCard): boolean {
  return /legendary/i.test(card.typeLine) && /creature|planeswalker/i.test(card.typeLine);
}

export interface Assignment {
  /** card key → pool index */
  byKey: Map<string, number>;
  /** cards that found no free carrier */
  unassigned: string[];
}

export function assignCarriers(cards: readonly CubeCard[], pool: readonly Carrier[], baked: Readonly<Record<string, number>>): Assignment {
  const byKey = new Map<string, number>();
  const used = new Set<number>();
  for (const c of cards) {
    const i = baked[c.key];
    if (i !== undefined && pool[i] && !used.has(i)) {
      byKey.set(c.key, i);
      used.add(i);
    }
  }
  // Slots held by baked cards that have since left the cube stay reserved, so a
  // card that comes back gets its old carrier and nobody else takes it.
  for (const i of Object.values(baked)) used.add(i);

  const rest = cards
    .filter((c) => !byKey.has(c.key))
    .sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const unassigned: string[] = [];
  const nextFree = (legendary: boolean): number => {
    for (let i = 0; i < pool.length; i++) if (!used.has(i) && pool[i]!.legendary === legendary) return i;
    return -1;
  };
  for (const c of rest) {
    const legendary = wantsLegendaryCarrier(c);
    let i = nextFree(legendary);
    if (i < 0) i = nextFree(!legendary);
    if (i < 0) {
      unassigned.push(c.key);
      continue;
    }
    used.add(i);
    byKey.set(c.key, i);
  }
  return { byKey, unassigned };
}
