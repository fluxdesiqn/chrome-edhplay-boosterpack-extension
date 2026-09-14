import { describe, expect, it } from 'vitest';
import { SET_DATA } from '@shared/packs/data';
import { _resetIdentityCaches, cardsInSet, findCard, identityFor, isKamigawaName } from '@shared/packs/identity';
import { makeRef, parseRef, SET_CODES, type PackCard } from '@shared/packs/types';

describe('identity', () => {
  it('identityFor a resolved card carries the real edhplay ids', () => {
    // Kami of Ancient Law is CHK common; its edhplay print was resolved at build time.
    const card = SET_DATA.chk.cards.find((c) => c.name === 'Kami of Ancient Law') as PackCard;
    expect(card).toBeDefined();
    expect(card.ep).toMatch(/^[0-9a-f-]{36}$/);
    expect(card.ec).toMatch(/^[0-9a-f-]{36}$/);
    const id = identityFor(makeRef('chk', card.cn));
    expect(id).not.toBeNull();
    expect(id!.card_print_id).toBe(card.ep);
    expect(id!.card_id).toBe(card.ec);
    expect(id!.name).toBe('Kami of Ancient Law');
    expect(id!.type_line).toBe('Creature — Spirit');
    expect(id!.front_image_uri).toBe(`https://cards.scryfall.io/normal/front/${card.id[0]}/${card.id[1]}/${card.id}.jpg`);
    expect(id!.back_image_uri).toBeNull();
    expect(id!.can_rotate).toBe(false);
    expect(id!.power).toBe('2');
    expect(id!.toughness).toBe('2');
    expect(id!.rarity).toBe('common');
    expect(id!.set_name).toBe('Champions of Kamigawa');
    expect(id!.mana_cost).toBe('{1}{W}');
    expect(id!.cmc).toBe(2);
    expect(id!.color_identity).toEqual(['W']);
  });

  it('falls back to synthetic ids when no edhplay print was resolved', () => {
    const real = SET_DATA.bok.cards[0] as PackCard;
    const synthetic: PackCard = { ...real, cn: 'synthetic-test-cn', ep: undefined, ec: undefined };
    delete synthetic.ep;
    delete synthetic.ec;
    SET_DATA.bok.cards.push(synthetic);
    _resetIdentityCaches();
    try {
      const id = identityFor(makeRef('bok', synthetic.cn));
      expect(id).not.toBeNull();
      expect(id!.card_print_id).toBe(`hok-${synthetic.id}`);
      expect(id!.card_id).toBe(`hok-card-${synthetic.id}`);
    } finally {
      SET_DATA.bok.cards.pop();
      _resetIdentityCaches();
    }
  });

  it('flip cards can rotate and have no back image; transform cards have a back image', () => {
    const flip = SET_DATA.chk.cards.find((c) => c.l === 'f') as PackCard;
    const flipId = identityFor(makeRef('chk', flip.cn))!;
    expect(flipId.can_rotate).toBe(true);
    expect(flipId.back_image_uri).toBeNull();
    expect(flipId.type_line).toContain(' // ');

    const dfc = SET_DATA.neo.cards.find((c) => c.l === 't') as PackCard;
    const dfcId = identityFor(makeRef('neo', dfc.cn))!;
    expect(dfcId.can_rotate).toBe(false);
    expect(dfcId.back_image_uri).toBe(`https://cards.scryfall.io/normal/back/${dfc.id[0]}/${dfc.id[1]}/${dfc.id}.jpg`);
  });

  it('findCard covers neo basics and returns null for unknown refs', () => {
    const basic = SET_DATA.neo.basics![0] as PackCard;
    expect(findCard(makeRef('neo', basic.cn))).toBe(basic);
    expect(findCard('neo:nope')).toBeNull();
    expect(findCard('xyz:1')).toBeNull();
    expect(identityFor('chk:')).toBeNull();
  });

  it('isKamigawaName recognises full and front-face names only', () => {
    expect(isKamigawaName('Kami of Ancient Law')).toBe(true);
    expect(isKamigawaName('Budoka Gardener')).toBe(true);
    expect(isKamigawaName('Budoka Gardener // Dokai, Weaver of Life')).toBe(true);
    expect(isKamigawaName('Sol Ring')).toBe(false);
    expect(isKamigawaName('')).toBe(false);
  });

  it('cardsInSet returns the sorted set list', () => {
    for (const set of SET_CODES) {
      const cards = cardsInSet(set);
      expect(cards).toBe(SET_DATA[set].cards);
      expect(cards.length).toBeGreaterThan(100);
    }
  });

  it('parseRef/makeRef round trip', () => {
    for (const set of SET_CODES) {
      for (const cn of ['1', '160a', '285']) {
        expect(parseRef(makeRef(set, cn))).toEqual({ set, cn });
      }
    }
    expect(parseRef('bad')).toBeNull();
    expect(parseRef(':1')).toBeNull();
    expect(parseRef('zzz:1')).toBeNull();
    expect(parseRef('neo:')).toBeNull();
  });
});
