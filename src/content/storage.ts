import type { Config, HokGameState } from '@shared/state';
import { defaultConfig } from '@shared/state';

const roomKey = (roomId: string) => `hok:room:${roomId}`;
const CONFIG_KEY = 'hok:config';

export async function loadRoomState(roomId: string): Promise<HokGameState | null> {
  const key = roomKey(roomId);
  try {
    const s = await chrome.storage.session.get(key);
    if (s[key]) return s[key] as HokGameState;
  } catch {
    /* session storage may be inaccessible before the SW sets the access level */
  }
  const l = await chrome.storage.local.get(key);
  return (l[key] as HokGameState | undefined) ?? null;
}

let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMirror: { key: string; state: HokGameState | null } | null = null;

export async function saveRoomState(roomId: string, state: HokGameState | null): Promise<void> {
  const key = roomKey(roomId);
  try {
    if (state) await chrome.storage.session.set({ [key]: state });
    else await chrome.storage.session.remove(key);
  } catch {
    /* ignore */
  }
  pendingMirror = { key, state };
  if (mirrorTimer) clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => {
    const p = pendingMirror;
    pendingMirror = null;
    mirrorTimer = null;
    if (!p) return;
    if (p.state) void chrome.storage.local.set({ [p.key]: p.state });
    else void chrome.storage.local.remove(p.key);
  }, 500);
}

export async function loadConfig(): Promise<Config> {
  const got = await chrome.storage.local.get(CONFIG_KEY);
  return { ...defaultConfig, ...((got[CONFIG_KEY] as Partial<Config> | undefined) ?? {}) };
}

export async function saveConfig(config: Config): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: config });
}
