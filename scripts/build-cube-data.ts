/**
 * Bake a CubeForge cube into the extension: `src/shared/cube/data/`.
 *
 *   npm run cube                       # refresh the default cube
 *   npm run cube -- <cube url or id>   # add or refresh another cube
 *
 * Writes
 *  - carrier-pool.json: obscure real cards (from edhplay's own database) that
 *    custom cards ride on. Built once, then only appended to, because decks
 *    store carriers: reordering or removing pool entries would break them.
 *  - <cube id>.json: the cube's custom cards plus the card → carrier table.
 *    Existing assignments are kept; new cards take the next free carrier.
 *
 * Every player in a pod must run the same build, since the table is what lets
 * all clients agree on which real card is which custom card.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignCarriers } from '../src/shared/cube/carriers';
import { cubeApiUrl, cubeIdFromUrl, normName, parseCube, type CubeApiResponse } from '../src/shared/cube/parse';
import type { BakedCube, Carrier } from '../src/shared/cube/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.cache');
const OUT_DIR = join(ROOT, 'src/shared/cube/data');
const POOL_FILE = join(OUT_DIR, 'carrier-pool.json');
const USER_AGENT = 'HoK-edhplay-extension/0.4';
const DEFAULT_CUBE = 'https://cubeforge.app/cubes/0f00d960-d538-4a53-a7eb-5ca3105d0802';

/** Least-played legendary creatures (commander slots). */
const LEGENDARY_QUERY = 't:legendary t:creature layout:normal year<=1999 -is:funny prints<=2 game:paper';
/** Portal / Starter cards nobody plays; plain single-faced cards only. */
const GENERAL_QUERY = '(set:ptk or set:po2 or set:por or set:s99 or set:s00) -t:basic -t:legendary layout:normal prints<=4';
const LEGENDARY_TARGET = 90;
const GENERAL_TARGET = 420;

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const lastAt: Record<string, number> = {};

/** GET JSON; Scryfall and edhplay responses are cached on disk, CubeForge never is. */
async function getJson(url: string, opts: { cache: boolean; gapMs: number }): Promise<{ status: number; body: unknown }> {
  const path = join(CACHE_DIR, createHash('sha1').update(url).digest('hex') + '.json');
  if (opts.cache && existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as { status: number; body: unknown };
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    const wait = (lastAt[host] ?? 0) + opts.gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt[host] = Date.now();
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(2000);
      continue;
    }
    if (res.status !== 200 && res.status !== 404) throw new Error(`HTTP ${res.status} for ${url}`);
    const out = { status: res.status, body: res.status === 200 ? ((await res.json()) as unknown) : null };
    if (opts.cache) {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(path, JSON.stringify(out));
    }
    return out;
  }
}

interface ScryCard {
  id: string;
  name: string;
}

async function scryfallNames(q: string): Promise<ScryCard[]> {
  let url: string | undefined = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=released&dir=asc`;
  const out: ScryCard[] = [];
  while (url) {
    const res = await getJson(url, { cache: true, gapMs: 100 });
    if (res.status === 404) break;
    const page = res.body as { data?: ScryCard[]; has_more?: boolean; next_page?: string };
    out.push(...(page.data ?? []));
    url = page.has_more ? page.next_page : undefined;
  }
  return out;
}

interface EdhPrint {
  card_id: string;
  card_print_id: string;
  name: string;
  type_line?: string;
  front_image_uri?: string;
}

async function edhplayPrints(name: string): Promise<EdhPrint[]> {
  const url = `https://api.edhplay.com/api/v1/public/cards/prints?name=${encodeURIComponent(name)}&tokens=exclude&lang=en&limit=50`;
  const res = await getJson(url, { cache: true, gapMs: 120 });
  const data = ((res.body as { data?: EdhPrint[] } | null)?.data ?? []).filter((p) => p.name === name);
  return data;
}

const imageId = (uri: string | undefined): string | null => /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(uri ?? '')?.[1]?.toLowerCase() ?? null;

async function toCarrier(sc: ScryCard, legendary: boolean): Promise<Carrier | null> {
  const prints = await edhplayPrints(sc.name);
  if (prints.length === 0) return null;
  const cardIds = new Set(prints.map((p) => p.card_id));
  if (cardIds.size !== 1) return null; // ambiguous name in edhplay's database
  const main = prints.find((p) => p.front_image_uri?.includes(sc.id)) ?? prints[0]!;
  return {
    card_id: main.card_id,
    card_print_id: main.card_print_id,
    print_ids: [...new Set(prints.map((p) => p.card_print_id))].filter((p) => p !== main.card_print_id),
    name: main.name,
    type_line: main.type_line ?? '',
    image_id: imageId(main.front_image_uri),
    legendary,
  };
}

async function growPool(pool: Carrier[], avoid: Set<string>): Promise<Carrier[]> {
  const have = new Set(pool.map((c) => c.card_id));
  const haveNames = new Set(pool.map((c) => normName(c.name)));
  const add = async (q: string, legendary: boolean, target: number) => {
    let count = pool.filter((c) => c.legendary === legendary).length;
    if (count >= target) return;
    for (const sc of await scryfallNames(q)) {
      if (count >= target) break;
      if (avoid.has(normName(sc.name)) || haveNames.has(normName(sc.name))) continue;
      const c = await toCarrier(sc, legendary);
      if (!c || have.has(c.card_id)) continue;
      pool.push(c);
      have.add(c.card_id);
      haveNames.add(normName(c.name));
      count++;
      process.stdout.write(legendary ? 'L' : '.');
    }
    process.stdout.write('\n');
  };
  await add(LEGENDARY_QUERY, true, LEGENDARY_TARGET);
  await add(GENERAL_QUERY, false, GENERAL_TARGET);
  return pool;
}

function writeIndex(): void {
  const cubes = readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'carrier-pool.json')
    .sort();
  const ident = (f: string) => 'cube_' + f.replace(/\.json$/, '').replace(/[^a-z0-9]/gi, '_');
  const lines = [
    '// GENERATED by scripts/build-cube-data.ts — do not edit by hand.',
    "import type { BakedCube, Carrier } from '../types';",
    "import pool from './carrier-pool.json';",
    ...cubes.map((f) => `import ${ident(f)} from './${f}';`),
    '',
    'export const CARRIER_POOL: Carrier[] = pool as Carrier[];',
    `export const BAKED_CUBES: BakedCube[] = [${cubes.map((f) => `${ident(f)} as BakedCube`).join(', ')}];`,
    '',
  ];
  writeFileSync(join(OUT_DIR, 'index.ts'), lines.join('\n'));
}

async function main(): Promise<void> {
  const input = process.argv[2] ?? DEFAULT_CUBE;
  const cubeId = cubeIdFromUrl(input);
  if (!cubeId) throw new Error(`not a CubeForge cube url or id: ${input}`);
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Fetching cube ${cubeId} from CubeForge…`);
  const api = await getJson(cubeApiUrl(cubeId), { cache: false, gapMs: 0 });
  if (api.status !== 200) throw new Error(`CubeForge returned ${api.status}`);
  const raw = api.body as CubeApiResponse & { cards?: Array<{ source?: unknown; name?: unknown }> };
  const snapshot = parseCube(raw);
  console.log(`  ${snapshot.name}: ${snapshot.cards.filter((c) => !c.considering).length} custom cards, ${snapshot.cards.filter((c) => c.considering).length} considering`);
  const backs = snapshot.cards.filter((c) => c.back);
  const byKey = new Map(snapshot.cards.map((c) => [c.key, c]));
  for (const c of backs) console.log(`  back face: ${c.name} → ${byKey.get(c.back!)?.name}`);

  // Real cards anywhere in the cube must never become carriers.
  const avoid = new Set<string>();
  for (const c of [...(raw.cards ?? []), ...((raw.consideringCards as Array<{ name?: unknown }> | undefined) ?? [])]) {
    if (typeof c.name === 'string') for (const half of c.name.split(' // ')) avoid.add(normName(half));
  }

  const pool: Carrier[] = existsSync(POOL_FILE) ? (JSON.parse(readFileSync(POOL_FILE, 'utf8')) as Carrier[]) : [];
  const before = pool.length;
  console.log(`Carrier pool: ${before} cards${before ? '' : ', building from Scryfall + edhplay…'}`);
  await growPool(pool, avoid);
  if (pool.length !== before) writeFileSync(POOL_FILE, JSON.stringify(pool, null, 1) + '\n');
  const clash = pool.filter((c) => avoid.has(normName(c.name)));
  for (const c of clash) console.warn(`  ! carrier ${c.name} is also a real card in this cube; cards on it will look custom`);

  const outFile = join(OUT_DIR, `${cubeId}.json`);
  const prev: BakedCube | null = existsSync(outFile) ? (JSON.parse(readFileSync(outFile, 'utf8')) as BakedCube) : null;
  const assignment = assignCarriers(snapshot.cards, pool, prev?.carriers ?? {});
  if (assignment.unassigned.length) throw new Error(`carrier pool exhausted: ${assignment.unassigned.length} card(s) left; raise the pool targets`);
  const carriers: Record<string, number> = { ...(prev?.carriers ?? {}) };
  for (const [k, i] of assignment.byKey) carriers[k] = i;
  const added = Object.keys(carriers).length - Object.keys(prev?.carriers ?? {}).length;

  const baked: BakedCube = { id: cubeId, name: snapshot.name, url: `https://cubeforge.app/cubes/${cubeId}`, snapshot, carriers };
  writeFileSync(outFile, JSON.stringify(baked) + '\n');
  writeIndex();
  console.log(`Wrote ${outFile}: ${Object.keys(carriers).length} carrier assignments (${added} new)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
