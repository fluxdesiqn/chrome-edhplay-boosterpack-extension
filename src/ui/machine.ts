/** UI-side state, fed by bridge messages from the MAIN-world engine. */
import { signal, computed } from '@preact/signals';
import type { Diag, MainToIso, OfferCard, SocketCtx } from '@shared/bridge-contract';
import type { CardSummary, RolledPackRecord } from '@shared/state';
import type { SetSummary } from '@shared/packs/runtime';
import type { Activation, Config, GamePhase, HokGameState, LedgerEntry, PeerView } from '@shared/state';
import { defaultConfig, emptyPhase } from '@shared/state';
import type { ZoneSnapshot } from '@shared/bridge-contract';

export const socket = signal<{ ev: string; ctx: SocketCtx } | null>(null);
export const phase = signal<GamePhase>(emptyPhase);
export const state = signal<HokGameState | null>(null);
export const peers = signal<PeerView[]>([]);
export const zones = signal<ZoneSnapshot | null>(null);
export const seq = signal<{ seq: string; step: string; pct: number; error?: string; done?: boolean } | null>(null);
export const offer = signal<{ activation: Activation; offer: OfferCard[]; pileSize: number; blanksLeft: number } | null>(null);
export const ledger = signal<LedgerEntry[]>([]);
export const diags = signal<Diag[]>([]);
export const needsReload = signal(false);
export const config = signal<Config>(defaultConfig);
export const readOnly = signal(false);
export const bridgeReady = signal(false);

/** Runtime set list for the pack chooser (loaded on demand by the content script). */
export const setList = signal<SetSummary[] | null>(null);
export const setListError = signal<string | undefined>(undefined);
export const setListLoader: { load: (() => void) | null } = { load: null };
export function requestSetList(): void {
  if (setList.value === null) setListLoader.load?.();
}

export const pileView = signal<{ kind: 'peek' | 'search'; cards: OfferCard[]; total: number } | null>(null);
export const mulliganChoose = signal<{ hand: CardSummary[]; bottom: number; mulligans: number } | null>(null);

export type RevealPhase = 'opening' | 'revealed' | 'shuffling' | 'closed';
export interface RevealState {
  ownerId: string;
  ownerName: string;
  isOwner: boolean;
  pack: RolledPackRecord;
  cards: OfferCard[];
  phase: RevealPhase;
}
export const reveal = signal<RevealState | null>(null);
const OPENING_MS = 900;
const SHUFFLE_MS = 1200;
let revealTimer: ReturnType<typeof setTimeout> | null = null;

function setRevealPhase(phase: RevealPhase, after?: () => void) {
  const r = reveal.value;
  if (!r) return;
  reveal.value = { ...r, phase };
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = null;
  if (after) revealTimer = setTimeout(after, phase === 'opening' ? OPENING_MS : SHUFFLE_MS);
}

export function closeReveal(): void {
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = null;
  reveal.value = null;
}

export type Screen = 'disabled' | 'waiting' | 'deck-check' | 'sweep' | 'ready' | 'activate';

export const screen = computed<Screen>(() => {
  const s = socket.value;
  if (needsReload.value) return 'disabled';
  if (!s || s.ev === 'closed') return 'waiting';
  if (s.ev === 'unsupported' || s.ctx.spectator || readOnly.value) return 'disabled';
  if (!s.ctx.confirmed) return 'waiting';
  const st = state.value;
  if (st?.activation && st.activation.phase !== 'done') return 'activate';
  if (!st || st.sweep.phase === 'disarmed' || st.sweep.phase === 'failed') return 'deck-check';
  if (st.sweep.phase !== 'done') return 'sweep';
  return 'ready';
});

export function applyMainMessage(msg: MainToIso): void {
  switch (msg.type) {
    case 'socket':
      socket.value = { ev: msg.ev, ctx: msg.ctx };
      if (msg.ev === 'confirmed') needsReload.value = false;
      break;
    case 'phase':
      phase.value = msg.phase;
      break;
    case 'zones':
      zones.value = msg.snapshot;
      break;
    case 'state':
      state.value = msg.state;
      if (!msg.state?.activation || msg.state.activation.phase === 'done') offer.value = null;
      break;
    case 'peers':
      peers.value = msg.peers;
      break;
    case 'seq':
      seq.value = { seq: msg.seq, step: msg.step, pct: msg.pct, error: msg.error, done: msg.done };
      break;
    case 'offer':
      offer.value = { activation: msg.activation, offer: msg.offer, pileSize: msg.pileSize, blanksLeft: msg.blanksLeft };
      break;
    case 'reveal': {
      const same = reveal.value && reveal.value.ownerId === msg.ownerId && reveal.value.pack.n === msg.pack.n;
      if (same) {
        // identities refreshed (e.g. print ids resolved): keep the phase, update the cards
        reveal.value = { ...reveal.value!, cards: msg.cards };
        break;
      }
      reveal.value = { ownerId: msg.ownerId, ownerName: msg.ownerName, isOwner: msg.isOwner, pack: msg.pack, cards: msg.cards, phase: 'opening' };
      setRevealPhase('opening', () => setRevealPhase('revealed'));
      break;
    }
    case 'reveal-end': {
      const r = reveal.value;
      if (!r || r.ownerId !== msg.ownerId || r.pack.n !== msg.n) break;
      if (msg.cancelled) closeReveal();
      else setRevealPhase('shuffling', () => closeReveal());
      break;
    }
    case 'ledger':
      ledger.value = msg.entries;
      break;
    case 'diag':
      diags.value = [...diags.value.slice(-199), msg.diag];
      break;
    case 'needs-reload':
      needsReload.value = true;
      break;
    case 'pile-view':
      pileView.value = { kind: msg.kind, cards: msg.cards, total: msg.total };
      break;
    case 'mulligan-choose':
      mulliganChoose.value = { hand: msg.hand, bottom: msg.bottom, mulligans: msg.mulligans };
      break;
    case 'game-reset':
      closeReveal();
      pileView.value = null;
      mulliganChoose.value = null;
      offer.value = null;
      seq.value = null;
      peers.value = [];
      break;
    case 'need-set':
    case 'need-prints':
    case 'record':
    case 'hello':
      break;
  }
}
