// @vitest-environment happy-dom
/**
 * Second-deck mode: with no Heroes of Kamigawa in the command zone the booster
 * pile behaves like a hidden extra library (open packs, draw, mill, search).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetIds } from '../fixtures/game-state';
import { FakeServer } from '../harness/fake-server';
import { FakeWs } from '../harness/fake-ws';
import { P1, P2, bootPlayer, sweep } from '../harness/flows';
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

async function setup() {
  const server = new FakeServer();
  const w1 = await bootPlayer(server, P1, { wastes: 50, real: 49, handWastes: 3, commander: 'other' });
  const w2 = await bootPlayer(server, P2, { wastes: 0, real: 60, handWastes: 0, commander: 'other' });
  worlds.push(w1, w2);
  return { server, w1, w2 };
}

describe('second-deck mode', () => {
  it('detects deck mode without Heroes in the command zone, opens a pack straight into the pile, then draws and mills', async () => {
    const { server, w1, w2 } = await setup();
    const swept = await sweep(w1);
    expect(swept.sweep.phase).toBe('done');
    expect(swept.mode).toBe('deck');

    // Open a pack: reveal → shuffle in → pile grows, nothing is looked at or taken.
    w1.send({ type: 'cmd', cmd: 'begin' });
    await until(() => w1.iso.state()?.activation?.phase === 'choose-pack', 'chooser');
    w1.send({ type: 'cmd', cmd: 'activate', set: 'chk', kind: 'draft' });
    await until(() => w1.iso.of('reveal').length > 0, 'reveal');
    w1.send({ type: 'cmd', cmd: 'shuffle-in' });
    await until(() => (w1.iso.state()?.pile.length ?? 0) === 15, 'pile has the pack');
    expect(w1.iso.state()!.activation).toBeNull();
    expect(w1.iso.of('offer')).toHaveLength(0);
    expect(w1.iso.state()!.reservoir).toHaveLength(50);

    // Draw the top card: one blank goes to hand with a private mapping.
    const top = w1.iso.state()!.pile[0]!;
    w1.send({ type: 'cmd', cmd: 'pile-draw', count: 1 });
    await until(() => w1.iso.state()?.reservoir.length === 49 && w1.iso.state()?.activation === null, 'draw resolved');
    const st = w1.iso.state()!;
    expect(st.pile).toHaveLength(14);
    const drawn = Object.entries(st.mappings).find(([, m]) => m.ref === top);
    expect(drawn).toBeDefined();
    expect(drawn![1].public).toBe(false);
    expect(server.zone(P1, 'hand').some((c) => c.id === drawn![0])).toBe(true);
    expect(w2.iso.peer(P1)?.mappings[drawn![0]]).toBeUndefined();

    // Mill the top card: public mapping, lands in the graveyard.
    const next = st.pile[0]!;
    w1.send({ type: 'cmd', cmd: 'pile-mill', count: 1 });
    await until(() => w1.iso.state()?.reservoir.length === 48 && w1.iso.state()?.activation === null, 'mill resolved');
    const st2 = w1.iso.state()!;
    const milled = Object.entries(st2.mappings).find(([, m]) => m.ref === next)!;
    expect(milled[1].public).toBe(true);
    expect(server.zone(P1, 'graveyard').some((c) => c.id === milled[0])).toBe(true);
    await until(() => w2.iso.peer(P1)?.mappings[milled[0]] === next, 'peer learned the milled card');

    // Peek shows the top 3 without changing anything; search takes a specific card.
    w1.send({ type: 'cmd', cmd: 'pile-peek', count: 3 });
    await until(() => w1.iso.of('pile-view').length > 0, 'peek view');
    const peek = w1.iso.of('pile-view').at(-1)!;
    expect(peek.kind).toBe('peek');
    expect(peek.cards.map((c) => c.ref)).toEqual(st2.pile.slice(0, 3));
    expect(w1.iso.state()!.pile).toHaveLength(13);

    const wanted = st2.pile[7]!;
    w1.send({ type: 'cmd', cmd: 'pile-take', ref: wanted, zone: 'hand' });
    await until(() => w1.iso.state()?.reservoir.length === 47 && w1.iso.state()?.activation === null, 'search resolved');
    expect(w1.iso.state()!.pile).toHaveLength(12);
    expect(w1.iso.state()!.pile).not.toContain(wanted);
  });

  it('a forced mode override sticks and can be returned to auto', async () => {
    const { w1 } = await setup();
    await sweep(w1);
    w1.send({ type: 'cmd', cmd: 'set-mode', mode: 'heroes' });
    await until(() => w1.iso.state()?.mode === 'heroes', 'forced heroes');
    expect(w1.iso.state()!.modeForced).toBe(true);
    w1.send({ type: 'cmd', cmd: 'set-mode', mode: 'auto' });
    await until(() => w1.iso.state()?.mode === 'deck', 'back to auto');
    expect(w1.iso.state()!.modeForced).toBe(false);
  });
});
