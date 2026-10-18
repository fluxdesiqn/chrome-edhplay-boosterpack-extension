import { describe, expect, it } from 'vitest';
import { CubeCatalog, detailsFor, rewriteApiJson, rewriteBulkImport, rewriteSearch, searchRow } from '@shared/cube/catalog';
import { parseCube } from '@shared/cube/parse';
import { cubeResponse, pool } from './fixture';

function catalog() {
  return new CubeCatalog(parseCube(cubeResponse()), pool(), {});
}

describe('CubeCatalog', () => {
  const cat = catalog();
  const yamato = cat.byName('yamato, pursuer')!;
  const silver = cat.byName('Silver, Drunkard')!;

  it('finds a custom card by carrier card id, any carrier print, name and cover image', () => {
    expect(cat.size).toBe(cubeResponse().cards!.length - 2 + cubeResponse().consideringCards!.length);
    expect(cat.lookup({ card_id: yamato.carrier.card_id })).toBe(yamato);
    expect(cat.lookup({ card_print_id: yamato.carrier.card_print_id })).toBe(yamato);
    expect(cat.lookup({ card_print_id: yamato.carrier.print_ids[0] })).toBe(yamato);
    expect(cat.lookup({ card_id: 'someone-else', card_print_id: 'nope' })).toBeNull();
    expect(cat.byCarrierName(yamato.carrier.name)).toBe(yamato);
    expect(cat.byImageUrl(`https://cards.scryfall.io/normal/front/x/y/${yamato.carrier.image_id}.jpg?1`)).toBe(yamato);
  });

  it('learns other printings seen next to a carrier card id', () => {
    const c = catalog();
    const e = c.byName('Yamato, Pursuer')!;
    expect(c.byPrintId('new-print')).toBeNull();
    c.learnPrint(e.carrier.card_id, 'new-print');
    expect(c.byPrintId('new-print')).toBe(e);
    c.learnPrint('unrelated', 'other-print');
    expect(c.byPrintId('other-print')).toBeNull();
  });

  it('links back faces', () => {
    expect(silver.back?.name).toBe('Silver, Beast Inside');
  });

  it('searches drafted cards for decks and considering cards first for tokens', () => {
    expect(cat.search('the', 'exclude').map((e) => e.card.name)).toEqual(['The Doorman', 'The Great Elm', 'The Stock Exchange // The Closing Bell', 'The Thing Under Bow Bridge', 'Welcome to the Baroness // Enjoy Your Stay']);
    const tokens = cat.search('the', 'only').map((e) => e.card.name);
    expect(tokens.slice(0, 4)).toEqual(['The Assembly Line', 'The Closing Bell', 'The Rootbound Guardian', 'The Soul Urn']);
    expect(tokens).toContain('The Doorman');
    expect(cat.search('barrel', 'exclude')).toEqual([]);
    expect(cat.search('barrel', 'only').map((e) => e.card.name)).toEqual(['Barrel']);
    expect(cat.search('  ', 'include')).toEqual([]);
  });
});

describe('rewriteApiJson', () => {
  const cat = catalog();
  const yamato = cat.byName('Yamato, Pursuer')!;
  const silver = cat.byName('Silver, Drunkard')!;

  it('paints deck cards but keeps the carrier ids', () => {
    const deck = {
      id: 'deck-1',
      name: 'My deck',
      commander_name: yamato.carrier.name,
      deck_image_uri: `https://cards.scryfall.io/normal/front/a/b/${yamato.carrier.image_id}.jpg`,
      cards: [
        { deck_card_id: 'dc1', card_id: yamato.carrier.card_id, card_print_id: 'some-print', name: 'Carrier 0', type_line: 'Legendary Creature — Human', front_image_uri: 'x', back_image_uri: null, mana_cost: '{B}', cmc: 1, power: '3', toughness: '3', zone: 'commander', quantity: 1 },
        { deck_card_id: 'dc2', card_id: silver.carrier.card_id, card_print_id: silver.carrier.card_print_id, name: 'Carrier 1', type_line: '', front_image_uri: 'y', back_image_uri: null, zone: 'main' },
        { deck_card_id: 'dc3', card_id: 'real', card_print_id: 'real-print', name: 'Sol Ring', front_image_uri: 'z', zone: 'main' },
      ],
    };
    const out = rewriteApiJson(deck, cat) as typeof deck;
    expect(out).not.toBe(deck);
    expect(out.commander_name).toBe('Yamato, Pursuer');
    expect(out.deck_image_uri).toBe(yamato.card.image);
    const [y, s, real] = out.cards;
    expect(y).toMatchObject({ card_id: yamato.carrier.card_id, card_print_id: 'some-print', name: 'Yamato, Pursuer', type_line: 'Legendary Creature — Ninja', front_image_uri: yamato.card.image, mana_cost: '{1}{U}', cmc: 2, power: null, toughness: null, zone: 'commander' });
    expect(s!.back_image_uri).toBe(silver.back!.image);
    expect(real).toBe(deck.cards[2]);
    expect(deck.cards[0]!.name).toBe('Carrier 0');
    // The print seen in the deck is now recognised in game frames.
    expect(cat.byPrintId('some-print')).toBe(yamato);
  });

  it('paints translation maps keyed by print id', () => {
    const json = { [yamato.carrier.card_print_id]: { printed_name: 'Kaiser', front_image_uri: 'de.jpg' }, other: { printed_name: 'x' } };
    const out = rewriteApiJson(json, cat) as Record<string, Record<string, unknown>>;
    expect(out[yamato.carrier.card_print_id]).toEqual({ printed_name: 'Yamato, Pursuer', front_image_uri: yamato.card.image });
    expect(out['other']).toBe(json.other);
  });

  it('returns the same object when nothing matches', () => {
    const json = { data: [{ card_id: 'a', card_print_id: 'b', name: 'Sol Ring' }], has_more: false };
    expect(rewriteApiJson(json, cat)).toBe(json);
  });
});

describe('rewriteSearch', () => {
  const cat = catalog();
  const yamato = cat.byName('Yamato, Pursuer')!;
  const url = (q: string) => new URL(`https://api.edhplay.com/api/v1/cards/prints?limit=20${q}`);

  it('puts matching custom cards on page one and hides carriers', () => {
    const json = { data: [{ card_id: yamato.carrier.card_id, name: 'Carrier 0' }, { card_id: 'real', name: 'Yamata no Orochi' }], has_more: false };
    const out = rewriteSearch(json, url('&skip=0&name=yama&tokens=exclude'), cat) as { data: Array<Record<string, unknown>> };
    expect(out.data.map((r) => r['name'])).toEqual(['Yamato, Pursuer', 'Yamata no Orochi']);
    expect(out.data[0]).toEqual(searchRow(yamato));
    expect(out.data[0]!['card_id']).toBe(yamato.carrier.card_id);
  });

  it('adds nothing on later pages and respects the token filter', () => {
    const json = { data: [], has_more: false };
    expect(rewriteSearch(json, url('&skip=20&name=yama'), cat)).toBe(json);
    const only = rewriteSearch(json, url('&name=barrel&tokens=only'), cat) as { data: Array<Record<string, unknown>> };
    expect(only.data.map((r) => r['name'])).toEqual(['Barrel']);
    const excl = rewriteSearch(json, url('&name=barrel&tokens=exclude'), cat);
    expect(excl).toBe(json);
  });

  it('builds a token-dialog row with the back face', () => {
    const row = searchRow(cat.byName('Times Square')!);
    expect(row['back_image_uri']).toBe(cat.byName('The Soul Urn')!.card.image);
  });
});

describe('rewriteBulkImport', () => {
  const cat = catalog();
  it('swaps custom names (any case, front half) for carrier names and drops set/collector', () => {
    const body = {
      cards: [
        { name: 'puddle punch', quantity: 2, set_code: 'CSTM', collector_number: 'abc' },
        { name: 'Sol Ring', quantity: 1, set_code: 'c21', collector_number: '1' },
        { name: 'The Stock Exchange', quantity: 1 },
      ],
      commander: 'Yamato, Pursuer',
      partner_commander: 'Nobody',
      replace: true,
    };
    const out = rewriteBulkImport(body, cat)!;
    expect(out['cards']).toEqual([
      { name: cat.byName('Puddle Punch')!.carrier.name, quantity: 2 },
      body.cards[1],
      { name: cat.byName('The Stock Exchange // The Closing Bell')!.carrier.name, quantity: 1 },
    ]);
    expect(out['commander']).toBe(cat.byName('Yamato, Pursuer')!.carrier.name);
    expect(out['partner_commander']).toBe('Nobody');
    expect(out['replace']).toBe(true);
  });

  it('prefers a card named exactly over the half of a split name', () => {
    expect(cat.byName('The Closing Bell')!.card.considering).toBe(true);
    expect(cat.byName('The Stock Exchange')!.card.name).toBe('The Stock Exchange // The Closing Bell');
  });

  it('returns null when the list has no custom cards', () => {
    expect(rewriteBulkImport({ cards: [{ name: 'Sol Ring', quantity: 1 }] }, cat)).toBeNull();
  });
});

describe('detailsFor', () => {
  it('describes both faces of a double-faced custom card', () => {
    const cat = catalog();
    const d = detailsFor(cat.byName('Calico, Contract Killer')!, 'Test Cube') as { faces: Array<{ name: string; oracle_text: string }>; set_name: string; back_image_uri: string };
    expect(d.faces.map((f) => f.name)).toEqual(['Calico, Contract Killer', 'Ava, Just a Cat']);
    expect(d.faces[0]!.oracle_text).not.toContain('Ava');
    expect(d.set_name).toBe('Test Cube');
    expect(d.back_image_uri).toContain('Ava');
  });
});
