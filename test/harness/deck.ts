/** Deterministic decks for the scenarios, built from the unit-test fixtures. */
import type { WireCard } from '@shared/protocol';
import { makeCard, makeReal, makeWastes } from '../fixtures/game-state';
import { HEROES_PRINT_ID } from '@main/engine';

export interface DeckSpec {
  wastes: number;
  real: number;
  /** blanks placed among the first `handSize` cards (default 3; 0 = no hand blanks) */
  handWastes?: number;
  handSize?: number;
  /** 'heroes' puts Heroes of Kamigawa in the command zone; 'other' any other commander; default 'heroes' */
  commander?: 'heroes' | 'other' | 'none';
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
  const commander = spec.commander ?? 'heroes';
  const cz: WireCard[] =
    commander === 'none'
      ? []
      : [
          makeCard({
            owner_id: ownerId,
            zone: 'commandZone',
            card_print_id: commander === 'heroes' ? HEROES_PRINT_ID : 'print-other-commander',
            card_id: commander === 'heroes' ? 'card-heroes' : 'card-other-commander',
            name: commander === 'heroes' ? 'Heroes of Kamigawa' : 'Some Other Commander',
            type_line: commander === 'heroes' ? 'Legendary Planeswalker — Kaito Wanderer' : 'Legendary Creature — Human',
          }),
        ];
  return [...cz, ...wastes.slice(0, handWastes), ...real.slice(0, handReal), ...wastes.slice(handWastes), ...real.slice(handReal)];
}
