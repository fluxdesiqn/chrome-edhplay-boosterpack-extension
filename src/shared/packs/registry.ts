/**
 * Process-local store of set data.
 *
 * The four Kamigawa sets ship inside the extension (`SET_DATA`); any other set is
 * fetched from Scryfall by the background worker and *registered* here at
 * runtime (in the MAIN-world engine and, independently, in every peer that has
 * to verify or display a pack from that set). Bundled data always wins and is
 * never replaced by runtime data.
 *
 * Runtime cards arrive without edhplay ids (`ep` / `ec`); `registerPrints` fills
 * them in later, mutating the registered `PackCard` objects in place so every
 * index built over them sees the real ids immediately.
 */
import { SET_DATA } from './data';
import type { RuntimeSetData } from './runtime';
import { type CardRef, type PackCard, type SetCode, type SetData, isBundledSet, parseRef, registerSetName } from './types';

export type AnySetData = SetData | RuntimeSetData;

export type PrintEntry = { card_print_id: string; card_id: string } | null;

const runtimeSets = new Map<SetCode, RuntimeSetData>();
/** Runtime cards by Scryfall id (across all registered runtime sets). */
const runtimeById = new Map<string, PackCard[]>();
/** Scryfall ids edhplay has no print for (so we stop asking). */
const knownMisses = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (err) {
      console.warn('[HoK] registry listener failed', err);
    }
  }
}

/** Bundled data first, else registered runtime data, else undefined. */
export function getSetData(set: SetCode): AnySetData | undefined {
  if (isBundledSet(set)) return SET_DATA[set];
  return runtimeSets.get(set);
}

export function hasSetData(set: SetCode): boolean {
  return getSetData(set) !== undefined;
}

/** True when `data` is a runtime (Scryfall-fetched) set rather than a bundled one. */
export function isRuntimeSetData(data: AnySetData): data is RuntimeSetData {
  return 'fetchedAt' in data && !isBundledSet(data.code);
}

function allCards(data: AnySetData): PackCard[] {
  const out = [...data.cards, ...(data.basics ?? [])];
  if ('variants' in data && data.variants) out.push(...data.variants);
  return out;
}

function rebuildIdIndex(): void {
  runtimeById.clear();
  for (const data of runtimeSets.values()) {
    for (const c of allCards(data)) {
      const list = runtimeById.get(c.id);
      if (list) list.push(c);
      else runtimeById.set(c.id, [c]);
    }
  }
}

/**
 * Register (or replace) runtime data for a non-bundled set. Bundled set codes
 * are ignored. When the set was already registered, edhplay ids resolved on the
 * old cards are carried over to the new ones by Scryfall id.
 */
export function registerSetData(data: RuntimeSetData): void {
  if (isBundledSet(data.code)) return;
  const previous = runtimeSets.get(data.code);
  if (previous && previous !== data) {
    const old = new Map<string, PackCard>();
    for (const c of allCards(previous)) if (c.ep) old.set(c.id, c);
    for (const c of allCards(data)) {
      const o = old.get(c.id);
      if (o && !c.ep) {
        c.ep = o.ep;
        if (o.ec) c.ec = o.ec;
      }
    }
  }
  runtimeSets.set(data.code, data);
  registerSetName(data.code, data.name);
  rebuildIdIndex();
  indexCache.delete(data.code);
  notify();
}

/**
 * Apply edhplay print resolutions keyed by Scryfall id. `null` marks a card
 * edhplay does not know (remembered so `unresolvedCards` stops reporting it).
 * Only runtime cards are touched: bundled data was resolved at build time.
 */
export function registerPrints(entries: Record<string, PrintEntry>): void {
  let changed = false;
  for (const [scryfallId, entry] of Object.entries(entries)) {
    if (!entry) {
      if (!knownMisses.has(scryfallId)) {
        knownMisses.add(scryfallId);
        changed = true;
      }
      continue;
    }
    knownMisses.delete(scryfallId);
    for (const card of runtimeById.get(scryfallId) ?? []) {
      if (card.ep !== entry.card_print_id || card.ec !== entry.card_id) {
        card.ep = entry.card_print_id;
        card.ec = entry.card_id;
        changed = true;
      }
    }
  }
  if (changed) notify();
}

/**
 * Runtime cards among `refs` that still lack an edhplay print id and are not a
 * known miss — i.e. what to ask the background to resolve before the pack is
 * shown. Deduplicated by Scryfall id; refs without data are skipped (fetch the
 * set first).
 */
export function unresolvedCards(refs: readonly (CardRef | string)[]): Array<{ scryfallId: string; name: string; set: SetCode }> {
  const out: Array<{ scryfallId: string; name: string; set: SetCode }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const parsed = parseRef(ref);
    if (!parsed || isBundledSet(parsed.set)) continue;
    const card = cardByCn(parsed.set, parsed.cn);
    if (!card || card.ep || knownMisses.has(card.id) || seen.has(card.id)) continue;
    seen.add(card.id);
    out.push({ scryfallId: card.id, name: card.name, set: parsed.set });
  }
  return out;
}

/** Subscribe to registry changes (set registered, prints applied). Returns the unsubscribe. */
export function onRegistryChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ---------------------------------------------------------------------------
// collector-number index (shared by identity.ts)
// ---------------------------------------------------------------------------

const indexCache = new Map<SetCode, { data: AnySetData; idx: Map<string, PackCard> }>();

/** Card of `set` with collector number `cn` (cards, then basics, then variants). */
export function cardByCn(set: SetCode, cn: string): PackCard | null {
  const data = getSetData(set);
  if (!data) return null;
  let entry = indexCache.get(set);
  if (!entry || entry.data !== data) {
    const idx = new Map<string, PackCard>();
    for (const c of data.cards) idx.set(c.cn, c);
    for (const c of data.basics ?? []) if (!idx.has(c.cn)) idx.set(c.cn, c);
    if ('variants' in data) for (const c of data.variants ?? []) if (!idx.has(c.cn)) idx.set(c.cn, c);
    entry = { data, idx };
    indexCache.set(set, entry);
  }
  return entry.idx.get(cn) ?? null;
}

/** Test hook: drop the collector-number indexes (data itself is kept). */
export function _resetRegistryIndexes(): void {
  indexCache.clear();
}

/** Test hook: forget every runtime set, print resolution and listener. */
export function _resetRegistry(): void {
  runtimeSets.clear();
  runtimeById.clear();
  knownMisses.clear();
  listeners.clear();
  indexCache.clear();
}
