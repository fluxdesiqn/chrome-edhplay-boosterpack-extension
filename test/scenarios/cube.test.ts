// @vitest-environment happy-dom
/** Custom cube cards in a game: carriers render as custom cards, custom tokens, and the on/off switch. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CubeRuntime } from '@main/cube/runtime';
import { parseCube } from '@shared/cube/parse';
import { defaultConfig } from '@shared/state';
import { resetIds } from '../fixtures/game-state';
import { buildDeck } from '../harness/deck';
import { FakeServer } from '../harness/fake-server';
import { FakeWs } from '../harness/fake-ws';
import { P1 } from '../harness/flows';
import { createWorld, until, type World } from '../harness/world';
import { cubeResponse, pool } from '../unit/cube/fixture';

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

describe('cube cards in a game', () => {
  it('re-skins carriers, creates custom tokens and turns off cleanly', async () => {
    const snapshot = parseCube(cubeResponse(), 1);
    const cube = new CubeRuntime([{ id: 'cube-1', name: 'Test Cube', url: '', snapshot, carriers: {} }], pool());
    const cat = cube.catalog!;
    const yamato = cat.byName('Yamato, Pursuer')!;
    const barrel = cat.byName('Barrel')!;

    const server = new FakeServer();
    const deck = buildDeck({ wastes: 0, real: 60, handWastes: 0, commander: 'other' }, P1);
    // The first card dealt to the hand is Yamato's carrier.
    const handCard = deck.find((c) => c.zone === 'library')!;
    Object.assign(handCard, { card_id: yamato.carrier.card_id, card_print_id: yamato.carrier.card_print_id, name: yamato.carrier.name });
    server.addPlayer(P1, 'user-p1', deck);

    const w = createWorld({ playerId: P1, roomId: server.roomId, cube });
    worlds.push(w);
    const config = { ...defaultConfig, cubeId: 'cube-1' };
    w.hydrate(null, config);
    w.connect(server);
    await until(() => w.lastCardSeen(handCard.id) !== null, 'hand dealt');
    expect(w.lastCardSeen(handCard.id)).toMatchObject({ name: 'Yamato, Pursuer', front_image_uri: yamato.card.image, card_id: yamato.carrier.card_id });
    await until(() => w.iso.of('cube-status').length > 0, 'cube status');
    expect(w.iso.last('cube-status')!.status).toMatchObject({ enabled: true, cubeId: 'cube-1', source: 'baked' });
    expect(w.iso.last('cube-status')!.cards.some((c) => c.name === 'Barrel' && c.considering)).toBe(true);

    // Create a custom token from the panel: a stock create_card with the whole card.
    server.keepHand(P1);
    w.send({ type: 'cmd', cmd: 'cube-token', key: barrel.card.key });
    await until(() => server.zone(P1, 'battlefield').some((c) => c.is_token), 'token created');
    const token = server.zone(P1, 'battlefield').find((c) => c.is_token)!;
    expect(token).toMatchObject({ card_print_id: barrel.carrier.card_print_id, name: 'Barrel', front_image_uri: barrel.card.image });
    await until(() => w.lastCardSeen(token.id) !== null, 'token seen');
    expect(w.lastCardSeen(token.id)!.name).toBe('Barrel');

    // A live snapshot replaces the baked one.
    w.send({ type: 'cube-snapshot', snapshot: { ...snapshot, fetchedAt: 2 } });
    await until(() => w.iso.last('cube-status')?.status.source === 'live', 'live snapshot');

    // Switching cube cards off repaints the carrier as itself.
    w.send({ type: 'cfg', config: { ...config, cubeEnabled: false } });
    await until(() => w.lastCardSeen(handCard.id)?.name === yamato.carrier.name, 'carrier shown again');
    expect(w.iso.last('cube-status')!.status.enabled).toBe(false);
  });
});
