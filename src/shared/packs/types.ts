/** Any Scryfall set code (lower case, 2–6 alphanumerics). */
export type SetCode = string;
/** The Kamigawa sets whose data ships inside the extension. */
export type BundledSet = 'chk' | 'bok' | 'sok' | 'neo';
export const SET_CODES: readonly BundledSet[] = ['chk', 'bok', 'sok', 'neo'];
export function isBundledSet(set: string): set is BundledSet {
  return (SET_CODES as readonly string[]).includes(set);
}
export function isValidSetCode(set: string): boolean {
  return /^[a-z0-9]{2,6}$/.test(set);
}

export const SET_NAMES: Record<BundledSet, string> = {
  chk: 'Champions of Kamigawa',
  bok: 'Betrayers of Kamigawa',
  sok: 'Saviors of Kamigawa',
  neo: 'Kamigawa: Neon Dynasty',
};

export type Rarity = 'c' | 'u' | 'r' | 'm';

/** Booster products. Only Neon Dynasty was sold as Set and Collector boosters. */
export type PackKind = 'draft' | 'set' | 'collector';
export const PACK_KINDS: readonly PackKind[] = ['draft', 'set', 'collector'];
export const PACK_KIND_NAMES: Record<PackKind, string> = { draft: 'Draft Booster', set: 'Set Booster', collector: 'Collector Booster' };
export const AVAILABLE_PACKS: Record<BundledSet, readonly PackKind[]> = {
  chk: ['draft'],
  bok: ['draft'],
  sok: ['draft'],
  neo: ['draft', 'set', 'collector'],
};
/** Booster kinds that can be rolled for a set (runtime-fetched sets are draft only). */
export function availablePacks(set: SetCode): readonly PackKind[] {
  return isBundledSet(set) ? AVAILABLE_PACKS[set] : ['draft'];
}
/** Human name for a set: bundled name, a registered runtime name, or the upper-cased code. */
const runtimeSetNames = new Map<string, string>();
export function registerSetName(set: SetCode, name: string): void {
  runtimeSetNames.set(set, name);
}
export function setName(set: SetCode): string {
  return isBundledSet(set) ? SET_NAMES[set] : (runtimeSetNames.get(set) ?? set.toUpperCase());
}
export function packLabel(set: SetCode, kind: PackKind): string {
  return `${setName(set)} ${PACK_KIND_NAMES[kind]}`;
}

/** Alternate-frame printing kinds: showcase, borderless, extended art, foil-etched / neon ink. */
export type Variant = 's' | 'b' | 'e' | 'x';

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
  /** alternate-frame variant kind (absent for the regular printing) */
  v?: Variant;
  /** collector-booster-only printing (not found in draft/set boosters) */
  co?: boolean;
}

export interface SetData {
  code: SetCode;
  name: string;
  released: string;
  /** all booster-eligible non-basic cards, sorted by collector number */
  cards: PackCard[];
  /** neo only: the ukiyo-e basics */
  basics?: PackCard[];
  /** neo only: collector-booster-only alternate printings (showcase, borderless, extended art, etched) */
  variants?: PackCard[];
}

/** Stable, data-version-independent wire reference: "neo:77". */
export type CardRef = `${SetCode}:${string}`;

export function makeRef(set: SetCode, cn: string): CardRef {
  return `${set}:${cn}`;
}

export function parseRef(ref: string): { set: SetCode; cn: string } | null {
  const i = ref.indexOf(':');
  if (i <= 0) return null;
  const set = ref.slice(0, i);
  if (!isValidSetCode(set)) return null;
  const cn = ref.slice(i + 1);
  if (!cn || cn.includes(':')) return null;
  return { set, cn };
}

export interface RolledPack {
  set: SetCode;
  kind: PackKind;
  seed: string;
  dataVersion: string;
  cards: CardRef[];
  /** indices into `cards` that are traditional/etched foil (cosmetic) */
  foil: number[];
}
