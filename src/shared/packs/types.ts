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

/** The Neon Dynasty Commander decks: a Kamigawa product fetched from Scryfall like any other runtime set. */
export const NEC_CODE: SetCode = 'nec';
/** Products in the picker's Kamigawa row: the four bundled sets plus the Neon Dynasty Commander decks. */
export const KAMIGAWA_PRODUCTS: readonly { code: SetCode; name: string }[] = [
  ...SET_CODES.map((code) => ({ code, name: SET_NAMES[code] })),
  { code: NEC_CODE, name: 'Neon Dynasty Commander' },
];
export function isKamigawaProduct(set: SetCode): boolean {
  return KAMIGAWA_PRODUCTS.some((p) => p.code === set);
}

export type Rarity = 'c' | 'u' | 'r' | 'm';

/** Booster products. Of the bundled sets only Neon Dynasty was sold as Set and Collector boosters. */
export type PackKind = 'draft' | 'set' | 'collector';
export const PACK_KINDS: readonly PackKind[] = ['draft', 'set', 'collector'];
export const PACK_KIND_NAMES: Record<PackKind, string> = { draft: 'Play Booster', set: 'Set Booster', collector: 'Collector Booster' };
/** Kinds a player can choose. The standard booster ("Play") resolves to a Draft (15) or Play (14) booster internally. */
export const SELECTABLE_KINDS: readonly PackKind[] = ['draft', 'collector'];
export const KIND_SHORT_NAMES: Record<PackKind, string> = { draft: 'Play', set: 'Set', collector: 'Collector' };
export const AVAILABLE_PACKS: Record<BundledSet, readonly PackKind[]> = {
  chk: ['draft'],
  bok: ['draft'],
  sok: ['draft'],
  neo: ['draft', 'set', 'collector'],
};
const RUNTIME_DRAFT_ONLY: readonly PackKind[] = ['draft'];
const RUNTIME_WITH_COLLECTOR: readonly PackKind[] = ['draft', 'collector'];
/**
 * Booster kinds that can be rolled for a set. Bundled sets use the product table;
 * a runtime set offers Collector Boosters when its registered info (or the
 * `meta` of its Scryfall set summary, before it is registered) says so — see
 * `setInfoFor`. Every peer derives the same answer from the same Scryfall meta.
 */
export function availablePacks(set: SetCode, meta?: { type: string; released: string }): readonly PackKind[] {
  if (isBundledSet(set)) return AVAILABLE_PACKS[set];
  const info = runtimeSetInfo.get(set) ?? (meta ? setInfoFor(meta.type, meta.released) : undefined);
  return info?.collector ? RUNTIME_WITH_COLLECTOR : RUNTIME_DRAFT_ONLY;
}
/** Human name for a set: bundled name, a registered runtime name, or the upper-cased code. */
const runtimeSetNames = new Map<string, string>(KAMIGAWA_PRODUCTS.map((p) => [p.code, p.name]));
export function registerSetName(set: SetCode, name: string): void {
  runtimeSetNames.set(set, name);
}
export function setName(set: SetCode): string {
  return isBundledSet(set) ? SET_NAMES[set] : (runtimeSetNames.get(set) ?? set.toUpperCase());
}
/** Sets from February 2024 on were sold as Play Boosters (14 cards) instead of Draft Boosters. */
export const PLAY_BOOSTER_FROM = '2024-02-01';
/** Collector Boosters exist for booster sets from Throne of Eldraine (2019-10-04) on. */
export const COLLECTOR_BOOSTER_FROM = '2019-10-04';
/** Scryfall set types that were sold as boosters. */
export const BOOSTER_SET_TYPES: ReadonlySet<string> = new Set(['core', 'expansion', 'masters', 'draft_innovation', 'funny']);
/** Scryfall set types the picker offers although they were never boosters (preconstructed Commander decks). */
export const PRECON_SET_TYPES: ReadonlySet<string> = new Set(['commander']);
/** What a runtime set was sold as, derived from its Scryfall set type and release date. */
export interface SetInfo {
  /** sold as boosters at all (false for preconstructed deck sets: a "pack" is just 15 random cards of the set) */
  booster: boolean;
  /** 14-card Play Boosters (2024-02 on) rather than 15-card Draft Boosters */
  playBooster: boolean;
  /** Collector Boosters were sold for the set */
  collector: boolean;
}
export function setInfoFor(type: string, released: string): SetInfo {
  const booster = BOOSTER_SET_TYPES.has(type);
  return { booster, playBooster: released >= PLAY_BOOSTER_FROM, collector: booster && released >= COLLECTOR_BOOSTER_FROM };
}
const runtimeSetInfo = new Map<string, SetInfo>();
export function registerSetInfo(set: SetCode, info: SetInfo): void {
  runtimeSetInfo.set(set, info);
}
export function isPlayBoosterSet(set: SetCode, released?: string): boolean {
  if (isBundledSet(set)) return false;
  const info = runtimeSetInfo.get(set);
  if (info) return info.playBooster;
  return !!released && released >= PLAY_BOOSTER_FROM;
}
/** Test hook: forget every registered runtime set name and info (bundled data is untouched). */
export function _resetSetInfo(): void {
  runtimeSetInfo.clear();
  runtimeSetNames.clear();
  for (const p of KAMIGAWA_PRODUCTS) runtimeSetNames.set(p.code, p.name);
}
/**
 * The booster name a player would recognise. The standard booster is shown as a
 * "Play Booster" everywhere (the era-correct 14/15-card product is rolled
 * internally); a set that was never sold as boosters just opens a "Pack".
 */
export function kindName(set: SetCode, kind: PackKind, released?: string): string {
  void released;
  if (kind === 'draft' && !isBundledSet(set) && runtimeSetInfo.get(set)?.booster === false) return 'Pack';
  return PACK_KIND_NAMES[kind];
}
export function packLabel(set: SetCode, kind: PackKind): string {
  return `${setName(set)} ${kindName(set, kind)}`;
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
