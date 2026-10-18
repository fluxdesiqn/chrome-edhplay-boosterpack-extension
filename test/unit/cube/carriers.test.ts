import { describe, expect, it } from 'vitest';
import { assignCarriers, wantsLegendaryCarrier } from '@shared/cube/carriers';
import { parseCube } from '@shared/cube/parse';
import type { CubeCard } from '@shared/cube/types';
import { cubeResponse, pool } from './fixture';

const cards = () => parseCube(cubeResponse()).cards;

describe('assignCarriers', () => {
  it('gives legendary creatures legendary carriers and the rest plain ones', () => {
    const p = pool();
    const { byKey, unassigned } = assignCarriers(cards(), p, {});
    expect(unassigned).toEqual([]);
    for (const c of cards()) expect(p[byKey.get(c.key)!]!.legendary).toBe(wantsLegendaryCarrier(c));
    expect(new Set(byKey.values()).size).toBe(byKey.size);
  });

  it('is independent of input order', () => {
    const a = assignCarriers(cards(), pool(), {});
    const b = assignCarriers([...cards()].reverse(), pool(), {});
    expect([...b.byKey].sort()).toEqual([...a.byKey].sort());
  });

  it('keeps baked assignments and never moves existing cards when cards are added', () => {
    const base = assignCarriers(cards(), pool(), {});
    const baked = Object.fromEntries(base.byKey);
    const late: CubeCard = { ...cards().find((c) => c.name === 'Puddle Punch')!, key: 'custom-late', name: 'Late Card', addedAt: '2027-01-01T00:00:00Z' };
    const next = assignCarriers([late, ...cards()], pool(), baked);
    for (const [k, i] of base.byKey) expect(next.byKey.get(k)).toBe(i);
    expect(Object.values(baked)).not.toContain(next.byKey.get('custom-late'));
  });

  it('reserves the slot of a baked card that left the cube', () => {
    const base = assignCarriers(cards(), pool(), {});
    const baked = Object.fromEntries(base.byKey);
    const gone = cards().find((c) => c.name === 'Puddle Punch')!;
    const late: CubeCard = { ...gone, key: 'custom-late', name: 'Late Card' };
    const next = assignCarriers([...cards().filter((c) => c.key !== gone.key), late], pool(), baked);
    expect(next.byKey.get('custom-late')).not.toBe(baked[gone.key]);
  });

  it('falls back to the other kind, then reports cards it cannot place', () => {
    const p = pool().slice(0, 11); // 10 legendary + 1 plain
    const { byKey, unassigned } = assignCarriers(cards(), p, {});
    expect(byKey.size).toBe(11);
    expect(unassigned.length).toBe(cards().length - 11);
  });
});
