import { beforeEach, describe, expect, it } from 'vitest';
import { SET_DATA } from '@shared/packs/data';
import { _resetIdentityCaches, cardsInSet, findCard, identityFor, isKamigawaName, isNameInSet } from '@shared/packs/identity';
import {
  _resetRegistry,
  getSetData,
  hasSetData,
  isRuntimeSetData,
  onRegistryChange,
  registerPrints,
  registerSetData,
  unresolvedCards,
} from '@shared/packs/registry';
import type { RuntimeSetData } from '@shared/packs/runtime';
import { availablePacks, setName } from '@shared/packs/types';
import { SYNTH_CODE, SYNTH_NAME, makeSyntheticSet, synthId } from './synthetic';

describe('registry', () => {
  beforeEach(() => {
    _resetRegistry();
    _resetIdentityCaches();
  });

  it('bundled sets are always available and are SET_DATA', () => {
    for (const set of ['chk', 'bok', 'sok', 'neo'] as const) {
      expect(hasSetData(set)).toBe(true);
      expect(getSetData(set)).toBe(SET_DATA[set]);
      expect(isRuntimeSetData(SET_DATA[set])).toBe(false);
    }
    expect(hasSetData(SYNTH_CODE)).toBe(false);
    expect(getSetData(SYNTH_CODE)).toBeUndefined();
  });

  it('registerSetData exposes a runtime set to getSetData, setName, cardsInSet and findCard', () => {
    const data = makeSyntheticSet();
    expect(setName(SYNTH_CODE)).toBe('ZZZ');
    expect(cardsInSet(SYNTH_CODE)).toEqual([]);
    registerSetData(data);
    expect(hasSetData(SYNTH_CODE)).toBe(true);
    expect(getSetData(SYNTH_CODE)).toBe(data);
    expect(isRuntimeSetData(data)).toBe(true);
    expect(setName(SYNTH_CODE)).toBe(SYNTH_NAME);
    expect(availablePacks(SYNTH_CODE)).toEqual(['draft']);
    expect(cardsInSet(SYNTH_CODE)).toBe(data.cards);
    expect(findCard('zzz:7')).toBe(data.cards[6]);
    // basics are addressable by ref too
    const basic = data.basics[0]!;
    expect(findCard(`zzz:${basic.cn}`)).toBe(basic);
    expect(findCard('zzz:9999')).toBeNull();
  });

  it('identityFor a runtime card is synthetic until registerPrints supplies the real ids', () => {
    const data = makeSyntheticSet();
    registerSetData(data);
    const card = data.cards[6]!;
    const before = identityFor('zzz:7');
    expect(before).not.toBeNull();
    expect(before!.card_print_id).toBe(`hok-${card.id}`);
    expect(before!.card_id).toBe(`hok-card-${card.id}`);
    expect(before!.name).toBe(card.name);
    expect(before!.set_name).toBe(SYNTH_NAME);
    expect(before!.rarity).toBe('common');
    expect(before!.front_image_uri).toContain(card.id);
    expect(before!.mana_cost).toBe('{1}');
    expect(before!.color_identity).toEqual(['W']);

    registerPrints({ [card.id]: { card_print_id: 'print-7', card_id: 'card-7' } });
    expect(card.ep).toBe('print-7');
    expect(card.ec).toBe('card-7');
    const after = identityFor('zzz:7')!;
    expect(after.card_print_id).toBe('print-7');
    expect(after.card_id).toBe('card-7');

    // rarity words for every rarity
    const rare = data.cards.find((c) => c.r === 'r')!;
    const mythic = data.cards.find((c) => c.r === 'm')!;
    const unc = data.cards.find((c) => c.r === 'u')!;
    expect(identityFor(`zzz:${rare.cn}`)!.rarity).toBe('rare');
    expect(identityFor(`zzz:${mythic.cn}`)!.rarity).toBe('mythic');
    expect(identityFor(`zzz:${unc.cn}`)!.rarity).toBe('uncommon');
  });

  it('unresolvedCards lists runtime cards without ep, skipping known misses, bundled cards, dupes and unknown sets', () => {
    const data = makeSyntheticSet();
    registerSetData(data);
    const refs = ['zzz:1', 'zzz:2', 'zzz:2', 'zzz:3', 'chk:1', 'neo:77', 'yyy:1', 'zzz:9999', 'garbage'];
    expect(unresolvedCards(refs)).toEqual([
      { scryfallId: synthId(SYNTH_CODE, 1), name: 'Common 1', set: SYNTH_CODE },
      { scryfallId: synthId(SYNTH_CODE, 2), name: 'Common 2', set: SYNTH_CODE },
      { scryfallId: synthId(SYNTH_CODE, 3), name: 'Common 3', set: SYNTH_CODE },
    ]);
    registerPrints({
      [synthId(SYNTH_CODE, 1)]: { card_print_id: 'p1', card_id: 'c1' },
      [synthId(SYNTH_CODE, 2)]: null,
    });
    expect(unresolvedCards(refs)).toEqual([{ scryfallId: synthId(SYNTH_CODE, 3), name: 'Common 3', set: SYNTH_CODE }]);
    // a later hit for a known miss clears the miss
    registerPrints({ [synthId(SYNTH_CODE, 2)]: { card_print_id: 'p2', card_id: 'c2' } });
    expect(identityFor('zzz:2')!.card_print_id).toBe('p2');
    expect(unresolvedCards(['zzz:2'])).toEqual([]);
    // unknown ids are ignored, bundled cards are never touched
    const chk1 = findCard('chk:1')!;
    const ep = chk1.ep;
    registerPrints({ 'not-a-card': { card_print_id: 'x', card_id: 'y' }, [chk1.id]: { card_print_id: 'hijack', card_id: 'hijack' } });
    expect(chk1.ep).toBe(ep);
  });

  it('notifies listeners on registration and on print changes; unsubscribe stops it', () => {
    let n = 0;
    const off = onRegistryChange(() => n++);
    const data = makeSyntheticSet();
    registerSetData(data);
    expect(n).toBe(1);
    registerPrints({ [synthId(SYNTH_CODE, 5)]: { card_print_id: 'p5', card_id: 'c5' } });
    expect(n).toBe(2);
    // identical re-application is not a change
    registerPrints({ [synthId(SYNTH_CODE, 5)]: { card_print_id: 'p5', card_id: 'c5' } });
    expect(n).toBe(2);
    registerPrints({ [synthId(SYNTH_CODE, 6)]: null });
    expect(n).toBe(3);
    registerPrints({ [synthId(SYNTH_CODE, 6)]: null });
    expect(n).toBe(3);
    off();
    registerSetData(makeSyntheticSet({ code: 'yyy' }));
    expect(n).toBe(3);
  });

  it('bundled sets cannot be replaced by runtime data', () => {
    let n = 0;
    onRegistryChange(() => n++);
    const fake: RuntimeSetData = { ...makeSyntheticSet({ code: 'neo', name: 'Fake Neo' }) };
    registerSetData(fake);
    expect(getSetData('neo')).toBe(SET_DATA.neo);
    expect(setName('neo')).toBe('Kamigawa: Neon Dynasty');
    expect(findCard('neo:1')).toBe(SET_DATA.neo.cards[0]);
    expect(n).toBe(0);
  });

  it('re-registering a set replaces the data and carries resolved prints over by Scryfall id', () => {
    const first = makeSyntheticSet();
    registerSetData(first);
    registerPrints({ [synthId(SYNTH_CODE, 3)]: { card_print_id: 'p3', card_id: 'c3' } });
    const second = makeSyntheticSet();
    expect(second.cards[2]!.ep).toBeUndefined();
    registerSetData(second);
    expect(getSetData(SYNTH_CODE)).toBe(second);
    expect(second.cards[2]!.ep).toBe('p3');
    expect(second.cards[2]!.ec).toBe('c3');
    expect(findCard('zzz:3')).toBe(second.cards[2]);
    expect(identityFor('zzz:3')!.card_print_id).toBe('p3');
  });

  it('isNameInSet covers runtime and bundled sets; isKamigawaName stays bundled-only', () => {
    expect(isNameInSet(SYNTH_CODE, 'Common 1')).toBe(false);
    registerSetData(makeSyntheticSet());
    expect(isNameInSet(SYNTH_CODE, 'Common 1')).toBe(true);
    expect(isNameInSet(SYNTH_CODE, 'Plains')).toBe(true);
    expect(isNameInSet(SYNTH_CODE, 'Kami of Ancient Law')).toBe(false);
    expect(isNameInSet('chk', 'Kami of Ancient Law')).toBe(true);
    expect(isNameInSet('chk', 'Budoka Gardener')).toBe(true);
    expect(isNameInSet('nope', 'Kami of Ancient Law')).toBe(false);
    expect(isKamigawaName('Common 1')).toBe(false);
  });
});
