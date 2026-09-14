/**
 * Pure reducer for the coarse game-phase view the extension needs: whose turn
 * it is, whether the mulligan phase is open, my hand/library counts, etc.
 * Returns the SAME object when an event changes nothing.
 */
import { isObject } from '@shared/protocol';
import type { GamePhase } from '@shared/state';

type Patch = Partial<GamePhase>;

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** How many cards a flat `cards_moved` echo carried. */
function movedCount(ev: Record<string, unknown>): number {
  if (typeof ev.count === 'number') return ev.count;
  if (Array.isArray(ev.cards)) return ev.cards.length;
  if (Array.isArray(ev.card_ids)) return ev.card_ids.length;
  return 0;
}

interface Counts {
  handCount: number;
  libraryCount: number;
}

/** Apply a hand/library delta for a move of `n` cards. Mutates `c`. */
function applyMove(c: Counts, toZone: unknown, fromZone: unknown, toIsMe: boolean, fromIsMe: boolean, n: number): void {
  if (n <= 0) return;
  let dHand = 0;
  let dLibrary = 0;
  if (fromIsMe) {
    if (fromZone === 'hand') dHand -= n;
    if (fromZone === 'library') dLibrary -= n;
  }
  if (toIsMe) {
    if (toZone === 'hand') dHand += n;
    if (toZone === 'library') dLibrary += n;
  }
  c.handCount = Math.max(0, c.handCount + dHand);
  c.libraryCount = Math.max(0, c.libraryCount + dLibrary);
}

function moveCardPatch(prev: GamePhase, mv: Record<string, unknown>, me: string | null, c: Counts): void {
  if (me === null) return;
  const toOwner = str(mv.player_id);
  const fromOwner = str(mv.from_player_id) ?? toOwner;
  applyMove(c, mv.zone, mv.from_zone, toOwner === me, fromOwner === me, 1);
  void prev;
}

function computePatch(prev: GamePhase, ev: Record<string, unknown>, me: string | null): Patch | null {
  const mine = (pid: unknown): boolean => me !== null && pid === me;

  switch (ev.type) {
    case 'game_state': {
      const players = Array.isArray(ev.players) ? ev.players.filter(isObject) : [];
      const self = me === null ? undefined : players.find((p) => p.player_id === me);
      const hand = self && Array.isArray(self.hand) ? self.hand : null;
      const library = self && Array.isArray(self.library) ? self.library : null;
      const currentTurnPlayerId = str(ev.current_turn_player_id);
      return {
        mulliganActive: ev.mulligan_phase_active === true,
        currentTurnPlayerId,
        turnSeq: typeof ev.turn_seq === 'number' ? ev.turn_seq : prev.turnSeq,
        phase: str(ev.turn_phase),
        deckSubmitted: self?.deck_submitted === true,
        decisionMade: self?.mulligan_decision_made === true,
        handCount: hand ? hand.length : typeof self?.hand_count === 'number' ? self.hand_count : 0,
        libraryCount: typeof self?.library_count === 'number' ? self.library_count : library ? library.length : 0,
        isSpectator: self === undefined,
      };
    }

    case 'turn_passed': {
      const p: Patch = {};
      if ('new_turn_player_id' in ev) p.currentTurnPlayerId = str(ev.new_turn_player_id);
      if (typeof ev.turn_seq === 'number') p.turnSeq = ev.turn_seq;
      if (typeof ev.phase === 'string') p.phase = ev.phase;
      if (typeof ev.mulligan_phase_active === 'boolean') p.mulliganActive = ev.mulligan_phase_active;
      return p;
    }

    case 'phase_changed':
      return typeof ev.phase === 'string' ? { phase: ev.phase } : null;

    case 'hand_kept': {
      const p: Patch = {};
      if (mine(ev.player_id)) p.decisionMade = true;
      if (typeof ev.mulligan_phase_active === 'boolean') p.mulliganActive = ev.mulligan_phase_active;
      return p;
    }

    case 'mulligan': {
      if (!mine(ev.player_id)) return null;
      const p: Patch = {};
      if (Array.isArray(ev.hand)) p.handCount = ev.hand.length;
      if (Array.isArray(ev.library)) p.libraryCount = ev.library.length;
      return p;
    }

    case 'deck_submitted':
      return mine(ev.player_id) ? { deckSubmitted: true } : null;

    case 'player_left': {
      const p: Patch = {};
      if ('new_turn_player_id' in ev) p.currentTurnPlayerId = str(ev.new_turn_player_id);
      return p;
    }

    case 'new_game_started': {
      const p: Patch = { decisionMade: false };
      if (typeof ev.mulligan_phase_active === 'boolean') p.mulliganActive = ev.mulligan_phase_active;
      if ('current_turn_player_id' in ev) p.currentTurnPlayerId = str(ev.current_turn_player_id);
      if (typeof ev.turn_seq === 'number') p.turnSeq = ev.turn_seq;
      if ('turn_phase' in ev) p.phase = str(ev.turn_phase);
      return p;
    }

    case 'move_card': {
      const c: Counts = { handCount: prev.handCount, libraryCount: prev.libraryCount };
      moveCardPatch(prev, ev, me, c);
      return c;
    }

    case 'cards_moved': {
      const c: Counts = { handCount: prev.handCount, libraryCount: prev.libraryCount };
      if (Array.isArray(ev.moves)) {
        for (const mv of ev.moves) if (isObject(mv)) moveCardPatch(prev, mv, me, c);
        return c;
      }
      const owner = str(ev.player_id);
      const isMe = mine(owner);
      applyMove(c, ev.to_zone, ev.from_zone, isMe, isMe, movedCount(ev));
      return c;
    }

    default:
      return null;
  }
}

export function reducePhase(prev: GamePhase, ev: Record<string, unknown>, localPlayerId: string | null): GamePhase {
  const patch = computePatch(prev, ev, localPlayerId);
  if (!patch) return prev;
  const next: GamePhase = { ...prev, ...patch };
  next.isMyTurn = localPlayerId !== null && next.currentTurnPlayerId === localPlayerId;
  for (const k of Object.keys(next) as (keyof GamePhase)[]) {
    if (next[k] !== prev[k]) return next;
  }
  return prev;
}
