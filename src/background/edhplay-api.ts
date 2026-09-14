/** Thin client for edhplay's public card API (no auth). Used only for runtime identity misses. */

const BASE = 'https://api.edhplay.com/api/v1/public';

export interface PrintSummary {
  card_id: string;
  card_print_id: string;
  name: string;
  type_line?: string;
  front_image_uri?: string;
  back_image_uri?: string | null;
  power?: string | null;
  toughness?: string | null;
  can_rotate?: boolean;
}

interface ListResponse {
  data?: PrintSummary[];
  has_more?: boolean;
}

let lastCall = 0;
const MIN_GAP_MS = 120;

async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

async function getJson<T>(url: string, attempt = 0): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if ((res.status === 429 || res.status >= 500) && attempt < 1) {
    await new Promise((r) => setTimeout(r, 2000));
    return getJson<T>(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`edhplay API ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** Exact-name lookup; returns all prints whose name matches exactly. */
export async function searchPrintsByName(name: string): Promise<PrintSummary[]> {
  const url = `${BASE}/cards/prints?name=${encodeURIComponent(name)}&tokens=exclude&lang=en&limit=50`;
  const json = await paced(() => getJson<ListResponse>(url));
  const front = name.split(' // ')[0]?.trim();
  return (json.data ?? []).filter((p) => p.name === name || p.name === front);
}

/** Pick the print whose image URL embeds the given Scryfall id, else the first. */
export function pickPrint(prints: PrintSummary[], scryfallId?: string): PrintSummary | null {
  if (prints.length === 0) return null;
  if (scryfallId) {
    const exact = prints.find((p) => p.front_image_uri?.includes(scryfallId));
    if (exact) return exact;
  }
  return prints[0] ?? null;
}
