import type { Activation, CardSummary, Config, GamePhase, HokGameState, LedgerEntry, PeerView } from './state';
import type { CardIdentity } from './protocol';
import type { CardRef, PackKind, SetCode } from './packs/types';
import type { RolledPackRecord } from './state';

export const BRIDGE_TAG = '__hok';
export const BRIDGE_VERSION = 1;

export interface SocketCtx {
  roomId: string;
  pv: string;
  spectator: boolean;
  confirmed: boolean;
  binaryOut: boolean;
}

export interface Diag {
  level: 'info' | 'warn' | 'error';
  msg: string;
  data?: unknown;
  at: number;
}

export interface ZoneSnapshot {
  /** own cards by zone (hand/library only known while owner); others' public zones */
  cards: CardSummary[];
  localPlayerId: string | null;
  players: Array<{ id: string; name: string }>;
}

export interface OfferCard {
  ref: CardRef;
  identity: CardIdentity;
}

export type MainToIso =
  | { type: 'hello' }
  | { type: 'socket'; ev: 'opened' | 'confirmed' | 'closed' | 'unsupported'; ctx: SocketCtx }
  | { type: 'phase'; phase: GamePhase }
  | { type: 'zones'; snapshot: ZoneSnapshot }
  | { type: 'state'; state: HokGameState | null }
  | { type: 'peers'; peers: PeerView[] }
  | { type: 'seq'; seq: 'sweep' | 'activate'; step: string; pct: number; error?: string; done?: boolean }
  | { type: 'offer'; activation: Activation; offer: OfferCard[]; pileSize: number; blanksLeft: number }
  /** A pack was opened by `ownerId` (possibly us): show the reveal overlay. */
  | { type: 'reveal'; ownerId: string; ownerName: string; isOwner: boolean; pack: RolledPackRecord; cards: OfferCard[] }
  /** The pack was shuffled into the pile (or the activation was cancelled): dismiss the reveal. */
  | { type: 'reveal-end'; ownerId: string; n: number; cancelled?: boolean }
  | { type: 'ledger'; entries: LedgerEntry[] }
  | { type: 'diag'; diag: Diag }
  | { type: 'record'; frames: unknown[] }
  | { type: 'needs-reload' };

export type IsoToMain =
  | { type: 'hello_ack'; nonce: string }
  | { type: 'hydrate'; roomId: string; state: HokGameState | null; config: Config; readOnly: boolean }
  | { type: 'cmd'; cmd: 'sweep' | 'rebroadcast' | 'resync' | 'cancel' | 'reset' | 'export-record' | 'begin' }
  | { type: 'cmd'; cmd: 'activate'; set: SetCode | null; kind?: PackKind }
  /** Owner clicked "shuffle into booster pile" after the reveal. */
  | { type: 'cmd'; cmd: 'shuffle-in' }
  | { type: 'cmd'; cmd: 'look-fewer' }
  | { type: 'cmd'; cmd: 'pick'; toHand: number[] }
  | { type: 'cmd'; cmd: 'set-placeholder'; printId: string; name: string }
  | { type: 'cmd'; cmd: 'dev-map'; cardId: string; ref: CardRef }
  | { type: 'cfg'; config: Config }
  | { type: 'record'; on: boolean };

export interface BridgeEnvelope<T> {
  [BRIDGE_TAG]: typeof BRIDGE_VERSION;
  dir: 'm2i' | 'i2m';
  nonce: string | null;
  payload: T;
}

/** ISO ↔ background RPC */
export type Rpc =
  | { m: 'ready' }
  | { m: 'prints.resolve'; names: string[] }
  | { m: 'cache.clear' }
  | { m: 'lock.acquire'; roomId: string }
  | { m: 'lock.release'; roomId: string };

export type RpcResult<R extends Rpc> = R extends { m: 'prints.resolve' }
  ? Record<string, { card_print_id: string; card_id: string } | null>
  : R extends { m: 'lock.acquire' }
    ? { granted: boolean }
    : { ok: true };
