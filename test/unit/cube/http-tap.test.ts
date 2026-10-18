import { describe, expect, it } from 'vitest';
import { installHttpTap, rewriteResponseText, route, type HttpTapDeps } from '@main/cube/http-tap';
import { CubeCatalog } from '@shared/cube/catalog';
import { parseCube } from '@shared/cube/parse';
import { cubeResponse, pool } from './fixture';

const cat = new CubeCatalog(parseCube(cubeResponse()), pool(), {});
const yamato = cat.byName('Yamato, Pursuer')!;
const API = 'https://api.edhplay.com';

function deps(on = true): HttpTapDeps {
  return { catalog: () => (on ? cat : null), cubeName: () => 'Test Cube' };
}

describe('route', () => {
  it('classifies edhplay API URLs', () => {
    expect(route(new URL(`${API}/api/v1/cards/prints?name=x`), 'GET')).toEqual({ kind: 'search' });
    expect(route(new URL(`${API}/api/v1/public/cards/prints?name=x`), 'GET')).toEqual({ kind: 'search' });
    expect(route(new URL(`${API}/api/v1/public/cards/prints/p-1/details?lang=en`), 'GET')).toEqual({ kind: 'details', printId: 'p-1' });
    expect(route(new URL(`${API}/api/v1/decks/d1/bulk-import`), 'POST')).toEqual({ kind: 'import' });
    expect(route(new URL(`${API}/api/v1/decks/d1`), 'GET')).toEqual({ kind: 'generic' });
    expect(route(new URL(`${API}/public/v1/decks/explore`), 'GET')).toEqual({ kind: 'generic' });
    expect(route(new URL('https://cards.scryfall.io/x.jpg'), 'GET')).toBeNull();
    expect(route(new URL(`${API}/ws/game`), 'GET')).toBeNull();
  });
});

describe('rewriteResponseText', () => {
  it('answers the card info dialog for a carrier print', () => {
    const url = new URL(`${API}/api/v1/public/cards/prints/${yamato.carrier.card_print_id}/details?lang=en`);
    const out = JSON.parse(rewriteResponseText(url, 'GET', 200, '{"name":"Carrier 0"}', deps())!) as { name: string; faces: unknown[] };
    expect(out.name).toBe('Yamato, Pursuer');
    expect(out.faces).toHaveLength(1);
  });

  it('passes through when off, on errors, non-JSON and unrelated bodies', () => {
    const url = new URL(`${API}/api/v1/decks/d1`);
    const body = JSON.stringify({ cards: [{ card_id: yamato.carrier.card_id, name: 'Carrier 0' }] });
    expect(rewriteResponseText(url, 'GET', 200, body, deps(false))).toBeNull();
    expect(rewriteResponseText(url, 'GET', 500, body, deps())).toBeNull();
    expect(rewriteResponseText(url, 'GET', 200, '<html>', deps())).toBeNull();
    expect(rewriteResponseText(url, 'GET', 200, '{"cards":[]}', deps())).toBeNull();
    expect(JSON.parse(rewriteResponseText(url, 'GET', 200, body, deps())!).cards[0].name).toBe('Yamato, Pursuer');
  });
});

class FakeXhr {
  readyState = 0;
  status = 0;
  responseType: XMLHttpRequestResponseType = '';
  body = '';
  sent: unknown = undefined;
  open(_m: string, _u: string): void {
    this.readyState = 1;
  }
  send(b?: unknown): void {
    this.sent = b;
  }
  get responseText(): string {
    return this.body;
  }
  get response(): unknown {
    return this.responseType === 'json' ? (JSON.parse(this.body) as unknown) : this.body;
  }
  finish(status: number, body: string): void {
    this.status = status;
    this.body = body;
    this.readyState = 4;
  }
}

function fakeWin(fetchImpl: (input: unknown, init?: RequestInit) => Promise<Response>) {
  class X extends FakeXhr {}
  const win = { XMLHttpRequest: X, fetch: fetchImpl, location: { href: 'https://edhplay.com/decks/d1' } };
  return win as unknown as Window & typeof globalThis & { XMLHttpRequest: typeof X };
}

describe('installHttpTap', () => {
  it('rewrites axios-style XHR responses and bulk-import bodies', () => {
    const win = fakeWin(async () => new Response('{}'));
    installHttpTap(win, deps());
    const X = win.XMLHttpRequest as unknown as typeof FakeXhr;

    const search = new X();
    search.open('GET', `${API}/api/v1/cards/prints?name=yama&limit=20&skip=0&tokens=exclude`);
    search.send();
    search.finish(200, JSON.stringify({ data: [], has_more: false }));
    expect((JSON.parse(search.responseText) as { data: Array<{ name: string }> }).data[0]!.name).toBe('Yamato, Pursuer');
    search.responseType = 'json';
    expect((search.response as { data: Array<{ name: string }> }).data[0]!.name).toBe('Yamato, Pursuer');

    const imp = new X();
    imp.open('POST', `${API}/api/v1/decks/d1/bulk-import`);
    imp.send(JSON.stringify({ cards: [{ name: 'Yamato, Pursuer', quantity: 1 }] }));
    expect(JSON.parse(imp.sent as string).cards[0].name).toBe(yamato.carrier.name);

    const other = new X();
    other.open('GET', 'https://cubeforge.app/x');
    other.send('raw');
    other.finish(200, '{"card_id":"x"}');
    expect(other.sent).toBe('raw');
    expect(other.responseText).toBe('{"card_id":"x"}');
  });

  it('does not touch a response before it completes', () => {
    const win = fakeWin(async () => new Response('{}'));
    installHttpTap(win, deps());
    const X = win.XMLHttpRequest as unknown as typeof FakeXhr;
    const x = new X();
    x.open('GET', `${API}/api/v1/decks/d1`);
    x.body = '{"card_id":"' + yamato.carrier.card_id + '"';
    x.readyState = 3;
    expect(x.responseText).toBe(x.body);
  });

  it('rewrites fetch JSON responses', async () => {
    const win = fakeWin(async () => new Response(JSON.stringify({ cards: [{ card_id: yamato.carrier.card_id, name: 'Carrier 0' }] }), { headers: { 'content-type': 'application/json' } }));
    installHttpTap(win, deps());
    const res = await win.fetch(`${API}/api/v1/decks/d1`);
    expect(((await res.json()) as { cards: Array<{ name: string }> }).cards[0]!.name).toBe('Yamato, Pursuer');
    const passthrough = await win.fetch('https://cubeforge.app/api/cubes/x');
    expect(await passthrough.json()).toEqual({ cards: [{ card_id: yamato.carrier.card_id, name: 'Carrier 0' }] });
  });
});
