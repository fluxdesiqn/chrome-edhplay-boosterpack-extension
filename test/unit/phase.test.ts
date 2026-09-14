import { beforeEach, describe, expect, it } from 'vitest';
import { reducePhase } from '@shared/game/phase';
import { emptyPhase, type GamePhase } from '@shared/state';
import { buildGameState, makeGameState, makeMulligan, resetIds } from '../fixtures/game-state';

const ME = 'p-me';
const OPP = 'p-opp';

describe('reducePhase', () => {
  beforeEach(() => resetIds());

  describe('game_state', () => {
    it('fills every field from the payload', () => {
      const ev = makeGameState({ me: ME, opponents: [OPP], wastesInHand: 7, wastesInLibrary: 43, realCards: 50, mulliganActive: true, decisionMade: false, turnSeq: 3, turnPhase: 'beginning' });
      const p = reducePhase(emptyPhase, ev, ME);
      expect(p).toEqual<GamePhase>({
        deckSubmitted: true,
        mulliganActive: true,
        decisionMade: false,
        handCount: 7,
        libraryCount: 93,
        currentTurnPlayerId: ME,
        turnSeq: 3,
        phase: 'beginning',
        isMyTurn: true,
        isSpectator: false,
      });
    });

    it('uses library_count when my library array is omitted', () => {
      const ev = makeGameState({ me: ME, wastesInHand: 7, wastesInLibrary: 43, realCards: 50, includeLibrary: false });
      const p = reducePhase(emptyPhase, ev, ME);
      expect(p.libraryCount).toBe(93);
      expect(p.handCount).toBe(7);
    });

    it('reports isMyTurn false when another player has the turn', () => {
      const ev = makeGameState({ me: ME, opponents: [OPP], currentTurnPlayerId: OPP });
      const p = reducePhase(emptyPhase, ev, ME);
      expect(p.currentTurnPlayerId).toBe(OPP);
      expect(p.isMyTurn).toBe(false);
    });

    it('detects spectators (null id or id not among players)', () => {
      const ev = makeGameState({ me: ME, opponents: [OPP], wastesInHand: 7 });
      const asNull = reducePhase(emptyPhase, ev, null);
      expect(asNull.isSpectator).toBe(true);
      expect(asNull.isMyTurn).toBe(false);
      expect(asNull.handCount).toBe(0);
      expect(asNull.deckSubmitted).toBe(false);
      const stranger = reducePhase(emptyPhase, ev, 'p-stranger');
      expect(stranger.isSpectator).toBe(true);
      expect(reducePhase(emptyPhase, ev, ME).isSpectator).toBe(false);
    });
  });

  describe('turn / phase events', () => {
    const base = reducePhase(emptyPhase, makeGameState({ me: ME, opponents: [OPP], mulliganActive: true }), ME);

    it('turn_passed updates turn owner, seq, phase and mulligan flag', () => {
      const p = reducePhase(base, { type: 'turn_passed', new_turn_player_id: OPP, round_count: 1, turn_seq: 2, phase: 'beginning', mulligan_phase_active: false }, ME);
      expect(p.currentTurnPlayerId).toBe(OPP);
      expect(p.isMyTurn).toBe(false);
      expect(p.turnSeq).toBe(2);
      expect(p.phase).toBe('beginning');
      expect(p.mulliganActive).toBe(false);
      const back = reducePhase(p, { type: 'turn_passed', new_turn_player_id: ME, turn_seq: 3, phase: 'beginning' }, ME);
      expect(back.isMyTurn).toBe(true);
      expect(back.mulliganActive).toBe(false);
    });

    it('phase_changed updates only the phase', () => {
      const p = reducePhase(base, { type: 'phase_changed', phase: 'combat' }, ME);
      expect(p.phase).toBe('combat');
      expect({ ...p, phase: base.phase }).toEqual(base);
    });

    it('hand_kept by me marks the decision made; by others does not', () => {
      const mine = reducePhase(base, { type: 'hand_kept', player_id: ME }, ME);
      expect(mine.decisionMade).toBe(true);
      expect(mine.mulliganActive).toBe(true);
      const theirs = reducePhase(base, { type: 'hand_kept', player_id: OPP }, ME);
      expect(theirs).toBe(base);
      const closing = reducePhase(base, { type: 'hand_kept', player_id: OPP, mulligan_phase_active: false }, ME);
      expect(closing.decisionMade).toBe(false);
      expect(closing.mulliganActive).toBe(false);
    });

    it('mulligan by me resets hand/library counts from the arrays', () => {
      const p = reducePhase(base, makeMulligan(ME, { wastesInHand: 3, realInHand: 4, wastesInLibrary: 40, realCards: 52 }), ME);
      expect(p.handCount).toBe(7);
      expect(p.libraryCount).toBe(92);
      expect(reducePhase(base, makeMulligan(OPP, { realInHand: 7, realCards: 92 }), ME)).toBe(base);
    });

    it('deck_submitted by me sets deckSubmitted', () => {
      const start = reducePhase(emptyPhase, makeGameState({ me: ME, deckSubmitted: false }), ME);
      expect(start.deckSubmitted).toBe(false);
      expect(reducePhase(start, { type: 'deck_submitted', player_id: OPP }, ME)).toBe(start);
      expect(reducePhase(start, { type: 'deck_submitted', player_id: ME }, ME).deckSubmitted).toBe(true);
    });

    it('new_game_started clears the mulligan decision and reads the flag', () => {
      const kept = reducePhase(base, { type: 'hand_kept', player_id: ME, mulligan_phase_active: false }, ME);
      const p = reducePhase(kept, { type: 'new_game_started', mulligan_phase_active: true }, ME);
      expect(p.decisionMade).toBe(false);
      expect(p.mulliganActive).toBe(true);
    });

    it('player_left with a new turn owner moves the turn', () => {
      const p = reducePhase(base, { type: 'player_left', player_id: OPP, new_turn_player_id: ME }, ME);
      expect(p.currentTurnPlayerId).toBe(ME);
    });
  });

  describe('hand / library counts', () => {
    const { event } = buildGameState({ me: ME, opponents: [OPP], wastesInHand: 7, wastesInLibrary: 43, realCards: 50 });
    const base = reducePhase(emptyPhase, event, ME);

    it('cards_moved (flat, count) library -> hand adjusts both counts', () => {
      const p = reducePhase(base, { type: 'cards_moved', player_id: ME, from_zone: 'library', to_zone: 'hand', count: 2 }, ME);
      expect(p.handCount).toBe(9);
      expect(p.libraryCount).toBe(91);
    });

    it('cards_moved (flat, cards) library -> exile lowers only the library', () => {
      const p = reducePhase(base, { type: 'cards_moved', player_id: ME, from_zone: 'library', to_zone: 'exile', cards: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], face_down: true }, ME);
      expect(p.handCount).toBe(7);
      expect(p.libraryCount).toBe(90);
    });

    it('cards_moved (flat, card_ids) for another player is ignored', () => {
      const p = reducePhase(base, { type: 'cards_moved', player_id: OPP, from_zone: 'library', to_zone: 'hand', card_ids: ['x', 'y'] }, ME);
      expect(p).toBe(base);
    });

    it('cards_moved with a moves array applies each move', () => {
      const p = reducePhase(
        base,
        {
          type: 'cards_moved',
          moves: [
            { type: 'move_card', player_id: ME, id: 'a', zone: 'library', from_zone: 'hand', to: 0 },
            { type: 'move_card', player_id: ME, id: 'b', zone: 'library', from_zone: 'hand', to: 0 },
            { type: 'move_card', player_id: OPP, id: 'c', zone: 'graveyard', from_zone: 'hand' },
          ],
        },
        ME,
      );
      expect(p.handCount).toBe(5);
      expect(p.libraryCount).toBe(95);
    });

    it('move_card hand -> library moves one card between counts', () => {
      const p = reducePhase(base, { type: 'move_card', player_id: ME, id: 'a', zone: 'library', from_zone: 'hand', to: 0 }, ME);
      expect(p.handCount).toBe(6);
      expect(p.libraryCount).toBe(94);
    });

    it('move_card that gives my card to another player leaves my hand count when it came from battlefield', () => {
      const p = reducePhase(base, { type: 'move_card', player_id: OPP, from_player_id: ME, id: 'a', zone: 'battlefield', from_zone: 'battlefield' }, ME);
      expect(p).toBe(base);
    });

    it('never goes below zero', () => {
      const p = reducePhase(base, { type: 'cards_moved', player_id: ME, from_zone: 'hand', to_zone: 'graveyard', count: 99 }, ME);
      expect(p.handCount).toBe(0);
    });
  });

  describe('identity', () => {
    const base = reducePhase(emptyPhase, makeGameState({ me: ME, opponents: [OPP] }), ME);

    it('returns the same reference when nothing changed', () => {
      expect(reducePhase(base, { type: 'chat_message_received', player_id: OPP, message: 'gg' }, ME)).toBe(base);
      expect(reducePhase(base, { type: 'phase_changed', phase: base.phase }, ME)).toBe(base);
      expect(reducePhase(base, { type: 'hand_kept', player_id: OPP }, ME)).toBe(base);
      expect(reducePhase(base, { type: 'library_shuffled', player_id: ME }, ME)).toBe(base);
      expect(reducePhase(base, { type: 'cards_moved', player_id: ME, from_zone: 'library', to_zone: 'library', count: 3 }, ME)).toBe(base);
    });

    it('does not mutate the previous state', () => {
      const snapshot = { ...base };
      reducePhase(base, { type: 'turn_passed', new_turn_player_id: OPP, turn_seq: 9 }, ME);
      expect(base).toEqual(snapshot);
    });
  });
});
