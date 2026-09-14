import { beforeEach, describe, expect, it } from 'vitest';
import { handleRpc, resolveCards } from '../../../src/background/rpc';
import { SCRYFALL_BASE } from '../../../src/background/scryfall';
import { installChromeStorage, installFetch, type Route } from './stubs';

const EDH = 'https://api.edhplay.com/api/v1/public/cards/prints?name=';
const printsUrl = (name: string): string => `${EDH}${encodeURIComponent(name)}&tokens=exclude&lang=en&limit=50`;
const sender = {} as chrome.runtime.MessageSender;

const SF_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SF_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const SF_C = 'cccccccc-0000-4000-8000-000000000003';

function routes(): Record<string, Route> {
  return {
    [printsUrl('Lightning Bolt')]: {
      status: 200,
      body: {
        data: [
          { card_id: 'card-bolt', card_print_id: 'print-bolt-other', name: 'Lightning Bolt', front_image_uri: `https://cards.scryfall.io/normal/front/9/9/99999999-0000-4000-8000-000000000009.jpg` },
          { card_id: 'card-bolt', card_print_id: 'print-bolt-a', name: 'Lightning Bolt', front_image_uri: `https://cards.scryfall.io/normal/front/a/a/${SF_A}.jpg` },
          { card_id: 'card-token', card_print_id: 'print-token', name: 'Lightning Bolt Token', front_image_uri: 'x' },
        ],
      },
    },
    // no print carries SF_B: falls back to the first exact-name match
    [printsUrl('Counterspell')]: {
      status: 200,
      body: { data: [{ card_id: 'card-cs', card_print_id: 'print-cs-first', name: 'Counterspell', front_image_uri: 'https://cards.scryfall.io/normal/front/1/2/1234.jpg' }] },
    },
    [printsUrl('Nonexistent Card')]: { status: 200, body: { data: [] } },
  };
}

describe('background rpc', () => {
  beforeEach(() => {
    installChromeStorage();
  });

  it('prints.resolveCards picks the print embedding the Scryfall id, falls back to the first, null when none; caches hits', async () => {
    const { calls } = installFetch(routes());
    const res = (await handleRpc(
      {
        m: 'prints.resolveCards',
        cards: [
          { scryfallId: SF_A, name: 'Lightning Bolt' },
          { scryfallId: SF_B, name: 'Counterspell' },
          { scryfallId: SF_C, name: 'Nonexistent Card' },
          { scryfallId: SF_A, name: 'Lightning Bolt' }, // duplicate in the same request
        ],
      },
      sender,
    )) as Record<string, unknown>;
    expect(res).toEqual({
      [SF_A]: { card_print_id: 'print-bolt-a', card_id: 'card-bolt' },
      [SF_B]: { card_print_id: 'print-cs-first', card_id: 'card-cs' },
      [SF_C]: null,
    });
    expect(calls).toEqual([printsUrl('Lightning Bolt'), printsUrl('Counterspell'), printsUrl('Nonexistent Card')]);

    // hits are cached under print:sf:{id}; misses are retried
    const stored = await chrome.storage.local.get(null);
    expect(stored[`hok:cache:print:sf:${SF_A}`]).toMatchObject({ v: { card_print_id: 'print-bolt-a', card_id: 'card-bolt' } });
    expect(stored[`hok:cache:print:sf:${SF_C}`]).toBeUndefined();
    const again = await resolveCards([
      { scryfallId: SF_A, name: 'Lightning Bolt' },
      { scryfallId: SF_C, name: 'Nonexistent Card' },
    ]);
    expect(again).toEqual({ [SF_A]: { card_print_id: 'print-bolt-a', card_id: 'card-bolt' }, [SF_C]: null });
    expect(calls).toEqual([printsUrl('Lightning Bolt'), printsUrl('Counterspell'), printsUrl('Nonexistent Card'), printsUrl('Nonexistent Card')]);
  });

  it('prints.resolveCards turns network failures into null entries', async () => {
    installFetch({});
    const res = await resolveCards([{ scryfallId: SF_A, name: 'Lightning Bolt' }]);
    expect(res).toEqual({ [SF_A]: null });
  });

  it('sets.list and sets.cards are routed to the Scryfall client', async () => {
    const { calls } = installFetch({
      [`${SCRYFALL_BASE}/sets`]: {
        status: 200,
        body: { data: [{ code: 'zzz', name: 'Zeta Zone', set_type: 'expansion', released_at: '2005-06-03', card_count: 165 }] },
      },
      [`${SCRYFALL_BASE}/cards/search?q=set:zzz+is:booster+-t:basic&unique=prints&order=set`]: {
        status: 200,
        body: { has_more: false, data: [{ id: 'z1', name: 'Zed', collector_number: '1', rarity: 'rare', layout: 'normal', type_line: 'Instant' }] },
      },
      [`${SCRYFALL_BASE}/cards/search?q=set:zzz+is:booster+t:basic&unique=prints&order=set`]: { status: 404, body: {} },
    });
    const list = (await handleRpc({ m: 'sets.list' }, sender)) as { sets: Array<{ code: string }> };
    expect(list.sets.map((s) => s.code)).toEqual(['zzz']);
    const cards = (await handleRpc({ m: 'sets.cards', set: 'zzz' }, sender)) as { data: { code: string; cards: unknown[]; packSize: number } | null };
    expect(cards.data?.code).toBe('zzz');
    expect(cards.data?.cards).toHaveLength(1);
    expect(cards.data?.packSize).toBe(15);
    expect(calls).toHaveLength(3);

    const bad = (await handleRpc({ m: 'sets.cards', set: 'qqq' }, sender)) as { data: unknown; error?: string };
    expect(bad.data).toBeNull();
    expect(bad.error).toBeTruthy();
  });

  it('sets.list degrades to an empty list when Scryfall is unreachable', async () => {
    installFetch({});
    expect(await handleRpc({ m: 'sets.list' }, sender)).toEqual({ sets: [] });
  });
});
