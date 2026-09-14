// @vitest-environment happy-dom
/**
 * The mulligan sequence driven directly (no Engine) against the FakeServer
 * through a FakeWs: zone index + echo waiter + paced sender, as the engine wires them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionSender } from '@main/actions';
import { EchoWaiter } from '@main/echo';
import { bottomCount, MulliganError, runMulliganBottom, runMulliganDraw, type MulliganDeps } from '@main/sequences/mulligan';
import { ZoneIndex } from '@main/zone-index';
import { resetIds } from '../fixtures/game-state';
import { buildDeck } from '../harness/deck';
import { FakeServer, MULLIGAN_PENDING_ERROR, MULLIGAN_VIEW_ERROR } from '../harness/fake-server';
import { FakeWs } from '../harness/fake-ws';
import { P1 } from '../harness/flows';

interface Rig {
  server: FakeServer;
  ws: FakeWs;
  zones: ZoneIndex;
  deps: MulliganDeps;
  frames: Array<Record<string, unknown>>;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** 60-card deck (7 in hand), one connected player, the engine's inbound wiring in miniature. */
async function rig(opts: { mulliganGate?: boolean; keep?: boolean } = {}): Promise<Rig> {
  const server = new FakeServer();
  server.options.mulliganGate = opts.mulliganGate ?? false;
  server.addPlayer(P1, 'p1', buildDeck({ wastes: 0, real: 60, handWastes: 0 }, P1));
  const zones = new ZoneIndex();
  zones.localPlayerId = P1;
  const echo = new EchoWaiter();
  const frames: Array<Record<string, unknown>> = [];
  const ws = new FakeWs(server.urlFor(P1));
  ws.addEventListener('message', (e) => {
    const f = JSON.parse(String((e as MessageEvent).data)) as Record<string, unknown>;
    frames.push(f);
    zones.apply(f);
    echo.offer(f);
  });
  server.connect(ws, P1);
  if (opts.keep) server.keepHand(P1);
  await tick(); // game_state (and hand_kept) land on microtasks
  // Instant pacing: the sequence's ordering is what we test, not the 150 ms gaps.
  const actions = new ActionSender({ sendRaw: async (m) => ws.send(JSON.stringify(m)) }, () => Date.now(), async () => undefined);
  const deps: MulliganDeps = {
    me: P1,
    zones,
    echo,
    actions,
    handSize: 7,
    progress: () => undefined,
    log: () => undefined,
    signal: new AbortController().signal,
  };
  return { server, ws, zones, deps, frames };
}

const ids = (cards: Array<{ id: string }>) => cards.map((c) => c.id);

beforeEach(() => {
  FakeWs.reset();
  resetIds();
});

afterEach(() => {
  FakeWs.reset();
});

describe('bottomCount', () => {
  it('first mulligan is free in Commander multiplayer', () => {
    expect(bottomCount(1, true)).toBe(0);
    expect(bottomCount(2, true)).toBe(1);
    expect(bottomCount(3, true)).toBe(2);
    expect(bottomCount(1, false)).toBe(1);
    expect(bottomCount(0, true)).toBe(0);
  });
});

describe('runMulliganDraw', () => {
  it('shuffles the hand into the library and draws a fresh hand', async () => {
    const r = await rig({ mulliganGate: true, keep: true });
    expect(r.zones.cardsIn('hand', P1)).toHaveLength(7);
    expect(r.zones.cardsIn('library', P1)).toHaveLength(53);
    const oldHand = ids(r.server.zone(P1, 'hand'));

    const { hand } = await runMulliganDraw(r.deps);

    // Server: same deck, 7 in hand, 53 in library, hand actually changed (shuffled in).
    expect(r.server.zone(P1, 'hand')).toHaveLength(7);
    expect(r.server.zone(P1, 'library')).toHaveLength(53);
    expect(ids(r.server.zone(P1, 'hand'))).not.toEqual(oldHand);
    // The sequence reports what the server holds, via the zone index.
    expect(hand).toHaveLength(7);
    expect(new Set(hand).size).toBe(7);
    expect(new Set(hand)).toEqual(new Set(ids(r.server.zone(P1, 'hand'))));
    expect(r.zones.cardsIn('library', P1)).toHaveLength(53);

    // Stock gestures, in order: multi-select hand → Move to library (shuffle) → Draw 7.
    expect(r.server.actionTypes(P1)).toEqual(['batch_move_cards', 'draw_x_cards']);
    const batch = r.server.actionsOf('batch_move_cards')[0]!;
    expect(batch['shuffle']).toBe(true);
    const items = batch['items'] as Array<{ id: string; zone: string; to: number }>;
    expect(items.map((i) => i.id)).toEqual(oldHand);
    expect(items.every((i) => i.zone === 'library' && i.to === 0)).toBe(true);
    expect(r.server.actionsOf('draw_x_cards')[0]).toMatchObject({ count: 7 });
    // The batch echo said `shuffled`, so no extra shuffle was needed.
    expect(r.frames.some((f) => f['type'] === 'cards_moved' && f['shuffled'] === true)).toBe(true);
  });

  it('sends shuffle_library when the batch echo does not report a shuffle', async () => {
    const r = await rig();
    // Strip `shuffled` from the echo before the sequence sees it.
    const raw = r.ws.serverEmit.bind(r.ws);
    r.ws.serverEmit = (obj: unknown) => {
      const f = typeof obj === 'string' ? (JSON.parse(obj) as Record<string, unknown>) : { ...(obj as Record<string, unknown>) };
      delete f['shuffled'];
      raw(f);
    };
    await runMulliganDraw(r.deps);
    expect(r.server.actionTypes(P1)).toEqual(['batch_move_cards', 'shuffle_library', 'draw_x_cards']);
    expect(r.server.zone(P1, 'hand')).toHaveLength(7);
  });

  it('refuses an empty hand', async () => {
    const r = await rig();
    r.server.keepHand(P1, ids(r.server.zone(P1, 'hand')));
    await tick();
    expect(r.zones.cardsIn('hand', P1)).toHaveLength(0);
    await expect(runMulliganDraw(r.deps)).rejects.toThrow(MulliganError);
    await expect(runMulliganDraw(r.deps)).rejects.toThrow(/hand is empty/);
    expect(r.server.actions(P1)).toEqual([]);
  });

  it('fails fast with the server error while the stock mulligan decision is pending', async () => {
    const r = await rig({ mulliganGate: true });
    const before = ids(r.server.zone(P1, 'library'));

    const started = Date.now();
    const err = await runMulliganDraw(r.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MulliganError);
    expect((err as Error).message).toContain(MULLIGAN_PENDING_ERROR);
    expect(Date.now() - started).toBeLessThan(1000); // did not wait for the 4 s echo timeout

    // Nothing moved.
    expect(r.server.zone(P1, 'hand')).toHaveLength(7);
    expect(ids(r.server.zone(P1, 'library'))).toEqual(before);
    expect(r.zones.cardsIn('hand', P1)).toHaveLength(7);

    // view_library gets the live server's exact wording.
    r.ws.send(JSON.stringify({ type: 'view_library', location: 'all', count: null, target_player_id: P1 }));
    await tick();
    expect(r.frames.at(-1)).toEqual({ type: 'error', message: MULLIGAN_VIEW_ERROR });
    expect(MULLIGAN_VIEW_ERROR).toContain("can't");

    // Once kept, the same sequence goes through.
    r.server.keepHand(P1);
    await tick();
    expect(r.frames.at(-1)).toMatchObject({ type: 'hand_kept', player_id: P1, mulligan_phase_active: false });
    const { hand } = await runMulliganDraw(r.deps);
    expect(hand).toHaveLength(7);
    expect(r.server.zone(P1, 'library')).toHaveLength(53);
  });
});

describe('runMulliganBottom', () => {
  it('puts the chosen cards on the bottom of the library, one by one, in order', async () => {
    const r = await rig({ mulliganGate: true, keep: true });
    const { hand } = await runMulliganDraw(r.deps);
    const [a, b] = [hand[0]!, hand[1]!];

    await runMulliganBottom(r.deps, [a, b]);

    expect(ids(r.server.zone(P1, 'library')).slice(-2)).toEqual([a, b]);
    expect(r.server.zone(P1, 'hand')).toHaveLength(5);
    expect(ids(r.server.zone(P1, 'hand'))).not.toContain(a);
    expect(ids(r.server.zone(P1, 'hand'))).not.toContain(b);
    // Zone index followed along.
    expect(r.zones.cardsIn('hand', P1)).toHaveLength(5);
    expect(r.zones.cardsIn('library', P1)).toHaveLength(55);
    expect(r.zones.get(a)?.zone).toBe('library');
    // Stock gesture per card: context menu → Library bottom.
    expect(r.server.actionsOf('move_to_library_position')).toEqual([
      { type: 'move_to_library_position', id: a, position: -1 },
      { type: 'move_to_library_position', id: b, position: -1 },
    ]);
  });

  it('with nothing to bottom, sends nothing', async () => {
    const r = await rig({ mulliganGate: true, keep: true });
    await runMulliganBottom(r.deps, []);
    expect(r.server.actions(P1)).toEqual([]);
  });

  it('surfaces a server refusal', async () => {
    const r = await rig({ mulliganGate: true });
    const id = r.server.zone(P1, 'hand')[0]!.id;
    await expect(runMulliganBottom(r.deps, [id])).rejects.toThrow(MULLIGAN_PENDING_ERROR);
    expect(r.server.zone(P1, 'hand')).toHaveLength(7);
  });
});
