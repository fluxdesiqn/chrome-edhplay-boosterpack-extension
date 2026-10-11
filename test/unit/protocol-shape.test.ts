import { describe, expect, it } from 'vitest';
import { frameProblems, gameStateProblems } from '@shared/protocol';
import { makeGameState } from '../fixtures/game-state';

const gameStateFixture = () => makeGameState({ me: 'p1', opponents: ['p2'] }) as unknown as Record<string, unknown>;

describe('gameStateProblems', () => {
  it('accepts the recorded pv 4 shape and ignores extra fields', () => {
    expect(gameStateProblems(gameStateFixture())).toEqual([]);
    expect(gameStateProblems({ ...gameStateFixture(), protocol_version: 9, brand_new_field: { a: 1 } })).toEqual([]);
  });

  it('accepts an empty table (no players yet)', () => {
    expect(gameStateProblems({ type: 'game_state', players: [] })).toEqual([]);
  });

  it('flags the changes the engine cannot survive', () => {
    expect(gameStateProblems({ type: 'game_state' })).toEqual(['game_state.players is missing']);
    expect(gameStateProblems({ type: 'game_state', players: [{ id: 'p1' }] })).toEqual(['a player has no string player_id']);
    expect(gameStateProblems({ type: 'game_state', players: [{ player_id: 'p1', hand: { cards: [] } }] })).toEqual(['player.hand is not a list']);
    expect(gameStateProblems({ type: 'game_state', players: [{ player_id: 'p1', hand: [{ uid: 'c1' }] }] })).toEqual(['player.hand has a card without a string id']);
    const renamed = { type: 'game_state', players: [{ player_id: 'p1', hand: [{ id: 'c1', name: 'Wastes', card_print_id: 'x', image: 'u' }] }] };
    expect(gameStateProblems(renamed)).toEqual(['visible cards no longer carry front_image_uri']);
  });

  it('does not demand image fields on face-down cards that carry no name', () => {
    expect(gameStateProblems({ type: 'game_state', players: [{ player_id: 'p1', library: [{ id: 'c1' }] }] })).toEqual([]);
  });
});

describe('frameProblems', () => {
  it('passes unknown frame types and well-formed known ones', () => {
    expect(frameProblems({ type: 'some_new_event', whatever: 1 })).toEqual([]);
    expect(frameProblems({ type: 'move_card', id: 'c1', zone: 'hand', extra: true })).toEqual([]);
    expect(frameProblems({ type: 'cards_moved', count: 3 })).toEqual([]);
    expect(frameProblems({ type: 'chat_message_received', player_id: 'p', message: 'hi' })).toEqual([]);
  });

  it('flags renamed or retyped fields the engine reads', () => {
    expect(frameProblems({ type: 'move_card', id: 'c1', to_zone: 'hand' })).toEqual(['move_card.zone is not a string']);
    expect(frameProblems({ type: 'cards_moved', items: [] })).toEqual(['cards_moved has none of cards/moves/card_ids/count']);
    expect(frameProblems({ type: 'cards_moved', cards: [{ card_id: 'x' }] })).toEqual(['cards_moved.cards has a card without a string id']);
    expect(frameProblems({ type: 'chat_message_received', player_id: 'p', text: 'hi' })).toEqual(['chat_message_received.message is not a string']);
  });
});
