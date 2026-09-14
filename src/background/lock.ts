/**
 * Per-room tab lock: only one tab drives sequences and broadcasts for a room.
 * Kept in memory (service worker lifetime) and mirrored to storage.session so a
 * restarted worker can recover; stale entries expire after 15 s without heartbeat.
 */

interface LockEntry {
  tabId: number;
  at: number;
}

const STALE_MS = 15_000;
const locks = new Map<string, LockEntry>();

export function acquireLock(roomId: string, tabId: number, now = Date.now()): boolean {
  const cur = locks.get(roomId);
  if (!cur || cur.tabId === tabId || now - cur.at > STALE_MS) {
    locks.set(roomId, { tabId, at: now });
    return true;
  }
  return false;
}

export function heartbeat(roomId: string, tabId: number, now = Date.now()): boolean {
  const cur = locks.get(roomId);
  if (cur && cur.tabId === tabId) {
    cur.at = now;
    return true;
  }
  return acquireLock(roomId, tabId, now);
}

export function releaseLock(roomId: string, tabId: number): void {
  const cur = locks.get(roomId);
  if (cur && cur.tabId === tabId) locks.delete(roomId);
}

export function releaseAllForTab(tabId: number): void {
  for (const [room, e] of locks) if (e.tabId === tabId) locks.delete(room);
}
