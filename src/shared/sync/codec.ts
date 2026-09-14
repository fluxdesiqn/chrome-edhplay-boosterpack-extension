import { SET_CODES, parseRef } from '../packs/types';
import type { CardRef, SetCode } from '../packs/types';
import {
  SYNC_MAX_CHARS,
  SYNC_MAX_MAP_PAIRS,
  SYNC_PREFIX,
  SYNC_PREFIX_ANY,
  SYNC_PROTOCOL_VERSION,
} from './types';
import type { SyncMessage } from './types';

/** Human-readable text appended to `hello` so other players understand the machine lines. */
export const HELLO_TRAILER =
  'Heroes of Kamigawa booster sync: lines starting with [HoK1] are machine data.';

/** `[HoK1] {...json}` + optional ` trailer`. Throws if the line exceeds the chat limit. */
export function encodeSync(msg: SyncMessage, trailer?: string): string {
  let text = `${SYNC_PREFIX} ${JSON.stringify(msg)}`;
  if (trailer) text += ` ${trailer}`;
  if (text.length > SYNC_MAX_CHARS) {
    throw new Error(`sync line too long: ${text.length} > ${SYNC_MAX_CHARS} chars`);
  }
  return text;
}

/** True for any sync line regardless of protocol version (used to hide lines from the chat UI). */
export function isSyncLine(text: string): boolean {
  return text.startsWith(SYNC_PREFIX_ANY);
}

/** The digits after `[HoK`, or null when the text is not a sync line. */
export function syncMajorVersion(text: string): number | null {
  if (!text.startsWith(SYNC_PREFIX_ANY)) return null;
  const m = /^\[HoK(\d+)\]/.exec(text);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * Decode a chat line into a SyncMessage. Only lines with the exact current prefix are accepted;
 * trailing text after the JSON object is ignored. Returns null for anything malformed.
 */
export function decodeSync(text: string): SyncMessage | null {
  if (!text.startsWith(SYNC_PREFIX)) return null;
  const start = text.indexOf('{', SYNC_PREFIX.length);
  if (start < 0) return null;
  const end = findObjectEnd(text, start);
  if (end < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  return validateSync(raw);
}

/** Index of the `}` that closes the object opening at `start`, respecting strings/escapes; -1 if unbalanced. */
function findObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---- runtime shape validation -------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isCardRef(v: unknown): v is CardRef {
  return isString(v) && parseRef(v) !== null;
}

function isPairArray(v: unknown): v is Array<[string, CardRef]> {
  return (
    Array.isArray(v) &&
    v.every((p) => Array.isArray(p) && p.length === 2 && isString(p[0]) && isCardRef(p[1]))
  );
}

function validateSync(raw: unknown): SyncMessage | null {
  if (!isRecord(raw) || !isString(raw.t)) return null;
  switch (raw.t) {
    case 'hello': {
      const { v, n, dv, role } = raw;
      if (v !== SYNC_PROTOCOL_VERSION || !isString(n) || !isString(dv)) return null;
      if (role !== 'p' && role !== 's') return null;
      return { t: 'hello', v, n, dv, role };
    }
    case 'state': {
      const { ph, res, pile, act, dv } = raw;
      if (ph !== null && !isString(ph)) return null;
      if (!isFiniteNumber(res) || !isFiniteNumber(pile) || !isFiniteNumber(act)) return null;
      if (!isString(dv)) return null;
      return { t: 'state', ph, res, pile, act, dv };
    }
    case 'pack': {
      const { n, set, seed, dv } = raw;
      if (!isFiniteNumber(n) || !isString(seed) || !isString(dv)) return null;
      if (!isString(set) || !(SET_CODES as readonly string[]).includes(set)) return null;
      return { t: 'pack', n, set: set as SetCode, seed, dv };
    }
    case 'map': {
      if (!isPairArray(raw.m)) return null;
      return { t: 'map', m: raw.m.map(([id, ref]) => [id, ref]) };
    }
    case 'tok': {
      if (!isPairArray(raw.m)) return null;
      return { t: 'tok', m: raw.m.map(([id, ref]) => [id, ref]) };
    }
    case 'need': {
      if (raw.from === undefined) return { t: 'need' };
      if (!isString(raw.from)) return null;
      return { t: 'need', from: raw.from };
    }
    default:
      return null;
  }
}

// ---- chunking -----------------------------------------------------------------------------

function encodedMapLength(pairs: [string, CardRef][]): number {
  return SYNC_PREFIX.length + 1 + JSON.stringify({ t: 'map', m: pairs }).length;
}

/**
 * Split map pairs into chunks of at most `maxPairs`, additionally shrinking any chunk whose
 * encoded `map` line would exceed SYNC_MAX_CHARS. A single pair that is itself too long is
 * still emitted alone (encodeSync will reject it at send time).
 */
export function chunkMapPairs(
  pairs: [string, CardRef][],
  maxPairs: number = SYNC_MAX_MAP_PAIRS,
): [string, CardRef][][] {
  const limit = Math.max(1, Math.floor(maxPairs));
  const chunks: [string, CardRef][][] = [];
  let current: [string, CardRef][] = [];
  for (const pair of pairs) {
    current.push(pair);
    if (current.length > 1 && (current.length > limit || encodedMapLength(current) > SYNC_MAX_CHARS)) {
      current.pop();
      chunks.push(current);
      current = [pair];
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}
