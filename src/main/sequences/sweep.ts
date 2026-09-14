/**
 * The sweep: park every placeholder blank face-down in exile using stock
 * gestures, verified step by step against server echoes.
 */
import type { OutboundAction, WireCard } from '@shared/protocol';
import {
  detectPlaceholder,
  planSweep,
  reservoirFromExileEcho,
  stepLabel,
  verifyStep,
  type DetectResult,
  type FoundPlaceholder,
  type SweepPlan,
  type SweepStep,
} from '@shared/sweep/planner';
import type { EchoWaiter } from '../echo';
import type { ActionSender } from '../actions';
import type { ZoneIndex } from '../zone-index';

export interface SweepDeps {
  me: string;
  zones: ZoneIndex;
  echo: EchoWaiter;
  actions: ActionSender;
  handSize: number;
  minCopies: number;
  preferredName: string;
  chosenPrintId: string | null;
  /** Called before we send a library-viewing action so the engine can hide the echo from the app. */
  suppressNext: (type: 'library_viewed' | 'viewed_cards_reordered' | 'library_viewing_cleared') => void;
  progress: (step: string, pct: number) => void;
  log: (msg: string, data?: unknown) => void;
  signal: AbortSignal;
  stepTimeoutMs?: number;
}

export interface SweepOutcome {
  placeholderPrintId: string;
  placeholderName: string;
  reservoir: string[];
  blankIds: string[];
}

export class SweepError extends Error {
  constructor(
    message: string,
    readonly detection?: DetectResult,
    readonly serverMessage?: string,
  ) {
    super(message);
  }
}

/**
 * Run `body` (which sends an action and returns the echo promise) while listening
 * for a server `error` frame. The error listener is registered first so a fast
 * rejection cannot slip past. Rejects with a SweepError carrying the server text.
 */
async function raceServerError<T>(echo: EchoWaiter, label: string, body: () => Promise<T>): Promise<T> {
  let settled = false;
  const err = echo.waitForType<{ message?: unknown }>('error', () => !settled, 60_000).then((e) => {
    const text = typeof e.message === 'string' ? e.message : 'action refused';
    throw new SweepError(`${label} refused: ${text}`, undefined, text);
  });
  err.catch(() => undefined);
  try {
    return await Promise.race([body(), err]);
  } finally {
    settled = true;
  }
}

const STEP_TIMEOUT = 4000;

export async function runSweep(d: SweepDeps): Promise<SweepOutcome> {
  const timeout = d.stepTimeoutMs ?? STEP_TIMEOUT;
  const abortIf = () => {
    if (d.signal.aborted) throw new SweepError('cancelled');
  };
  const send = (a: OutboundAction, summary?: string) => d.actions.send(a, summary);

  // --- 1. Learn the library so we can detect the placeholder and collect ids.
  d.progress('Viewing library', 0.05);
  d.suppressNext('library_viewed');
  const viewed = await withTimeout(
    raceServerError(d.echo, 'view library', async () => {
      const wait = d.echo.waitForType<{ viewed_library_cards?: WireCard[]; player_id: string }>(
        'library_viewed',
        (m) => m.player_id === d.me && Array.isArray(m.viewed_library_cards),
        timeout,
      );
      await send({ type: 'view_library', location: 'all', count: null, target_player_id: d.me });
      return wait;
    }),
    'library view',
  );
  abortIf();
  const libraryCards = viewed.viewed_library_cards ?? [];
  const hand = d.zones.cardsIn('hand', d.me).map((c) => c.card);

  const det = detectPlaceholder({ hand, library: libraryCards }, { minCopies: d.minCopies, preferredName: d.preferredName, chosenPrintId: d.chosenPrintId });
  if (det.kind !== 'found') {
    // Close the viewer before giving up.
    d.suppressNext('library_viewing_cleared');
    await send({ type: 'clear_library_viewing', target_player_id: d.me });
    if (det.kind === 'ambiguous') throw new SweepError('Several basics qualify as placeholder; choose one in the panel.', det);
    const best = det.candidates[0];
    throw new SweepError(
      best ? `No basic land with ≥${d.minCopies} copies (best: ${best.name} ×${best.count}).` : `No basic land with ≥${d.minCopies} copies found in your deck.`,
      det,
    );
  }
  d.log(`placeholder ${det.name} (${det.printId}): ${det.ids.hand.length} in hand, ${det.ids.library.length} in library`);

  const plan = planSweep(det, { handSize: d.handSize, libraryKnown: true, libraryOrderIds: libraryCards.map((c) => c.id) });
  const blankSet = new Set([...plan.handBlankIds, ...plan.libraryBlankIds]);
  if (blankSet.size === 0) {
    d.suppressNext('library_viewing_cleared');
    await send({ type: 'clear_library_viewing', target_player_id: d.me });
    throw new SweepError('Nothing to sweep: no blanks in hand or library.');
  }

  // --- 2. Put the blanks on top of the library. Preferred: reorder inside the open viewer.
  d.progress('Moving blanks to the top of the library', 0.2);
  const restIds = libraryCards.map((c) => c.id).filter((id) => !blankSet.has(id));
  let onTop = false;
  if (plan.handBlankIds.length === 0) {
    onTop = await tryReorder(d, plan, [...plan.libraryBlankIds, ...restIds], timeout);
  }
  if (!onTop) {
    // Fallback / hand blanks present: close the viewer, then batch-move all blanks to library top.
    d.suppressNext('library_viewing_cleared');
    await send({ type: 'clear_library_viewing', target_player_id: d.me });
    await waitOrIgnore(d.echo.waitForType('library_viewing_cleared', (m) => m['player_id'] === d.me, 1500));
    abortIf();
    const ids = [...plan.handBlankIds, ...plan.libraryBlankIds];
    try {
      await raceServerError(d.echo, 'move blanks', async () => {
        const wait = d.echo.waitFor((f) => movedToLibrary(f, d.me, ids), timeout, 'batch move to library');
        await send({ type: 'batch_move_cards', items: ids.map((id) => ({ id, zone: 'library' as const, to: 0 })) }, `move ${ids.length} blanks to library top`);
        return wait;
      });
      onTop = true;
    } catch (err) {
      if (err instanceof SweepError && err.serverMessage) throw err;
      d.log('batch move echo missing, falling back to individual moves', String(err));
      // Last resort: individual moves (150 ms pacing).
      for (const id of ids) {
        abortIf();
        await raceServerError(d.echo, 'move blank', async () => {
          const w = d.echo.waitFor((f) => movedToLibrary(f, d.me, [id]), timeout, 'move to library');
          await send({ type: 'move_card', id, zone: 'library', to: 0 });
          return w;
        });
      }
      onTop = true;
    }
  } else {
    d.suppressNext('library_viewing_cleared');
    await send({ type: 'clear_library_viewing', target_player_id: d.me });
    await waitOrIgnore(d.echo.waitForType('library_viewing_cleared', (m) => m['player_id'] === d.me, 1500));
  }
  abortIf();

  // --- 3. Exile the top N face down.
  const count = blankSet.size;
  d.progress(`Exiling ${count} blanks face down`, 0.55);
  const exileStep: SweepStep = { kind: 'exile_top', count };
  const exiled: string[] = [];
  let remaining = count;
  while (remaining > 0) {
    abortIf();
    const n = Math.min(remaining, 150);
    const ev = await raceServerError(d.echo, 'exile', async () => {
      const wait = d.echo.waitFor((f) => {
        const v = verifyStep({ kind: 'exile_top', count: n }, f, plan, d.me);
        if (typeof v === 'object') throw new SweepError(v.error);
        return v === 'ok';
      }, timeout, 'exile echo');
      await send({ type: 'exile_x_cards', count: n, face_down: true });
      return wait;
    });
    const ids = reservoirFromExileEcho(ev);
    exiled.push(...ids.filter((id) => blankSet.has(id)));
    remaining -= n;
  }
  void exileStep;
  // If the echo carried no card objects, fall back to the zone index.
  let reservoir = exiled;
  if (reservoir.length < count) {
    reservoir = d.zones
      .cardsIn('exile', d.me)
      .filter((c) => blankSet.has(c.id))
      .map((c) => c.id);
    d.log(`reservoir from zone index (${reservoir.length}/${count})`);
  }
  if (reservoir.length === 0) throw new SweepError('Exile echo did not contain the blanks; nothing recorded.');

  // --- 4. Refill the hand.
  const handNow = d.zones.cardsIn('hand', d.me).length;
  const draw = Math.max(0, plan.targetHandSize - handNow);
  if (draw > 0) {
    d.progress(`Drawing ${draw}`, 0.8);
    const wait = d.echo.waitFor((f) => verifyStep({ kind: 'draw', count: draw }, f, plan, d.me) === 'ok', timeout, 'draw echo');
    await send(draw === 1 ? { type: 'draw_card' } : { type: 'draw_x_cards', count: draw });
    await waitOrIgnore(wait);
  }

  // --- 5. Shuffle.
  d.progress('Shuffling', 0.92);
  const ws = d.echo.waitFor((f) => verifyStep({ kind: 'shuffle' }, f, plan, d.me) === 'ok', timeout, 'shuffle echo');
  await send({ type: 'shuffle_library' });
  await waitOrIgnore(ws);
  d.progress('Done', 1);
  return { placeholderPrintId: plan.placeholderPrintId, placeholderName: plan.placeholderName, reservoir, blankIds: [...blankSet] };
}

async function tryReorder(d: SweepDeps, plan: SweepPlan, order: string[], timeout: number): Promise<boolean> {
  d.suppressNext('viewed_cards_reordered');
  try {
    await raceServerError(d.echo, 'reorder', async () => {
      const wait = d.echo.waitFor((f) => verifyStep({ kind: 'reorder', blankIds: plan.libraryBlankIds }, f, plan, d.me) === 'ok', timeout, 'reorder echo');
      await d.actions.send({ type: 'reorder_viewed_cards', card_ids: order }, `reorder library: ${plan.libraryBlankIds.length} blanks first`);
      return wait;
    });
    return true;
  } catch (err) {
    d.log('reorder not confirmed; using batch move', String(err));
    return false;
  }
}

function movedToLibrary(f: Record<string, unknown>, me: string, ids: string[]): boolean {
  const t = f['type'];
  const want = new Set(ids);
  if (t === 'move_card') return f['player_id'] === me && f['zone'] === 'library' && want.has(String(f['id']));
  if (t === 'cards_moved') {
    if (Array.isArray(f['moves'])) {
      const got = new Set((f['moves'] as Array<Record<string, unknown>>).filter((m) => m['zone'] === 'library').map((m) => String(m['id'])));
      return ids.every((id) => got.has(id));
    }
    if (f['player_id'] !== me || f['to_zone'] !== 'library') return false;
    const got = new Set<string>([
      ...((f['card_ids'] as string[] | undefined) ?? []),
      ...(((f['cards'] as Array<{ id: string }> | undefined) ?? []).map((c) => c.id)),
    ]);
    return ids.every((id) => got.has(id));
  }
  return false;
}

async function waitOrIgnore<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

async function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof SweepError) throw err;
    throw new SweepError(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function sweepStepLabel(step: SweepStep): string {
  return stepLabel(step);
}

export type { FoundPlaceholder };
