import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectPlaceholder,
  planSweep,
  reservoirFromExileEcho,
  verifyStep,
  type FoundPlaceholder,
  type SweepPlan,
  type SweepStep,
} from '@shared/sweep/planner';
import { PLAINS_PRINT_ID, WASTES_PRINT_ID, makeCard, makePlains, makeReal, makeWastes, resetIds } from '../fixtures/game-state';

const ME = 'p-me';
const OPP = 'p-opp';
const opts = { minCopies: 50, preferredName: 'Wastes' };

describe('detectPlaceholder', () => {
  beforeEach(() => resetIds());

  it('finds 50 Wastes split across hand (7) and library (43)', () => {
    const hand = makeWastes(7, ME, 'hand');
    const library = [...makeWastes(43, ME, 'library'), ...makeReal(50, ME, 'library')];
    const det = detectPlaceholder({ hand, library }, opts);
    expect(det.kind).toBe('found');
    if (det.kind !== 'found') return;
    expect(det.printId).toBe(WASTES_PRINT_ID);
    expect(det.name).toBe('Wastes');
    expect(det.ids.hand).toEqual(hand.map((c) => c.id));
    expect(det.ids.library).toEqual(library.slice(0, 43).map((c) => c.id));
  });

  it('finds 52 Wastes (more than the threshold)', () => {
    const det = detectPlaceholder({ hand: makeWastes(2, ME, 'hand'), library: makeWastes(50, ME, 'library') }, opts);
    expect(det.kind).toBe('found');
    if (det.kind === 'found') expect(det.ids.hand.length + det.ids.library.length).toBe(52);
  });

  it('50 Plains + 50 Wastes is ambiguous without a preferred name match', () => {
    const library = [...makeWastes(50, ME, 'library'), ...makePlains(50, ME, 'library')];
    const det = detectPlaceholder({ hand: [], library }, { minCopies: 50, preferredName: 'Forest' });
    expect(det.kind).toBe('ambiguous');
    if (det.kind === 'ambiguous') {
      expect(det.candidates).toHaveLength(2);
      expect(det.candidates.map((c) => c.printId).sort()).toEqual([PLAINS_PRINT_ID, WASTES_PRINT_ID].sort());
      expect(det.candidates.every((c) => c.count === 50)).toBe(true);
    }
  });

  it('50 Plains + 50 Wastes resolves to the preferred name', () => {
    const library = [...makePlains(50, ME, 'library'), ...makeWastes(50, ME, 'library')];
    const det = detectPlaceholder({ hand: [], library }, opts);
    expect(det).toMatchObject({ kind: 'found', printId: WASTES_PRINT_ID, name: 'Wastes' });
  });

  it('chosenPrintId wins over the preferred name', () => {
    const library = [...makePlains(50, ME, 'library'), ...makeWastes(50, ME, 'library')];
    const det = detectPlaceholder({ hand: [], library }, { ...opts, chosenPrintId: PLAINS_PRINT_ID });
    expect(det).toMatchObject({ kind: 'found', printId: PLAINS_PRINT_ID, name: 'Plains' });
  });

  it('a chosenPrintId that is not a candidate falls through to the other rules', () => {
    const det = detectPlaceholder({ hand: [], library: makeWastes(50, ME, 'library') }, { ...opts, chosenPrintId: 'print-nope' });
    expect(det).toMatchObject({ kind: 'found', printId: WASTES_PRINT_ID });
  });

  it('49 copies is none, with the near-miss listed as a candidate', () => {
    const library = [...makeWastes(49, ME, 'library'), ...makePlains(3, ME, 'library'), ...makeReal(40, ME, 'library')];
    const det = detectPlaceholder({ hand: [], library }, opts);
    expect(det.kind).toBe('none');
    if (det.kind === 'none') {
      expect(det.candidates[0]).toEqual({ printId: WASTES_PRINT_ID, name: 'Wastes', count: 49 });
      expect(det.candidates[1]).toEqual({ printId: PLAINS_PRINT_ID, name: 'Plains', count: 3 });
      expect(det.candidates).toHaveLength(2);
    }
  });

  it('ignores 50 copies of a non-basic card', () => {
    const library: ReturnType<typeof makeReal> = [];
    for (let i = 0; i < 50; i++) library.push(makeCard({ card_print_id: 'print-relic', name: 'Relic of Progenitus', type_line: 'Artifact', owner_id: ME, zone: 'library' }));
    const det = detectPlaceholder({ hand: [], library }, opts);
    expect(det).toEqual({ kind: 'none', candidates: [] });
  });

  it('a single basic-land group over threshold is found even with an unrelated preferred name', () => {
    const det = detectPlaceholder({ hand: [], library: makePlains(60, ME, 'library') }, { minCopies: 50, preferredName: 'Wastes' });
    expect(det).toMatchObject({ kind: 'found', printId: PLAINS_PRINT_ID });
  });

  it('skips cards without a card_print_id', () => {
    const library = makeWastes(50, ME, 'library').map((c) => ({ ...c, card_print_id: undefined }));
    expect(detectPlaceholder({ hand: [], library }, opts)).toEqual({ kind: 'none', candidates: [] });
  });
});

function found(hand: string[], library: string[]): FoundPlaceholder {
  return { kind: 'found', printId: WASTES_PRINT_ID, name: 'Wastes', ids: { hand, library } };
}

describe('planSweep', () => {
  it('produces the exact step list, ordering library blanks by the known library order', () => {
    const det = found(['h1', 'h2'], ['l1', 'l2', 'l3']);
    const plan = planSweep(det, { handSize: 7, libraryKnown: true, libraryOrderIds: ['r1', 'l3', 'r2', 'l1', 'l2', 'r3'] });
    expect(plan.placeholderPrintId).toBe(WASTES_PRINT_ID);
    expect(plan.placeholderName).toBe('Wastes');
    expect(plan.handBlankIds).toEqual(['h1', 'h2']);
    expect(plan.libraryBlankIds).toEqual(['l3', 'l1', 'l2']);
    expect(plan.targetHandSize).toBe(7);
    expect(plan.steps).toEqual<SweepStep[]>([
      { kind: 'move_hand_blank', id: 'h1' },
      { kind: 'move_hand_blank', id: 'h2' },
      { kind: 'view_library' },
      { kind: 'reorder', blankIds: ['h1', 'h2', 'l3', 'l1', 'l2'] },
      { kind: 'clear_view' },
      { kind: 'exile_top', count: 5 },
      { kind: 'draw', count: 2 },
      { kind: 'shuffle' },
    ]);
  });

  it('skips the draw step when no blanks were in hand and keeps detection order when the library is unknown', () => {
    const plan = planSweep(found([], ['l1', 'l2']), { handSize: 7, libraryKnown: false, libraryOrderIds: [] });
    expect(plan.libraryBlankIds).toEqual(['l1', 'l2']);
    expect(plan.steps).toEqual<SweepStep[]>([
      { kind: 'view_library' },
      { kind: 'reorder', blankIds: ['l1', 'l2'] },
      { kind: 'clear_view' },
      { kind: 'exile_top', count: 2 },
      { kind: 'shuffle' },
    ]);
  });

  it('does not alias the detection arrays', () => {
    const det = found(['h1'], ['l1']);
    const plan = planSweep(det, { handSize: 7, libraryKnown: false, libraryOrderIds: [] });
    plan.handBlankIds.push('x');
    expect(det.ids.hand).toEqual(['h1']);
  });
});

describe('verifyStep', () => {
  const plan: SweepPlan = planSweep(found(['h1', 'h2'], ['l1', 'l2', 'l3']), { handSize: 7, libraryKnown: true, libraryOrderIds: [] });
  const step = (kind: SweepStep['kind']) => plan.steps.find((s) => s.kind === kind)!;
  const blankCards = (ids: string[]) => ids.map((id) => ({ id, name: 'Wastes', card_print_id: WASTES_PRINT_ID }));

  it('move_hand_blank accepts move_card / cards_moved echoes for that id into my library', () => {
    const s: SweepStep = { kind: 'move_hand_blank', id: 'h1' };
    expect(verifyStep(s, { type: 'move_card', player_id: ME, id: 'h1', zone: 'library', from_zone: 'hand', to: 0 }, plan, ME)).toBe('ok');
    expect(verifyStep(s, { type: 'cards_moved', moves: [{ type: 'move_card', player_id: ME, id: 'h1', zone: 'library', from_zone: 'hand' }] }, plan, ME)).toBe('ok');
    expect(verifyStep(s, { type: 'cards_moved', player_id: ME, to_zone: 'library', from_zone: 'hand', card_ids: ['h1'] }, plan, ME)).toBe('ok');
    expect(verifyStep(s, { type: 'move_card', player_id: ME, id: 'h2', zone: 'library', from_zone: 'hand' }, plan, ME)).toBe('ignore');
    expect(verifyStep(s, { type: 'move_card', player_id: ME, id: 'h1', zone: 'graveyard', from_zone: 'hand' }, plan, ME)).toBe('ignore');
    expect(verifyStep(s, { type: 'move_card', player_id: OPP, id: 'h1', zone: 'library', from_zone: 'hand' }, plan, ME)).toBe('ignore');
    expect(verifyStep(s, { type: 'library_shuffled', player_id: ME }, plan, ME)).toBe('ignore');
  });

  it('view_library accepts my library_viewed echo carrying the cards', () => {
    const s = step('view_library');
    expect(verifyStep(s, { type: 'library_viewed', player_id: ME, location: 'all', count: null, view_count: 1, viewed_library_cards: [] }, plan, ME)).toBe('ok');
    expect(verifyStep(s, { type: 'library_viewed', player_id: ME, location: 'all', count: null, view_count: 1 }, plan, ME)).toBe('ignore');
    expect(verifyStep(s, { type: 'library_viewed', player_id: OPP, location: 'all', viewed_library_cards: [] }, plan, ME)).toBe('ignore');
    expect(verifyStep(s, { type: 'library_viewed', player_id: ME, target_player_id: OPP, location: 'all', viewed_library_cards: [] }, plan, ME)).toBe('ignore');
  });

  it('reorder / clear_view / shuffle accept their echoes for me only', () => {
    expect(verifyStep(step('reorder'), { type: 'viewed_cards_reordered', player_id: ME, card_ids: [] }, plan, ME)).toBe('ok');
    expect(verifyStep(step('reorder'), { type: 'viewed_cards_reordered', player_id: OPP }, plan, ME)).toBe('ignore');
    expect(verifyStep(step('clear_view'), { type: 'library_viewing_cleared', player_id: ME }, plan, ME)).toBe('ok');
    expect(verifyStep(step('clear_view'), { type: 'library_viewing_cleared', player_id: OPP }, plan, ME)).toBe('ignore');
    expect(verifyStep(step('shuffle'), { type: 'library_shuffled', player_id: ME }, plan, ME)).toBe('ok');
    expect(verifyStep(step('shuffle'), { type: 'library_shuffled', player_id: OPP }, plan, ME)).toBe('ignore');
    expect(verifyStep(step('shuffle'), { type: 'library_viewing_cleared', player_id: ME }, plan, ME)).toBe('ignore');
  });

  it('exile_top accepts a matching all-blank echo and rejects a stray id', () => {
    const s = step('exile_top');
    const good = { type: 'cards_moved', player_id: ME, from_zone: 'library', to_zone: 'exile', cards: blankCards(['h1', 'h2', 'l1', 'l2', 'l3']), count: 5, face_down: true };
    expect(verifyStep(s, good, plan, ME)).toBe('ok');
    const stray = { ...good, cards: blankCards(['h1', 'h2', 'l1', 'l2', 'real-9']) };
    expect(verifyStep(s, stray, plan, ME)).toEqual({ error: expect.stringContaining('real-9') });
    expect(verifyStep(s, { ...good, cards: undefined, card_ids: ['h1', 'x'] }, plan, ME)).toEqual({ error: expect.stringContaining('x') });
    expect(verifyStep(s, { ...good, cards: blankCards(['h1', 'h2']), count: 2 }, plan, ME)).toBe('ignore');
    expect(verifyStep(s, { ...good, cards: undefined, count: 5 }, plan, ME)).toBe('ok');
    expect(verifyStep(s, { ...good, player_id: OPP }, plan, ME)).toBe('ignore');
    expect(verifyStep(s, { ...good, to_zone: 'graveyard' }, plan, ME)).toBe('ignore');
  });

  it('draw accepts hand arrivals with a matching (or unknown) count', () => {
    const s = step('draw');
    expect(verifyStep(s, { type: 'cards_moved', player_id: ME, from_zone: 'library', to_zone: 'hand', cards: [{ id: 'a' }, { id: 'b' }] }, plan, ME)).toBe('ok');
    expect(verifyStep(s, { type: 'cards_moved', player_id: ME, from_zone: 'library', to_zone: 'hand', count: 2 }, plan, ME)).toBe('ok');
    expect(verifyStep(s, { type: 'cards_moved', player_id: ME, from_zone: 'library', to_zone: 'hand' }, plan, ME)).toBe('ok');
    expect(verifyStep(s, { type: 'cards_moved', player_id: ME, from_zone: 'library', to_zone: 'hand', count: 1 }, plan, ME)).toBe('ignore');
    expect(verifyStep(s, { type: 'cards_moved', player_id: OPP, from_zone: 'library', to_zone: 'hand', count: 2 }, plan, ME)).toBe('ignore');
    expect(
      verifyStep(
        s,
        { type: 'cards_moved', moves: [{ player_id: ME, id: 'a', zone: 'hand' }, { player_id: ME, id: 'b', zone: 'hand' }] },
        plan,
        ME,
      ),
    ).toBe('ok');
    expect(verifyStep({ kind: 'draw', count: 1 }, { type: 'move_card', player_id: ME, id: 'a', zone: 'hand', from_zone: 'library' }, plan, ME)).toBe('ok');
    expect(verifyStep(s, { type: 'move_card', player_id: ME, id: 'a', zone: 'hand', from_zone: 'library' }, plan, ME)).toBe('ignore');
  });
});

describe('reservoirFromExileEcho', () => {
  it('returns ids in the order of the cards array', () => {
    const ev = { type: 'cards_moved', player_id: ME, to_zone: 'exile', cards: [{ id: 'c' }, { id: 'a' }, { id: 'b' }], count: 3 };
    expect(reservoirFromExileEcho(ev)).toEqual(['c', 'a', 'b']);
  });

  it('falls back to card_ids, then nested moves, then empty', () => {
    expect(reservoirFromExileEcho({ type: 'cards_moved', card_ids: ['x', 'y'] })).toEqual(['x', 'y']);
    expect(reservoirFromExileEcho({ type: 'cards_moved', moves: [{ id: 'm1', zone: 'exile' }, { id: 'm2', zone: 'hand' }] })).toEqual(['m1']);
    expect(reservoirFromExileEcho({ type: 'library_shuffled' })).toEqual([]);
  });
});
