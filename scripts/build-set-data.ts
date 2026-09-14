/**
 * Build `src/shared/packs/data/{chk,bok,sok,neo}.json` + `index.ts` from Scryfall
 * (card data) and edhplay (print ids).
 *
 *   npx tsx scripts/build-set-data.ts
 *
 * Raw HTTP responses are cached in `.cache/` (gitignored) so re-runs are fast and
 * do not hammer either API. Delete the directory to force a refetch.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BundledSet, Layout, PackCard, Rarity, SetData, Variant } from '../src/shared/packs/types';
import { SET_CODES, SET_NAMES } from '../src/shared/packs/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.cache');
const OUT_DIR = join(ROOT, 'src/shared/packs/data');
const USER_AGENT = 'HoK-edhplay-extension/0.1';
const SCRYFALL_GAP_MS = 100;
const EDHPLAY_GAP_MS = 120;

// ---------------------------------------------------------------------------
// HTTP with on-disk cache + per-host pacing
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const lastRequestAt: Record<string, number> = {};

async function pace(host: string, gapMs: number): Promise<void> {
  const last = lastRequestAt[host] ?? 0;
  const wait = last + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt[host] = Date.now();
}

function cachePath(url: string): string {
  const h = createHash('sha1').update(url).digest('hex');
  return join(CACHE_DIR, `${h}.json`);
}

interface CachedResponse {
  url: string;
  status: number;
  body: unknown;
}

/** GET a JSON URL. 404 is cached as a response (empty result), other errors retry once. */
async function getJson(url: string, gapMs: number): Promise<CachedResponse> {
  const path = cachePath(url);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8')) as CachedResponse;
  }
  const host = new URL(url).host;
  let attempt = 0;
  for (;;) {
    attempt++;
    await pace(host, gapMs);
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    } catch (e) {
      if (attempt >= 2) throw e;
      console.warn(`  ! network error for ${url}: ${(e as Error).message}; retrying in 2 s`);
      await sleep(2000);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 2) throw new Error(`HTTP ${res.status} for ${url}`);
      console.warn(`  ! HTTP ${res.status} for ${url}; retrying in 2 s`);
      await sleep(2000);
      continue;
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (res.status !== 200 && res.status !== 404) {
      throw new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 200)}`);
    }
    const out: CachedResponse = { url, status: res.status, body };
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(out));
    return out;
  }
}

// ---------------------------------------------------------------------------
// Scryfall
// ---------------------------------------------------------------------------

interface ScryFace {
  name: string;
  type_line?: string;
  power?: string;
  toughness?: string;
  mana_cost?: string;
}

interface ScryCard {
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
  frame_effects?: string[];
  border_color?: string;
  finishes?: string[];
  promo_types?: string[];
  digital?: boolean;
  promo?: boolean;
  booster?: boolean;
}

interface ScrySearchPage {
  data?: ScryCard[];
  has_more?: boolean;
  next_page?: string;
}

async function scryfallSearch(q: string): Promise<ScryCard[]> {
  let url: string | undefined = `https://api.scryfall.com/cards/search?q=${q}&unique=prints&order=set`;
  const out: ScryCard[] = [];
  while (url) {
    const res = await getJson(url, SCRYFALL_GAP_MS);
    if (res.status === 404) break; // no results
    const page = res.body as ScrySearchPage;
    out.push(...(page.data ?? []));
    url = page.has_more ? page.next_page : undefined;
  }
  return out;
}

async function scryfallSet(code: BundledSet): Promise<{ name: string; released_at: string }> {
  const res = await getJson(`https://api.scryfall.com/sets/${code}`, SCRYFALL_GAP_MS);
  const body = res.body as { name?: string; released_at?: string } | null;
  return { name: body?.name ?? SET_NAMES[code], released_at: body?.released_at ?? '' };
}

const RARITY: Record<string, Rarity> = { common: 'c', uncommon: 'u', rare: 'r', mythic: 'm' };

function layoutOf(card: ScryCard): Layout {
  if (card.layout === 'flip') return 'f';
  if (card.layout === 'transform' || card.layout === 'modal_dfc') return 't';
  return 'n';
}

function toPackCard(card: ScryCard): PackCard | null {
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

// ---------------------------------------------------------------------------
// NEO collector-booster-only printings (showcase / borderless / extended / etched)
// ---------------------------------------------------------------------------

/**
 * Promo types that match `-is:booster` but were never in Collector Boosters:
 * Alchemy rebalanced digital cards, bundle / buy-a-box / promo-pack / WPN promos
 * and the 2023 "Phyrexia: All Will Be One" set-extension Jin-Gitaxias concept art.
 */
const NON_COLLECTOR_PROMO_TYPES = new Set([
  'rebalanced',
  'alchemy',
  'bundle',
  'buyabox',
  'promopack',
  'prerelease',
  'wizardsplaynetwork',
  'setextension',
  'stepandcompleat',
]);

function isCollectorPrinting(card: ScryCard): boolean {
  if (card.digital || card.promo) return false;
  if (card.collector_number.startsWith('A-')) return false;
  for (const t of card.promo_types ?? []) if (NON_COLLECTOR_PROMO_TYPES.has(t)) return false;
  return true;
}

/** Variant kind with precedence x > b > s > e (a neon-ink borderless is still 'x'). */
function variantOf(card: ScryCard): Variant | null {
  const fx = card.frame_effects ?? [];
  const finishes = card.finishes ?? [];
  const promos = card.promo_types ?? [];
  if (finishes.includes('etched') || promos.includes('neonink')) return 'x';
  if (card.border_color === 'borderless') return 'b';
  if (fx.includes('showcase')) return 's';
  if (fx.includes('extendedart')) return 'e';
  return null;
}

function cnCompare(a: PackCard, b: PackCard): number {
  const na = parseInt(a.cn, 10);
  const nb = parseInt(b.cn, 10);
  const aNum = Number.isFinite(na);
  const bNum = Number.isFinite(nb);
  if (aNum && bNum && na !== nb) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a.cn < b.cn ? -1 : a.cn > b.cn ? 1 : 0;
}

// ---------------------------------------------------------------------------
// edhplay print resolution
// ---------------------------------------------------------------------------

interface EdhPrint {
  card_id?: string;
  card_print_id?: string;
  name?: string;
  front_image_uri?: string | null;
}

interface EdhAlternative {
  id?: string;
  card_print_id?: string;
  front_image_uri?: string | null;
  set_name?: string;
}

type Resolution = 'exact' | 'any' | 'none';

function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === 'object') {
    const data = (v as { data?: unknown }).data;
    if (Array.isArray(data)) return data as T[];
  }
  return [];
}

async function queryPrints(name: string): Promise<EdhPrint[]> {
  const url = `https://api.edhplay.com/api/v1/public/cards/prints?name=${encodeURIComponent(name)}&tokens=exclude&lang=en&limit=50`;
  const res = await getJson(url, EDHPLAY_GAP_MS);
  return asArray<EdhPrint>(res.body).filter((p) => p && typeof p === 'object');
}

async function resolveEdhplay(card: PackCard, setName: string): Promise<Resolution> {
  const fullName = card.name;
  const frontName = fullName.split(' // ')[0] ?? fullName;
  const isMatch = (p: EdhPrint) => p.name === fullName || p.name === frontName;

  let matches = (await queryPrints(fullName)).filter(isMatch);
  if (matches.length === 0 && frontName !== fullName) {
    matches = (await queryPrints(frontName)).filter(isMatch);
  }
  if (matches.length === 0) return 'none';

  const exact = matches.find((p) => (p.front_image_uri ?? '').includes(card.id));
  if (exact?.card_print_id) {
    card.ep = exact.card_print_id;
    if (exact.card_id) card.ec = exact.card_id;
    return 'exact';
  }

  const first = matches[0]!;
  if (first.card_print_id) {
    const url = `https://api.edhplay.com/api/v1/public/cards/prints/${encodeURIComponent(first.card_print_id)}/alternatives?set_name=${encodeURIComponent(setName)}&page_size=100`;
    try {
      const res = await getJson(url, EDHPLAY_GAP_MS);
      const alts = asArray<EdhAlternative>(res.body).filter((a) => a && typeof a === 'object');
      const idOf = (a: EdhAlternative) => a.id ?? a.card_print_id;
      const altExact = alts.find((a) => (a.front_image_uri ?? '').includes(card.id) && idOf(a));
      if (altExact) {
        card.ep = idOf(altExact)!;
        if (first.card_id) card.ec = first.card_id;
        return 'exact';
      }
      const altFirst = alts.find((a) => idOf(a));
      if (altFirst) {
        card.ep = idOf(altFirst)!;
        if (first.card_id) card.ec = first.card_id;
        return 'any';
      }
    } catch (e) {
      console.warn(`  ! alternatives lookup failed for ${fullName}: ${(e as Error).message}`);
    }
    card.ep = first.card_print_id;
    if (first.card_id) card.ec = first.card_id;
    return 'any';
  }
  return 'none';
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface BuildResult {
  data: SetData;
  stats: Record<Resolution, number>;
  variantStats?: Record<Resolution, number>;
}

async function buildSet(code: BundledSet): Promise<BuildResult> {
  console.log(`\n== ${code} ==`);
  const meta = await scryfallSet(code);
  const raw = await scryfallSearch(`set:${code}+is:booster+-t:basic`);
  const cards = raw.map(toPackCard).filter((c): c is PackCard => c !== null).sort(cnCompare);
  console.log(`  scryfall: ${raw.length} booster cards (${cards.length} kept)`);

  let basics: PackCard[] | undefined;
  if (code === 'neo') {
    const rawBasics = await scryfallSearch(`set:${code}+is:booster+t:basic`);
    basics = rawBasics.map(toPackCard).filter((c): c is PackCard => c !== null).sort(cnCompare);
    console.log(`  scryfall: ${basics.length} basics`);
  }

  let variants: PackCard[] | undefined;
  if (code === 'neo') {
    const rawVariants = await scryfallSearch(`set:${code}+-is:booster+-t:basic`);
    const kept = rawVariants.filter(isCollectorPrinting);
    variants = [];
    const byKind: Record<Variant, number> = { s: 0, b: 0, e: 0, x: 0 };
    for (const raw of kept) {
      const v = variantOf(raw);
      if (!v) {
        console.warn(`  ? non-booster printing with no variant kind, skipped: ${raw.name} (${code}:${raw.collector_number})`);
        continue;
      }
      const card = toPackCard(raw);
      if (!card) continue;
      card.v = v;
      card.co = true;
      variants.push(card);
      byKind[v]++;
    }
    variants.sort(cnCompare);
    console.log(
      `  scryfall: ${rawVariants.length} non-booster printings, ${rawVariants.length - kept.length} promo/digital dropped, ${variants.length} variants kept` +
        ` (showcase=${byKind.s} borderless=${byKind.b} extended=${byKind.e} etched/neon=${byKind.x})`,
    );
  }

  const resolveAll = async (list: PackCard[], label: string): Promise<Record<Resolution, number>> => {
    const stats: Record<Resolution, number> = { exact: 0, any: 0, none: 0 };
    let done = 0;
    for (const card of list) {
      const r = await resolveEdhplay(card, meta.name);
      stats[r]++;
      if (r === 'none') console.warn(`  ? unresolved ${label}: ${card.name} (${code}:${card.cn})`);
      done++;
      if (done % 50 === 0) console.log(`  edhplay ${label}: ${done}/${list.length}`);
    }
    console.log(`  edhplay ${label}: exact=${stats.exact} any-print=${stats.any} unresolved=${stats.none}`);
    return stats;
  };

  const stats = await resolveAll([...cards, ...(basics ?? [])], 'cards');
  const variantStats = variants ? await resolveAll(variants, 'variants') : undefined;

  const data: SetData = { code, name: meta.name, released: meta.released_at, cards };
  if (basics) data.basics = basics;
  if (variants) data.variants = variants;
  const out: BuildResult = { data, stats };
  if (variantStats) out.variantStats = variantStats;
  return out;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const sets: SetData[] = [];
  const summary: string[] = [];
  for (const code of SET_CODES) {
    const { data, stats, variantStats } = await buildSet(code);
    sets.push(data);
    writeFileSync(join(OUT_DIR, `${code}.json`), JSON.stringify(data));
    const n = data.cards.length + (data.basics?.length ?? 0);
    summary.push(
      `${code}: ${data.cards.length} cards${data.basics ? ` + ${data.basics.length} basics` : ''}; edhplay exact=${stats.exact} any-print=${stats.any} unresolved=${stats.none} (of ${n})`,
    );
    if (data.variants && variantStats) {
      const by = (v: Variant) => data.variants!.filter((c) => c.v === v).length;
      summary.push(
        `${code} variants: ${data.variants.length} (showcase=${by('s')} borderless=${by('b')} extended=${by('e')} etched/neon=${by('x')});` +
          ` edhplay exact=${variantStats.exact} any-print=${variantStats.any} unresolved=${variantStats.none}`,
      );
    }
  }

  const canonical = JSON.stringify(sets);
  const version = createHash('sha256').update(canonical).digest('hex').slice(0, 8);

  const index = `// GENERATED by scripts/build-set-data.ts — do not edit by hand.
import type { BundledSet, SetData } from '../types';
import chk from './chk.json';
import bok from './bok.json';
import sok from './sok.json';
import neo from './neo.json';

const asSet = (json: unknown): SetData => json as SetData;

export const SET_DATA: Record<BundledSet, SetData> = {
  chk: asSet(chk),
  bok: asSet(bok),
  sok: asSet(sok),
  neo: asSet(neo),
};

/** First 8 hex of sha256 over the canonical JSON of the four sets, in code order. */
export const DATA_VERSION: string = '${version}';
`;
  writeFileSync(join(OUT_DIR, 'index.ts'), index);

  console.log('\n== summary ==');
  for (const line of summary) console.log(line);
  console.log(`DATA_VERSION=${version}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
