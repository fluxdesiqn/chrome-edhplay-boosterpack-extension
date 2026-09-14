// @vitest-environment happy-dom
/** A new game in the same room resets the booster pile, blanks and peer data, then the next keep re-sweeps. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetIds } from '../fixtures/game-state';
import { FakeServer } from '../harness/fake-server';
import { FakeWs } from '../harness/fake-ws';
import { P1, P2, bootPlayer, sweepAndActivate } from '../harness/flows';
import { until, type World } from '../harness/world';

const worlds: World[] = [];
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  resetIds();
  FakeWs.reset();
});
afterEach(() => {
  for (const w of worlds.splice(0)) w.dispose();
  vi.useRealTimers();
});

describe('new game', () => {
  it('clears pile, reservoir, mappings and peer views, then re-sweeps after the new keep', async () => {
    const server = new FakeServer();
    const w1 = await bootPlayer(server, P1, { wastes: 50, real: 49, handWastes: 3 });
    const w2 = await bootPlayer(server, P2, { wastes: 0, real: 60, handWastes: 0, commander: 'other' });
    worlds.push(w1, w2);
    const before = await sweepAndActivate(w1);
    expect(before.pile).toHaveLength(11);
    expect(before.reservoir).toHaveLength(46);
    await until(() => Object.keys(w2.iso.peer(P1)?.mappings ?? {}).length === 2, 'peer learned mappings');

    server.newGame();
    await until(() => w1.iso.of('game-reset').length > 0 && w2.iso.of('game-reset').length > 0, 'both reset');
    await until(() => w1.iso.state()?.sweep.phase !== 'done', 'owner state reset');
    const st = w1.iso.state()!;
    expect(st.pile).toHaveLength(0);
    expect(st.reservoir).toHaveLength(0);
    expect(st.packs).toHaveLength(0);
    expect(Object.keys(st.mappings)).toHaveLength(0);
    expect(st.mulligans).toBe(0);
    expect(w2.iso.of('peers').at(-1)?.peers ?? []).toHaveLength(0);
    // Nothing leaks from the old game into the new library/hand on the server either.
    expect(server.zone(P1, 'exile')).toHaveLength(0);

    // The player keeps again → automatic sweep → fresh reservoir of 50.
    server.keepHand(P1);
    await until(() => w1.iso.state()?.sweep.phase === 'done', 'second sweep');
    expect(w1.iso.state()!.reservoir).toHaveLength(50);
    expect(server.zone(P1, 'exile')).toHaveLength(50);
    expect(server.zone(P1, 'hand').some((c) => c.name === 'Wastes')).toBe(false);
    // And the keep-or-mulligan prompt shows up again for the new hand.
    expect(w1.iso.of('mulligan-choose').at(-1)?.mulligans).toBe(0);
  });
});
