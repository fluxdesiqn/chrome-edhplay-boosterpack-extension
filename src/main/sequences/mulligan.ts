/**
 * The extension's own Commander mulligan (London mulligan, first one free in
 * multiplayer), built from stock gestures and verified against server echoes.
 *
 * Phase 1 (`runMulliganDraw`): shuffle the whole hand into the library and draw
 * a fresh hand. Phase 2 (`runMulliganBottom`): put the cards the player chose
 * on the bottom of the library, one by one.
 *
 * edhplay only allows library actions once the player has kept in the stock
 * mulligan dialog, so every step also listens for a server `error` frame and
 * fails fast with its message instead of waiting for the echo timeout.
 */
import type { OutboundAction } from '@shared/protocol';
import type { EchoWaiter } from '../echo';
import type { ActionSender } from '../actions';
import type { ZoneIndex } from '../zone-index';

export interface MulliganDeps {
  me: string;
  zones: ZoneIndex;
  echo: EchoWaiter;
  actions: ActionSender;
  /** draw this many */
  handSize: number;
  progress: (step: string, pct: number) => void;
  log: (msg: string, data?: unknown) => void;
  signal: AbortSignal;
  stepTimeoutMs?: number;
}

export class MulliganError extends Error {}

const STEP_TIMEOUT = 4000;

/**
 * Cards to put on the bottom after mulligan number `mulligans` (1-based).
 * Commander multiplayer: the first mulligan is free.
 */
export function bottomCount(mulligans: number, freeFirst: boolean): number {
  const n = Math.max(0, Math.floor(mulligans));
  return freeFirst ? Math.max(0, n - 1) : n;
}

/** Phase 1: shuffle the hand into the library and draw a fresh hand. Returns the new hand ids (from the zone index). */
export async function runMulliganDraw(d: MulliganDeps): Promise<{ hand: string[] }> {
  const timeout = d.stepTimeoutMs ?? STEP_TIMEOUT;
  const abortIf = () => {
    if (d.signal.aborted) throw new MulliganError('cancelled');
  };
  const send = (a: OutboundAction, summary?: string) => d.actions.send(a, summary);

  abortIf();
  const handIds = d.zones.cardsIn('hand', d.me).map((c) => c.id);
  if (handIds.length === 0) throw new MulliganError('hand is empty');

  // --- 1. Hand → bottom of the library (multi-select hand → Move to library bottom).
  // NOTE: edhplay's `shuffle` flag on batch_move_cards only shuffles the order of the
  // moved cards among themselves before inserting them; it does NOT shuffle the library.
  // Putting the hand on the bottom means a fresh draw even if the shuffle below were lost.
  d.progress(`Returning ${handIds.length} cards to the library`, 0.1);
  await step(
    d,
    'return hand to library',
    (f) => movedToLibrary(f, d.me, handIds),
    () => send({ type: 'batch_move_cards', items: handIds.map((id) => ({ id, zone: 'library' as const, to: -1 })) }, `${handIds.length} hand cards → library bottom`),
    timeout,
  );
  abortIf();

  // --- 2. Really shuffle the library (library menu → Shuffle).
  d.progress('Shuffling the library', 0.4);
  const shuffled = await step(d, 'shuffle library', (f) => f['type'] === 'library_shuffled' && f['player_id'] === d.me, () => send({ type: 'shuffle_library' }), timeout).catch((err: unknown) => {
    d.log('shuffle not confirmed; the hand is on the bottom so the draw is fresh anyway', String(err));
    return null;
  });
  void shuffled;
  abortIf();

  // --- 3. Draw the new hand.
  d.progress(`Drawing ${d.handSize}`, 0.6);
  const drew = await step(d, `draw ${d.handSize}`, (f) => drewToHand(f, d.me, d.handSize), () => send({ type: 'draw_x_cards', count: d.handSize }), timeout);

  const echoIds = Array.isArray(drew['cards']) ? (drew['cards'] as Array<{ id?: unknown }>).map((c) => String(c.id ?? '')).filter(Boolean) : [];
  const hand = echoIds.length === d.handSize ? echoIds : d.zones.cardsIn('hand', d.me).map((c) => c.id);
  const same = hand.length === handIds.length && hand.every((id) => handIds.includes(id));
  if (same) d.log('warning: the new hand has the same cards as the old one');
  d.log(`mulligan draw: ${hand.length} cards in hand`);
  d.progress('Choose cards for the bottom', 1);
  return { hand };
}

/** Phase 2: put the chosen cards on the bottom of the library, one by one (card menu → Library bottom). */
export async function runMulliganBottom(d: MulliganDeps, ids: string[]): Promise<void> {
  const timeout = d.stepTimeoutMs ?? STEP_TIMEOUT;
  let i = 0;
  for (const id of ids) {
    if (d.signal.aborted) throw new MulliganError('cancelled');
    d.progress(`Bottoming card ${i + 1} of ${ids.length}`, ids.length ? i / ids.length : 1);
    await step(d, `bottom ${id.slice(0, 8)}`, (f) => movedToLibraryPosition(f, d.me, id) || movedToLibrary(f, d.me, [id]), () => d.actions.send({ type: 'move_to_library_position', id, position: -1 }, `${id.slice(0, 8)} → library bottom`), timeout);
    i += 1;
  }
  d.progress('Done', 1);
}

// ---------------------------------------------------------------- helpers

/**
 * Register the echo waiter, send the action, then wait for the echo — racing it
 * against a server `error` frame (errors are unicast, so any we see is ours).
 */
async function step(
  d: MulliganDeps,
  label: string,
  pred: (f: Record<string, unknown>) => boolean,
  send: () => Promise<void>,
  timeout: number,
): Promise<Record<string, unknown>> {
  const echo = d.echo.waitFor(pred, timeout, label);
  const error = d.echo.waitForType('error', () => true, timeout + 50);
  // Whichever loses the race still times out later; keep that rejection quiet.
  echo.catch(() => undefined);
  error.catch(() => undefined);
  try {
    await send();
    return await Promise.race([
      echo,
      error.then((e) => {
        throw new MulliganError(`${label} refused: ${String(e['message'] ?? 'server error')}`);
      }),
    ]);
  } catch (err) {
    if (err instanceof MulliganError) throw err;
    throw new MulliganError(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Copied from sweep.ts (kept private there). */
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

function movedToLibraryPosition(f: Record<string, unknown>, me: string, id: string): boolean {
  return f['type'] === 'move_to_library_position' && f['player_id'] === me && String(f['id']) === id;
}

function drewToHand(f: Record<string, unknown>, me: string, count: number): boolean {
  if (f['type'] !== 'cards_moved' || f['player_id'] !== me || f['to_zone'] !== 'hand') return false;
  const n = typeof f['count'] === 'number' ? f['count'] : Array.isArray(f['cards']) ? f['cards'].length : Array.isArray(f['card_ids']) ? f['card_ids'].length : -1;
  return n === count;
}

async function waitOrIgnore<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}
