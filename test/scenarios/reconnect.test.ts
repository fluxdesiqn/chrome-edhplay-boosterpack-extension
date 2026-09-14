// @vitest-environment happy-dom
/**
 * Scenario D: reconnect + hydrate keeps the owner state; unsupported protocol versions are inert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetIds } from '../fixtures/game-state';
import { buildDeck } from '../harness/deck';
import { FakeServer } from '../harness/fake-server';
import { FakeWs } from '../harness/fake-ws';
import { activate, bootPlayer, P1, sweepAndActivate } from '../harness/flows';
import { advance, createWorld, flush, until, type World } from '../harness/world';

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

describe('reconnect', () => {
  it('D1: a new world hydrated with the saved state keeps reservoir and mappings; no second sweep, no resync', async () => {
    const server = new FakeServer();
    const w1 = await bootPlayer(server, P1, { wastes: 50, real: 49, handWastes: 3 });
    worlds.push(w1);
    await sweepAndActivate(w1);
    const saved = w1.iso.state()!;
    expect(saved.reservoir).toHaveLength(46);
    expect(Object.keys(saved.mappings)).toHaveLength(4);

    server.disconnect(P1);
    await flush();
    expect(w1.iso.socketEvents()).toContain('closed');
    w1.dispose();

    const logMark = server.log.length;
    const chatMark = server.chat.length;
    const w2 = createWorld({ playerId: P1, roomId: server.roomId });
    worlds.push(w2);
    w2.hydrate(saved);
    await flush();
    w2.connect(server);
    await until(() => w2.iso.state()?.sweep.phase === 'done', 'restored state');
    await advance(5000); // room for any spurious follow-up actions to show up

    const st = w2.iso.state()!;
    expect(st.reservoir).toEqual(saved.reservoir);
    expect(st.mappings).toEqual(saved.mappings);
    expect(st.activationCount).toBe(1);
    expect(st.pile).toEqual(saved.pile);
    expect(st.placeholderName).toBe('Wastes');
    expect(st.activation).toBeNull();

    // Only chat went out after reconnecting: no sweep actions, no resync.
    const after = server.log.slice(logMark).map((e) => e.msg['type']);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((t) => t === 'send_chat_message')).toBe(true);
    expect(w2.iso.diags().some((d) => /resetting room state|reservoir reconciled/.test(d.msg))).toBe(false);
    expect(w2.iso.socketEvents()).toEqual(['opened', 'confirmed']);
    // It re-announced its state to the room.
    const stateLines = server.chat.slice(chatMark).filter((c) => c.playerId === P1 && c.message.startsWith('[HoK1] {"t":"state"'));
    expect(stateLines.length).toBeGreaterThan(0);
    expect(stateLines.at(-1)!.message).toContain('"res":46');

    // The restored engine is live: it can offer from the remaining pile.
    const offer = await activate(w2, null);
    expect(offer.offer).toHaveLength(4);
    expect(offer.pileSize).toBe(7);
    expect(offer.blanksLeft).toBe(46);
  });

  it('D2: protocol version 5 → socket unsupported, no actions ever sent', async () => {
    const server = new FakeServer();
    server.addPlayer(P1, 'owner', buildDeck({ wastes: 50, real: 49, handWastes: 3 }, P1));
    const w = createWorld({ playerId: P1, roomId: server.roomId });
    worlds.push(w);
    w.hydrate();
    w.connect(server, { pv: 5 });
    await advance(3000);

    expect(w.iso.socketEvents()).toEqual(['opened', 'unsupported']);
    expect(w.iso.last('socket')!.ctx.pv).toBe('5');
    expect(w.iso.diags().some((d) => d.level === 'error' && /unsupported protocol version 5/.test(d.msg))).toBe(true);
    expect(w.iso.state()).toBeNull();
    expect(server.log).toEqual([]);
    // The page still receives the untouched frames.
    expect(w.appFrames.some((f) => f['type'] === 'game_state' && f['protocol_version'] === 5)).toBe(true);

    w.send({ type: 'cmd', cmd: 'sweep' });
    await advance(3000);
    expect(server.log).toEqual([]);
    expect(w.tap.active()).toBeNull();
  });
});
