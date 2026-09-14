// @vitest-environment happy-dom
/**
 * Scenario A: the sweep, driven end to end through the real Engine against the FakeServer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetIds, WASTES_PRINT_ID } from '../fixtures/game-state';
import { FakeServer } from '../harness/fake-server';
import { FakeWs } from '../harness/fake-ws';
import { bootPlayer, P1, sweep } from '../harness/flows';
import { until, type World } from '../harness/world';

const worlds: World[] = [];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  FakeWs.reset();
  resetIds();
});

afterEach(() => {
  for (const w of worlds.splice(0)) w.dispose();
  vi.useRealTimers();
});

const isWastes = (c: { name?: string }) => c.name === 'Wastes';
const hiddenViewerFrames = (w: World) =>
  w.appFrames.filter((f) => (f['type'] === 'library_viewed' || f['type'] === 'library_viewing_cleared' || f['type'] === 'viewed_cards_reordered') && f['player_id'] === w.playerId);

describe('sweep', () => {
  it('A1: hand blanks → batch move, exile 50 face down, redraw, shuffle', async () => {
    const server = new FakeServer();
    const w = await bootPlayer(server, P1, { wastes: 50, real: 49, handWastes: 3 });
    worlds.push(w);
    expect(server.zone(P1, 'hand').filter(isWastes)).toHaveLength(3);

    const state = await sweep(w);
    // The state line is paced behind the hello/need lines; let the queue drain.
    await until(() => server.syncLines('state', P1).length > 0, 'state chat line');

    // Actions, in order.
    expect(server.actionTypes(P1)).toEqual(['view_library', 'clear_library_viewing', 'batch_move_cards', 'exile_x_cards', 'draw_x_cards', 'shuffle_library']);
    const batch = server.actionsOf('batch_move_cards')[0]!;
    const items = batch['items'] as Array<{ id: string; zone: string; to: number }>;
    expect(items).toHaveLength(50);
    expect(items.every((i) => i.zone === 'library' && i.to === 0)).toBe(true);
    expect(server.actionsOf('exile_x_cards')[0]).toMatchObject({ count: 50, face_down: true });
    expect(server.actionsOf('draw_x_cards')[0]).toMatchObject({ count: 3 });

    // The app never saw the library viewer open/close for this player.
    expect(hiddenViewerFrames(w)).toEqual([]);
    expect(w.appFrames.some((f) => f['type'] === 'game_state')).toBe(true);

    // Engine state.
    expect(state.sweep.phase).toBe('done');
    expect(state.placeholderName).toBe('Wastes');
    expect(state.placeholderPrintId).toBe(WASTES_PRINT_ID);
    expect(state.reservoir).toHaveLength(50);
    expect(state.seenBlankIds).toHaveLength(50);
    expect(w.iso.of('seq').some((s) => s.seq === 'sweep' && s.done && !s.error)).toBe(true);

    // Server state.
    const hand = server.zone(P1, 'hand');
    expect(hand).toHaveLength(7);
    expect(hand.filter(isWastes)).toHaveLength(0);
    const exile = server.zone(P1, 'exile');
    expect(exile).toHaveLength(50);
    expect(exile.every((c) => isWastes(c) && c.visibility === 'face_down')).toBe(true);
    expect(new Set(state.reservoir)).toEqual(new Set(exile.map((c) => c.id)));
    expect(server.zone(P1, 'library')).toHaveLength(42);

    // Chat: hello (with trailer) and a state line.
    expect(server.chat.some((c) => c.message.startsWith('[HoK1] {"t":"hello"') && c.message.includes('Heroes of Kamigawa'))).toBe(true);
    const stateLines = server.syncLines('state', P1);
    expect(stateLines.length).toBeGreaterThan(0);
    expect(stateLines.at(-1)!.message).toContain('"res":50');
    // The page never sees sync lines.
    expect(w.appFrames.some((f) => f['type'] === 'chat_message_received' && String(f['message']).startsWith('[HoK'))).toBe(false);
  });

  it('A2: no hand blanks → reorder inside the viewer, no batch move, no draw', async () => {
    const server = new FakeServer();
    const w = await bootPlayer(server, P1, { wastes: 50, real: 49, handWastes: 0 });
    worlds.push(w);

    const state = await sweep(w);

    expect(server.actionTypes(P1)).toEqual(['view_library', 'reorder_viewed_cards', 'clear_library_viewing', 'exile_x_cards', 'shuffle_library']);
    const reorder = server.actionsOf('reorder_viewed_cards')[0]!;
    const ids = reorder['card_ids'] as string[];
    expect(ids).toHaveLength(92);
    expect(new Set(ids.slice(0, 50))).toEqual(new Set(state.reservoir));
    expect(hiddenViewerFrames(w)).toEqual([]);
    expect(state.sweep.phase).toBe('done');
    expect(state.reservoir).toHaveLength(50);
    expect(server.zone(P1, 'hand')).toHaveLength(7);
    expect(server.zone(P1, 'exile').every((c) => isWastes(c) && c.visibility === 'face_down')).toBe(true);
  });

  it('A3: reorder rejected → falls back to batch move', async () => {
    const server = new FakeServer();
    server.options.rejectReorder = true;
    const w = await bootPlayer(server, P1, { wastes: 50, real: 49, handWastes: 0 });
    worlds.push(w);

    const state = await sweep(w);

    expect(server.actionTypes(P1)).toEqual(['view_library', 'reorder_viewed_cards', 'clear_library_viewing', 'batch_move_cards', 'exile_x_cards', 'shuffle_library']);
    expect((server.actionsOf('batch_move_cards')[0]!['items'] as unknown[]).length).toBe(50);
    expect(hiddenViewerFrames(w)).toEqual([]);
    expect(state.sweep.phase).toBe('done');
    expect(state.reservoir).toHaveLength(50);
    expect(server.zone(P1, 'exile')).toHaveLength(50);
  });

  it('A4: only 49 blanks → sweep fails, viewer closed, nothing moved', async () => {
    const server = new FakeServer();
    const w = await bootPlayer(server, P1, { wastes: 49, real: 50, handWastes: 3 });
    worlds.push(w);

    const state = await sweep(w);

    expect(state.sweep.phase).toBe('failed');
    expect(state.sweep.error).toMatch(/50/);
    expect(state.sweep.error).toMatch(/49/);
    expect(state.reservoir).toHaveLength(0);
    expect(server.actionTypes(P1)).toEqual(['view_library', 'clear_library_viewing']);
    expect(hiddenViewerFrames(w)).toEqual([]);
    expect(server.zone(P1, 'exile')).toHaveLength(0);
    expect(server.zone(P1, 'hand').filter(isWastes)).toHaveLength(3);
    expect(w.iso.of('seq').some((s) => s.seq === 'sweep' && s.step === 'Failed')).toBe(true);
    expect(server.syncLines('state', P1)).toHaveLength(0);
  });

  it('A5: sweep refused during a pending mulligan decision surfaces the server error', async () => {
    const server = new FakeServer();
    const w = await bootPlayer(server, P1, { wastes: 50, real: 49, handWastes: 3 }, { keep: false });
    worlds.push(w);
    expect(server.mulliganPhaseActive).toBe(true);
    expect(w.iso.last('phase')?.phase).toMatchObject({ mulliganActive: true, decisionMade: false });

    // 1. The engine knows the decision is pending: `cmd sweep` is parked, nothing hits the wire.
    w.send({ type: 'cmd', cmd: 'sweep' });
    await until(() => /keep your hand/i.test(w.iso.state()?.sweep.error ?? ''), 'engine guard');
    expect(w.iso.state()!.sweep.phase).toBe('armed');
    expect(server.actions(P1)).toEqual([]);

    // 2. The engine believes the player kept (it heard `hand_kept`) but the server still gates
    //    (stale keep): the auto-sweep fires, edhplay refuses `view_library`, the sweep fails
    //    with the server's own words and nothing moves.
    const settledBefore = settledSweeps(w);
    server.keepHand(P1);
    server.player(P1).mulliganDecisionMade = false; // the `hand_kept` frame is already on its way
    await until(() => settledSweeps(w) > settledBefore && w.iso.state()?.sweep.phase !== 'running', 'refused sweep settled');
    const first = w.iso.state()!;
    expect(first.sweep.phase).toBe('failed');
    expect(first.sweep.error).toMatch(/mulligan/i);
    expect(first.sweep.error).toContain("can't view your library");
    expect(server.actionTypes(P1)).toEqual(['view_library']);
    expect(server.zone(P1, 'exile')).toHaveLength(0);
    expect(server.zone(P1, 'library')).toHaveLength(92);
    expect(server.zone(P1, 'hand').filter(isWastes)).toHaveLength(3);
    expect(first.reservoir).toHaveLength(0);
    expect(w.appFrames.some((f) => f['type'] === 'error' && /mulligan/i.test(String(f['message'])))).toBe(true);

    // 3. The player really keeps → the gate opens → the sweep goes through.
    server.keepHand(P1);
    await until(() => server.mulliganPhaseActive === false, 'mulligan phase closed');
    const second = await sweepOnce(w);
    expect(second.sweep.phase).toBe('done');
    expect(second.reservoir).toHaveLength(50);
    expect(server.actionTypes(P1).slice(1)).toEqual(['view_library', 'clear_library_viewing', 'batch_move_cards', 'exile_x_cards', 'draw_x_cards', 'shuffle_library']);
    expect(server.zone(P1, 'exile')).toHaveLength(50);
    expect(server.zone(P1, 'hand')).toHaveLength(7);
    expect(server.zone(P1, 'hand').filter(isWastes)).toHaveLength(0);
    expect(hiddenViewerFrames(w)).toEqual([]);
  });
});

/** Number of sweeps that have settled (done or failed) so far, per the `seq` stream. */
function settledSweeps(w: World): number {
  return w.iso.of('seq').filter((s) => s.seq === 'sweep' && s.done).length;
}

/** `cmd sweep`, then wait for the NEXT sweep completion (`seq` with done), whether we or the auto-sweep started it. */
async function sweepOnce(w: World) {
  const before = settledSweeps(w);
  w.send({ type: 'cmd', cmd: 'sweep' });
  // The `seq` line is sent before the engine's final state push, so also wait for the phase to leave `running`.
  await until(() => settledSweeps(w) > before && w.iso.state()?.sweep.phase !== 'running', 'sweep settled');
  return w.iso.state()!;
}
