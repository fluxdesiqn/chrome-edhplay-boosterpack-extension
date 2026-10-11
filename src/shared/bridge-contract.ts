import type { Activation, CardSummary, Config, GameMode, GamePhase, HokGameState, LedgerEntry, PeerView } from './state';
import type { RuntimeSetData, SetSummary } from './packs/runtime';
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
  /** protocol_version from the first game_state (null until then). */
  protocolVersion: number | null;
  /** Shape problems that disabled the socket (`unsupported`) or paused automation (drift). */
  problems: string[];
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
  | { type: 'socket'; ev: 'opened' | 'confirmed' | 'closed' | 'unsupported' | 'drift'; ctx: SocketCtx }
  | { type: 'phase'; phase: GamePhase }
  | { type: 'zones'; snapshot: ZoneSnapshot }
  | { type: 'state'; state: HokGameState | null }
  | { type: 'peers'; peers: PeerView[] }
  | { type: 'seq'; seq: 'sweep' | 'activate' | 'mulligan'; step: string; pct: number; error?: string; done?: boolean }
  | { type: 'offer'; activation: Activation; offer: OfferCard[]; pileSize: number; blanksLeft: number }
  /** A pack was opened by `ownerId` (possibly us): show the reveal overlay. */
  | { type: 'reveal'; ownerId: string; ownerName: string; isOwner: boolean; pack: RolledPackRecord; cards: OfferCard[] }
  /** The pack was shuffled into the pile (or the activation was cancelled): dismiss the reveal. */
  | { type: 'reveal-end'; ownerId: string; n: number; cancelled?: boolean }
  /** Engine needs card data for a runtime set (ISO fetches via background and answers with `set-data`). */
  | { type: 'need-set'; set: string }
  /** Engine wants edhplay print ids for Scryfall cards (ISO answers with `prints`). */
  | { type: 'need-prints'; cards: Array<{ scryfallId: string; name: string; set: string }> }
  /** Second-deck mode: show the owner a view of pile cards (peek at top N, or the whole pile for a search). */
  | { type: 'pile-view'; kind: 'peek' | 'search'; cards: OfferCard[]; total: number }
  /** Mulligan: the new hand was drawn; the owner must choose `bottom` cards to put on the bottom. */
  | { type: 'mulligan-choose'; hand: CardSummary[]; bottom: number; mulligans: number }
  | { type: 'ledger'; entries: LedgerEntry[] }
  | { type: 'diag'; diag: Diag }
  | { type: 'record'; frames: unknown[] }
  | { type: 'needs-reload' }
  /** A new game started in this room: forget everything shown for the previous one. */
  | { type: 'game-reset' };

export type IsoToMain =
  | { type: 'hello_ack'; nonce: string }
  | { type: 'hydrate'; roomId: string; state: HokGameState | null; config: Config; readOnly: boolean }
  | { type: 'cmd'; cmd: 'sweep' | 'rebroadcast' | 'resync' | 'cancel' | 'reset' | 'export-record' | 'begin' }
  | { type: 'cmd'; cmd: 'activate'; set: SetCode | null; kind?: PackKind }
  /** Owner clicked "shuffle into booster pile" after the reveal. */
  | { type: 'cmd'; cmd: 'shuffle-in' }
  /** Extension-driven Commander mulligan (after the sweep). */
  | { type: 'cmd'; cmd: 'mulligan' }
  | { type: 'cmd'; cmd: 'mulligan-bottom'; ids: string[] }
  | { type: 'cmd'; cmd: 'mulligan-keep' }
  | { type: 'cmd'; cmd: 'mulligan-reopen' }
  | { type: 'cmd'; cmd: 'set-mode'; mode: GameMode | 'auto' }
  /** Second-deck pile operations. */
  | { type: 'cmd'; cmd: 'pile-draw'; count: number }
  | { type: 'cmd'; cmd: 'pile-mill'; count: number }
  | { type: 'cmd'; cmd: 'pile-peek'; count: number }
  | { type: 'cmd'; cmd: 'pile-search' }
  | { type: 'cmd'; cmd: 'pile-take'; ref: CardRef; zone: 'hand' | 'graveyard' }
  | { type: 'cmd'; cmd: 'pile-shuffle' }
  | { type: 'cmd'; cmd: 'pile-view-close' }
  /** Answers to `need-set` / `need-prints`. */
  | { type: 'set-data'; set: string; data: RuntimeSetData | null; error?: string }
  | { type: 'prints'; entries: Record<string, { card_print_id: string; card_id: string } | null> }
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
  /** Resolve edhplay print ids for Scryfall cards (matched by Scryfall id inside the image URL). */
  | { m: 'prints.resolveCards'; cards: Array<{ scryfallId: string; name: string }> }
  /** Scryfall set list (booster-capable sets), cached. */
  | { m: 'sets.list' }
  /** Runtime set data for one set (booster-eligible cards), cached. */
  | { m: 'sets.cards'; set: string }
  | { m: 'cache.clear' }
  | { m: 'lock.acquire'; roomId: string }
  | { m: 'lock.release'; roomId: string };

export type RpcResult<R extends Rpc> = R extends { m: 'prints.resolve' | 'prints.resolveCards' }
  ? Record<string, { card_print_id: string; card_id: string } | null>
  : R extends { m: 'sets.list' }
    ? { sets: SetSummary[] }
    : R extends { m: 'sets.cards' }
      ? { data: RuntimeSetData | null; error?: string }
      : R extends { m: 'lock.acquire' }
        ? { granted: boolean }
        : { ok: true };
