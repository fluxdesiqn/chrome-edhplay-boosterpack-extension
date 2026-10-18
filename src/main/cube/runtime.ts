/**
 * The cube the page is playing with. Starts from the data baked into the
 * extension (so the very first deck-builder request is already re-skinned),
 * then takes a live CubeForge snapshot from the content script when one
 * arrives. Carriers always come from the baked table plus the deterministic
 * fill in `assignCarriers`, so every player's extension agrees.
 */
import { CubeCatalog } from '@shared/cube/catalog';
import type { BakedCube, Carrier, CubeSnapshot } from '@shared/cube/types';
import type { CubeStatus } from '@shared/bridge-contract';

export class CubeRuntime {
  #catalog: CubeCatalog | null = null;
  #enabled = true;
  #cubeId: string | null;
  #source: CubeStatus['source'] = 'none';
  #error: string | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly baked: readonly BakedCube[],
    private readonly pool: readonly Carrier[],
  ) {
    this.#cubeId = baked[0]?.id ?? null;
    this.#loadBaked();
  }

  /** Catalog to paint with, or null when cube cards are off or no cube is loaded. */
  active(): CubeCatalog | null {
    return this.#enabled ? this.#catalog : null;
  }

  get catalog(): CubeCatalog | null {
    return this.#catalog;
  }

  configure(cubeId: string | null, enabled: boolean): void {
    const changed = cubeId !== this.#cubeId || enabled !== this.#enabled;
    this.#enabled = enabled;
    if (cubeId !== this.#cubeId) {
      this.#cubeId = cubeId;
      this.#catalog = null;
      this.#source = 'none';
      this.#loadBaked();
    }
    if (changed) this.#emit();
  }

  /** A fresh CubeForge snapshot (or a fetch error) for the configured cube. */
  applySnapshot(snapshot: CubeSnapshot | null, error?: string): void {
    this.#error = error ?? null;
    if (snapshot && snapshot.id === this.#cubeId) {
      const baked = this.baked.find((b) => b.id === snapshot.id);
      this.#catalog = new CubeCatalog(snapshot, this.pool, baked?.carriers ?? {});
      this.#source = 'live';
    }
    this.#emit();
  }

  status(): CubeStatus {
    const cat = this.#catalog;
    return {
      enabled: this.#enabled,
      cubeId: this.#cubeId,
      name: cat?.snapshot.name ?? null,
      source: this.#source,
      fetchedAt: cat?.snapshot.fetchedAt ?? null,
      cards: cat ? cat.entries.filter((e) => !e.card.considering).length : 0,
      considering: cat ? cat.entries.filter((e) => e.card.considering).length : 0,
      backFaces: cat ? cat.entries.filter((e) => e.back).length : 0,
      unassigned: cat ? cat.unassigned.map((c) => c.name) : [],
      error: this.#error,
    };
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #loadBaked(): void {
    const b = this.baked.find((x) => x.id === this.#cubeId);
    if (!b) return;
    this.#catalog = new CubeCatalog(b.snapshot, this.pool, b.carriers);
    this.#source = 'baked';
  }

  #emit(): void {
    for (const fn of this.#listeners) fn();
  }
}
