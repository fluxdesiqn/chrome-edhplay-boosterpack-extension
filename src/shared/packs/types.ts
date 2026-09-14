/** Kamigawa booster sets that can be rolled. */
export type SetCode = 'chk' | 'bok' | 'sok' | 'neo';
export const SET_CODES: readonly SetCode[] = ['chk', 'bok', 'sok', 'neo'];

export const SET_NAMES: Record<SetCode, string> = {
  chk: 'Champions of Kamigawa',
  bok: 'Betrayers of Kamigawa',
  sok: 'Saviors of Kamigawa',
  neo: 'Kamigawa: Neon Dynasty',
};

export type Rarity = 'c' | 'u' | 'r' | 'm';

/** Card layout: normal, flip (CHK-block flip cards), transform (NEO sagas). */
export type Layout = 'n' | 'f' | 't';

export interface PackCard {
  /** Scryfall id */
  id: string;
  name: string;
  /** collector number as printed ("12", "285") */
  cn: string;
  r: Rarity;
  /** type line; for transform cards "Front // Back" */
  t: string;
  p?: string;
  q?: string;
  l: Layout;
  /** transform back face */
  b?: { t: string; p?: string; q?: string };
  /** edhplay card_print_id resolved at build time */
  ep?: string;
  /** edhplay card_id resolved at build time */
  ec?: string;
  mana_cost?: string;
  cmc?: number;
  ci?: string[];
}

export interface SetData {
  code: SetCode;
  name: string;
  released: string;
  /** all booster-eligible non-basic cards, sorted by collector number */
  cards: PackCard[];
  /** neo only: the ukiyo-e basics */
  basics?: PackCard[];
}

/** Stable, data-version-independent wire reference: "neo:77". */
export type CardRef = `${SetCode}:${string}`;

export function makeRef(set: SetCode, cn: string): CardRef {
  return `${set}:${cn}`;
}

export function parseRef(ref: string): { set: SetCode; cn: string } | null {
  const i = ref.indexOf(':');
  if (i <= 0) return null;
  const set = ref.slice(0, i) as SetCode;
  if (!SET_CODES.includes(set)) return null;
  const cn = ref.slice(i + 1);
  if (!cn) return null;
  return { set, cn };
}

export interface RolledPack {
  set: SetCode;
  seed: string;
  dataVersion: string;
  cards: CardRef[];
}
