/** CubeForge cube fetch for the content script (the page cannot read CubeForge cross-origin). */
import { cubeApiUrl, parseCube, type CubeApiResponse } from '@shared/cube/parse';
import type { CubeSnapshot } from '@shared/cube/types';
import { cacheGet, cacheSet } from './cache';

const TTL = 10 * 60 * 1000;

export async function fetchCube(cubeId: string, force = false): Promise<{ snapshot: CubeSnapshot | null; error?: string }> {
  const key = 'cube:' + cubeId;
  if (!force) {
    const cached = await cacheGet<CubeSnapshot>(key);
    if (cached) return { snapshot: cached };
  }
  try {
    const res = await fetch(cubeApiUrl(cubeId), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`CubeForge ${res.status}`);
    const snapshot = parseCube((await res.json()) as CubeApiResponse);
    await cacheSet(key, snapshot, TTL);
    return { snapshot };
  } catch (err) {
    // A stale copy beats the baked one when CubeForge is down.
    const stale = await cacheGet<CubeSnapshot>(key);
    return { snapshot: stale, error: String(err instanceof Error ? err.message : err) };
  }
}
