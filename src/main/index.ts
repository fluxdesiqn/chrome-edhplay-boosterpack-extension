/**
 * MAIN-world entry: install the HTTP and WebSocket taps before the app loads,
 * then start the engine. Must never throw into the page.
 */
import { installWsTap } from './ws-tap';
import { Engine } from './engine';
import { installHttpTap } from './cube/http-tap';
import { CubeRuntime } from './cube/runtime';
import { BAKED_CUBES, CARRIER_POOL } from '@shared/cube/data';

(() => {
  try {
    const KEY = Symbol.for('hok.engine');
    const g = globalThis as unknown as Record<symbol, unknown>;
    if (g[KEY]) return;
    const cube = new CubeRuntime(BAKED_CUBES, CARRIER_POOL);
    try {
      installHttpTap(window, {
        catalog: () => cube.active(),
        cubeName: () => cube.catalog?.snapshot.name ?? 'Custom cube',
        onError: (where, err) => console.warn('[HoK] cube http tap', where, err),
      });
    } catch (err) {
      console.error('[HoK] cube http tap failed', err);
    }
    const tap = installWsTap(window);
    g[KEY] = new Engine(tap, window, cube);
  } catch (err) {
    console.error('[HoK] failed to start', err);
  }
})();
