/**
 * Lookup tables from carrier ids to custom cards, plus the overlays that paint
 * a carrier as its custom card in edhplay's REST and game messages. Overlays
 * never touch `card_id`/`card_print_id`: edhplay keeps acting on the carrier.
 */
import { assignCarriers } from './carriers';
import { normName } from './parse';
import type { Carrier, CubeCard, CubeSnapshot } from './types';

export interface CubeEntry {
  card: CubeCard;
  carrier: Carrier;
  back: CubeCard | null;
}

export type TokenFilter = 'exclude' | 'only' | 'include';

function isPlainObject(o: unknown): o is Record<string, unknown> {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
  const proto = Object.getPrototypeOf(o);
  return proto === Object.prototype || proto === null;
}

export class CubeCatalog {
  readonly entries: CubeEntry[] = [];
  readonly unassigned: CubeCard[] = [];
  readonly #byCardId = new Map<string, CubeEntry>();
  readonly #byPrintId = new Map<string, CubeEntry>();
  readonly #byName = new Map<string, CubeEntry>();
  readonly #byCarrierName = new Map<string, CubeEntry>();
  readonly #byImageId = new Map<string, CubeEntry>();

  constructor(
    readonly snapshot: CubeSnapshot,
    pool: readonly Carrier[],
    baked: Readonly<Record<string, number>>,
  ) {
    const { byKey } = assignCarriers(snapshot.cards, pool, baked);
    const byKeyCard = new Map(snapshot.cards.map((c) => [c.key, c]));
    for (const card of snapshot.cards) {
      const i = byKey.get(card.key);
      const carrier = i === undefined ? undefined : pool[i];
      if (!carrier) {
        this.unassigned.push(card);
        continue;
      }
      const entry: CubeEntry = { card, carrier, back: card.back ? (byKeyCard.get(card.back) ?? null) : null };
      this.entries.push(entry);
      this.#byCardId.set(carrier.card_id, entry);
      for (const p of [carrier.card_print_id, ...carrier.print_ids]) this.#byPrintId.set(p, entry);
      if (!this.#byName.has(normName(card.name))) this.#byName.set(normName(card.name), entry);
      this.#byCarrierName.set(normName(carrier.name), entry);
      if (carrier.image_id) this.#byImageId.set(carrier.image_id, entry);
    }
    // Then each half of a `Front // Back` name (decklists often list the front
    // only), without shadowing a card whose full name it is.
    for (const entry of this.entries) {
      const halves = entry.card.name.split(' // ');
      if (halves.length > 1) for (const h of halves) if (!this.#byName.has(normName(h))) this.#byName.set(normName(h), entry);
    }
  }

  get size(): number {
    return this.entries.length;
  }

  /** Entry for a card-like object, by `card_id` first, then `card_print_id`. */
  lookup(o: Record<string, unknown>): CubeEntry | null {
    const cid = o['card_id'];
    if (typeof cid === 'string') {
      const e = this.#byCardId.get(cid);
      if (e) return e;
    }
    const pid = o['card_print_id'];
    if (typeof pid === 'string') return this.#byPrintId.get(pid) ?? null;
    return null;
  }

  byCardId(id: string): CubeEntry | null {
    return this.#byCardId.get(id) ?? null;
  }

  byPrintId(id: string): CubeEntry | null {
    return this.#byPrintId.get(id) ?? null;
  }

  byName(name: string): CubeEntry | null {
    return this.#byName.get(normName(name)) ?? null;
  }

  byCarrierName(name: string): CubeEntry | null {
    return this.#byCarrierName.get(normName(name)) ?? null;
  }

  byKey(key: string): CubeEntry | null {
    return this.entries.find((e) => e.card.key === key) ?? null;
  }

  /** Scryfall id in an image URL (`…/front/a/b/<uuid>.jpg`) → entry whose carrier uses it. */
  byImageUrl(url: string): CubeEntry | null {
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(url);
    return m?.[1] ? (this.#byImageId.get(m[1].toLowerCase()) ?? null) : null;
  }

  /** A print id seen next to a carrier card id (another printing picked in the deck builder). */
  learnPrint(cardId: unknown, printId: unknown): void {
    if (typeof cardId !== 'string' || typeof printId !== 'string') return;
    const e = this.#byCardId.get(cardId);
    if (e && !this.#byPrintId.has(printId)) this.#byPrintId.set(printId, e);
  }

  /**
   * Custom cards whose name contains `query`. Deck searches (`exclude`) offer
   * the drafted cards; token searches (`only`) offer the Considering cards
   * (tokens, back faces) first, then the rest for token copies.
   */
  search(query: string, tokens: TokenFilter, limit = 40): CubeEntry[] {
    const q = normName(query);
    if (!q) return [];
    const hits = this.entries.filter((e) => normName(e.card.name).includes(q));
    const rank = (e: CubeEntry) => (normName(e.card.name).startsWith(q) ? 0 : 1);
    const pick = (list: CubeEntry[]) => list.sort((a, b) => rank(a) - rank(b) || a.card.name.localeCompare(b.card.name));
    const main = pick(hits.filter((e) => !e.card.considering));
    const extra = pick(hits.filter((e) => e.card.considering));
    const ordered = tokens === 'exclude' ? main : tokens === 'only' ? [...extra, ...main] : [...main, ...extra];
    return ordered.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

/** Paint `o` (a card object from edhplay) as the custom card. Returns a new object. */
export function overlayCube(o: Record<string, unknown>, e: CubeEntry): Record<string, unknown> {
  const c = e.card;
  const out: Record<string, unknown> = { ...o };
  out['name'] = c.name;
  out['type_line'] = c.typeLine;
  out['front_image_uri'] = c.image;
  out['back_image_uri'] = e.back?.image ?? null;
  const ifPresent: Record<string, unknown> = {
    power: c.power,
    toughness: c.toughness,
    mana_cost: c.manaCost,
    cmc: c.cmc,
    color_identity: c.colorIdentity,
    colors: c.colors,
    oracle_text: c.oracleText,
    oracle_name: c.name,
    rarity: c.rarity,
    printed_name: null,
    flavor_name: '',
    game_changer: false,
    image_uri: c.image,
  };
  for (const [k, v] of Object.entries(ifPresent)) if (k in o) out[k] = v;
  return out;
}

/** A row for edhplay's card search (`/cards/prints`) that adds the carrier when picked. */
export function searchRow(e: CubeEntry): Record<string, unknown> {
  const c = e.card;
  return {
    card_id: e.carrier.card_id,
    card_print_id: e.carrier.card_print_id,
    name: c.name,
    type_line: c.typeLine,
    cmc: c.cmc,
    mana_cost: c.manaCost,
    color_identity: c.colorIdentity,
    rarity: c.rarity,
    front_image_uri: c.image,
    back_image_uri: e.back?.image ?? null,
    printed_name: null,
    flavor_name: '',
    game_changer: false,
    power: c.power,
    toughness: c.toughness,
    can_rotate: false,
  };
}

/** Response for `/cards/prints/{id}/details` (the card info dialog). */
export function detailsFor(e: CubeEntry, cubeName: string): Record<string, unknown> {
  const face = (c: CubeCard) => ({
    name: c.name,
    mana_cost: c.manaCost,
    type_line: c.typeLine,
    oracle_text: c.oracleText,
    power: c.power,
    toughness: c.toughness,
    loyalty: null,
  });
  return {
    name: e.card.name,
    oracle_name: e.card.name,
    faces: e.back ? [face(e.card), face(e.back)] : [face(e.card)],
    rulings: [],
    legalities: {},
    rarity: e.card.rarity,
    set_code: 'cstm',
    set_name: cubeName,
    collector_number: '',
    front_image_uri: e.card.image,
    back_image_uri: e.back?.image ?? null,
    price_manapool_cents: null,
  };
}

/**
 * Walk a REST response and paint every carrier as its custom card: card
 * objects, translation maps keyed by print id, and deck summaries (cover art,
 * commander name). Copy-on-write; returns the input when nothing matched.
 */
export function rewriteApiJson(json: unknown, cat: CubeCatalog): unknown {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      let out: unknown[] | null = null;
      for (let i = 0; i < node.length; i++) {
        const next = walk(node[i]);
        if (next !== node[i]) (out ??= node.slice())[i] = next;
      }
      return out ?? node;
    }
    if (!isPlainObject(node)) return node;
    let base = node;
    let cloned = false;
    const clone = () => {
      if (!cloned) {
        base = { ...node };
        cloned = true;
      }
    };

    if (typeof node['card_id'] === 'string' || typeof node['card_print_id'] === 'string') {
      cat.learnPrint(node['card_id'], node['card_print_id']);
      const e = cat.lookup(node);
      if (e) {
        base = overlayCube(node, e);
        cloned = true;
      }
    }
    if (typeof node['commander_name'] === 'string') {
      const e = cat.byCarrierName(node['commander_name']);
      if (e) {
        clone();
        base['commander_name'] = e.card.name;
      }
    }
    if (typeof node['deck_image_uri'] === 'string') {
      const e = cat.byImageUrl(node['deck_image_uri']);
      if (e) {
        clone();
        base['deck_image_uri'] = e.card.image;
      }
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (typeof child !== 'object' || child === null) continue;
      let next = walk(child);
      // Translation maps: { [card_print_id]: { printed_name, front_image_uri, … } }
      const keyed = isPlainObject(next) ? cat.byPrintId(key) : null;
      if (keyed && isPlainObject(next)) {
        const t: Record<string, unknown> = { ...next };
        if ('printed_name' in t) t['printed_name'] = keyed.card.name;
        if ('name' in t) t['name'] = keyed.card.name;
        if ('front_image_uri' in t) t['front_image_uri'] = keyed.card.image;
        if ('back_image_uri' in t) t['back_image_uri'] = keyed.back?.image ?? null;
        if ('type_line' in t) t['type_line'] = keyed.card.typeLine;
        if ('oracle_text' in t) t['oracle_text'] = keyed.card.oracleText;
        next = t;
      }
      if (next !== child) {
        clone();
        base[key] = next;
      }
    }
    return base;
  };
  return walk(json);
}

/**
 * Card search response: drop the carriers' own rows (searching "Cao Cao"
 * should not offer a custom card) and put matching custom cards on page one.
 */
export function rewriteSearch(json: unknown, url: URL, cat: CubeCatalog): unknown {
  if (!isPlainObject(json) || !Array.isArray(json['data'])) return json;
  const data = (json['data'] as unknown[]).filter((r) => !(isPlainObject(r) && typeof r['card_id'] === 'string' && cat.byCardId(r['card_id'])));
  const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
  const page = Number(url.searchParams.get('page') ?? '1') || 1;
  const name = url.searchParams.get('name') ?? '';
  const tokens = (url.searchParams.get('tokens') as TokenFilter | null) ?? 'include';
  const extra = skip === 0 && page <= 1 && name ? cat.search(name, tokens).map(searchRow) : [];
  if (extra.length === 0 && data.length === (json['data'] as unknown[]).length) return json;
  return { ...json, data: [...extra, ...data] };
}

interface ImportLine {
  name?: unknown;
  set_code?: unknown;
  collector_number?: unknown;
  [k: string]: unknown;
}

/**
 * Deck import (`/decks/{id}/bulk-import`): swap custom card names for their
 * carriers so a list exported from CubeForge imports whole. Returns null when
 * nothing changed.
 */
export function rewriteBulkImport(body: Record<string, unknown>, cat: CubeCatalog): Record<string, unknown> | null {
  let changed = false;
  const swapName = (name: unknown): unknown => {
    if (typeof name !== 'string') return name;
    const e = cat.byName(name);
    if (!e) return name;
    changed = true;
    return e.carrier.name;
  };
  const swapList = (list: unknown): unknown =>
    Array.isArray(list)
      ? list.map((l: ImportLine) => {
          if (!isPlainObject(l)) return l;
          const name = swapName(l.name);
          if (name === l.name) return l;
          const { set_code: _s, collector_number: _c, ...rest } = l;
          return { ...rest, name };
        })
      : list;
  const out: Record<string, unknown> = { ...body };
  for (const k of ['cards', 'sideboard_cards']) if (k in body) out[k] = swapList(body[k]);
  for (const k of ['commander', 'partner_commander', 'companion']) if (k in body) out[k] = swapName(body[k]);
  return changed ? out : null;
}
