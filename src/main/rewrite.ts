/**
 * Copy-on-write deep rewrite of wire messages: overlays a real card identity
 * onto every card-like object whose `id` is in the blank→identity index.
 */
import { IDENTITY_ALWAYS_FIELDS, IDENTITY_IF_PRESENT_FIELDS, type CardIdentity } from '@shared/protocol';

export interface RewriteResult<T> {
  msg: T;
  changed: boolean;
  /** ids of the cards that were overlaid, in walk order */
  touched: string[];
}

function isPlainObject(o: unknown): o is Record<string, unknown> {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
  const proto = Object.getPrototypeOf(o);
  return proto === Object.prototype || proto === null;
}

/** Plain object with a string `id` and at least one of card_print_id | name | front_image_uri. */
export function isCardLike(o: unknown): o is Record<string, unknown> {
  if (!isPlainObject(o)) return false;
  if (typeof o.id !== 'string') return false;
  return 'card_print_id' in o || 'name' in o || 'front_image_uri' in o;
}

/** Returns a NEW object with the identity fields applied; never mutates `card`. */
export function overlayIdentity(card: Record<string, unknown>, identity: CardIdentity): Record<string, unknown> {
  const out: Record<string, unknown> = { ...card };
  for (const key of IDENTITY_ALWAYS_FIELDS) {
    const v = identity[key];
    out[key] = key === 'back_image_uri' ? (v ?? null) : v;
  }
  for (const key of IDENTITY_IF_PRESENT_FIELDS) {
    if (key in card && identity[key] !== undefined) out[key] = identity[key];
  }
  return out;
}

const EMPTY_INDEX: ReadonlyMap<string, CardIdentity> = new Map();

export class RewriteEngine {
  #index: ReadonlyMap<string, CardIdentity> = EMPTY_INDEX;

  setIndex(index: ReadonlyMap<string, CardIdentity>): void {
    this.#index = index;
  }

  rewrite<T extends Record<string, unknown>>(msg: T): RewriteResult<T> {
    const touched: string[] = [];
    if (this.#index.size === 0) return { msg, changed: false, touched };
    const seen = new Set<object>();
    const out = this.#walk(msg, seen, touched);
    if (out === msg) return { msg, changed: false, touched };
    return { msg: out as T, changed: true, touched };
  }

  /** Returns the same reference when nothing beneath `node` changed; otherwise a shallow-cloned container. */
  #walk(node: unknown, seen: Set<object>, touched: string[]): unknown {
    if (typeof node !== 'object' || node === null) return node;
    if (seen.has(node)) return node;
    seen.add(node);
    try {
      if (Array.isArray(node)) return this.#walkArray(node, seen, touched);
      if (!isPlainObject(node)) return node;

      let base: Record<string, unknown> = node;
      let cloned = false;

      if (isCardLike(node) && node.is_token !== true) {
        const identity = this.#index.get(node.id as string);
        if (identity) {
          base = overlayIdentity(node, identity);
          cloned = true;
          touched.push(node.id as string);
        }
      }

      for (const key of Object.keys(node)) {
        const child = node[key];
        if (typeof child !== 'object' || child === null) continue;
        const next = this.#walk(child, seen, touched);
        if (next !== child) {
          if (!cloned) {
            base = { ...node };
            cloned = true;
          }
          base[key] = next;
        }
      }
      return cloned ? base : node;
    } finally {
      // Allow the same object to be reached via multiple non-cyclic paths (shared refs) while
      // still breaking true cycles during the descent.
      seen.delete(node);
    }
  }

  #walkArray(arr: unknown[], seen: Set<object>, touched: string[]): unknown {
    let out: unknown[] | null = null;
    for (let i = 0; i < arr.length; i++) {
      const child = arr[i];
      if (typeof child !== 'object' || child === null) continue;
      const next = this.#walk(child, seen, touched);
      if (next !== child) {
        if (!out) out = arr.slice();
        out[i] = next;
      }
    }
    return out ?? arr;
  }
}
