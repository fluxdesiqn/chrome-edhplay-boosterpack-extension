/** Reusable multi-step flows so each scenario reads as a short script. */
import type { SetCode } from '@shared/packs/types';
import type { HokGameState } from '@shared/state';
import { buildDeck, type DeckSpec } from './deck';
import type { FakeServer } from './fake-server';
import { createWorld, until, type World } from './world';

export const P1 = 'aaaaaaaa-1111-4000-8000-000000000001';
export const P2 = 'bbbbbbbb-2222-4000-8000-000000000002';

/** Add the player to the server, build a world, hydrate a fresh room, connect, and wait for the first state push. */
export async function bootPlayer(server: FakeServer, playerId: string, deck: DeckSpec, opts: { state?: HokGameState | null } = {}): Promise<World> {
  server.addPlayer(playerId, `user-${playerId.slice(0, 8)}`, buildDeck(deck, playerId));
  const world = createWorld({ playerId, roomId: server.roomId });
  world.hydrate(opts.state ?? null);
  world.connect(server);
  await until(() => world.iso.state() !== null, `${playerId.slice(0, 8)} first state`);
  return world;
}

/** ISO → `cmd sweep`, then wait for the sweep to settle (done or failed). */
export async function sweep(world: World): Promise<HokGameState> {
  world.send({ type: 'cmd', cmd: 'sweep' });
  await until(() => {
    const ph = world.iso.state()?.sweep.phase;
    return ph === 'done' || ph === 'failed';
  }, 'sweep settled');
  return world.iso.state()!;
}

/** `cmd activate` (a set or null), then wait for the offer. Returns the offer message. */
export async function activate(world: World, set: SetCode | null) {
  const before = world.iso.of('offer').length;
  world.send({ type: 'cmd', cmd: 'activate', set });
  await until(() => world.iso.of('offer').length > before, 'offer');
  return world.iso.offer()!;
}

/** `cmd pick`, then wait until the activation resolved (activationCount incremented). */
export async function pick(world: World, toHand: number[]): Promise<HokGameState> {
  const target = (world.iso.state()?.activationCount ?? 0) + 1;
  world.send({ type: 'cmd', cmd: 'pick', toHand });
  await until(() => (world.iso.state()?.activationCount ?? 0) >= target, 'activation resolved');
  return world.iso.state()!;
}

/** Sweep + one full `neo` activation keeping look indices 0 and 1. */
export async function sweepAndActivate(world: World): Promise<HokGameState> {
  const swept = await sweep(world);
  if (swept.sweep.phase !== 'done') throw new Error(`sweep failed: ${swept.sweep.error}`);
  await activate(world, 'neo');
  return pick(world, [0, 1]);
}
