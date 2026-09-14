/** In-memory chrome.storage.local and a URL-routed fetch stub for background tests (node env). */
import { vi } from 'vitest';

export function installChromeStorage(): { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const local = {
    get: vi.fn(async (keys: string | string[] | null) => {
      const out: Record<string, unknown> = {};
      const list = keys === null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      for (const k of list) if (store.has(k)) out[k] = store.get(k);
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    }),
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local } };
  return { store };
}

export type Route = { status: number; body: unknown } | ((url: URL) => { status: number; body: unknown });

/**
 * Stub `globalThis.fetch`. `routes` maps an exact URL (or a `prefix*` pattern)
 * to a response; unmatched URLs return 599 and are recorded so tests can assert
 * on them. Returns the list of requested URLs and the headers of each call.
 */
export function installFetch(routes: Record<string, Route>): { calls: string[]; headers: Array<Record<string, string>> } {
  const calls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    headers.push((init?.headers as Record<string, string>) ?? {});
    let route: Route | undefined = routes[url];
    if (!route) {
      for (const [pattern, r] of Object.entries(routes)) {
        if (pattern.endsWith('*') && url.startsWith(pattern.slice(0, -1))) {
          route = r;
          break;
        }
      }
    }
    const res = route ? (typeof route === 'function' ? route(new URL(url)) : route) : { status: 599, body: { error: `unrouted ${url}` } };
    const text = JSON.stringify(res.body);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
    } as unknown as Response;
  });
  globalThis.fetch = fetchStub as unknown as typeof fetch;
  return { calls, headers };
}
