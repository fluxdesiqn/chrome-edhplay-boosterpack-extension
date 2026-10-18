/**
 * CubeForge `GET /api/cubes/{id}` → CubeSnapshot. Only custom cards are kept:
 * real Magic cards in the cube are already in edhplay's database.
 */
import type { CubeCard, CubeSnapshot } from './types';

export const CUBEFORGE_ORIGIN = 'https://cubeforge.app';

export const cubeApiUrl = (cubeId: string): string => `${CUBEFORGE_ORIGIN}/api/cubes/${encodeURIComponent(cubeId)}`;

/** Accepts a cube page URL or a bare id. */
export function cubeIdFromUrl(input: string): string | null {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(input);
  return m?.[1]?.toLowerCase() ?? null;
}

interface RawCard {
  name?: unknown;
  type?: unknown;
  manaCost?: unknown;
  cmc?: unknown;
  colors?: unknown;
  colorIdentity?: unknown;
  oracleText?: unknown;
  imageUrl?: unknown;
  rarity?: unknown;
  source?: unknown;
  oracleId?: unknown;
  addedAt?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Apostrophes and slashes vary between CubeForge text and what people type. */
export function normName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/\s*\/\/?\s*/g, ' // ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const PT_LINE = /^\*?[0-9X*+−-]+\/\*?[0-9X*+−-]+$/;

/** The card's own face: everything before a `//` line or a line naming its printed back. */
export function frontText(text: string, backName: string | null): string {
  const lines = text.split('\n');
  const cut = lines.findIndex((l) => {
    const t = l.trim();
    return t === '//' || (backName !== null && normName(t) === normName(backName));
  });
  return (cut < 0 ? lines : lines.slice(0, cut)).join('\n').trim();
}

/** Custom cards have no P/T fields; some put "3/3" as the last rules line. */
export function parsePowerToughness(text: string, typeLine: string): { power: string | null; toughness: string | null } {
  if (!/creature|vehicle/i.test(typeLine)) return { power: null, toughness: null };
  const last = text.trim().split('\n').pop()?.trim() ?? '';
  if (!PT_LINE.test(last)) return { power: null, toughness: null };
  const [p, t] = last.split('/');
  return { power: p ?? null, toughness: t ?? null };
}

function toCard(raw: RawCard, considering: boolean): CubeCard | null {
  const key = str(raw.oracleId);
  const name = str(raw.name).trim();
  const image = str(raw.imageUrl);
  if (!key || !name || !image) return null;
  return {
    key,
    name,
    typeLine: str(raw.type),
    manaCost: str(raw.manaCost),
    cmc: typeof raw.cmc === 'number' ? raw.cmc : 0,
    colors: strList(raw.colors),
    colorIdentity: Array.isArray(raw.colorIdentity) ? strList(raw.colorIdentity) : strList(raw.colors),
    oracleText: str(raw.oracleText),
    image,
    power: null,
    toughness: null,
    rarity: str(raw.rarity) || 'special',
    considering,
    back: null,
    addedAt: str(raw.addedAt),
  };
}

/**
 * Find the printed back of each drafted card among the Considering cards.
 * CubeForge has no back-face link, so this reads the front's rules text:
 * `Front // Back` names, a line naming the back after `//` or in a
 * transforming card, an unnamed `//` section whose text matches, and finally a
 * transforming card whose back shares its first name ("Silver, …").
 */
export function pairBackFaces(main: CubeCard[], considering: CubeCard[], overrides: Record<string, string> = {}): Map<string, string> {
  const out = new Map<string, string>();
  const byName = new Map<string, CubeCard>();
  for (const c of considering) if (!byName.has(normName(c.name))) byName.set(normName(c.name), c);
  const firstName = (n: string) => normName(n).split(',')[0]!.trim();

  for (const f of main) {
    const override = overrides[f.name];
    if (override) {
      const b = byName.get(normName(override));
      if (b) out.set(f.key, b.key);
      continue;
    }
    const text = f.oracleText;
    const lines = text.split('\n').map((l) => l.trim());
    const slash = lines.indexOf('//');
    const transforms = /transform/i.test(text);
    let back: CubeCard | undefined;

    const halves = f.name.split(' // ');
    if (halves.length === 2) back = byName.get(normName(halves[1]!));

    if (!back && (slash >= 0 || transforms)) {
      for (const l of slash >= 0 ? lines.slice(slash + 1) : lines) {
        const hit = byName.get(normName(l));
        if (hit && hit.key !== f.key) {
          back = hit;
          break;
        }
      }
    }
    if (!back) {
      // Meld: the half that names the result ("meld them into X") flips to show it.
      const meld = /meld (?:them|it|these) into ([^.\n]+)/i.exec(text);
      if (meld?.[1]) back = byName.get(normName(meld[1]));
    }
    if (!back && slash >= 0) {
      const rest = normName(lines.slice(slash + 1).join(' '));
      back = considering.find((c) => {
        const first = normName(c.oracleText.split('\n')[0] ?? '');
        return first.length > 20 && rest.includes(first);
      });
    }
    if (!back && transforms) {
      const fn = firstName(f.name);
      back = considering.find((c) => c.key !== f.key && firstName(c.name) === fn && /legendary/i.test(c.typeLine));
    }
    if (back) out.set(f.key, back.key);
  }
  return out;
}

export interface CubeApiResponse {
  cube?: { id?: unknown; name?: unknown; revision?: unknown };
  cards?: RawCard[];
  consideringCards?: RawCard[];
}

export function parseCube(json: CubeApiResponse, fetchedAt = Date.now(), overrides: Record<string, string> = {}): CubeSnapshot {
  const id = str(json.cube?.id);
  if (!id || !Array.isArray(json.cards)) throw new Error('not a CubeForge cube response');
  const seen = new Set<string>();
  const take = (list: RawCard[] | undefined, considering: boolean): CubeCard[] => {
    const out: CubeCard[] = [];
    for (const raw of list ?? []) {
      if (raw.source !== 'custom') continue;
      const c = toCard(raw, considering);
      // Doubled-up cards are separate entries with one oracle id.
      if (!c || seen.has(c.key)) continue;
      seen.add(c.key);
      out.push(c);
    }
    return out;
  };
  const main = take(json.cards, false);
  const considering = take(json.consideringCards, true);
  const backs = pairBackFaces(main, considering, overrides);
  const all = [...main, ...considering];
  const byKey = new Map(all.map((c) => [c.key, c]));
  for (const c of all) {
    c.back = backs.get(c.key) ?? null;
    const backName = c.back ? (byKey.get(c.back)?.name ?? null) : null;
    const halves = c.name.split(' // ');
    // A Room keeps both doors on its face; a printed back is cut off.
    if (!(halves.length === 2 && !c.back)) c.oracleText = frontText(c.oracleText, backName);
    const pt = parsePowerToughness(c.oracleText, c.typeLine);
    c.power = pt.power;
    c.toughness = pt.toughness;
  }
  return {
    id,
    name: str(json.cube?.name) || 'Cube',
    revision: typeof json.cube?.revision === 'number' ? json.cube.revision : null,
    fetchedAt,
    cards: all,
  };
}
