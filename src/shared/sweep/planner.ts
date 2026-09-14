/**
 * The "sweep": detect the placeholder basic land the deck is padded with,
 * plan the stock-UI-equivalent gestures that park every blank face down in
 * exile, and verify the server echoes for each step.
 */
import { isObject, type WireCard } from '@shared/protocol';

// ---------------------------------------------------------------- detection

export interface PlaceholderCandidate {
  printId: string;
  name: string;
  count: number;
}

export interface DetectInput {
  hand: WireCard[];
  library: WireCard[];
}

export interface DetectOptions {
  minCopies: number;
  preferredName: string;
  chosenPrintId?: string | null;
}

export type FoundPlaceholder = {
  kind: 'found';
  printId: string;
  name: string;
  ids: { hand: string[]; library: string[] };
};

export type DetectResult =
  | FoundPlaceholder
  | { kind: 'ambiguous'; candidates: PlaceholderCandidate[] }
  | { kind: 'none'; candidates: PlaceholderCandidate[] };

interface Group extends PlaceholderCandidate {
  basic: boolean;
  hand: string[];
  library: string[];
}

function isBasicLand(card: WireCard): boolean {
  return typeof card.type_line === 'string' && card.type_line.startsWith('Basic Land');
}

export function detectPlaceholder(input: DetectInput, opts: DetectOptions): DetectResult {
  const groups = new Map<string, Group>();
  const add = (card: WireCard, zone: 'hand' | 'library') => {
    const printId = card.card_print_id;
    if (typeof printId !== 'string' || printId === '') return;
    let g = groups.get(printId);
    if (!g) {
      g = { printId, name: typeof card.name === 'string' ? card.name : '', count: 0, basic: isBasicLand(card), hand: [], library: [] };
      groups.set(printId, g);
    }
    g.count += 1;
    g[zone].push(card.id);
  };
  for (const c of input.hand) add(c, 'hand');
  for (const c of input.library) add(c, 'library');

  const basics = [...groups.values()].filter((g) => g.basic).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const candidates = basics.filter((g) => g.count >= opts.minCopies);
  const toCandidate = (g: Group): PlaceholderCandidate => ({ printId: g.printId, name: g.name, count: g.count });
  const found = (g: Group): FoundPlaceholder => ({ kind: 'found', printId: g.printId, name: g.name, ids: { hand: [...g.hand], library: [...g.library] } });

  if (opts.chosenPrintId) {
    const chosen = candidates.find((g) => g.printId === opts.chosenPrintId);
    if (chosen) return found(chosen);
  }
  const preferred = candidates.find((g) => g.name === opts.preferredName);
  if (preferred) return found(preferred);
  if (candidates.length === 1) return found(candidates[0]!);
  if (candidates.length > 1) return { kind: 'ambiguous', candidates: candidates.map(toCandidate) };
  return { kind: 'none', candidates: basics.slice(0, 5).map(toCandidate) };
}

// ---------------------------------------------------------------- planning

export type SweepStep =
  /** move_card hand → library top */
  | { kind: 'move_hand_blank'; id: string }
  /** view_library all (suppressed from the app) */
  | { kind: 'view_library' }
  /** reorder_viewed_cards: blanks first, then the rest in original order (executor appends the rest) */
  | { kind: 'reorder'; blankIds: string[] }
  | { kind: 'clear_view' }
  /** exile_x_cards face_down */
  | { kind: 'exile_top'; count: number }
  | { kind: 'draw'; count: number }
  | { kind: 'shuffle' };

export interface SweepPlan {
  placeholderPrintId: string;
  placeholderName: string;
  handBlankIds: string[];
  libraryBlankIds: string[];
  targetHandSize: number;
  steps: SweepStep[];
}

export interface PlanContext {
  handSize: number;
  libraryKnown: boolean;
  /** current library order, index 0 = top (only meaningful when libraryKnown) */
  libraryOrderIds: string[];
}

export function planSweep(det: FoundPlaceholder, ctx: PlanContext): SweepPlan {
  const handBlankIds = [...det.ids.hand];
  let libraryBlankIds = [...det.ids.library];
  if (ctx.libraryKnown && ctx.libraryOrderIds.length > 0) {
    const blanks = new Set(libraryBlankIds);
    const ordered = ctx.libraryOrderIds.filter((id) => blanks.has(id));
    const seen = new Set(ordered);
    libraryBlankIds = [...ordered, ...libraryBlankIds.filter((id) => !seen.has(id))];
  }
  const steps: SweepStep[] = [];
  for (const id of handBlankIds) steps.push({ kind: 'move_hand_blank', id });
  steps.push({ kind: 'view_library' });
  steps.push({ kind: 'reorder', blankIds: [...handBlankIds, ...libraryBlankIds] });
  steps.push({ kind: 'clear_view' });
  steps.push({ kind: 'exile_top', count: handBlankIds.length + libraryBlankIds.length });
  if (handBlankIds.length > 0) steps.push({ kind: 'draw', count: handBlankIds.length });
  steps.push({ kind: 'shuffle' });
  return {
    placeholderPrintId: det.printId,
    placeholderName: det.name,
    handBlankIds,
    libraryBlankIds,
    targetHandSize: ctx.handSize,
    steps,
  };
}

// ---------------------------------------------------------------- verification

export type StepVerdict = 'ok' | 'ignore' | { error: string };

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function idsOf(ev: Record<string, unknown>): string[] | null {
  if (Array.isArray(ev.cards)) {
    const out: string[] = [];
    for (const c of ev.cards) if (isObject(c) && typeof c.id === 'string') out.push(c.id);
    return out;
  }
  if (Array.isArray(ev.card_ids)) return ev.card_ids.filter((x): x is string => typeof x === 'string');
  return null;
}

/** Number of cards a flat `cards_moved` echo carried, or null when it only says "some". */
function countOf(ev: Record<string, unknown>): number | null {
  const ids = idsOf(ev);
  if (ids) return ids.length;
  if (typeof ev.count === 'number') return ev.count;
  return null;
}

/** Is this echo about `me` (owner), tolerating echoes that omit the player id. */
function forMe(ev: Record<string, unknown>, me: string, key = 'player_id'): boolean {
  const pid = ev[key];
  return pid === undefined || pid === null || pid === me;
}

/** Individual card moves described by a `move_card` or `cards_moved{moves}` echo. */
function singleMoves(ev: Record<string, unknown>): Array<Record<string, unknown>> {
  if (ev.type === 'move_card') return [ev];
  if (ev.type === 'cards_moved' && Array.isArray(ev.moves)) return ev.moves.filter(isObject);
  return [];
}

export function verifyStep(step: SweepStep, ev: Record<string, unknown>, plan: SweepPlan, localPlayerId: string): StepVerdict {
  const me = localPlayerId;
  switch (step.kind) {
    case 'move_hand_blank': {
      for (const mv of singleMoves(ev)) {
        if (mv.id === step.id && mv.zone === 'library' && mv.player_id === me) return 'ok';
      }
      if (ev.type === 'cards_moved' && !Array.isArray(ev.moves) && ev.player_id === me && ev.to_zone === 'library') {
        if ((idsOf(ev) ?? []).includes(step.id)) return 'ok';
      }
      return 'ignore';
    }

    case 'view_library': {
      if (ev.type !== 'library_viewed' || ev.player_id !== me) return 'ignore';
      if (!forMe(ev, me, 'target_player_id')) return 'ignore';
      return Array.isArray(ev.viewed_library_cards) ? 'ok' : 'ignore';
    }

    case 'reorder':
      return ev.type === 'viewed_cards_reordered' && forMe(ev, me) ? 'ok' : 'ignore';

    case 'clear_view':
      return ev.type === 'library_viewing_cleared' && forMe(ev, me) && forMe(ev, me, 'target_player_id') ? 'ok' : 'ignore';

    case 'exile_top': {
      if (ev.type !== 'cards_moved' || ev.player_id !== me || ev.to_zone !== 'exile') return 'ignore';
      const ids = idsOf(ev);
      if (ids) {
        const blanks = new Set([...plan.handBlankIds, ...plan.libraryBlankIds]);
        const stray = ids.find((id) => !blanks.has(id));
        if (stray !== undefined) return { error: `exile echo contained a non-blank card (${stray})` };
      }
      const n = countOf(ev);
      return n === step.count ? 'ok' : 'ignore';
    }

    case 'draw': {
      if (ev.type === 'cards_moved' && !Array.isArray(ev.moves)) {
        if (ev.player_id !== me || ev.to_zone !== 'hand') return 'ignore';
        const n = countOf(ev);
        return n === null || n === step.count ? 'ok' : 'ignore';
      }
      const arrivals = singleMoves(ev).filter((mv) => mv.player_id === me && mv.zone === 'hand').length;
      if (arrivals === 0) return 'ignore';
      return arrivals === step.count ? 'ok' : 'ignore';
    }

    case 'shuffle':
      return ev.type === 'library_shuffled' && ev.player_id === me ? 'ok' : 'ignore';

    default:
      return 'ignore';
  }
}

/**
 * Card ids from an exile echo in the order the exile pile shows them
 * (index 0 = top). Falls back to `card_ids` when the echo carries no objects.
 */
export function reservoirFromExileEcho(ev: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(ev.cards)) {
    for (const c of ev.cards) if (isObject(c) && typeof c.id === 'string') out.push(c.id);
    return out;
  }
  if (Array.isArray(ev.card_ids)) {
    for (const id of ev.card_ids) if (typeof id === 'string') out.push(id);
    return out;
  }
  if (Array.isArray(ev.moves)) {
    for (const mv of ev.moves) if (isObject(mv) && typeof mv.id === 'string' && mv.zone === 'exile') out.push(mv.id);
  }
  return out;
}

/** Convenience: the set of every blank id in a plan. */
export function planBlankIds(plan: SweepPlan): string[] {
  return [...plan.handBlankIds, ...plan.libraryBlankIds];
}

export function stepLabel(step: SweepStep): string {
  switch (step.kind) {
    case 'move_hand_blank':
      return `move blank ${step.id.slice(0, 8)} to library`;
    case 'view_library':
      return 'view library';
    case 'reorder':
      return `move ${step.blankIds.length} blanks to top`;
    case 'clear_view':
      return 'close library view';
    case 'exile_top':
      return `exile top ${step.count} face down`;
    case 'draw':
      return `draw ${step.count}`;
    case 'shuffle':
      return 'shuffle';
  }
}
