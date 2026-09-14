import type { Rpc } from '@shared/bridge-contract';
import { cacheClear, cacheGet, cacheSet } from './cache';
import { pickPrint, searchPrintsByName } from './edhplay-api';
import { acquireLock, releaseLock } from './lock';

const ID_TTL = 30 * 24 * 3600 * 1000;

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
