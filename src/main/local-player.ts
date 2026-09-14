/** Derive the local player id: JWT `sub` from localStorage, confirmed against game_state. */
import type { WirePlayer } from '@shared/protocol';

export function decodeJwtSub(token: string | null | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(atob(pad)) as { sub?: unknown };
    return typeof json.sub === 'string' ? json.sub : null;
  } catch {
    return null;
  }
}

export function localIdFromStorage(storage: Pick<Storage, 'getItem'> | null): string | null {
  try {
    return decodeJwtSub(storage?.getItem('access_token'));
  } catch {
    return null;
  }
}

/** The only player entry carrying a `hand` array is the local player. */
export function localIdFromGameState(players: WirePlayer[] | undefined): string | null {
  if (!Array.isArray(players)) return null;
  const withHand = players.filter((p) => Array.isArray(p.hand));
  return withHand.length === 1 ? withHand[0]!.player_id : null;
}
