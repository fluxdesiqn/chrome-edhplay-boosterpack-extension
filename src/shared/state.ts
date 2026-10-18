import type { CardRef, RolledPack, SetCode } from './packs/types';
import type { Zone } from './protocol';
import { DEFAULT_CUBE_ID } from './cube/defaults';

export interface Mapping {
  ref: CardRef;
  /** true once the blank has been seen in a public zone or revealed; never flips back */
  public: boolean;
  assignedAt: number; // turn_seq at assignment
}

export interface RolledPackRecord extends RolledPack {
  /** 1-based ordinal of this pack for this owner */
  n: number;
}

export type SweepPhase = 'disarmed' | 'armed' | 'running' | 'done' | 'failed';

export interface SweepState {
  phase: SweepPhase;
  stepIndex: number;
  error?: string;
  /** why we are disarmed (no placeholder, ambiguous, …) */
  reason?: string;
}

export type ActivationPhase = 'choose-pack' | 'rolled' | 'viewing' | 'resolving' | 'done';

/** What an activation is for: the Heroes +2, or a second-deck pile operation. */
export type ActivationOp = 'heroes' | 'open' | 'draw' | 'mill' | 'search';

export interface PlannedMove {
  blankId: string;
  ref: CardRef;
  zone: 'hand' | 'graveyard';
  sent: boolean;
  done: boolean;
}

export interface Activation {
  phase: ActivationPhase;
  op: ActivationOp;
  turnSeq: number;
  pack: RolledPackRecord | null;
  /** cards removed from the top of the pile for this activation (≤4) */
  look: CardRef[];
  /** indices into look */
  toHand: number[];
  moves: PlannedMove[];
}

/**
 * heroes: Heroes of Kamigawa is the commander → +2 look-four-pick-two flow.
 * deck:   any other commander → the booster pile is a hidden second deck (draw/peek/search/mill).
 */
export type GameMode = 'heroes' | 'deck';

/** Owner-side per-room game state. Persisted in chrome.storage.session. */
export interface HokGameState {
  v: 1;
  roomId: string;
  playerId: string;
  mode: GameMode;
  /** true when the user forced the mode instead of auto-detecting from the command zone */
  modeForced: boolean;
  /** mulligans taken through the extension after the sweep (first one is free in Commander) */
  mulligans: number;
  /** the player declared they are happy with their hand */
  mulliganDone: boolean;
  placeholderPrintId: string | null;
  placeholderName: string | null;
  sweep: SweepState;
  /** blank ids currently face-down in exile and unconsumed; index 0 = next to take */
  reservoir: string[];
  /** every id that was ever a blank (only the sweep adds ids) */
  seenBlankIds: string[];
  /** own blanks: blankId → mapping */
  mappings: Record<string, Mapping>;
  /** booster pile, index 0 = top */
  pile: CardRef[];
  packs: RolledPackRecord[];
  activation: Activation | null;
  activationCount: number;
  /** blank ids whose mapping we have already broadcast */
  announced: string[];
  updatedAt: number;
}

export function emptyGameState(roomId: string, playerId: string): HokGameState {
  return {
    v: 1,
    roomId,
    playerId,
    mode: 'heroes',
    modeForced: false,
    mulligans: 0,
    mulliganDone: false,
    placeholderPrintId: null,
    placeholderName: null,
    sweep: { phase: 'disarmed', stepIndex: 0 },
    reservoir: [],
    seenBlankIds: [],
    mappings: {},
    pile: [],
    packs: [],
    activation: null,
    activationCount: 0,
    announced: [],
    updatedAt: Date.now(),
  };
}

/** What every client knows about another owner's blanks (learned from chat). */
export interface PeerView {
  ownerId: string;
  extVersion?: string;
  dataVersion?: string;
  role?: 'p' | 's';
  placeholderPrintId?: string | null;
  reservoirCount?: number;
  pileCount?: number;
  activationCount?: number;
  packs: RolledPackRecord[];
  /** blankId → ref, only what was broadcast */
  mappings: Record<string, CardRef>;
  /** tokenId → ref for token copies without a resolvable print */
  tokenMappings: Record<string, CardRef>;
  dataVersionMismatch: boolean;
  lastSeen: number;
}

export interface GamePhase {
  deckSubmitted: boolean;
  mulliganActive: boolean;
  decisionMade: boolean;
  handCount: number;
  libraryCount: number;
  currentTurnPlayerId: string | null;
  turnSeq: number;
  phase: string | null;
  isMyTurn: boolean;
  isSpectator: boolean;
}

export const emptyPhase: GamePhase = {
  deckSubmitted: false,
  mulliganActive: false,
  decisionMade: false,
  handCount: 0,
  libraryCount: 0,
  currentTurnPlayerId: null,
  turnSeq: 0,
  phase: null,
  isMyTurn: false,
  isSpectator: false,
};

/** Minimal card summary shared with the UI. */
export interface CardSummary {
  id: string;
  card_print_id: string;
  name: string;
  type_line: string;
  zone: Zone;
  ownerId: string;
  faceDown: boolean;
  front_image_uri: string;
}

export interface Config {
  /** @deprecated the sweep always runs after the keep; kept so stored configs still parse */
  autoSweep?: boolean;
  /** Commander multiplayer rule: the first mulligan puts nothing on the bottom. */
  freeFirstMulligan: boolean;
  /** Recently used runtime set codes for the pack chooser. */
  recentSets: string[];
  defaultSet: SetCode;
  handSize: number;
  minBlankCopies: number;
  preferredPlaceholderName: string;
  panelCollapsed: boolean;
  /** Paint carrier cards as the custom cards of `cubeId`. */
  cubeEnabled: boolean;
  /** CubeForge cube id whose custom cards are played. */
  cubeId: string;
}

export const defaultConfig: Config = {
  freeFirstMulligan: true,
  recentSets: [],
  defaultSet: 'neo',
  handSize: 7,
  minBlankCopies: 50,
  preferredPlaceholderName: 'Wastes',
  panelCollapsed: false,
  cubeEnabled: true,
  cubeId: DEFAULT_CUBE_ID,
};

export interface LedgerEntry {
  at: number;
  action: string;
  summary: string;
}
