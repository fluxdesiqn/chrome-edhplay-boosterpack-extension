/**
 * Owner-side booster-pile / +2 activation state machine. Pure functions over
 * HokGameState; side effects (sending moves, chat) are described as "effects"
 * for the engine to perform.
 */
import type { CardRef, PackKind, RolledPack, SetCode } from '../packs/types';
import type { Activation, ActivationOp, HokGameState, PlannedMove, RolledPackRecord } from '../state';

export type ActivationEffect =
  | { kind: 'chat-pack'; pack: RolledPackRecord }
  | { kind: 'chat-map'; pairs: Array<[string, CardRef]> }
  | { kind: 'chat-shuffled'; n: number }
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

/** Start an activation: choose a set (or null = "no pack"). `op` = heroes (+2) or a second-deck pack opening. */
export function beginActivation(state: HokGameState, turnSeq: number, op: ActivationOp = 'heroes'): StepResult {
  if (state.activation && state.activation.phase !== 'done') {
    return { state, effects: [], error: 'activation already in progress' };
  }
  if (state.sweep.phase !== 'done') {
    return { state, effects: [], error: 'sweep not completed' };
  }
  const activation: Activation = { phase: 'choose-pack', op, turnSeq, pack: null, look: [], toHand: [], moves: [] };
  return { state: touch({ ...state, activation }), effects: [{ kind: 'persist' }] };
}

/**
 * Roll (or skip) a pack. With a pack the activation stops at `rolled` so the
 * reveal can be shown; `shufflePackIn` then merges it into the pile. Without a
 * pack we go straight to viewing the top of the existing pile.
 */
export function openPack(
  state: HokGameState,
  set: SetCode | null,
  roll: (set: SetCode, kind: PackKind) => RolledPack,
  shuffleInto: (pile: CardRef[], pack: CardRef[], seed: string) => CardRef[],
  kind: PackKind = 'draft',
): StepResult {
  const a = state.activation;
  if (!a || a.phase !== 'choose-pack') return { state, effects: [], error: 'not choosing a pack' };
  if (!set) return takeLook({ ...state, activation: { ...a, pack: null } }, [], shuffleInto);
  const rolled = roll(set, kind);
  const record: RolledPackRecord = { ...rolled, n: state.packs.length + 1 };
  const activation: Activation = { ...a, phase: 'rolled', pack: record, look: [], toHand: [], moves: [] };
  return {
    state: touch({ ...state, packs: [...state.packs, record], activation }),
    effects: [{ kind: 'chat-pack', pack: record }, { kind: 'persist' }],
  };
}

/** After the reveal: shuffle the rolled pack into the pile and look at the top cards. */
export function shufflePackIn(
  state: HokGameState,
  shuffleInto: (pile: CardRef[], pack: CardRef[], seed: string) => CardRef[],
): StepResult {
  const a = state.activation;
  if (!a || a.phase !== 'rolled' || !a.pack) return { state, effects: [], error: 'no rolled pack to shuffle in' };
  const r = takeLook(state, [{ kind: 'chat-shuffled', n: a.pack.n }], shuffleInto);
  return r;
}

function takeLook(
  state: HokGameState,
  effects: ActivationEffect[],
  shuffleInto: (pile: CardRef[], pack: CardRef[], seed: string) => CardRef[],
): StepResult {
  const a = state.activation!;
  let pile = state.pile;
  if (a.pack) pile = shuffleInto(pile, a.pack.cards, a.pack.seed);
  if (a.op === 'open') {
    // Second-deck mode: the pack just joins the pile; nothing is looked at or taken.
    const done: Activation = { ...a, phase: 'done', look: [], toHand: [], moves: [] };
    return { state: touch({ ...state, pile, activation: done }), effects: [...effects, { kind: 'persist' }] };
  }
  const lookCount = Math.min(LOOK_COUNT, pile.length);
  const look = pile.slice(0, lookCount);
  const rest = pile.slice(lookCount);
  if (look.length === 0) {
    // Nothing to look at: the ability resolves with no effect.
    const done: Activation = { ...a, phase: 'done', look: [], toHand: [], moves: [] };
    return {
      state: touch({ ...state, pile: rest, activation: done, activationCount: state.activationCount + 1 }),
      effects: [...effects, { kind: 'persist' }],
    };
  }
  const activation: Activation = { ...a, phase: 'viewing', look, toHand: [], moves: [] };
  return { state: touch({ ...state, pile: rest, activation }), effects: [...effects, { kind: 'persist' }] };
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
  if (a.pack && a.phase === 'rolled') {
    packs = packs.filter((p) => p.n !== a.pack!.n);
  } else if (a.pack) {
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

// ---------------------------------------------------------------------------
// Second-deck mode: the booster pile is a hidden deck the owner draws from.
// ---------------------------------------------------------------------------

/** Plan moves for the top `count` cards of the pile into `zone` (draw → hand, mill → graveyard). */
export function takeFromPile(state: HokGameState, count: number, zone: 'hand' | 'graveyard', turnSeq: number): StepResult {
  if (state.activation && state.activation.phase !== 'done') return { state, effects: [], error: 'another operation is in progress' };
  if (state.sweep.phase !== 'done') return { state, effects: [], error: 'sweep not completed' };
  const n = Math.min(count, state.pile.length);
  if (n <= 0) return { state, effects: [], error: 'booster pile is empty' };
  if (state.reservoir.length < n) return { state, effects: [], error: `need ${n} blanks, have ${state.reservoir.length}` };
  const refs = state.pile.slice(0, n);
  return placeRefs({ ...state, pile: state.pile.slice(n) }, refs, zone, zone === 'hand' ? 'draw' : 'mill', turnSeq);
}

/** Take one specific card out of the pile (a "search"). */
export function takeSpecific(state: HokGameState, ref: CardRef, zone: 'hand' | 'graveyard', turnSeq: number): StepResult {
  if (state.activation && state.activation.phase !== 'done') return { state, effects: [], error: 'another operation is in progress' };
  if (state.sweep.phase !== 'done') return { state, effects: [], error: 'sweep not completed' };
  const i = state.pile.indexOf(ref);
  if (i < 0) return { state, effects: [], error: 'card is not in the booster pile' };
  if (state.reservoir.length < 1) return { state, effects: [], error: 'no blanks left' };
  const pile = [...state.pile.slice(0, i), ...state.pile.slice(i + 1)];
  return placeRefs({ ...state, pile }, [ref], zone, 'search', turnSeq);
}

function placeRefs(state: HokGameState, refs: CardRef[], zone: 'hand' | 'graveyard', op: ActivationOp, turnSeq: number): StepResult {
  const blanks = state.reservoir.slice(0, refs.length);
  const reservoir = state.reservoir.slice(refs.length);
  const mappings = { ...state.mappings };
  const announced = [...state.announced];
  const moves: PlannedMove[] = refs.map((ref, i) => {
    const blankId = blanks[i]!;
    mappings[blankId] = { ref, public: zone === 'graveyard', assignedAt: turnSeq };
    if (zone === 'graveyard' && !announced.includes(blankId)) announced.push(blankId);
    return { blankId, ref, zone, sent: false, done: false };
  });
  const effects: ActivationEffect[] = [{ kind: 'persist' }];
  if (zone === 'graveyard') effects.push({ kind: 'chat-map', pairs: moves.map((m) => [m.blankId, m.ref]) });
  for (const m of moves) effects.push({ kind: 'move', move: m });
  const activation: Activation = { phase: 'resolving', op, turnSeq, pack: null, look: refs, toHand: zone === 'hand' ? refs.map((_, i) => i) : [], moves };
  return { state: touch({ ...state, reservoir, mappings, announced, activation }), effects };
}

/** Reshuffle the whole booster pile with a fresh seed. */
export function reshufflePile(state: HokGameState, seed: string, shuffle: (pile: CardRef[], seed: string) => CardRef[]): StepResult {
  if (state.activation && state.activation.phase !== 'done') return { state, effects: [], error: 'another operation is in progress' };
  if (state.pile.length < 2) return { state, effects: [] };
  return { state: touch({ ...state, pile: shuffle(state.pile, seed) }), effects: [{ kind: 'persist' }] };
}
