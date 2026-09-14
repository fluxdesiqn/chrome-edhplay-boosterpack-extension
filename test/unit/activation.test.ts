import { describe, expect, it } from 'vitest';
import {
  beginActivation,
  cancelActivation,
  lookFewer,
  markMoveDone,
  openPack,
  pendingMoves,
  pickCards,
  shufflePackIn,
} from '@shared/game/activation';
import { emptyGameState, type HokGameState } from '@shared/state';
import type { CardRef, PackKind, RolledPack, SetCode } from '@shared/packs/types';

const refs = (n: number, set = 'neo'): CardRef[] => Array.from({ length: n }, (_, i) => `${set}:${i + 1}` as CardRef);

const roll = (set: SetCode, kind: PackKind = 'draft'): RolledPack => ({ set, kind, seed: 'abcd', dataVersion: 'dv', cards: refs(15, set), foil: [] });
/** open + shuffle in one go for tests that do not care about the reveal */
const open = (s: HokGameState, set: SetCode | null) => {
  const r = openPack(s, set, roll, shuffleInto);
  return set ? shufflePackIn(r.state, shuffleInto) : r;
};
const shuffleInto = (pile: CardRef[], pack: CardRef[]) => [...pack, ...pile]; // deterministic for tests

function ready(): HokGameState {
  const s = emptyGameState('room', 'me');
  s.sweep = { phase: 'done', stepIndex: 7 };
  s.reservoir = Array.from({ length: 50 }, (_, i) => `blank-${i}`);
  s.seenBlankIds = [...s.reservoir];
  return s;
}

describe('activation state machine', () => {
  it('refuses to start before the sweep is done', () => {
    const s = emptyGameState('r', 'me');
    expect(beginActivation(s, 1).error).toMatch(/sweep/);
  });

  it('rolls a pack, publishes it, stops at the reveal, then shuffles in and shows the top four', () => {
    let r = beginActivation(ready(), 3);
    r = openPack(r.state, 'neo', roll, shuffleInto, 'collector');
    expect(r.error).toBeUndefined();
    expect(r.effects.some((e) => e.kind === 'chat-pack')).toBe(true);
    expect(r.state.activation?.phase).toBe('rolled');
    expect(r.state.activation?.pack?.kind).toBe('collector');
    expect(r.state.pile).toHaveLength(0); // not shuffled in yet
    expect(r.state.packs[0]?.n).toBe(1);
    expect(pickCards(r.state, [0, 1]).error).toMatch(/not viewing/);
    r = shufflePackIn(r.state, shuffleInto);
    expect(r.effects.some((e) => e.kind === 'chat-shuffled' && e.n === 1)).toBe(true);
    expect(r.state.activation?.phase).toBe('viewing');
    expect(r.state.activation?.look).toEqual(refs(4));
    expect(r.state.pile).toHaveLength(11);
  });

  it('cancel during the reveal discards the pack record and leaves the pile untouched', () => {
    const base = ready();
    base.pile = refs(3, 'bok');
    let r = beginActivation(base, 3);
    r = openPack(r.state, 'neo', roll, shuffleInto);
    r = cancelActivation(r.state);
    expect(r.state.pile).toEqual(refs(3, 'bok'));
    expect(r.state.packs).toHaveLength(0);
    expect(r.state.activation).toBeNull();
  });

  it('"no pack" with an empty pile resolves with no effect', () => {
    let r = beginActivation(ready(), 3);
    r = openPack(r.state, null, roll, shuffleInto);
    expect(r.state.activation?.phase).toBe('done');
    expect(r.state.activationCount).toBe(1);
    expect(r.state.reservoir).toHaveLength(50);
  });

  it('picks two to hand, rest to graveyard, announcing graveyard pairs first', () => {
    let r = beginActivation(ready(), 3);
    r = open(r.state, 'chk');
    r = pickCards(r.state, [0, 2]);
    expect(r.error).toBeUndefined();
    const a = r.state.activation!;
    expect(a.phase).toBe('resolving');
    expect(a.moves.map((m) => m.zone)).toEqual(['graveyard', 'graveyard', 'hand', 'hand']);
    expect(r.state.reservoir).toHaveLength(46);
    const chat = r.effects.find((e) => e.kind === 'chat-map');
    expect(chat && chat.kind === 'chat-map' ? chat.pairs.length : 0).toBe(2);
    const firstMoveIdx = r.effects.findIndex((e) => e.kind === 'move');
    const chatIdx = r.effects.findIndex((e) => e.kind === 'chat-map');
    expect(chatIdx).toBeLessThan(firstMoveIdx);
    // graveyard blanks are public, hand blanks private
    const gy = a.moves.filter((m) => m.zone === 'graveyard');
    const hd = a.moves.filter((m) => m.zone === 'hand');
    expect(r.state.mappings[gy[0]!.blankId]?.public).toBe(true);
    expect(r.state.mappings[hd[0]!.blankId]?.public).toBe(false);
    expect(r.state.mappings[hd[0]!.blankId]?.ref).toBe(a.look[0]);
  });

  it('rejects a wrong pick count', () => {
    let r = beginActivation(ready(), 3);
    r = open(r.state, 'chk');
    expect(pickCards(r.state, [0]).error).toMatch(/exactly 2/);
    expect(pickCards(r.state, [0, 1, 2]).error).toMatch(/exactly 2/);
    // duplicates collapse: [0,0,1] is a valid pick of 0 and 1
    expect(pickCards(r.state, [0, 0, 1]).error).toBeUndefined();
  });

  it('completes when all moves are observed and counts the activation', () => {
    let r = beginActivation(ready(), 3);
    r = open(r.state, 'chk');
    r = pickCards(r.state, [1, 3]);
    let s = r.state;
    expect(pendingMoves(s)).toHaveLength(4);
    for (const m of s.activation!.moves) {
      const out = markMoveDone(s, m.blankId, m.zone);
      s = out.state;
    }
    expect(s.activation?.phase).toBe('done');
    expect(s.activationCount).toBe(1);
    expect(pendingMoves(s)).toHaveLength(0);
  });

  it('ignores an observation into the wrong zone', () => {
    let r = beginActivation(ready(), 3);
    r = open(r.state, 'chk');
    r = pickCards(r.state, [0, 1]);
    const m = r.state.activation!.moves[0]!;
    const out = markMoveDone(r.state, m.blankId, m.zone === 'hand' ? 'graveyard' : 'hand');
    expect(out.completed).toBe(false);
    expect(out.state).toBe(r.state);
  });

  it('lookFewer trims the look to the reservoir size and returns extras to the pile top', () => {
    const s = ready();
    s.reservoir = s.reservoir.slice(0, 2);
    let r = beginActivation(s, 3);
    r = open(r.state, 'sok');
    expect(pickCards(r.state, [0, 1]).error).toMatch(/need 4 blanks/);
    r = lookFewer(r.state);
    expect(r.state.activation?.look).toEqual(refs(2, 'sok'));
    expect(r.state.pile.slice(0, 2)).toEqual([refs(4, 'sok')[2], refs(4, 'sok')[3]]);
    r = pickCards(r.state, [0, 1]);
    expect(r.error).toBeUndefined();
    expect(r.state.activation?.moves.every((m) => m.zone === 'hand')).toBe(true);
  });

  it('cancel while viewing restores the pile exactly and drops the pack record', () => {
    const base = ready();
    base.pile = refs(3, 'bok');
    let r = beginActivation(base, 3);
    r = open(r.state, 'neo');
    r = cancelActivation(r.state);
    expect(r.state.pile).toEqual(refs(3, 'bok'));
    expect(r.state.packs).toHaveLength(0);
    expect(r.state.activation).toBeNull();
  });
});
