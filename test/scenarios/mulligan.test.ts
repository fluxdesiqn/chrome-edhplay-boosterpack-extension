// @vitest-environment happy-dom
/** Keep in edhplay → automatic sweep → extension mulligan with Commander rules. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetIds } from '../fixtures/game-state';
import { FakeServer } from '../harness/fake-server';
import { FakeWs } from '../harness/fake-ws';
import { P1, bootPlayer } from '../harness/flows';
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

describe('mulligan', () => {
  it('sweeps automatically after the keep, then a free first mulligan and a second one with one card to the bottom', async () => {
    const server = new FakeServer();
    const w = await bootPlayer(server, P1, { wastes: 50, real: 49, handWastes: 3 });
    worlds.push(w);
    // Auto-sweep (default on) kicked in on hand_kept.
    await until(() => w.iso.state()?.sweep.phase === 'done', 'auto sweep');
    expect(server.zone(P1, 'hand')).toHaveLength(7);
    expect(server.zone(P1, 'hand').some((c) => c.name === 'Wastes')).toBe(false);
    const libBefore = server.zone(P1, 'library').length;
    const firstHand = server.zone(P1, 'hand').map((c) => c.id);
    // The sweep ends with a keep-or-mulligan prompt showing the fresh hand.
    await until(() => w.iso.of('mulligan-choose').length === 1, 'post-sweep prompt');
    const prompt = w.iso.of('mulligan-choose')[0]!;
    expect(prompt.mulligans).toBe(0);
    expect(prompt.bottom).toBe(0);
    expect(new Set(prompt.hand.map((c) => c.id))).toEqual(new Set(firstHand));

    // Mulligan 1: free.
    w.send({ type: 'cmd', cmd: 'mulligan' });
    await until(() => w.iso.of('mulligan-choose').length === 2, 'chooser 1');
    const c1 = w.iso.of('mulligan-choose')[1]!;
    expect(c1.mulligans).toBe(1);
    expect(c1.bottom).toBe(0);
    expect(c1.hand).toHaveLength(7);
    // A real mulligan: the hand is re-drawn from a shuffled library, not the same seven put back on top.
    expect(new Set(c1.hand.map((c) => c.id))).not.toEqual(new Set(firstHand));
    expect(new Set(c1.hand.map((c) => c.id))).toEqual(new Set(server.zone(P1, 'hand').map((c) => c.id)));
    expect(server.zone(P1, 'library')).toHaveLength(libBefore);
    // The chooser must be usable immediately (the sequence is complete until the player picks).
    expect(w.iso.of('seq').filter((s) => s.seq === 'mulligan').at(-1)?.done).toBe(true);
    const batch = server.log.find((e) => e.msg['type'] === 'batch_move_cards' && (e.msg['items'] as Array<{ to: number }>).every((i) => i.to === -1));
    expect(batch).toBeDefined();
    expect(server.log.some((e) => e.msg['type'] === 'shuffle_library')).toBe(true);
    expect(server.log.some((e) => e.msg['type'] === 'draw_x_cards' && e.msg['count'] === 7)).toBe(true);
    w.send({ type: 'cmd', cmd: 'mulligan-bottom', ids: [] });
    await until(() => w.iso.state()?.mulligans === 1, 'mulligan 1 recorded');

    // Mulligan 2: one card to the bottom.
    w.send({ type: 'cmd', cmd: 'mulligan' });
    await until(() => w.iso.of('mulligan-choose').length === 3, 'chooser 2');
    const c2 = w.iso.of('mulligan-choose')[2]!;
    expect(c2.mulligans).toBe(2);
    expect(c2.bottom).toBe(1);
    const victim = c2.hand[3]!.id;
    w.send({ type: 'cmd', cmd: 'mulligan-bottom', ids: [victim] });
    await until(() => server.zone(P1, 'hand').length === 6, 'card bottomed');
    const lib = server.zone(P1, 'library');
    expect(lib[lib.length - 1]!.id).toBe(victim);
    await until(() => w.iso.state()?.mulligans === 2, 'mulligan 2 recorded');
    // The reservoir was never touched by mulligans.
    expect(w.iso.state()!.reservoir).toHaveLength(50);
    expect(server.zone(P1, 'exile')).toHaveLength(50);
  });

  it('a sweep requested before the keep is parked with guidance and nothing is sent', async () => {
    const server = new FakeServer();
    const w = await bootPlayer(server, P1, { wastes: 50, real: 49, handWastes: 3 }, { keep: false });
    worlds.push(w);
    const before = server.log.length;
    w.send({ type: 'cmd', cmd: 'sweep' });
    await until(() => /Keep your hand/.test(w.iso.state()?.sweep.reason ?? ''), 'parked');
    expect(server.log.length).toBe(before);
    expect(w.iso.state()!.sweep.phase).toBe('armed');
  });
});
