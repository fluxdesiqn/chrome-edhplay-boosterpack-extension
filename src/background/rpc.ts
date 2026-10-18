import type { Rpc } from '@shared/bridge-contract';
import { cacheClear, cacheGet, cacheSet } from './cache';
import { pickPrint, searchPrintsByName } from './edhplay-api';
import { acquireLock, releaseLock } from './lock';
import { fetchSetList, loadSetCards } from './scryfall';
import { fetchCube } from './cubeforge';

const ID_TTL = 30 * 24 * 3600 * 1000;

type PrintEntry = { card_print_id: string; card_id: string } | null;

/**
 * Resolve edhplay print ids for Scryfall cards: exact-name search, then the
 * print whose image URL embeds the Scryfall id (falling back to the first
 * print). Hits are cached 30 days under `print:sf:{scryfallId}`; misses are not
 * cached here (the engine's registry remembers them per session).
 */
export async function resolveCards(cards: ReadonlyArray<{ scryfallId: string; name: string }>): Promise<Record<string, PrintEntry>> {
  const out: Record<string, PrintEntry> = {};
  for (const { scryfallId, name } of cards) {
    if (!scryfallId || scryfallId in out) continue;
    const key = 'print:sf:' + scryfallId;
    const cached = await cacheGet<PrintEntry>(key);
    if (cached) {
      out[scryfallId] = cached;
      continue;
    }
    try {
      const prints = await searchPrintsByName(name);
      const p = pickPrint(prints, scryfallId);
      const val: PrintEntry = p ? { card_print_id: p.card_print_id, card_id: p.card_id } : null;
      out[scryfallId] = val;
      if (val) await cacheSet(key, val, ID_TTL);
    } catch (err) {
      out[scryfallId] = null;
      console.warn('[HoK] print resolve failed', name, scryfallId, err);
    }
  }
  return out;
}

export async function handleRpc(req: Rpc, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (req.m) {
    case 'ready':
      return { ok: true };
    case 'cache.clear':
      await cacheClear();
      return { ok: true };
    case 'lock.acquire': {
      const tabId = sender.tab?.id ?? -1;
      return { granted: acquireLock(req.roomId, tabId) };
    }
    case 'lock.release': {
      const tabId = sender.tab?.id ?? -1;
      releaseLock(req.roomId, tabId);
      return { ok: true };
    }
    case 'prints.resolveCards':
      return resolveCards(req.cards);
    case 'sets.list': {
      try {
        return { sets: await fetchSetList() };
      } catch (err) {
        console.warn('[HoK] set list failed', err);
        return { sets: [] };
      }
    }
    case 'sets.cards':
      return loadSetCards(req.set);
    case 'cube.fetch':
      return fetchCube(req.cubeId, req.force);
    case 'prints.resolve': {
      const out: Record<string, { card_print_id: string; card_id: string } | null> = {};
      for (const name of req.names) {
        const key = 'print:' + name.toLowerCase();
        const cached = await cacheGet<{ card_print_id: string; card_id: string } | null>(key);
        if (cached !== null) {
          out[name] = cached;
          continue;
        }
        try {
          const prints = await searchPrintsByName(name);
          const p = pickPrint(prints);
          const val = p ? { card_print_id: p.card_print_id, card_id: p.card_id } : null;
          out[name] = val;
          if (val) await cacheSet(key, val, ID_TTL);
        } catch (err) {
          out[name] = null;
          console.warn('[HoK] print resolve failed', name, err);
        }
      }
      return out;
    }
    default:
      return { ok: false, error: 'unknown rpc' };
  }
}
