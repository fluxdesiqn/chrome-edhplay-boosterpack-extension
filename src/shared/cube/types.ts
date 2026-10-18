/**
 * Custom cube cards (CubeForge) played on edhplay through "carrier" cards.
 *
 * edhplay only knows real Magic cards, so every custom card rides on one
 * dedicated real card (its carrier): decks hold the carrier, the server deals
 * with the carrier, and every client with the extension paints the carrier as
 * the custom card wherever it appears (deck builder, lobby, game). The
 * carrier → custom mapping is fixed per cube, so it needs no syncing and keeps
 * hidden zones hidden.
 */

/** One custom card, normalised from CubeForge. */
export interface CubeCard {
  /** CubeForge oracle id (`custom-<uuid>`); stable across edits and duplicate copies. */
  key: string;
  name: string;
  typeLine: string;
  manaCost: string;
  cmc: number;
  colors: string[];
  colorIdentity: string[];
  /** Rules text of this face only (a printed back face is cut off). */
  oracleText: string;
  image: string;
  power: string | null;
  toughness: string | null;
  rarity: string;
  /** From the cube's Considering list: tokens and back faces, not drafted. */
  considering: boolean;
  /** Key of the card printed on the back (transform, battle, …), if any. */
  back: string | null;
  addedAt: string;
}

export interface CubeSnapshot {
  id: string;
  name: string;
  /** CubeForge revision counter, when known. */
  revision: number | null;
  fetchedAt: number;
  cards: CubeCard[];
}

/** A real edhplay card that stands in for one custom card. */
export interface Carrier {
  card_id: string;
  /** Print the extension uses when it creates the card itself (tokens). */
  card_print_id: string;
  /** Every known print of the carrier, so any printing chosen in the deck builder is recognised. */
  print_ids: string[];
  name: string;
  type_line: string;
  /** Scryfall id embedded in the default print's image URL (deck cover art matching). */
  image_id: string | null;
  /** Legendary creature, so it is safe in a commander slot. */
  legendary: boolean;
}

/** Cube data the build script bakes into the extension. */
export interface BakedCube {
  id: string;
  name: string;
  url: string;
  snapshot: CubeSnapshot;
  /** card key → index into the carrier pool. Append-only: never reassign a key. */
  carriers: Record<string, number>;
}
