/**
 * MAIN-world orchestrator: wires the WebSocket tap to the rewrite engine, the
 * zone index, the sync protocol, the owner state machine and the ISO bridge.
 */
import { Bridge } from '@shared/bridge';
import type { Diag, IsoToMain, MainToIso, OfferCard, SocketCtx } from '@shared/bridge-contract';
import { announcementsFor, markAnnounced, preAnnouncePairs, publicPairs } from '@shared/game/observer';
import {
  beginActivation,
  cancelActivation,
  clearDoneActivation,
  lookFewer,
  markMoveDone,
  markMoveSent,
  openPack,
  pendingMoves,
  pickCards,
  shufflePackIn,
  type ActivationEffect,
} from '@shared/game/activation';
import { reducePhase } from '@shared/game/phase';
import { DATA_VERSION } from '@shared/packs/data';
import { identityFor } from '@shared/packs/identity';
import { newSeed } from '@shared/packs/rng';
import { rollPackOfKind, shuffleIntoPile } from '@shared/packs/roller';
import type { CardRef, PackKind, SetCode } from '@shared/packs/types';
import { PROTOCOL_VERSION, stockNonBattlefieldUpdates, type CardIdentity, type Zone } from '@shared/protocol';
import { defaultConfig, emptyGameState, emptyPhase, type Config, type GamePhase, type HokGameState, type PeerView, type RolledPackRecord } from '@shared/state';
import { chunkMapPairs, decodeSync, encodeSync, HELLO_TRAILER, isSyncLine } from '@shared/sync/codec';
import { applySync, mappingIndex } from '@shared/sync/peers';
import { SyncQueue } from '@shared/sync/queue';
import type { SyncMessage } from '@shared/sync/types';
import { ActionSender } from './actions';
import { EchoWaiter } from './echo';
import { localIdFromGameState, localIdFromStorage } from './local-player';
import { RewriteEngine } from './rewrite';
import { runSweep, SweepError } from './sequences/sweep';
import type { FrameDecision, OutboundDecision, WsTap } from './ws-tap';
import { ZoneIndex, type Observation } from './zone-index';

declare const __EXT_VERSION__: string;
const EXT_VERSION = typeof __EXT_VERSION__ === 'string' ? __EXT_VERSION__ : 'dev';

type SuppressType = 'library_viewed' | 'viewed_cards_reordered' | 'library_viewing_cleared';

export class Engine {
  private readonly zones = new ZoneIndex();
  private readonly rewrite = new RewriteEngine();
  private readonly echo = new EchoWaiter();
  private readonly actions: ActionSender;
  private readonly sync: SyncQueue;
  private readonly bridge: Bridge<MainToIso, IsoToMain>;
  private peers: Record<string, PeerView> = {};
  private state: HokGameState | null = null;
  private phase: GamePhase = emptyPhase;
  private config: Config = defaultConfig;
  private readOnly = false;
  private hydratedRoom: string | null = null;
  private hydratedState: HokGameState | null = null;
  private ctx: SocketCtx | null = null;
  private localId: string | null = null;
  private suppress: Partial<Record<SuppressType, number>> = {};
  private sweepAbort: AbortController | null = null;
  private recording = false;
  private readonly record: unknown[] = [];
  private lastReplyAt = new Map<string, string | number>();
  private zonesTimer: ReturnType<typeof setTimeout> | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private helloSent = false;

  constructor(
    private readonly tap: WsTap,
    win: Window & typeof globalThis = window,
  ) {
    this.actions = new ActionSender(tap);
    this.actions.onLedger = (entries) => this.bridge.send({ type: 'ledger', entries });
    this.sync = new SyncQueue({
      send: (text) => {
        void this.actions.send({ type: 'send_chat_message', message: text }, `sync ${text.slice(7, 40)}`).catch((err) => this.diag('warn', 'chat send failed', String(err)));
      },
    });
    this.bridge = new Bridge<MainToIso, IsoToMain>({
      role: 'main',
      win,
      onMessage: (m) => this.onIso(m),
      onReady: () => this.pushAll(),
    });
    this.localId = localIdFromStorage(safeLocalStorage(win));
    tap.setHandlers({
      onFrame: (ctx, msg) => this.onFrame(ctx, msg),
      onOutbound: (ctx, msg) => this.onOutbound(ctx, msg),
      onSocket: (ev, ctx, detail) => this.onSocket(ev, ctx, detail),
    });
  }

  // ------------------------------------------------------------------ socket

  private onSocket(ev: 'opened' | 'confirmed' | 'closed' | 'unsupported' | 'error', ctx: SocketCtx, detail?: unknown): void {
    if (ev === 'error') {
      this.diag('error', 'tap error', String(detail));
      return;
    }
    this.ctx = ctx;
    if (ev === 'opened') {
      this.helloSent = false;
    }
    if (ev === 'unsupported') this.diag('error', `unsupported protocol version ${ctx.pv} (need ${PROTOCOL_VERSION})`);
    if (ev === 'closed') {
      this.echo.cancelAll('socket closed');
      this.sweepAbort?.abort();
    }
    this.bridge.send({ type: 'socket', ev, ctx: { ...ctx } });
  }

  // ------------------------------------------------------------------ inbound

  private onFrame(ctx: SocketCtx, msg: Record<string, unknown>): FrameDecision {
    if (this.recording) this.record.push(this.record.length > 2000 ? undefined : msg);
    const type = msg['type'];
    const synthetic = msg['hok_synthetic'] === true;

    if (type === 'chat_message_received' && typeof msg['message'] === 'string' && isSyncLine(msg['message'])) {
      this.onSyncLine(String(msg['player_id']), msg['message']);
      return { kind: 'drop' };
    }

    if (!synthetic) {
      if (type === 'game_state') this.onGameState(ctx, msg);
      if (this.shouldSuppress(type, msg)) return { kind: 'drop' };

      const observations = this.zones.apply(msg);
      const prevPhase = this.phase;
      this.phase = reducePhase(this.phase, msg, this.localId);
      if (this.phase !== prevPhase) this.bridge.send({ type: 'phase', phase: this.phase });
      this.echo.offer(msg);
      this.afterObservations(observations);
      if (type === 'new_game_started') this.onNewGame();
      if (observations.length) this.scheduleZones();
    }

    const cleaned = synthetic ? stripSynthetic(msg) : msg;
    const r = this.rewrite.rewrite(cleaned);
    if (r.changed || synthetic) return { kind: 'replace', msg: r.msg };
    return { kind: 'pass' };
  }

  private shouldSuppress(type: unknown, msg: Record<string, unknown>): boolean {
    if (typeof type !== 'string') return false;
    const t = type as SuppressType;
    const n = this.suppress[t];
    if (!n || n <= 0) return false;
    if (msg['player_id'] !== this.localId) return false;
    this.suppress[t] = n - 1;
    // The zone index still needs the library snapshot even though the app must not see it.
    if (t === 'library_viewed') this.zones.apply(msg);
    this.echo.offer(msg);
    return true;
  }

  private onGameState(ctx: SocketCtx, msg: Record<string, unknown>): void {
    const players = msg['players'] as Array<Record<string, unknown>> | undefined;
    const fromState = localIdFromGameState(players as never);
    if (fromState && fromState !== this.localId) {
      if (this.localId) this.diag('warn', `local id from token ${this.localId} disagrees with game_state ${fromState}; trusting game_state`);
      this.localId = fromState;
    }
    this.zones.localPlayerId = this.localId;
    const me = this.localId;
    const isPlayer = !!me && Array.isArray(players) && players.some((p) => p['player_id'] === me);

    // Owner state: adopt hydrated state for this room, else start fresh.
    if (isPlayer && !ctx.spectator && !this.readOnly) {
      if (!this.state || this.state.roomId !== ctx.roomId) {
        this.state = this.hydratedRoom === ctx.roomId && this.hydratedState ? this.hydratedState : emptyGameState(ctx.roomId, me!);
        if (this.state.playerId !== me) this.state = emptyGameState(ctx.roomId, me!);
      }
      // Reconcile against the snapshot once the zone index has it (done after apply, see afterGameState).
      queueMicrotask(() => this.afterGameState());
    }
    if (!this.helloSent) {
      this.helloSent = true;
      this.sync.enqueue({ t: 'hello', v: 1, n: EXT_VERSION, dv: DATA_VERSION, role: isPlayer ? 'p' : 's' }, { priority: true, trailer: HELLO_TRAILER });
      if (isPlayer) this.sync.enqueue({ t: 'need' });
    }
  }

  private afterGameState(): void {
    const s = this.state;
    const me = this.localId;
    if (!s || !me) return;
    const exileFaceDown = new Set(
      this.zones
        .cardsIn('exile', me)
        .filter((c) => c.faceDown)
        .map((c) => c.id),
    );
    const reservoir = s.reservoir.filter((id) => exileFaceDown.has(id));
    const anyMappedPresent = Object.keys(s.mappings).some((id) => this.zones.get(id));
    let cur: HokGameState = s;
    if (s.sweep.phase === 'done' && reservoir.length === 0 && !anyMappedPresent && s.seenBlankIds.length > 0) {
      this.diag('info', 'no known blanks in this game; resetting room state');
      cur = emptyGameState(s.roomId, me);
    } else if (reservoir.length !== s.reservoir.length) {
      this.diag('info', `reservoir reconciled ${s.reservoir.length} → ${reservoir.length}`);
      cur = { ...s, reservoir };
    }
    // Resume an in-flight activation: moves already visible in their zone count as done.
    for (const m of pendingMoves(cur)) {
      const c = this.zones.get(m.blankId);
      if (c && c.zone === m.zone) cur = markMoveDone(cur, m.blankId, m.zone).state;
    }
    this.state = cur;
    this.rebuildIndex();
    this.pushState();
    this.maybeAutoSweep();
    if (cur.sweep.phase === 'done') this.sync.enqueueState(this.stateMessage());
  }

  private onNewGame(): void {
    if (!this.state) return;
    this.diag('info', 'new game started; resetting booster state');
    this.state = emptyGameState(this.state.roomId, this.state.playerId);
    this.rebuildIndex();
    this.pushState();
    this.helloSent = false;
  }

  private afterObservations(observations: Observation[]): void {
    if (!this.state || !observations.length) return;
    let s = this.state;
    // Announce mappings for blanks that became public.
    const ann = announcementsFor(s, observations);
    if (ann.pairs.length) {
      this.sync.enqueueMap(ann.pairs, { priority: true });
      this.diag('info', `announced ${ann.pairs.length} mapping(s)`);
    }
    s = ann.state;
    // Complete activation moves whose blank reached its zone.
    for (const o of observations) {
      if (o.kind === 'removed') continue;
      const r = markMoveDone(s, o.cardId, o.zone);
      s = r.state;
      if (r.completed) {
        this.diag('info', 'activation resolved');
        this.bridge.send({ type: 'seq', seq: 'activate', step: 'Done', pct: 1, done: true });
        s = clearDoneActivation(s);
        this.sync.enqueueState({ ...this.stateMessage(), act: s.activationCount, res: s.reservoir.length, pile: s.pile.length });
      }
    }
    // Blanks leaving the reservoir by hand (user dragged a face-down blank out of exile).
    const reservoirSet = new Set(s.reservoir);
    const left = observations.filter((o) => reservoirSet.has(o.cardId) && (o.zone !== 'exile' || !o.faceDown) && o.kind !== 'seen');
    if (left.length) {
      const gone = new Set(left.map((o) => o.cardId));
      s = { ...s, reservoir: s.reservoir.filter((id) => !gone.has(id)) };
      this.diag('warn', `${left.length} blank(s) left the reservoir outside an activation`);
    }
    if (s !== this.state) {
      this.state = s;
      this.pushState();
    }
  }

  // ------------------------------------------------------------------ outbound

  private onOutbound(_ctx: SocketCtx, msg: Record<string, unknown>): OutboundDecision {
    const s = this.state;
    if (!s) return { kind: 'pass' };
    // Announce before a private blank goes public.
    const pairs = preAnnouncePairs(s, msg);
    const prepend: Record<string, unknown>[] = [];
    if (pairs.length) {
      // Write the mapping lines on the wire immediately before the app's own action.
      for (const chunk of chunkMapPairs(pairs)) {
        const text = encodeSync({ t: 'map', m: chunk });
        prepend.push({ type: 'send_chat_message', message: text });
        this.actions.note('send_chat_message', `sync map ×${chunk.length} (before ${String(msg['type'])})`);
      }
      this.sync.removePendingMapIds(pairs.map(([id]) => id));
      this.state = markAnnounced(s, pairs.map(([id]) => id));
      this.pushState();
      this.diag('info', `pre-announced ${pairs.length} mapping(s)`);
    }
    // Token copies of a re-skinned blank: make a real-card token instead of a Wastes token.
    if (msg['type'] === 'make_token_copy' && typeof msg['card_id'] === 'string') {
      const m = this.state?.mappings[msg['card_id']];
      const id = m ? identityFor(m.ref) : null;
      if (id && !id.card_print_id.startsWith('hok-')) {
        this.diag('info', `token copy of ${id.name} sent as create_card`);
        return { kind: 'replace', msgs: [...prepend, { type: 'create_card', card_print_id: id.card_print_id }] };
      }
    }
    if (prepend.length) return { kind: 'replace', msgs: [...prepend, msg] };
    return { kind: 'pass' };
  }

  // ------------------------------------------------------------------ sync

  private onSyncLine(senderId: string, text: string): void {
    const msg = decodeSync(text);
    if (!msg) return;
    if (senderId === this.localId) return;
    const res = applySync(this.peers, { senderId, msg }, { now: Date.now(), myDataVersion: DATA_VERSION, ownerOf: (id) => this.zones.ownerOf(id) });
    this.peers = res.peers;
    if (res.rejected) this.diag('warn', `sync rejected: ${res.rejected}`);
    if (msg.t === 'hello' || msg.t === 'need') this.replyWithState(senderId, msg.t);
    if (msg.t === 'pack' && msg.c && msg.c.length && res.changed) {
      // Only live packs get a reveal; re-broadcasts of old packs arrive with `state` and are not "new".
      const pack: RolledPackRecord = { n: msg.n, set: msg.set, kind: msg.k ?? 'draft', seed: msg.seed, dataVersion: msg.dv, cards: msg.c, foil: msg.f ?? [] };
      this.sendReveal(senderId, pack, false);
    }
    if (msg.t === 'shuf') this.bridge.send({ type: 'reveal-end', ownerId: senderId, n: msg.n });
    if (res.changed) {
      const before = this.rewrite;
      void before;
      this.rebuildIndex();
      if (msg.t === 'map' || msg.t === 'tok') this.reskinExisting(msg.m.map(([id]) => id));
      this.bridge.send({ type: 'peers', peers: Object.values(this.peers) });
    }
  }

  private replyWithState(requester: string, why: 'hello' | 'need'): void {
    const s = this.state;
    if (!s || s.sweep.phase !== 'done') return;
    const last = this.lastReplyAt.get(requester);
    if (typeof last === 'number' && Date.now() - last < 5000) return;
    this.lastReplyAt.set(requester, Date.now());
    this.sync.enqueueState(this.stateMessage());
    for (const p of s.packs) this.sync.enqueue({ t: 'pack', n: p.n, set: p.set, k: p.kind, seed: p.seed, dv: p.dataVersion, c: p.cards, f: p.foil });
    const pairs = publicPairs(s);
    if (pairs.length) this.sync.enqueueMap(pairs);
    this.diag('info', `replied to ${why} from ${requester.slice(0, 8)} with ${pairs.length} mapping(s)`);
  }

  private stateMessage(): Extract<SyncMessage, { t: 'state' }> {
    const s = this.state!;
    return { t: 'state', ph: s.placeholderPrintId, res: s.reservoir.length, pile: s.pile.length, act: s.activationCount, dv: DATA_VERSION };
  }

  private rebuildIndex(): void {
    const index = new Map<string, CardIdentity>();
    const add = (id: string, ref: CardRef) => {
      const ident = identityFor(ref);
      if (ident) index.set(id, ident);
    };
    for (const [id, ref] of mappingIndex(this.peers)) add(id, ref);
    if (this.state) for (const [id, m] of Object.entries(this.state.mappings)) add(id, m.ref);
    this.rewrite.setIndex(index);
  }

  /** Re-deliver already-rendered cards that just received a mapping so the app repaints them. */
  private reskinExisting(ids: string[]): void {
    const sock = this.tap.activeSocket();
    if (!sock) return;
    for (const id of ids) {
      const c = this.zones.get(id);
      if (!c) continue;
      const frame = {
        type: 'move_card',
        hok_synthetic: true,
        player_id: c.ownerId,
        id,
        zone: c.zone,
        from_zone: c.zone,
        updates: { visibility: c.card.visibility ?? 'default' },
        card: { ...c.card, zone: c.zone },
      };
      try {
        sock.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
      } catch (err) {
        this.diag('warn', 'reskin dispatch failed', String(err));
      }
    }
  }

  // ------------------------------------------------------------------ ISO commands

  private onIso(m: IsoToMain): void {
    switch (m.type) {
      case 'hydrate':
        this.hydratedRoom = m.roomId;
        this.hydratedState = m.state;
        this.config = m.config;
        this.readOnly = m.readOnly;
        if (this.state && this.state.roomId === m.roomId && m.state && m.state.updatedAt > this.state.updatedAt) {
          this.state = m.state;
          this.rebuildIndex();
          this.pushState();
        }
        break;
      case 'cfg':
        this.config = m.config;
        break;
      case 'record':
        this.recording = m.on;
        if (!m.on) this.bridge.send({ type: 'record', frames: [...this.record] });
        break;
      case 'cmd':
        this.onCommand(m);
        break;
      case 'hello_ack':
        break;
    }
  }

  private onCommand(m: Extract<IsoToMain, { type: 'cmd' }>): void {
    switch (m.cmd) {
      case 'sweep':
        void this.startSweep();
        break;
      case 'cancel':
        if (this.sweepAbort) this.sweepAbort.abort();
        else if (this.state?.activation) {
          const a = this.state.activation;
          if (a.phase === 'rolled' && a.pack) {
            this.sync.enqueue({ t: 'shuf', n: a.pack.n }, { priority: true });
            this.bridge.send({ type: 'reveal-end', ownerId: this.state.playerId, n: a.pack.n, cancelled: true });
          }
          this.applyStep(cancelActivation(this.state));
        }
        break;
      case 'begin':
        this.beginOnly();
        break;
      case 'activate':
        this.activate(m.set, m.kind ?? 'draft');
        break;
      case 'shuffle-in':
        if (this.state) this.applyStep(shufflePackIn(this.state, shuffleIntoPile));
        break;
      case 'look-fewer':
        if (this.state) this.applyStep(lookFewer(this.state));
        break;
      case 'pick':
        this.pick(m.toHand);
        break;
      case 'rebroadcast':
        this.lastReplyAt.clear();
        if (this.state?.sweep.phase === 'done') this.replyWithState('*', 'need');
        this.sync.enqueue({ t: 'need' });
        break;
      case 'resync':
        void this.actions.send({ type: 'resync' });
        break;
      case 'reset':
        if (this.state) {
          this.state = emptyGameState(this.state.roomId, this.state.playerId);
          this.rebuildIndex();
          this.pushState();
        }
        break;
      case 'set-placeholder':
        if (this.state) {
          this.state = { ...this.state, placeholderPrintId: m.printId, placeholderName: m.name, sweep: { phase: 'armed', stepIndex: 0 } };
          this.pushState();
        }
        break;
      case 'dev-map':
        if (this.state) {
          this.state = { ...this.state, mappings: { ...this.state.mappings, [m.cardId]: { ref: m.ref, public: true, assignedAt: 0 } } };
          this.rebuildIndex();
          this.reskinExisting([m.cardId]);
          this.pushState();
        }
        break;
      case 'export-record':
        this.bridge.send({ type: 'record', frames: [...this.record] });
        break;
    }
  }

  // ------------------------------------------------------------------ sweep

  private maybeAutoSweep(): void {
    const s = this.state;
    if (!s || !this.config.autoSweep) return;
    if (s.sweep.phase === 'done' || s.sweep.phase === 'running') return;
    if (this.phase.mulliganActive && this.phase.handCount > 0 && !this.phase.decisionMade) void this.startSweep();
  }

  private async startSweep(): Promise<void> {
    const s = this.state;
    const me = this.localId;
    if (!s || !me || this.sweepAbort) return;
    if (!this.tap.active()) {
      this.diag('warn', 'no active game socket');
      return;
    }
    this.sweepAbort = new AbortController();
    this.state = { ...s, sweep: { phase: 'running', stepIndex: 0 } };
    this.pushState();
    const progress = (step: string, pct: number) => this.bridge.send({ type: 'seq', seq: 'sweep', step, pct });
    try {
      const out = await runSweep({
        me,
        zones: this.zones,
        echo: this.echo,
        actions: this.actions,
        handSize: this.config.handSize,
        minCopies: this.config.minBlankCopies,
        preferredName: this.config.preferredPlaceholderName,
        chosenPrintId: s.placeholderPrintId,
        suppressNext: (t) => {
          this.suppress[t] = (this.suppress[t] ?? 0) + 1;
        },
        progress,
        log: (msg, data) => this.diag('info', `sweep: ${msg}`, data),
        signal: this.sweepAbort.signal,
      });
      const cur = this.state ?? s;
      const seen = new Set([...cur.seenBlankIds, ...out.blankIds]);
      // Prepend new blanks to whatever survived from an earlier sweep (stragglers).
      const reservoir = [...out.reservoir, ...cur.reservoir.filter((id) => !out.reservoir.includes(id))];
      this.state = {
        ...cur,
        placeholderPrintId: out.placeholderPrintId,
        placeholderName: out.placeholderName,
        reservoir,
        seenBlankIds: [...seen],
        sweep: { phase: 'done', stepIndex: 7 },
        updatedAt: Date.now(),
      };
      this.diag('info', `sweep done: ${out.reservoir.length} blanks in reservoir`);
      this.bridge.send({ type: 'seq', seq: 'sweep', step: 'Done', pct: 1, done: true });
      this.sync.enqueueState(this.stateMessage());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cur = this.state ?? s;
      const cancelled = msg === 'cancelled';
      this.state = { ...cur, sweep: { phase: cancelled ? 'armed' : 'failed', stepIndex: 0, error: cancelled ? undefined : msg, reason: err instanceof SweepError && err.detection?.kind !== 'found' ? msg : undefined } };
      this.diag(cancelled ? 'info' : 'error', `sweep ${cancelled ? 'cancelled' : 'failed'}: ${msg}`);
      this.bridge.send({ type: 'seq', seq: 'sweep', step: cancelled ? 'Cancelled' : 'Failed', pct: 0, error: cancelled ? undefined : msg, done: true });
    } finally {
      this.sweepAbort = null;
      this.suppress = {};
      this.pushState();
    }
  }

  // ------------------------------------------------------------------ activation

  private beginOnly(): void {
    const s = this.state;
    if (!s) return;
    if (s.activation && s.activation.phase !== 'done') return;
    const r = beginActivation(clearDoneActivation(s), this.phase.turnSeq);
    if (r.error) {
      this.diag('warn', r.error);
      return;
    }
    this.state = r.state;
    this.pushState();
  }

  private activate(set: SetCode | null, kind: PackKind = 'draft'): void {
    let s = this.state;
    if (!s) return;
    if (!s.activation || s.activation.phase === 'done') {
      const r = beginActivation(clearDoneActivation(s), this.phase.turnSeq);
      if (r.error) {
        this.diag('warn', r.error);
        return;
      }
      s = r.state;
    }
    if (s.activation?.phase !== 'choose-pack') {
      this.state = s;
      this.pushState();
      return;
    }
    const r = openPack(s, set, (code, k) => rollPackOfKind(code, k, newSeed()), shuffleIntoPile, kind);
    this.applyStep(r);
  }

  private pick(toHand: number[]): void {
    const s = this.state;
    if (!s?.activation) return;
    if (s.activation.phase === 'resolving') {
      // Retry: resend pending moves.
      void this.sendMoves(pendingMoves(s).map((m) => ({ kind: 'move', move: m }) as ActivationEffect));
      return;
    }
    this.applyStep(pickCards(s, toHand));
  }

  private applyStep(r: { state: HokGameState; effects: ActivationEffect[]; error?: string }): void {
    if (r.error) {
      this.diag('warn', r.error);
      this.bridge.send({ type: 'seq', seq: 'activate', step: r.error, pct: 0, error: r.error });
      return;
    }
    this.state = r.state;
    this.rebuildIndex();
    const chatPack = r.effects.find((e): e is Extract<ActivationEffect, { kind: 'chat-pack' }> => e.kind === 'chat-pack');
    if (chatPack) {
      const p = chatPack.pack;
      this.sync.enqueue({ t: 'pack', n: p.n, set: p.set, k: p.kind, seed: p.seed, dv: p.dataVersion, c: p.cards, f: p.foil }, { priority: true });
      this.sendReveal(r.state.playerId, p, true);
    }
    const shuffled = r.effects.find((e): e is Extract<ActivationEffect, { kind: 'chat-shuffled' }> => e.kind === 'chat-shuffled');
    if (shuffled) {
      this.sync.enqueue({ t: 'shuf', n: shuffled.n }, { priority: true });
      this.bridge.send({ type: 'reveal-end', ownerId: r.state.playerId, n: shuffled.n });
    }
    const chatMap = r.effects.find((e): e is Extract<ActivationEffect, { kind: 'chat-map' }> => e.kind === 'chat-map');
    if (chatMap) this.sync.flushMapNow(chatMap.pairs);
    this.pushState();
    this.pushOffer();
    const moves = r.effects.filter((e) => e.kind === 'move');
    if (moves.length) void this.sendMoves(moves);
  }

  private async sendMoves(effects: ActivationEffect[]): Promise<void> {
    const moves = effects.filter((e): e is Extract<ActivationEffect, { kind: 'move' }> => e.kind === 'move');
    for (const { move } of moves) {
      if (!this.state?.activation) return;
      this.bridge.send({ type: 'seq', seq: 'activate', step: `Moving ${move.ref} to ${move.zone}`, pct: 0.5 });
      this.state = markMoveSent(this.state, move.blankId);
      try {
        await this.actions.send({ type: 'move_card', id: move.blankId, zone: move.zone, to: 0, updates: stockNonBattlefieldUpdates('default') }, `${move.ref} → ${move.zone}`);
      } catch (err) {
        this.diag('error', `move failed: ${String(err)}`);
      }
    }
    // Wait for echoes; on timeout ask for a resync and re-check.
    await sleep(3000);
    if (!this.state || !pendingMoves(this.state).length) return;
    await this.actions.send({ type: 'resync' }).catch(() => undefined);
    await sleep(2500);
    const still = this.state ? pendingMoves(this.state) : [];
    if (still.length) {
      const msg = `${still.length} move(s) not confirmed by the server. Retry, or drag the blank(s) yourself.`;
      this.diag('error', msg);
      this.bridge.send({ type: 'seq', seq: 'activate', step: 'Stuck', pct: 0.5, error: msg });
    }
  }

  private sendReveal(ownerId: string, pack: RolledPackRecord, isOwner: boolean): void {
    const cards: OfferCard[] = pack.cards.map((ref) => ({ ref, identity: identityFor(ref) ?? placeholderIdentity(ref) }));
    for (const c of cards) prefetch(c.identity.front_image_uri);
    const ownerName = isOwner ? 'You' : (this.zones.players.get(ownerId)?.name || ownerId.slice(0, 8));
    this.bridge.send({ type: 'reveal', ownerId, ownerName, isOwner, pack, cards });
  }

  private pushOffer(): void {
    const s = this.state;
    if (!s?.activation || s.activation.phase !== 'viewing') return;
    const offer: OfferCard[] = s.activation.look.map((ref) => ({ ref, identity: identityFor(ref) ?? placeholderIdentity(ref) }));
    for (const o of offer) prefetch(o.identity.front_image_uri);
    this.bridge.send({ type: 'offer', activation: s.activation, offer, pileSize: s.pile.length, blanksLeft: s.reservoir.length });
  }

  // ------------------------------------------------------------------ bridge pushes

  private pushAll(): void {
    // Socket events sent before the handshake are buffered by the bridge, so no replay here.
    this.bridge.send({ type: 'phase', phase: this.phase });
    this.pushState();
    this.pushOffer();
    this.bridge.send({ type: 'peers', peers: Object.values(this.peers) });
    this.scheduleZones();
  }

  private pushState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.bridge.send({ type: 'state', state: this.state });
    }, 0);
  }

  private scheduleZones(): void {
    if (this.zonesTimer) return;
    this.zonesTimer = setTimeout(() => {
      this.zonesTimer = null;
      this.bridge.send({
        type: 'zones',
        snapshot: { cards: this.zones.snapshot(), localPlayerId: this.localId, players: [...this.zones.players.values()] },
      });
    }, 250);
  }

  private diag(level: Diag['level'], msg: string, data?: unknown): void {
    const d: Diag = { level, msg, data, at: Date.now() };
    if (level !== 'info') console[level === 'error' ? 'error' : 'warn']('[HoK]', msg, data ?? '');
    this.bridge.send({ type: 'diag', diag: d });
  }
}

function stripSynthetic(msg: Record<string, unknown>): Record<string, unknown> {
  const { hok_synthetic: _s, ...rest } = msg;
  return rest;
}

function placeholderIdentity(ref: CardRef): CardIdentity {
  return { card_id: `hok-card-${ref}`, card_print_id: `hok-${ref}`, name: ref, type_line: '', front_image_uri: '', back_image_uri: null, can_rotate: false, power: null, toughness: null };
}

function prefetch(url: string): void {
  if (!url) return;
  try {
    const img = new Image();
    img.src = url;
  } catch {
    /* ignore */
  }
}

function safeLocalStorage(win: Window): Storage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { Zone };
