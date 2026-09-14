/**
 * Runtime (non-bundled) set data, fetched from Scryfall by the background
 * worker and handed to the MAIN-world engine through the bridge.
 */
import type { PackCard, SetCode } from './types';

export interface SetSummary {
  code: SetCode;
  name: string;
  released: string;
  cardCount: number;
  /** Scryfall set_type (expansion, core, masters, draft_innovation, …) */
  type: string;
  iconSvg?: string;
}

export interface RuntimeSetData {
  code: SetCode;
  name: string;
  released: string;
  /** booster-eligible non-basic cards sorted by collector number */
  cards: PackCard[];
  /** basic lands found in boosters (may be empty) */
  basics: PackCard[];
  /** true when the set has mythic rares */
  hasMythics: boolean;
  /** Scryfall booster size hint when known (14 for Play Boosters, else 15) */
  packSize: number;
  fetchedAt: number;
}
