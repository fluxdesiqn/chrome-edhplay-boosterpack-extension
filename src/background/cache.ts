/** Small TTL cache on chrome.storage.local. */

const PREFIX = 'hok:cache:';

export async function cacheGet<T>(key: string): Promise<T | null> {
  const k = PREFIX + key;
  const got = await chrome.storage.local.get(k);
  const entry = got[k] as { v: T; exp: number } | undefined;
  if (!entry) return null;
  if (entry.exp && entry.exp < Date.now()) {
    void chrome.storage.local.remove(k);
    return null;
  }
  return entry.v;
}

export async function cacheSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  await chrome.storage.local.set({ [PREFIX + key]: { v: value, exp: ttlMs > 0 ? Date.now() + ttlMs : 0 } });
}

export async function cacheClear(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}
