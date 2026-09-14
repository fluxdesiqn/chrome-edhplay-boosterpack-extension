/**
 * Scryfall client for runtime (non-bundled) sets: the booster-capable set list
 * and the booster-eligible cards of one set, mapped to `PackCard` exactly like
 * `scripts/build-set-data.ts` does for the bundled sets (the mapping is copied,
 * not imported — the script is a node-only tool).
 *
 * Results are cached in chrome.storage.local via cache.ts. edhplay print ids are
 * *not* resolved here (one edhplay call per card is far too slow for a 300-card
 * set); the engine asks for them per pack through `prints.resolveCards`.
 */
import type { RuntimeSetData, SetSummary } from '@shared/packs/runtime';
import type { Layout, PackCard, Rarity } from '@shared/packs/types';
import { cacheGet, cacheSet } from './cache';

export const SCRYFALL_BASE = 'https://api.scryfall.com';
const USER_AGENT = 'HoK-edhplay-extension/0.2';
/** Scryfall asks for 50–100 ms between requests. */
const GAP_MS = 100;

export const SETS_CACHE_KEY = 'sets:list';
export const SETS_TTL = 7 * 24 * 3600 * 1000;
export const setCardsCacheKey = (code: string): string => `sets:cards:${code}`;
export const SET_CARDS_TTL = 30 * 24 * 3600 * 1000;

/** Sets that were sold as boosters and have enough cards to draft. */
export const BOOSTER_SET_TYPES: ReadonlySet<string> = new Set(['core', 'expansion', 'masters', 'draft_innovation', 'funny']);
export const MIN_SET_CARDS = 60;
/** Play Boosters (14 cards) replaced Draft Boosters from Murders at Karlov Manor on. */
export const PLAY_BOOSTER_FROM = '2024-02-01';

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

export class ScryfallError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    detail?: string,
  ) {
    super(`Scryfall ${status} for ${url}${detail ? `: ${detail}` : ''}`);
    this.name = 'ScryfallError';
  }
}

/** Paced GET; 404 resolves to `null` (Scryfall's "no results"/"unknown"), 429/5xx retry once. */
async function scryfallGet<T>(url: string, attempt = 0): Promise<T | null> {
  const wait = lastRequestAt + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (res.status === 404) return null;
  if ((res.status === 429 || res.status >= 500) && attempt < 1) {
    await sleep(2000);
    return scryfallGet<T>(url, attempt + 1);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new ScryfallError(res.status, url, detail);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Scryfall shapes (subset)
// ---------------------------------------------------------------------------

interface ScrySet {
  code: string;
  name: string;
  set_type: string;
  released_at?: string;
  card_count: number;
  digital?: boolean;
  icon_svg_uri?: string;
}

interface ScryList<T> {
  data?: T[];
  has_more?: boolean;
  next_page?: string;
}

interface ScryFace {
  name: string;
  type_line?: string;
  power?: string;
  toughness?: string;
  mana_cost?: string;
}

export interface ScryCard {
  id: string;
  name: string;
  collector_number: string;
  rarity: string;
  type_line?: string;
  layout: string;
  power?: string;
  toughness?: string;
  mana_cost?: string;
  cmc?: number;
  color_identity?: string[];
  card_faces?: ScryFace[];
  set?: string;
  set_name?: string;
  released_at?: string;
}

// ---------------------------------------------------------------------------
// card mapping (mirror of scripts/build-set-data.ts)
// ---------------------------------------------------------------------------

const RARITY: Record<string, Rarity> = { common: 'c', uncommon: 'u', rare: 'r', mythic: 'm' };

function layoutOf(card: ScryCard): Layout {
  if (card.layout === 'flip') return 'f';
  if (card.layout === 'transform' || card.layout === 'modal_dfc') return 't';
  return 'n';
}

/** Map one Scryfall card to a `PackCard`; null for rarities outside c/u/r/m (`special`, `bonus`). */
export function toPackCard(card: ScryCard): PackCard | null {
  const r = RARITY[card.rarity];
  if (!r) return null;
  const front: ScryFace | undefined = card.card_faces?.[0];
  const out: PackCard = {
    id: card.id,
    name: card.name,
    cn: card.collector_number,
    r,
    t: card.type_line ?? front?.type_line ?? '',
    l: layoutOf(card),
  };
  const p = front?.power ?? card.power;
  const q = front?.toughness ?? card.toughness;
  if (p !== undefined) out.p = p;
  if (q !== undefined) out.q = q;
  if (out.l === 't') {
    const back = card.card_faces?.[1];
    if (back) {
      const b: NonNullable<PackCard['b']> = { t: back.type_line ?? '' };
      if (back.power !== undefined) b.p = back.power;
      if (back.toughness !== undefined) b.q = back.toughness;
      out.b = b;
    }
  }
  const mana = front?.mana_cost ?? card.mana_cost;
  if (mana !== undefined) out.mana_cost = mana;
  if (card.cmc !== undefined) out.cmc = card.cmc;
  if (card.color_identity) out.ci = card.color_identity;
  return out;
}

/** Numeric collector numbers first in numeric order, then the rest lexically. */
export function cnCompare(a: PackCard, b: PackCard): number {
  const na = parseInt(a.cn, 10);
  const nb = parseInt(b.cn, 10);
  const aNum = Number.isFinite(na);
  const bNum = Number.isFinite(nb);
  if (aNum && bNum && na !== nb) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a.cn < b.cn ? -1 : a.cn > b.cn ? 1 : 0;
}

/** 14 for Play Booster era sets (released on/after 2024-02-01), else 15. */
export function packSizeFor(released: string): number {
  return released && released >= PLAY_BOOSTER_FROM ? 14 : 15;
}

// ---------------------------------------------------------------------------
// set list
// ---------------------------------------------------------------------------

export function toSetSummary(s: ScrySet): SetSummary {
  const out: SetSummary = { code: s.code, name: s.name, released: s.released_at ?? '', cardCount: s.card_count, type: s.set_type };
  if (s.icon_svg_uri) out.iconSvg = s.icon_svg_uri;
  return out;
}

export function isBoosterSet(s: ScrySet): boolean {
  return BOOSTER_SET_TYPES.has(s.set_type) && s.digital !== true && s.card_count >= MIN_SET_CARDS;
}

/** Booster-capable paper sets with ≥60 cards, newest first (Scryfall order). Cached 7 days. */
export async function fetchSetList(): Promise<SetSummary[]> {
  const cached = await cacheGet<SetSummary[]>(SETS_CACHE_KEY);
  if (cached) return cached;
  const url = `${SCRYFALL_BASE}/sets`;
  const list = await scryfallGet<ScryList<ScrySet>>(url);
  if (!list) throw new ScryfallError(404, url);
  const sets = (list.data ?? []).filter(isBoosterSet).map(toSetSummary);
  await cacheSet(SETS_CACHE_KEY, sets, SETS_TTL);
  return sets;
}

// ---------------------------------------------------------------------------
// set cards
// ---------------------------------------------------------------------------

/** Every page of a card search; 404 (no results) → empty. */
async function searchAll(q: string): Promise<ScryCard[]> {
  let url: string | undefined = `${SCRYFALL_BASE}/cards/search?q=${q}&unique=prints&order=set`;
  const out: ScryCard[] = [];
  while (url) {
    const page: ScryList<ScryCard> | null = await scryfallGet<ScryList<ScryCard>>(url);
    if (!page) break;
    out.push(...(page.data ?? []));
    url = page.has_more ? page.next_page : undefined;
  }
  return out;
}

async function setMeta(code: string): Promise<{ name: string; released: string } | null> {
  const cached = await cacheGet<SetSummary[]>(SETS_CACHE_KEY);
  const hit = cached?.find((s) => s.code === code);
  if (hit) return { name: hit.name, released: hit.released };
  const set = await scryfallGet<ScrySet>(`${SCRYFALL_BASE}/sets/${encodeURIComponent(code)}`);
  return set ? { name: set.name, released: set.released_at ?? '' } : null;
}

/**
 * Booster-eligible cards of `code` (non-basics + basics), as `RuntimeSetData`.
 * Throws for unknown sets or sets without booster cards. Cached 30 days.
 */
export async function fetchSetCards(code: string): Promise<RuntimeSetData> {
  code = code.toLowerCase();
  const key = setCardsCacheKey(code);
  const cached = await cacheGet<RuntimeSetData>(key);
  if (cached) return cached;

  const meta = await setMeta(code);
  if (!meta) throw new Error(`unknown set "${code}"`);

  const rawCards = await searchAll(`set:${code}+is:booster+-t:basic`);
  const cards = rawCards.map(toPackCard).filter((c): c is PackCard => c !== null).sort(cnCompare);
  if (cards.length === 0) throw new Error(`set "${code}" has no booster cards`);
  const rawBasics = await searchAll(`set:${code}+is:booster+t:basic`);
  const basics = rawBasics.map(toPackCard).filter((c): c is PackCard => c !== null).sort(cnCompare);

  const data: RuntimeSetData = {
    code,
    name: meta.name,
    released: meta.released,
    cards,
    basics,
    hasMythics: cards.some((c) => c.r === 'm'),
    packSize: packSizeFor(meta.released),
    fetchedAt: Date.now(),
  };
  await cacheSet(key, data, SET_CARDS_TTL);
  return data;
}

/** `sets.cards` RPC body: never throws. */
export async function loadSetCards(code: string): Promise<{ data: RuntimeSetData | null; error?: string }> {
  try {
    return { data: await fetchSetCards(code) };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}
