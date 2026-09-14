// @vitest-environment happy-dom
/** Runtime (non-bundled) sets: the engine asks the ISO side for data, then rolls; a second set must work too. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetIds } from '../fixtures/game-state';
import { FakeServer } from '../harness/fake-server';
import { FakeWs } from '../harness/fake-ws';
import { P1, bootPlayer, sweep } from '../harness/flows';
import { until, type World } from '../harness/world';
import { makeSyntheticSet } from '../unit/packs/synthetic';

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

/** Answer `need-set` requests like the content script would, from synthetic data. */
function serveSets(w: World, codes: Record<string, { released: string; packSize: number }>) {
  let answered = 0;
  const tick = () => {
    const reqs = w.iso.of('need-set');
    while (answered < reqs.length) {
      const set = reqs[answered]!.set;
      answered += 1;
      const spec = codes[set];
      w.send({ type: 'set-data', set, data: spec ? makeSyntheticSet({ code: set, name: `Set ${set.toUpperCase()}`, released: spec.released, packSize: spec.packSize }) : null, error: spec ? undefined : 'unknown set' });
    }
  };
  return tick;
}

describe('runtime sets', () => {
  it('loads a set on demand, opens a Play Booster from it, then opens a second, different set without getting stuck', async () => {
    const server = new FakeServer();
    const w = await bootPlayer(server, P1, { wastes: 50, real: 49, handWastes: 3, commander: 'other' });
    worlds.push(w);
    await sweep(w);
    const serve = serveSets(w, { zzz: { released: '2025-06-01', packSize: 14 }, yyy: { released: '2019-01-01', packSize: 15 } });

    // First set.
    w.send({ type: 'cmd', cmd: 'begin' });
    await until(() => w.iso.state()?.activation?.phase === 'choose-pack', 'chooser');
    w.send({ type: 'cmd', cmd: 'activate', set: 'zzz', kind: 'draft' });
    await until(() => w.iso.of('need-set').length === 1, 'need-set zzz');
    expect(w.iso.last('seq')?.step).toMatch(/Loading ZZZ/);
    serve();
    await until(() => w.iso.of('reveal').length === 1, 'reveal zzz');
    const r1 = w.iso.of('reveal')[0]!;
    expect(r1.pack.set).toBe('zzz');
    expect(r1.cards).toHaveLength(14); // Play Booster era
    // The loading progress was cleared so the chooser is usable again.
    const seqAfterLoad = w.iso.of('seq').filter((s) => s.seq === 'activate').at(-1)!;
    expect(seqAfterLoad.done).toBe(true);
    w.send({ type: 'cmd', cmd: 'shuffle-in' });
    await until(() => (w.iso.state()?.pile.length ?? 0) === 14, 'pile has pack 1');

    // Second set: a fresh request, a fresh reveal, nothing stuck from the first load.
    w.send({ type: 'cmd', cmd: 'begin' });
    await until(() => w.iso.state()?.activation?.phase === 'choose-pack', 'chooser 2');
    w.send({ type: 'cmd', cmd: 'activate', set: 'yyy', kind: 'draft' });
    await until(() => w.iso.of('need-set').length === 2, 'need-set yyy');
    expect(w.iso.of('need-set')[1]!.set).toBe('yyy');
    serve();
    await until(() => w.iso.of('reveal').length === 2, 'reveal yyy');
    const r2 = w.iso.of('reveal')[1]!;
    expect(r2.pack.set).toBe('yyy');
    expect(r2.cards).toHaveLength(15);
    expect(r2.cards.every((c) => c.identity.name && c.identity.card_print_id.startsWith('hok-'))).toBe(true); // no edhplay ids yet
    expect(w.iso.of('need-prints').length).toBeGreaterThan(0);
    w.send({ type: 'cmd', cmd: 'shuffle-in' });
    await until(() => (w.iso.state()?.pile.length ?? 0) === 29, 'pile has both packs');

    // A set that cannot be loaded reports an error and leaves the chooser usable.
    w.send({ type: 'cmd', cmd: 'begin' });
    await until(() => w.iso.state()?.activation?.phase === 'choose-pack', 'chooser 3');
    w.send({ type: 'cmd', cmd: 'activate', set: 'nope', kind: 'draft' });
    await until(() => w.iso.of('need-set').length === 3, 'need-set nope');
    serve();
    await until(() => /Could not load NOPE/.test(w.iso.of('seq').at(-1)?.error ?? ''), 'load error surfaced');
    expect(w.iso.state()?.activation?.phase).toBe('choose-pack');
  });
});
