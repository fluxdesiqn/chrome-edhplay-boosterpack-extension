// @vitest-environment happy-dom
/**
 * Scenario B: a +2 activation after a successful sweep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { identityFor } from '@shared/packs/identity';
import { decodeSync } from '@shared/sync/codec';
import { resetIds, WASTES_PRINT_ID } from '../fixtures/game-state';
import { FakeServer } from '../harness/fake-server';
import { FakeWs } from '../harness/fake-ws';
import { activate, bootPlayer, P1, pick, sweep, sweepAndActivate } from '../harness/flows';
import { advance, until, type World } from '../harness/world';

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

const isSync = (t: string) => (e: { msg: Record<string, unknown> }) => e.msg['type'] === 'send_chat_message' && String(e.msg['message']).startsWith(`[HoK1] {"t":"${t}"`);

describe('activation', () => {
  it('B1: activate neo → pack line + 4-card offer; pick [0,1] → map line, 4 moves, resolved', async () => {
    const server = new FakeServer();
    const w = await bootPlayer(server, P1, { wastes: 50, real: 49, handWastes: 3 });
    worlds.push(w);
    expect((await sweep(w)).sweep.phase).toBe('done');

    const offer = await activate(w, 'neo');
    expect(offer.offer).toHaveLength(4);
    expect(offer.pileSize).toBe(11);
    expect(offer.blanksLeft).toBe(50);
    expect(offer.activation.phase).toBe('viewing');
    expect(offer.offer.every((o) => o.identity.name && o.identity.card_print_id !== WASTES_PRINT_ID)).toBe(true);
    await until(() => server.syncLines('pack', P1).length === 1, 'pack chat line');
    const pack = decodeSync(server.syncLines('pack', P1)[0]!.message);
    expect(pack).toMatchObject({ t: 'pack', n: 1, set: 'neo' });

    const logMark = server.log.length;
    const state = await pick(w, [0, 1]);

    // Four stock move_card actions: graveyard first, then hand, all with the stock non-battlefield updates.
    const moves = server.actionsOf('move_card', P1);
    expect(moves).toHaveLength(4);
    expect(moves.map((m) => m['zone'])).toEqual(['graveyard', 'graveyard', 'hand', 'hand']);
    expect(moves.every((m) => (m['updates'] as { visibility: string }).visibility === 'default' && m['to'] === 0)).toBe(true);
    const graveIds = moves.slice(0, 2).map((m) => String(m['id']));
    const handIds = moves.slice(2).map((m) => String(m['id']));

    // The map line for the public (graveyard) blanks was written BEFORE the first move.
    const mapIdx = server.logIndex(isSync('map'), logMark);
    const moveIdx = server.logIndex((e) => e.msg['type'] === 'move_card', logMark);
    expect(mapIdx).toBeGreaterThanOrEqual(0);
    expect(mapIdx).toBeLessThan(moveIdx);
    const map = decodeSync(String(server.log[mapIdx]!.msg['message']));
    expect(map?.t).toBe('map');
    expect(map && map.t === 'map' ? map.m.map(([id]) => id).sort() : []).toEqual([...graveIds].sort());

    // Engine state.
    expect(w.iso.of('seq').some((s) => s.seq === 'activate' && s.step === 'Done' && s.done)).toBe(true);
    expect(state.activation).toBeNull();
    expect(state.activationCount).toBe(1);
    expect(state.reservoir).toHaveLength(46);
    expect(state.pile).toHaveLength(11);
    expect(state.packs).toHaveLength(1);
    expect(Object.keys(state.mappings).sort()).toEqual([...graveIds, ...handIds].sort());
    for (const id of graveIds) expect(state.mappings[id]!.public).toBe(true);
    for (const id of handIds) expect(state.mappings[id]!.public).toBe(false);
    expect([...state.announced].sort()).toEqual([...graveIds].sort());
    // look[0], look[1] went to hand; look[2], look[3] to the graveyard.
    const look = offer.offer.map((o) => o.ref);
    expect(handIds.map((id) => state.mappings[id]!.ref)).toEqual([look[0], look[1]]);
    expect(graveIds.map((id) => state.mappings[id]!.ref)).toEqual([look[2], look[3]]);

    // Server state.
    expect(server.zone(P1, 'graveyard').map((c) => c.id)).toEqual(expect.arrayContaining(graveIds));
    expect(server.zone(P1, 'hand').map((c) => c.id)).toEqual(expect.arrayContaining(handIds));
    expect(server.zone(P1, 'hand').filter((c) => handIds.includes(c.id)).every((c) => c.visibility === 'default')).toBe(true);
    expect(server.zone(P1, 'exile')).toHaveLength(46);
    // A state line with the new counts follows.
    await until(() => server.syncLines('state', P1).some((c) => c.message.includes('"act":1')), 'post-activation state line');
    expect(server.syncLines('state', P1).at(-1)!.message).toContain('"res":46');
  });

  it("B2: the owner's own frames for the picked blanks carry the rewritten identity", async () => {
    const server = new FakeServer();
    const w = await bootPlayer(server, P1, { wastes: 50, real: 49, handWastes: 3 });
    worlds.push(w);
    const state = await sweepAndActivate(w);
    await advance(500);
    for (const [id, m] of Object.entries(state.mappings)) {
      const seen = w.lastCardSeen(id);
      expect(seen, `frame for ${id}`).not.toBeNull();
      expect(seen!.name).toBe(identityFor(m.ref)!.name);
      expect(seen!.card_print_id).not.toBe(WASTES_PRINT_ID);
    }
  });

  it('B3: activate with set:null and a non-empty pile → offer from the pile, no new pack', async () => {
    const server = new FakeServer();
    const w = await bootPlayer(server, P1, { wastes: 50, real: 49, handWastes: 3 });
    worlds.push(w);
    await sweepAndActivate(w);
    const packLinesBefore = server.syncLines('pack', P1).length;

    const offer = await activate(w, null);
    expect(offer.offer).toHaveLength(4);
    expect(offer.pileSize).toBe(7);
    expect(offer.blanksLeft).toBe(46);
    expect(offer.activation.pack).toBeNull();
    await advance(2000);
    expect(server.syncLines('pack', P1)).toHaveLength(packLinesBefore);
    expect(w.iso.state()!.packs).toHaveLength(1);

    // Cancel puts the look back on top of the pile.
    w.send({ type: 'cmd', cmd: 'cancel' });
    await until(() => w.iso.state()?.activation === null && w.iso.state()?.pile.length === 11, 'cancelled');
    expect(server.actionsOf('move_card', P1)).toHaveLength(4);
  });
});
