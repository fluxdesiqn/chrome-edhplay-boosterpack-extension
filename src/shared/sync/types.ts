import type { CardRef, SetCode } from '../packs/types';

export const SYNC_PREFIX = '[HoK1]';
export const SYNC_PREFIX_ANY = '[HoK';
export const SYNC_MAX_CHARS = 500;
export const SYNC_MAX_MAP_PAIRS = 8;
export const SYNC_PROTOCOL_VERSION = 1 as const;

export type SyncMessage =
  | { t: 'hello'; v: typeof SYNC_PROTOCOL_VERSION; n: string; dv: string; role: 'p' | 's' }
  | { t: 'state'; ph: string | null; res: number; pile: number; act: number; dv: string }
  | { t: 'pack'; n: number; set: SetCode; seed: string; dv: string }
  | { t: 'map'; m: Array<[blankId: string, ref: CardRef]> }
  | { t: 'tok'; m: Array<[tokenId: string, ref: CardRef]> }
  | { t: 'need'; from?: string };

export interface ReceivedSync {
  senderId: string;
  msg: SyncMessage;
}
