/**
 * Owner-side booster-pile / +2 activation state machine. Pure functions over
 * HokGameState; side effects (sending moves, chat) are described as "effects"
 * for the engine to perform.
 */
import type { CardRef, RolledPack, SetCode } from '../packs/types';
import type { Activation, HokGameState, PlannedMove, RolledPackRecord } from '../state';

export type ActivationEffect =
  | { kind: 'chat-pack'; pack: RolledPackRecord }
  | { kind: 'chat-map'; pairs: Array<[string, CardRef]> }
  | { kind: 'move'; move: PlannedMove }
  | { kind: 'persist' };

export interface StepResult {
  state: HokGameState;
  effects: ActivationEffect[];
  error?: string;
}

export const LOOK_COUNT = 4;
export const KEEP_COUNT = 2;

const touch = (s: HokGameState): HokGameState => ({ ...s, updatedAt: Date.now() });

/** Start an activation: choose a set (or null = "no pack"). */
export function beginActivation(state: HokGameState, turnSeq: number): StepResult {
  if (state.activation && state.activation.phase !== 'done') {
    return { state, effects: [], error: 'activation already in progress' };
  }
  if (state.sweep.phase !== 'done') {
    return { state, effects: [], error: 'sweep not completed' };
  }
  const activation: Activation = { phase: 'choose-pack', turnSeq, pack: null, look: [], toHand: [], moves: [] };
  return { state: touch({ ...state, activation }), effects: [{ kind: 'persist' }] };
}

/**
 * Roll (or skip) a pack, shuffle it into the pile and take the top cards to look at.
 * `roll` is injected so this module stays free of data imports.
 */
export function openPack(
  state: HokGameState,
  set: SetCode | null,
  roll: (set: SetCode) => RolledPack,
  shuffleInto: (pile: CardRef[], pack: CardRef[], seed: string) => CardRef[],
): StepResult {
  const a = state.activation;
  if (!a || a.phase !== 'choose-pack') return { state, effects: [], error: 'not choosing a pack' };
  const effects: ActivationEffect[] = [];
  let pile = state.pile;
  let record: RolledPackRecord | null = null;
  let packs = state.packs;
  if (set) {
    const rolled = roll(set);
    record = { ...rolled, n: state.packs.length + 1 };
    pile = shuffleInto(pile, rolled.cards, rolled.seed);
    packs = [...packs, record];
    effects.push({ kind: 'chat-pack', pack: record });
  }
  const lookCount = Math.min(LOOK_COUNT, pile.length);
  const look = pile.slice(0, lookCount);
  const rest = pile.slice(lookCount);
  if (look.length === 0) {
    // Nothing to look at: the ability resolves with no effect.
    const done: Activation = { ...a, phase: 'done', pack: record, look: [], toHand: [], moves: [] };
    return {
      state: touch({ ...state, pile: rest, packs, activation: done, activationCount: state.activationCount + 1 }),
      effects: [...effects, { kind: 'persist' }],
    };
  }
  const activation: Activation = { ...a, phase: 'viewing', pack: record, look, toHand: [], moves: [] };
  return { state: touch({ ...state, pile: rest, packs, activation }), effects: [...effects, { kind: 'persist' }] };
}

/** Number of blanks needed for the current look. */
export function blanksNeeded(state: HokGameState): number {
  return state.activation?.look.length ?? 0;
}

/** Reduce the look to what the reservoir can cover; extra cards go back on top of the pile in order. */
export function lookFewer(state: HokGameState): StepResult {
  const a = state.activation;
  if (!a || a.phase !== 'viewing') return { state, effects: [], error: 'not viewing' };
  const k = Math.min(a.look.length, state.reservoir.length);
  if (k === a.look.length) return { state, effects: [] };
  const keep = a.look.slice(0, k);
  const back = a.look.slice(k);
  const activation: Activation = { ...a, look: keep, toHand: [] };
  return { state: touch({ ...state, pile: [...back, ...state.pile], activation }), effects: [{ kind: 'persist' }] };
}

/** Cancel while viewing: put the look back on top and remove the pack we just shuffled in. */
export function cancelActivation(state: HokGameState): StepResult {
  const a = state.activation;
  if (!a) return { state, effects: [] };
  if (a.phase === 'resolving') return { state, effects: [], error: 'cannot cancel while resolving' };
  let pile = [...a.look, ...state.pile];
  let packs = state.packs;
  if (a.pack) {
    const remove = new Map<CardRef, number>();
    for (const c of a.pack.cards) remove.set(c, (remove.get(c) ?? 0) + 1);
    pile = pile.filter((c) => {
      const n = remove.get(c) ?? 0;
      if (n > 0) {
        remove.set(c, n - 1);
        return false;
      }
      return true;
    });
    packs = packs.filter((p) => p.n !== a.pack!.n);
  }
  return { state: touch({ ...state, pile, packs, activation: null }), effects: [{ kind: 'persist' }] };
}

/** Owner picked which look indices go to hand; the rest go to the graveyard. */
export function pickCards(state: HokGameState, toHand: number[]): StepResult {
  const a = state.activation;
  if (!a || a.phase !== 'viewing') return { state, effects: [], error: 'not viewing' };
  const need = Math.min(KEEP_COUNT, a.look.length);
  const uniq = [...new Set(toHand)].filter((i) => i >= 0 && i < a.look.length);
  if (uniq.length !== need) return { state, effects: [], error: `pick exactly ${need}` };
  if (state.reservoir.length < a.look.length) {
    return { state, effects: [], error: `need ${a.look.length} blanks, have ${state.reservoir.length}` };
  }
  const blanks = state.reservoir.slice(0, a.look.length);
  const reservoir = state.reservoir.slice(a.look.length);
  const mappings = { ...state.mappings };
  const moves: PlannedMove[] = [];
  const graveMoves: PlannedMove[] = [];
  const handMoves: PlannedMove[] = [];
  a.look.forEach((ref, i) => {
    const blankId = blanks[i]!;
    const zone = uniq.includes(i) ? 'hand' : 'graveyard';
    mappings[blankId] = { ref, public: zone === 'graveyard', assignedAt: a.turnSeq };
    const mv: PlannedMove = { blankId, ref, zone, sent: false, done: false };
    (zone === 'graveyard' ? graveMoves : handMoves).push(mv);
  });
  moves.push(...graveMoves, ...handMoves);
  const effects: ActivationEffect[] = [{ kind: 'persist' }];
  const announced = [...state.announced];
  if (graveMoves.length) {
    effects.push({ kind: 'chat-map', pairs: graveMoves.map((m) => [m.blankId, m.ref]) });
    for (const m of graveMoves) if (!announced.includes(m.blankId)) announced.push(m.blankId);
  }
  for (const m of moves) effects.push({ kind: 'move', move: m });
  const activation: Activation = { ...a, phase: 'resolving', toHand: uniq, moves };
  return { state: touch({ ...state, reservoir, mappings, announced, activation }), effects };
}

export function markMoveSent(state: HokGameState, blankId: string): HokGameState {
  const a = state.activation;
  if (!a) return state;
  return { ...state, activation: { ...a, moves: a.moves.map((m) => (m.blankId === blankId ? { ...m, sent: true } : m)) } };
}

/** A blank was observed in its target zone; returns updated state and whether the activation completed. */
export function markMoveDone(state: HokGameState, blankId: string, zone: string): { state: HokGameState; completed: boolean } {
  const a = state.activation;
  if (!a || a.phase !== 'resolving') return { state, completed: false };
  let changed = false;
  const moves = a.moves.map((m) => {
    if (m.blankId === blankId && m.zone === zone && !m.done) {
      changed = true;
      return { ...m, done: true, sent: true };
    }
    return m;
  });
  if (!changed) return { state, completed: false };
  const all = moves.every((m) => m.done);
  const activation: Activation = { ...a, moves, phase: all ? 'done' : 'resolving' };
  const next = touch({ ...state, activation, activationCount: all ? state.activationCount + 1 : state.activationCount });
  return { state: next, completed: all };
}

export function clearDoneActivation(state: HokGameState): HokGameState {
  if (state.activation?.phase === 'done') return { ...state, activation: null };
  return state;
}

/** Pending (unsent or unconfirmed) moves of the in-flight activation. */
export function pendingMoves(state: HokGameState): PlannedMove[] {
  const a = state.activation;
  if (!a || a.phase !== 'resolving') return [];
  return a.moves.filter((m) => !m.done);
}
