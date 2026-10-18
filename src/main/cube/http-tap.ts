/**
 * MAIN-world HTTP tap for edhplay's REST API (deck builder, lobby, card info):
 * paints carriers as their custom cards, puts custom cards into card search,
 * answers the card info dialog with custom rules text, and lets a decklist
 * with custom card names import. edhplay's API client is axios (XHR); fetch
 * is wrapped too in case that changes. Only the page's view of responses is
 * altered; requests reach the server unchanged except bulk-import names.
 */
import { detailsFor, rewriteApiJson, rewriteBulkImport, rewriteSearch, type CubeCatalog } from '@shared/cube/catalog';

export const API_HOST = 'api.edhplay.com';

export interface HttpTapDeps {
  /** The active catalog, or null when cube cards are off. */
  catalog: () => CubeCatalog | null;
  cubeName: () => string;
  onError?: (where: string, err: unknown) => void;
}

type Route =
  | { kind: 'search' }
  | { kind: 'details'; printId: string }
  | { kind: 'import' }
  | { kind: 'generic' };

const SEARCH = /^\/(?:api|public)\/v1\/(?:public\/)?cards\/prints\/?$/;
const DETAILS = /^\/(?:api|public)\/v1\/(?:public\/)?cards\/prints\/([^/]+)\/details\/?$/;
const IMPORT = /^\/api\/v1\/decks\/[^/]+\/bulk-import\/?$/;
const API = /^\/(?:api|public)\/v1\//;

export function route(url: URL, method: string): Route | null {
  if (url.host !== API_HOST || !API.test(url.pathname)) return null;
  if (SEARCH.test(url.pathname)) return { kind: 'search' };
  const d = DETAILS.exec(url.pathname);
  if (d?.[1]) return { kind: 'details', printId: decodeURIComponent(d[1]) };
  if (method.toUpperCase() === 'POST' && IMPORT.test(url.pathname)) return { kind: 'import' };
  return { kind: 'generic' };
}

/** Rewrite a JSON response body; returns null when it should pass unchanged. */
export function rewriteResponseText(url: URL, method: string, status: number, text: string, deps: HttpTapDeps): string | null {
  const cat = deps.catalog();
  const r = route(url, method);
  if (!cat || !r || status < 200 || status >= 300 || !text) return null;
  if (r.kind === 'details') {
    const e = cat.byPrintId(r.printId);
    return e ? JSON.stringify(detailsFor(e, deps.cubeName())) : null;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  let out = json;
  if (r.kind === 'search') out = rewriteSearch(out, url, cat);
  out = rewriteApiJson(out, cat);
  return out === json ? null : JSON.stringify(out);
}

/** Rewrite a request body (bulk-import only); returns null when unchanged. */
export function rewriteRequestBody(url: URL, method: string, body: unknown, deps: HttpTapDeps): string | null {
  const cat = deps.catalog();
  if (!cat || typeof body !== 'string' || route(url, method)?.kind !== 'import') return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const next = rewriteBulkImport(parsed as Record<string, unknown>, cat);
    return next ? JSON.stringify(next) : null;
  } catch {
    return null;
  }
}

function toUrl(input: unknown, base: string): URL | null {
  try {
    if (typeof input === 'string') return new URL(input, base);
    if (input instanceof URL) return input;
    if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url);
  } catch {
    /* not a URL */
  }
  return null;
}

function findDescriptor(proto: object | null, key: string): PropertyDescriptor | undefined {
  for (let p = proto; p; p = Object.getPrototypeOf(p) as object | null) {
    const d = Object.getOwnPropertyDescriptor(p, key);
    if (d) return d;
  }
  return undefined;
}

interface XhrInfo {
  url: URL | null;
  method: string;
  cache?: { text: string | null };
}

export function installHttpTap(win: Window & typeof globalThis, deps: HttpTapDeps): void {
  const KEY = Symbol.for('hok.httpTap');
  const g = win as unknown as Record<symbol, unknown>;
  if (g[KEY]) return;
  g[KEY] = true;
  const report = (where: string, err: unknown) => deps.onError?.(where, err);

  // ---------------------------------------------------------------- XHR
  const X = win.XMLHttpRequest;
  if (X) {
    const proto = X.prototype;
    const info = new WeakMap<XMLHttpRequest, XhrInfo>();
    const open = proto.open;
    const send = proto.send;
    const textDesc = findDescriptor(proto, 'responseText');
    const respDesc = findDescriptor(proto, 'response');

    proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      info.set(this, { url: toUrl(url, win.location.href), method: String(method) });
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof proto.open;

    proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const i = info.get(this);
      if (i?.url) {
        try {
          const next = rewriteRequestBody(i.url, i.method, body, deps);
          if (next !== null) return send.call(this, next);
        } catch (err) {
          report('xhr send', err);
        }
      }
      return send.call(this, body);
    };

    const rewritten = (xhr: XMLHttpRequest, original: string): string => {
      const i = info.get(xhr);
      if (!i?.url || xhr.readyState !== 4) return original;
      if (!i.cache) {
        let text: string | null = null;
        try {
          text = rewriteResponseText(i.url, i.method, xhr.status, original, deps);
        } catch (err) {
          report('xhr response', err);
        }
        i.cache = { text };
      }
      return i.cache.text ?? original;
    };

    if (textDesc?.get) {
      const get = textDesc.get;
      Object.defineProperty(proto, 'responseText', {
        ...textDesc,
        get(this: XMLHttpRequest) {
          const v = get.call(this) as string;
          return typeof v === 'string' && v ? rewritten(this, v) : v;
        },
      });
    }
    if (respDesc?.get) {
      const get = respDesc.get;
      Object.defineProperty(proto, 'response', {
        ...respDesc,
        get(this: XMLHttpRequest) {
          const v = get.call(this) as unknown;
          const type = this.responseType;
          if (type === '' || type === 'text') return typeof v === 'string' && v ? rewritten(this, v) : v;
          if (type === 'json' && v !== null && this.readyState === 4) {
            const raw = JSON.stringify(v);
            const text = rewritten(this, raw);
            return text === raw ? v : (JSON.parse(text) as unknown);
          }
          return v;
        },
      });
    }
  }

  // ---------------------------------------------------------------- fetch
  const origFetch = win.fetch?.bind(win);
  if (origFetch) {
    win.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = toUrl(input, win.location.href);
      const method = init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
      const r = url ? route(url, method) : null;
      if (!url || !r || !deps.catalog()) return origFetch(input, init);
      let nextInit = init;
      if (r.kind === 'import' && typeof init?.body === 'string') {
        const body = rewriteRequestBody(url, method, init.body, deps);
        if (body !== null) nextInit = { ...init, body };
      }
      const res = await origFetch(input, nextInit);
      if (!(res.headers.get('content-type') ?? '').includes('json')) return res;
      try {
        const text = await res.clone().text();
        const next = rewriteResponseText(url, method, res.status, text, deps);
        if (next === null) return res;
        return new Response(next, { status: res.status, statusText: res.statusText, headers: res.headers });
      } catch (err) {
        report('fetch response', err);
        return res;
      }
    } as typeof win.fetch;
  }
}
