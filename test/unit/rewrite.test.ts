import { describe, expect, it } from 'vitest';
import { RewriteEngine, isCardLike, overlayIdentity } from '@main/rewrite';
import type { CardIdentity } from '@shared/protocol';

const identityA: CardIdentity = {
  card_id: 'real-a',
  card_print_id: 'print-a',
  name: 'Real Card A',
  type_line: 'Creature — Samurai',
  front_image_uri: 'https://img/a.jpg',
  back_image_uri: null,
  can_rotate: false,
  power: '2',
  toughness: '3',
  mana_cost: '{1}{W}',
  cmc: 2,
};

const identityB: CardIdentity = {
  card_id: 'real-b',
  card_print_id: 'print-b',
  name: 'Real Card B',
  type_line: 'Instant',
  front_image_uri: 'https://img/b.jpg',
  back_image_uri: 'https://img/b-back.jpg',
  can_rotate: true,
  power: null,
  toughness: null,
};

function blank(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, card_print_id: 'blank', name: 'Blank', front_image_uri: 'https://img/blank.jpg', ...extra };
}

function engineWith(entries: Array<[string, CardIdentity]>) {
  const e = new RewriteEngine();
  e.setIndex(new Map(entries));
  return e;
}

describe('isCardLike', () => {
  it('accepts plain objects with string id and a card marker', () => {
    expect(isCardLike({ id: 'x', name: 'n' })).toBe(true);
    expect(isCardLike({ id: 'x', card_print_id: 'p' })).toBe(true);
    expect(isCardLike({ id: 'x', front_image_uri: 'u' })).toBe(true);
  });
  it('rejects non-cards', () => {
    expect(isCardLike({ id: 'x' })).toBe(false);
    expect(isCardLike({ id: 1, name: 'n' })).toBe(false);
    expect(isCardLike(['id'])).toBe(false);
    expect(isCardLike(null)).toBe(false);
    expect(isCardLike('id')).toBe(false);
  });
});

describe('overlayIdentity', () => {
  it('returns a new object and never mutates the input', () => {
    const card = blank('b1', { tapped: true, x: 4 });
    const out = overlayIdentity(card, identityA);
    expect(out).not.toBe(card);
    expect(card.name).toBe('Blank');
    expect(out).toMatchObject({ id: 'b1', tapped: true, x: 4, name: 'Real Card A', card_id: 'real-a' });
  });
  it('always sets the always-fields, with back_image_uri null when absent', () => {
    const out = overlayIdentity(blank('b1'), identityA);
    expect(out.back_image_uri).toBeNull();
    expect(out.power).toBe('2');
    expect(out.can_rotate).toBe(false);
    expect(out.type_line).toBe('Creature — Samurai');
    const out2 = overlayIdentity(blank('b2'), identityB);
    expect(out2.back_image_uri).toBe('https://img/b-back.jpg');
  });
  it('sets if-present fields only when the card already has the key', () => {
    const without = overlayIdentity(blank('b1'), identityA);
    expect('mana_cost' in without).toBe(false);
    expect('cmc' in without).toBe(false);
    const withKeys = overlayIdentity(blank('b1', { mana_cost: '', cmc: 0, rarity: 'common' }), identityA);
    expect(withKeys.mana_cost).toBe('{1}{W}');
    expect(withKeys.cmc).toBe(2);
    // identity lacks rarity → existing value untouched
    expect(withKeys.rarity).toBe('common');
  });
});

describe('RewriteEngine copy-on-write', () => {
  it('returns the same reference and changed:false when nothing maps', () => {
    const engine = engineWith([['other', identityA]]);
    const msg = { type: 'cards_moved', cards: [blank('b1'), blank('b2')] };
    const res = engine.rewrite(msg);
    expect(res.msg).toBe(msg);
    expect(res.changed).toBe(false);
    expect(res.touched).toEqual([]);
  });

  it('returns the same reference with an empty index', () => {
    const engine = new RewriteEngine();
    const msg = { type: 'cards_moved', cards: [blank('b1')] };
    expect(engine.rewrite(msg).msg).toBe(msg);
  });

  it('clones only along the touched path; siblings are shared by reference', () => {
    const engine = engineWith([['b1', identityA]]);
    const untouchedPlayer: Record<string, unknown> = { player_id: 'p2', hand: [blank('h1')], battlefield: [] };
    const touchedHand = [blank('b1'), blank('b3')];
    const touchedPlayer: Record<string, unknown> = { player_id: 'p1', hand: touchedHand, graveyard: [blank('g1')] };
    const msg = { type: 'game_state', protocol_version: 4, players: [touchedPlayer, untouchedPlayer], stack: [] };

    const res = engine.rewrite(msg);
    expect(res.changed).toBe(true);
    expect(res.touched).toEqual(['b1']);
    expect(res.msg).not.toBe(msg);
    expect(res.msg.players).not.toBe(msg.players);
    const p0 = res.msg.players[0]!;
    const hand = p0.hand as Record<string, unknown>[];
    expect(p0).not.toBe(touchedPlayer);
    expect(hand).not.toBe(touchedHand);
    expect(hand[0]).not.toBe(touchedHand[0]);
    expect(hand[0]!.name).toBe('Real Card A');
    // siblings untouched → same references
    expect(hand[1]).toBe(touchedHand[1]);
    expect(p0.graveyard).toBe(touchedPlayer.graveyard);
    expect(res.msg.players[1]).toBe(untouchedPlayer);
    expect(res.msg.stack).toBe(msg.stack);
    // original untouched
    expect(touchedHand[0]!.name).toBe('Blank');
  });

  it('rewrites cards in every nested carrier shape', () => {
    const engine = engineWith([
      ['b1', identityA],
      ['b2', identityB],
    ]);

    const gameState = {
      type: 'game_state',
      protocol_version: 4,
      players: [
        { player_id: 'p1', hand: [blank('b1')], battlefield: [blank('b2', { tapped: true })] },
        { player_id: 'p2', hand: [], battlefield: [blank('zz')] },
      ],
      stack: [{ card_id: 'b1', card: blank('b1') }],
    };
    const gs = engine.rewrite(gameState);
    expect(gs.changed).toBe(true);
    expect(gs.msg.players[0]!.hand[0]!.name).toBe('Real Card A');
    expect(gs.msg.players[0]!.battlefield[0]).toMatchObject({ name: 'Real Card B', tapped: true, can_rotate: true });
    expect(gs.msg.players[1]!.battlefield[0]!.name).toBe('Blank');
    expect(gs.msg.stack[0]!.card.card_id).toBe('real-a');
    expect(gs.touched).toEqual(['b1', 'b2', 'b1']);

    const cardsMoved = { type: 'cards_moved', cards: [blank('b2'), blank('x')] };
    const cm = engine.rewrite(cardsMoved);
    expect(cm.msg.cards[0]!.front_image_uri).toBe('https://img/b.jpg');
    expect(cm.msg.cards[1]).toBe(cardsMoved.cards[1]);

    const moveCard = { type: 'move_card', id: 'b1', zone: 'hand', card: blank('b1') };
    const mc = engine.rewrite(moveCard);
    expect(mc.changed).toBe(true);
    expect(mc.msg.card.name).toBe('Real Card A');
    expect(mc.msg.id).toBe('b1');

    const place = { type: 'place_on_battlefield', items: [{ card: blank('b2'), x: 1 }, { card: blank('n') }] };
    const pl = engine.rewrite(place);
    expect(pl.msg.items[0]!.card.name).toBe('Real Card B');
    expect(pl.msg.items[0]!.x).toBe(1);
    expect(pl.msg.items[1]).toBe(place.items[1]);
  });

  it('skips tokens even when their id maps', () => {
    const engine = engineWith([['b1', identityA]]);
    const msg = { type: 'cards_moved', cards: [blank('b1', { is_token: true })] };
    const res = engine.rewrite(msg);
    expect(res.msg).toBe(msg);
    expect(res.changed).toBe(false);
  });

  it('applies if-present fields only where the key exists', () => {
    const engine = engineWith([['b1', identityA]]);
    const msg = { type: 'cards_moved', cards: [blank('b1', { mana_cost: '' }), blank('b1')] };
    const res = engine.rewrite(msg);
    expect(res.msg.cards[0]!.mana_cost).toBe('{1}{W}');
    expect('mana_cost' in res.msg.cards[1]!).toBe(false);
  });

  it('does not walk into strings, numbers or non-plain objects', () => {
    const engine = engineWith([['b1', identityA]]);
    const date = new Date(0);
    const msg = { type: 'x', note: 'b1', n: 5, when: date, card: blank('b1') };
    const res = engine.rewrite(msg);
    expect(res.msg.when).toBe(date);
    expect(res.msg.card.name).toBe('Real Card A');
  });

  it('is cycle-safe', () => {
    const engine = engineWith([['b1', identityA]]);
    const a: Record<string, unknown> = { type: 'weird', card: blank('b1') };
    const b: Record<string, unknown> = { parent: a };
    a.child = b;
    const res = engine.rewrite(a);
    expect(res.changed).toBe(true);
    expect((res.msg.card as Record<string, unknown>).name).toBe('Real Card A');
    // the cyclic back-reference is left pointing at the original container
    expect((res.msg.child as Record<string, unknown>).parent).toBe(a);
  });

  it('handles the same card object referenced twice (shared, not cyclic)', () => {
    const engine = engineWith([['b1', identityA]]);
    const shared = blank('b1');
    const msg = { type: 'x', a: [shared], b: { card: shared } };
    const res = engine.rewrite(msg);
    expect(res.msg.a[0]!.name).toBe('Real Card A');
    expect(res.msg.b.card.name).toBe('Real Card A');
    expect(res.touched).toEqual(['b1', 'b1']);
  });
});
