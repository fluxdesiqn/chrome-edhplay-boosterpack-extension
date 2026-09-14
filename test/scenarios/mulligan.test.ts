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

    // Mulligan 1: free.
    w.send({ type: 'cmd', cmd: 'mulligan' });
    await until(() => w.iso.of('mulligan-choose').length === 1, 'chooser 1');
    const c1 = w.iso.of('mulligan-choose')[0]!;
    expect(c1.mulligans).toBe(1);
    expect(c1.bottom).toBe(0);
    expect(c1.hand).toHaveLength(7);
    expect(server.zone(P1, 'library')).toHaveLength(libBefore);
    expect(server.log.some((e) => e.msg['type'] === 'batch_move_cards' && e.msg['shuffle'] === true)).toBe(true);
    expect(server.log.some((e) => e.msg['type'] === 'draw_x_cards' && e.msg['count'] === 7)).toBe(true);
    w.send({ type: 'cmd', cmd: 'mulligan-bottom', ids: [] });
    await until(() => w.iso.of('seq').some((s) => s.seq === 'mulligan' && s.done), 'mulligan 1 done');
    expect(w.iso.state()!.mulligans).toBe(1);

    // Mulligan 2: one card to the bottom.
    w.send({ type: 'cmd', cmd: 'mulligan' });
    await until(() => w.iso.of('mulligan-choose').length === 2, 'chooser 2');
    const c2 = w.iso.of('mulligan-choose')[1]!;
    expect(c2.mulligans).toBe(2);
    expect(c2.bottom).toBe(1);
    const victim = c2.hand[3]!.id;
    w.send({ type: 'cmd', cmd: 'mulligan-bottom', ids: [victim] });
    await until(() => server.zone(P1, 'hand').length === 6, 'card bottomed');
    const lib = server.zone(P1, 'library');
    expect(lib[lib.length - 1]!.id).toBe(victim);
    expect(w.iso.state()!.mulligans).toBe(2);
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
