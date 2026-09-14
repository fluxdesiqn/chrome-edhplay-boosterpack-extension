import { describe, expect, it } from 'vitest';
import { SET_DATA } from '@shared/packs/data';
import { _resetIdentityCaches, cardsInSet, findCard, identityFor, isKamigawaName, variantLabel } from '@shared/packs/identity';
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

  it('findCard covers neo collector variants and identityFor images them by their own Scryfall id', () => {
    const variants = SET_DATA.neo.variants!;
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) {
      expect(findCard(makeRef('neo', v.cn))).toBe(v);
      expect(v.co).toBe(true);
      expect(['s', 'b', 'e', 'x']).toContain(v.v);
      // variant collector numbers never collide with the regular printings or basics
      expect(SET_DATA.neo.cards.some((c) => c.cn === v.cn)).toBe(false);
      expect(SET_DATA.neo.basics!.some((c) => c.cn === v.cn)).toBe(false);
    }
    const showcase = variants.find((c) => c.v === 's') as PackCard;
    const regular = SET_DATA.neo.cards.find((c) => c.name === showcase.name) as PackCard;
    expect(regular).toBeDefined();
    const id = identityFor(makeRef('neo', showcase.cn))!;
    expect(id.name).toBe(regular.name);
    expect(id.front_image_uri).toContain(showcase.id);
    expect(id.front_image_uri).not.toContain(regular.id);
    expect(id.card_print_id).toBe(showcase.ep);
    expect(id.card_print_id).not.toBe(regular.ep);
  });

  it('variantLabel names every variant kind and is null for regular printings', () => {
    expect(variantLabel(SET_DATA.neo.cards[0] as PackCard)).toBeNull();
    expect(variantLabel(SET_DATA.chk.cards[0] as PackCard)).toBeNull();
    const variants = SET_DATA.neo.variants!;
    expect(variantLabel(variants.find((c) => c.v === 's') as PackCard)).toBe('Showcase');
    expect(variantLabel(variants.find((c) => c.v === 'b') as PackCard)).toBe('Borderless');
    expect(variantLabel(variants.find((c) => c.v === 'e') as PackCard)).toBe('Extended art');
    const etched = variants.find((c) => c.v === 'x' && c.name !== 'Hidetsugu, Devouring Chaos') as PackCard;
    expect(variantLabel(etched)).toBe('Foil etched');
    const neon = variants.find((c) => c.v === 'x' && c.name === 'Hidetsugu, Devouring Chaos');
    if (neon) expect(variantLabel(neon)).toBe('Neon ink');
    for (const v of variants) expect(variantLabel(v)).not.toBeNull();
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
    // any well-formed set code parses now (runtime sets); data lookup decides whether it resolves
    expect(parseRef('zzz:1')).toEqual({ set: 'zzz', cn: '1' });
    expect(findCard('zzz:1')).toBeNull();
    expect(parseRef('neo:')).toBeNull();
  });
});
