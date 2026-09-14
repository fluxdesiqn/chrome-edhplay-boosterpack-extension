/** Deterministic decks for the scenarios, built from the unit-test fixtures. */
import type { WireCard } from '@shared/protocol';
import { makeReal, makeWastes } from '../fixtures/game-state';

export interface DeckSpec {
  wastes: number;
  real: number;
  /** blanks placed among the first `handSize` cards (default 3; 0 = no hand blanks) */
  handWastes?: number;
  handSize?: number;
}

/**
 * Deck order = [hand: `handWastes` Wastes + real cards][remaining Wastes][remaining real].
 * The server deals the first `handSize` cards to the hand without shuffling.
 */
export function buildDeck(spec: DeckSpec, ownerId: string): WireCard[] {
  const handSize = spec.handSize ?? 7;
  const handWastes = Math.min(spec.handWastes ?? 3, spec.wastes, handSize);
  const handReal = handSize - handWastes;
  if (spec.real < handReal) throw new Error(`buildDeck: need at least ${handReal} real cards for the opening hand`);
  const wastes = makeWastes(spec.wastes, ownerId, 'library');
  const real = makeReal(spec.real, ownerId, 'library');
  return [...wastes.slice(0, handWastes), ...real.slice(0, handReal), ...wastes.slice(handWastes), ...real.slice(handReal)];
}
