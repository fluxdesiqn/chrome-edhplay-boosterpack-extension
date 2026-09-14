// @vitest-environment happy-dom
/**
 * Scenario C: two engines in one room. Public mappings reach the peer, private ones never do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { identityFor } from '@shared/packs/identity';
import { decodeSync } from '@shared/sync/codec';
import { resetIds, WASTES_PRINT_ID } from '../fixtures/game-state';
import { buildDeck } from '../harness/deck';
import { FakeServer } from '../harness/fake-server';
import { FakeWs } from '../harness/fake-ws';
import { P1, P2, sweepAndActivate } from '../harness/flows';
import { createWorld, findCard, flush, until, type World } from '../harness/world';

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

const syncLine = (t: string) => (e: { msg: Record<string, unknown> }) => e.msg['type'] === 'send_chat_message' && String(e.msg['message']).startsWith(`[HoK1] {"t":"${t}"`);

/** Both players in the room before either connects, so each game_state lists both. */
async function setupRoom() {
  const server = new FakeServer();
  server.addPlayer(P1, 'owner', buildDeck({ wastes: 50, real: 49, handWastes: 3 }, P1));
  server.addPlayer(P2, 'peer', buildDeck({ wastes: 0, real: 60, handWastes: 0 }, P2));
  const w1 = createWorld({ playerId: P1, roomId: server.roomId });
  const w2 = createWorld({ playerId: P2, roomId: server.roomId });
  worlds.push(w1, w2);
  w1.hydrate();
  w2.hydrate();
  w1.connect(server);
  w2.connect(server);
  await until(() => w1.iso.state() !== null && w2.iso.state() !== null, 'both states');
  return { server, w1, w2 };
}

async function ownerActivates(server: FakeServer, w1: World, w2: World) {
  const s1 = await sweepAndActivate(w1);
  const graveIds = server.zone(P1, 'graveyard').map((c) => c.id);
  const handIds = Object.keys(s1.mappings).filter((id) => !graveIds.includes(id));
  expect(graveIds).toHaveLength(2);
  expect(handIds).toHaveLength(2);
  await until(() => Object.keys(w2.iso.peer(P1)?.mappings ?? {}).length >= 2, 'P2 learned the public mappings');
  await until(() => w2.iso.peer(P1)?.reservoirCount === s1.reservoir.length, 'P2 received the paced state line');
  return { s1, graveIds, handIds };
}

describe('peers', () => {
  it('C1: P2 sees real identities for public blanks and never learns hand mappings', async () => {
    const { server, w1, w2 } = await setupRoom();
    const { s1, graveIds, handIds } = await ownerActivates(server, w1, w2);

    // Peer view: exactly the two graveyard blanks.
    const peer = w2.iso.peer(P1)!;
    expect(Object.keys(peer.mappings).sort()).toEqual([...graveIds].sort());
    for (const id of handIds) expect(peer.mappings[id]).toBeUndefined();
    expect(peer.packs).toHaveLength(1);
    expect(peer.reservoirCount).toBe(46);

    // P2's page saw the graveyard blanks with the real card identity...
    for (const id of graveIds) {
      const seen = w2.lastCardSeen(id);
      expect(seen, `P2 frame for ${id}`).not.toBeNull();
      expect(seen!.name).toBe(identityFor(s1.mappings[id]!.ref)!.name);
      expect(seen!.card_print_id).not.toBe(WASTES_PRINT_ID);
    }
    // ...and only ever saw the hand blanks as Wastes (face-down in exile), never their identity.
    for (const id of handIds) {
      const frames = w2.framesFor(id);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every((f) => findCard(f, id)!.name === 'Wastes')).toBe(true);
      expect(w2.appFrames.some((f) => f['type'] === 'move_card' && f['id'] === id && f['zone'] === 'hand' && !('card' in f))).toBe(true);
    }
    // Sync lines never reach either page.
    for (const w of [w1, w2]) expect(w.appFrames.some((f) => f['type'] === 'chat_message_received' && String(f['message']).startsWith('[HoK'))).toBe(false);
  });

  it('C2: casting a hand-mapped blank via the app announces it and re-skins it for P2', async () => {
    const { server, w1, w2 } = await setupRoom();
    const { s1, handIds } = await ownerActivates(server, w1, w2);
    const castId = handIds[0]!;
    const ref = s1.mappings[castId]!.ref;

    w1.appSend({ type: 'move_card', id: castId, zone: 'battlefield', to: { x: 0.4, y: 0.4 }, updates: {} });
    await until(() => w2.iso.peer(P1)?.mappings[castId] === ref, 'P2 learned the cast mapping');
    await flush();

    expect(server.zone(P1, 'battlefield').some((c) => c.id === castId)).toBe(true);
    const st = w1.iso.state()!;
    expect(st.mappings[castId]!.public).toBe(true);
    expect(st.announced).toContain(castId);
    expect(w1.iso.diags().some((d) => /pre-announced 1 mapping/.test(d.msg))).toBe(true);
    // P2's latest frame for the card (the synthetic re-skin) carries the real identity.
    const seen = w2.lastCardSeen(castId);
    expect(seen!.name).toBe(identityFor(ref)!.name);
    expect(seen!.card_print_id).not.toBe(WASTES_PRINT_ID);
    expect(seen!.zone).toBe('battlefield');
    // The other hand blank is still private.
    expect(w2.iso.peer(P1)!.mappings[handIds[1]!]).toBeUndefined();
  });

  it('C3: the map line for an app-path move is written BEFORE the move_card', async () => {
    const { server, w1, w2 } = await setupRoom();
    const { handIds } = await ownerActivates(server, w1, w2);
    const castId = handIds[0]!;
    const mark = server.log.length;

    w1.appSend({ type: 'move_card', id: castId, zone: 'battlefield', to: { x: 0.4, y: 0.4 }, updates: {} });
    await until(() => server.logIndex(syncLine('map'), mark) >= 0, 'map line');

    const mapIdx = server.logIndex(syncLine('map'), mark);
    const moveIdx = server.logIndex((e) => e.msg['type'] === 'move_card' && e.msg['id'] === castId, mark);
    expect(moveIdx).toBeGreaterThanOrEqual(0);
    expect(mapIdx).toBeLessThan(moveIdx);
  });

  it('C4: a `need` from P2 is answered with state, pack and map lines', async () => {
    const { server, w1, w2 } = await setupRoom();
    const { graveIds, handIds } = await ownerActivates(server, w1, w2);
    const castId = handIds[0]!;
    w1.appSend({ type: 'move_card', id: castId, zone: 'battlefield', to: { x: 0.4, y: 0.4 }, updates: {} });
    await until(() => w2.iso.peer(P1)?.mappings[castId] !== undefined, 'cast announced');

    const chatMark = server.chat.length;
    w2.appSend({ type: 'send_chat_message', message: '[HoK1] {"t":"need"}' });
    const fromP1 = () => server.chat.slice(chatMark).filter((c) => c.playerId === P1);
    await until(() => ['state', 'pack', 'map'].every((t) => fromP1().some((c) => c.message.startsWith(`[HoK1] {"t":"${t}"`))), 'P1 replied to need');

    const lines = fromP1().map((c) => decodeSync(c.message)!);
    expect(lines.find((l) => l.t === 'state')).toMatchObject({ t: 'state', res: 46, pile: 11, act: 1 });
    expect(lines.find((l) => l.t === 'pack')).toMatchObject({ t: 'pack', n: 1, set: 'neo' });
    const mapped = lines.filter((l): l is Extract<typeof l, { t: 'map' }> => l.t === 'map').flatMap((l) => l.m.map(([id]) => id));
    expect([...mapped].sort()).toEqual([...graveIds, castId].sort());
    expect(mapped).not.toContain(handIds[1]);
    expect(w1.iso.diags().some((d) => /replied to need/.test(d.msg))).toBe(true);
    // P2's own need line never reached P2's page.
    expect(w2.appFrames.some((f) => f['type'] === 'chat_message_received' && String(f['message']).includes('"need"'))).toBe(false);
  });
});
