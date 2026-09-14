/**
 * MAIN-world entry: install the WebSocket tap before the app loads, then
 * start the engine. Must never throw into the page.
 */
import { installWsTap } from './ws-tap';
import { Engine } from './engine';

(() => {
  try {
    const KEY = Symbol.for('hok.engine');
    const g = globalThis as unknown as Record<symbol, unknown>;
    if (g[KEY]) return;
    const tap = installWsTap(window);
    g[KEY] = new Engine(tap, window);
  } catch (err) {
    console.error('[HoK] failed to start', err);
  }
})();
