import { beforeEach, describe, expect, it } from 'vitest';
import { ZoneIndex, type Observation } from '@main/zone-index';
import type { WireCard } from '@shared/protocol';
import { buildGameState, makeCard, makeReal, makeWastes, resetIds, type BuiltGameState } from '../fixtures/game-state';

const ME = 'p-me';
const OPP = 'p-opp';

const ids = (cards: Array<{ id: string }>) => cards.map((c) => c.id);
const kinds = (obs: Observation[]) => obs.map((o) => o.kind);

function fresh(): { idx: ZoneIndex; built: BuiltGameState } {
  const idx = new ZoneIndex();
  idx.localPlayerId = ME;
  const built = buildGameState({ me: ME, opponents: [OPP], wastesInHand: 2, realInHand: 1, wastesInLibrary: 3, realCards: 2 });
  idx.apply(built.event);
  return { idx, built };
}

function oppPlayer(built: BuiltGameState) {
  return built.event.players.find((p) => p.player_id === OPP)!;
}

describe('ZoneIndex', () => {
  beforeEach(() => resetIds());

  describe('game_state', () => {
    it('rebuilds every zone for every player, keeping per-zone order', () => {
      const idx = new ZoneIndex();
      idx.localPlayerId = ME;
      const built = buildGameState({ me: ME, opponents: [OPP], wastesInHand: 2, realInHand: 1, wastesInLibrary: 3, realCards: 2 });
      const obs = idx.apply(built.event);
      const opp = oppPlayer(built);

      expect(ids(idx.cardsIn('hand', ME))).toEqual(ids(built.hand));
      expect(ids(idx.cardsIn('library', ME))).toEqual(ids(built.library));
      expect(ids(idx.cardsIn('battlefield', OPP))).toEqual(ids(opp.battlefield!));
      expect(ids(idx.cardsIn('graveyard', OPP))).toEqual(ids(opp.graveyard!));
      expect(ids(idx.cardsIn('commandZone', OPP))).toEqual(ids(opp.commandZone!));
      expect(idx.cardsIn('hand', OPP)).toEqual([]);

      const total = built.hand.length + built.library.length + opp.battlefield!.length + opp.graveyard!.length + opp.commandZone!.length;
      expect(obs).toHaveLength(total);
      expect(new Set(kinds(obs))).toEqual(new Set(['seen']));
      expect(idx.snapshot()).toHaveLength(total);
      expect(idx.ownerOf(built.hand[0]!.id)).toBe(ME);
      expect(idx.ownerOf(opp.battlefield![0]!.id)).toBe(OPP);
      expect(idx.ownerOf('nope')).toBeNull();

      expect([...idx.players.keys()]).toEqual([ME, OPP]);
      expect(idx.players.get(OPP)).toEqual({ id: OPP, name: `user-${OPP}` });

      const summary = idx.snapshot().find((s) => s.id === built.hand[0]!.id)!;
      expect(summary).toMatchObject({ zone: 'hand', ownerId: ME, faceDown: false, name: 'Wastes' });
      expect(summary.card_print_id).toBe(built.hand[0]!.card_print_id);
    });

    it('a second game_state diffs against the previous index', () => {
      const { idx, built } = fresh();
      const moved = built.hand[0]!;
      const gone = built.library[0]!;
      const me = built.event.players[0]!;
      const next = {
        ...built.event,
        players: [
          { ...me, hand: built.hand.slice(1), library: built.library.slice(1), battlefield: [{ ...moved, zone: 'battlefield' as const }] },
          ...built.event.players.slice(1),
        ],
      };
      const obs = idx.apply(next);
      expect(obs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ cardId: moved.id, kind: 'moved', zone: 'battlefield' }),
          expect.objectContaining({ cardId: gone.id, kind: 'removed', zone: 'library' }),
        ]),
      );
      expect(obs).toHaveLength(2);
      expect(idx.get(gone.id)).toBeUndefined();
    });

    it('picks up revealed hidden-zone cards of other players', () => {
      const idx = new ZoneIndex();
      const built = buildGameState({ me: ME, opponents: [OPP] });
      const revealed = makeCard({ name: 'Shown', owner_id: OPP, zone: 'hand', visibility: 'revealed' });
      oppPlayer(built).revealed_hand_cards = [revealed];
      idx.apply(built.event);
      expect(idx.get(revealed.id)).toMatchObject({ ownerId: OPP, zone: 'hand', faceDown: false });
    });
  });

  describe('move_card', () => {
    it('changes zone and owner, merging updates and card into the stored object', () => {
      const { idx, built } = fresh();
      const card = built.hand[0]!;
      const obs = idx.apply({
        type: 'move_card',
        player_id: OPP,
        from_player_id: ME,
        id: card.id,
        zone: 'battlefield',
        from_zone: 'hand',
        to: { x: 120, y: 40 },
        updates: { tapped: true, visibility: 'default' },
        card: { ...card, zone: 'battlefield' },
      });
      expect(obs).toEqual([{ cardId: card.id, ownerId: OPP, zone: 'battlefield', faceDown: false, kind: 'moved' }]);
      const stored = idx.get(card.id)!;
      expect(stored.ownerId).toBe(OPP);
      expect(stored.zone).toBe('battlefield');
      expect(stored.card).toMatchObject({ name: 'Wastes', tapped: true, x: 120, y: 40 });
      expect(idx.ownerOf(card.id)).toBe(OPP);
      expect(ids(idx.cardsIn('hand', ME))).not.toContain(card.id);
      expect(ids(idx.cardsIn('battlefield', OPP))).toContain(card.id);
    });

    it('inserts at the requested position when `to` is a number', () => {
      const { idx, built } = fresh();
      const card = built.hand[0]!;
      idx.apply({ type: 'move_card', player_id: ME, id: card.id, zone: 'library', from_zone: 'hand', to: 0 });
      expect(ids(idx.cardsIn('library', ME))).toEqual([card.id, ...ids(built.library)]);
    });

    it('a same-zone reposition yields no observation', () => {
      const { idx, built } = fresh();
      const opp = oppPlayer(built);
      const card = opp.battlefield![0]!;
      const obs = idx.apply({ type: 'move_card', player_id: OPP, id: card.id, zone: 'battlefield', from_zone: 'battlefield', to: { x: 1, y: 1 } });
      expect(obs).toEqual([]);
      expect(idx.get(card.id)!.card.x).toBe(1);
    });

    it('a move of an unknown card is recorded and reported as moved', () => {
      const { idx } = fresh();
      const obs = idx.apply({ type: 'move_card', player_id: OPP, id: 'new-1', zone: 'graveyard', from_zone: 'hand', card: { id: 'new-1', name: 'Bolt' } });
      expect(kinds(obs)).toEqual(['moved']);
      expect(idx.get('new-1')).toMatchObject({ ownerId: OPP, zone: 'graveyard' });
    });
  });

  describe('cards_moved', () => {
    it('moves shape: applies each nested move', () => {
      const { idx, built } = fresh();
      const [a, b] = built.hand;
      const obs = idx.apply({
        type: 'cards_moved',
        moves: [
          { type: 'move_card', player_id: ME, id: a!.id, zone: 'library', from_zone: 'hand', to: 0 },
          { type: 'move_card', player_id: ME, id: b!.id, zone: 'library', from_zone: 'hand', to: 0 },
        ],
      });
      expect(kinds(obs)).toEqual(['moved', 'moved']);
      expect(ids(idx.cardsIn('library', ME)).slice(0, 2)).toEqual([b!.id, a!.id]);
      expect(ids(idx.cardsIn('hand', ME))).toEqual([built.hand[2]!.id]);
    });

    it('flat shape with cards: moves them and honours face_down', () => {
      const { idx, built } = fresh();
      const blanks = built.library.slice(0, 3);
      const obs = idx.apply({ type: 'cards_moved', player_id: ME, from_zone: 'library', to_zone: 'exile', cards: blanks, count: 3, face_down: true });
      expect(obs.every((o) => o.kind === 'moved' && o.zone === 'exile' && o.faceDown)).toBe(true);
      expect(ids(idx.cardsIn('exile', ME))).toEqual(ids(blanks));
      expect(ids(idx.cardsIn('library', ME))).toEqual(ids(built.library.slice(3)));
      expect(idx.get(blanks[0]!.id)!.faceDown).toBe(true);
    });

    it('flat ids-only shape for an opponent: moves known ids, ignores unknown', () => {
      const { idx, built } = fresh();
      const opp = oppPlayer(built);
      const known = opp.battlefield![0]!;
      const obs = idx.apply({ type: 'cards_moved', player_id: OPP, from_zone: 'battlefield', to_zone: 'graveyard', card_ids: [known.id, 'unknown-id'], count: 2 });
      expect(obs).toEqual([{ cardId: known.id, ownerId: OPP, zone: 'graveyard', faceDown: false, kind: 'moved' }]);
      expect(idx.get('unknown-id')).toBeUndefined();
      expect(ids(idx.cardsIn('graveyard', OPP))).toEqual([...ids(opp.graveyard!), known.id]);
    });

    it('flat count-only shape (opponent draw) changes nothing', () => {
      const { idx } = fresh();
      const before = idx.snapshot();
      expect(idx.apply({ type: 'cards_moved', player_id: OPP, from_zone: 'library', to_zone: 'hand', count: 1 })).toEqual([]);
      expect(idx.snapshot()).toEqual(before);
    });

    it('removed_token_ids are dropped', () => {
      const { idx } = fresh();
      idx.apply({ type: 'card_created', player_id: OPP, token: { id: 'tok-1', name: 'Soldier', is_token: true, zone: 'battlefield' } });
      expect(idx.get('tok-1')).toBeDefined();
      const obs = idx.apply({ type: 'cards_moved', player_id: OPP, from_zone: 'battlefield', to_zone: 'graveyard', card_ids: ['tok-1'], removed_token_ids: ['tok-1'] });
      expect(kinds(obs)).toEqual(['moved', 'removed']);
      expect(idx.get('tok-1')).toBeUndefined();
    });
  });

  describe('visibility', () => {
    it('set_visibility toggles faceDown and reports the reveal', () => {
      const { idx, built } = fresh();
      const card = built.hand[0]!;
      const down = idx.apply({ type: 'set_visibility', player_id: ME, id: card.id, visibility: 'face_down' });
      expect(down).toEqual([]);
      expect(idx.get(card.id)!.faceDown).toBe(true);
      expect(idx.get(card.id)!.card.visibility).toBe('face_down');

      const up = idx.apply({ type: 'set_visibility', player_id: ME, id: card.id, visibility: 'default' });
      expect(up).toEqual([{ cardId: card.id, ownerId: ME, zone: 'hand', faceDown: false, kind: 'revealed' }]);
      expect(idx.get(card.id)!.faceDown).toBe(false);
    });

    it('set_visibility understands the {base, revealed_to} shape', () => {
      const { idx, built } = fresh();
      const card = built.library[0]!;
      idx.apply({ type: 'set_visibility', player_id: ME, id: card.id, visibility: { base: 'face_down', revealed_to: [] } });
      expect(idx.get(card.id)!.faceDown).toBe(true);
      const obs = idx.apply({ type: 'set_visibility', player_id: ME, id: card.id, visibility: { revealed_to: [OPP] } });
      expect(kinds(obs)).toEqual(['revealed']);
      expect(idx.get(card.id)!.faceDown).toBe(false);
    });

    it('a face-down exile card flipped up is a reveal (public zone)', () => {
      const { idx, built } = fresh();
      const blank = built.library[0]!;
      idx.apply({ type: 'cards_moved', player_id: ME, from_zone: 'library', to_zone: 'exile', cards: [blank], face_down: true });
      const obs = idx.apply({ type: 'set_visibility', player_id: ME, id: blank.id, visibility: 'default' });
      expect(kinds(obs)).toEqual(['revealed']);
    });

    it('reveal_zone_cards reports revealed for each card when visibility is not default', () => {
      const { idx } = fresh();
      const shown = makeReal(2, OPP, 'hand');
      const obs = idx.apply({ type: 'reveal_zone_cards', player_id: OPP, zone: 'hand', visibility: 'revealed', cards: shown });
      expect(obs).toEqual(shown.map((c) => ({ cardId: c.id, ownerId: OPP, zone: 'hand', faceDown: false, kind: 'revealed' })));
      expect(ids(idx.cardsIn('hand', OPP))).toEqual(ids(shown));
      const back = idx.apply({ type: 'reveal_zone_cards', player_id: OPP, zone: 'hand', visibility: 'default', cards: shown });
      expect(back).toEqual([]);
      expect(idx.get(shown[0]!.id)!.card.visibility).toBe('default');
    });
  });

  describe('library_viewed', () => {
    it('sets the local library order and content from viewed_library_cards', () => {
      const { idx, built } = fresh();
      const reordered = [...built.library].reverse();
      const obs = idx.apply({ type: 'library_viewed', player_id: ME, location: 'all', count: null, view_count: 1, viewed_library_cards: reordered });
      expect(obs).toEqual([]);
      expect(ids(idx.cardsIn('library', ME))).toEqual(ids(reordered));
    });

    it('learns new cards and drops stale ones on an `all` view', () => {
      const { idx, built } = fresh();
      const extra = makeCard({ name: 'Forgotten', owner_id: ME, zone: 'library' });
      const stale = built.library[0]!;
      const viewed = [...built.library.slice(1), extra];
      const obs = idx.apply({ type: 'library_viewed', player_id: ME, location: 'all', viewed_library_cards: viewed });
      expect(obs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ cardId: extra.id, kind: 'seen', zone: 'library' }),
          expect.objectContaining({ cardId: stale.id, kind: 'removed' }),
        ]),
      );
      expect(ids(idx.cardsIn('library', ME))).toEqual(ids(viewed));
    });

    it('a `top` view only fixes the order of the viewed prefix', () => {
      const { idx, built } = fresh();
      const top = [built.library[1]!, built.library[0]!];
      idx.apply({ type: 'library_viewed', player_id: ME, location: 'top', count: 2, viewed_library_cards: top });
      expect(ids(idx.cardsIn('library', ME))).toEqual([...ids(top), ...ids(built.library.slice(2))]);
    });

    it('a view of another player without cards changes nothing', () => {
      const { idx } = fresh();
      const before = idx.snapshot();
      expect(idx.apply({ type: 'library_viewed', player_id: OPP, location: 'top', count: 3, view_count: 1 })).toEqual([]);
      expect(idx.snapshot()).toEqual(before);
    });

    it('uses target_player_id as the owner when present', () => {
      const { idx } = fresh();
      const cards = makeReal(2, OPP, 'library');
      idx.apply({ type: 'library_viewed', player_id: ME, target_player_id: OPP, location: 'top', count: 2, viewed_library_cards: cards });
      expect(ids(idx.cardsIn('library', OPP))).toEqual(ids(cards));
      expect(idx.ownerOf(cards[0]!.id)).toBe(OPP);
    });
  });

  describe('mulligan', () => {
    it('replaces the local hand and library', () => {
      const { idx, built } = fresh();
      const hand = makeWastes(1, ME, 'hand').concat(makeReal(5, ME, 'hand'));
      const library: WireCard[] = [...built.hand, ...built.library, ...makeReal(3, ME, 'library')];
      const obs = idx.apply({ type: 'mulligan', player_id: ME, hand, library, mulligan_count: 1 });
      expect(ids(idx.cardsIn('hand', ME))).toEqual(ids(hand));
      expect(ids(idx.cardsIn('library', ME))).toEqual(ids(library));
      expect(obs.filter((o) => o.kind === 'moved').map((o) => o.cardId)).toEqual(ids(built.hand));
      expect(obs.filter((o) => o.kind === 'seen')).toHaveLength(hand.length + 3);
    });
  });

  describe('lifecycle', () => {
    it('new_game_started forgets cards but keeps players and local id', () => {
      const { idx } = fresh();
      expect(idx.apply({ type: 'new_game_started', mulligan_phase_active: true })).toEqual([]);
      expect(idx.snapshot()).toEqual([]);
      expect(idx.cardsIn('hand', ME)).toEqual([]);
      expect([...idx.players.keys()]).toEqual([ME, OPP]);
      expect(idx.localPlayerId).toBe(ME);
    });

    it('player_joined / player_left maintain the players map and drop a leaver’s cards', () => {
      const { idx, built } = fresh();
      idx.apply({ type: 'player_joined', player_id: 'p-new', username: 'newbie' });
      expect(idx.players.get('p-new')).toEqual({ id: 'p-new', name: 'newbie' });
      const oppCards = oppPlayer(built).battlefield!;
      const obs = idx.apply({ type: 'player_left', player_id: OPP, new_turn_player_id: ME });
      expect(idx.players.has(OPP)).toBe(false);
      expect(obs.every((o) => o.kind === 'removed' && o.ownerId === OPP)).toBe(true);
      expect(idx.get(oppCards[0]!.id)).toBeUndefined();
    });

    it('card_created / remove_card / card_given / discard_random', () => {
      const { idx, built } = fresh();
      expect(kinds(idx.apply({ type: 'card_created', player_id: ME, token: { id: 'tok', name: 'Bear', is_token: true, zone: 'battlefield' } }))).toEqual(['seen']);
      expect(idx.get('tok')).toMatchObject({ ownerId: ME, zone: 'battlefield' });

      const given = built.hand[2]!;
      expect(idx.apply({ type: 'card_given', target_player_id: OPP, card: { ...given, zone: 'battlefield' } })).toEqual([
        { cardId: given.id, ownerId: OPP, zone: 'battlefield', faceDown: false, kind: 'moved' },
      ]);

      const discarded = built.hand[0]!;
      expect(kinds(idx.apply({ type: 'discard_random', player_id: ME, discarded_cards: [discarded] }))).toEqual(['moved']);
      expect(idx.get(discarded.id)!.zone).toBe('graveyard');

      expect(idx.apply({ type: 'remove_card', player_id: ME, card_id: 'tok', from_zone: 'battlefield' })).toEqual([
        { cardId: 'tok', ownerId: ME, zone: 'battlefield', faceDown: false, kind: 'removed' },
      ]);
      expect(idx.apply({ type: 'remove_card', player_id: ME, card_id: 'tok', from_zone: 'battlefield' })).toEqual([]);
    });

    it('place_on_battlefield and batch_cards_given move cards to the battlefield', () => {
      const { idx, built } = fresh();
      const [a, b] = built.hand;
      const obs = idx.apply({ type: 'place_on_battlefield', player_id: ME, items: [{ id: a!.id, zone: 'battlefield', from_zone: 'hand', to: { x: 3, y: 4 }, card: a }] });
      expect(obs).toEqual([{ cardId: a!.id, ownerId: ME, zone: 'battlefield', faceDown: false, kind: 'moved' }]);
      expect(idx.get(a!.id)!.card).toMatchObject({ x: 3, y: 4 });
      expect(kinds(idx.apply({ type: 'batch_cards_given', target_player_id: OPP, cards: [b] }))).toEqual(['moved']);
      expect(idx.ownerOf(b!.id)).toBe(OPP);
    });

    it('library_shuffled and unknown events are no-ops', () => {
      const { idx } = fresh();
      const before = idx.snapshot();
      expect(idx.apply({ type: 'library_shuffled', player_id: ME })).toEqual([]);
      expect(idx.apply({ type: 'pong' })).toEqual([]);
      expect(idx.snapshot()).toEqual(before);
    });
  });
});
