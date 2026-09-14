/** UI-side state, fed by bridge messages from the MAIN-world engine. */
import { signal, computed } from '@preact/signals';
import type { Diag, MainToIso, OfferCard, SocketCtx } from '@shared/bridge-contract';
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
    case 'ledger':
      ledger.value = msg.entries;
      break;
    case 'diag':
      diags.value = [...diags.value.slice(-199), msg.diag];
      break;
    case 'needs-reload':
      needsReload.value = true;
      break;
    case 'record':
    case 'hello':
      break;
  }
}
