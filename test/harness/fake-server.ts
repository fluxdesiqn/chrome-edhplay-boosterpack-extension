/**
 * In-memory edhplay game server (protocol version 4) for end-to-end scenarios.
 *
 * Holds the room state, answers the client actions the extension sends with the
 * echoes the real simulator produces, and redacts hidden zones per recipient.
 * Every received action is appended to `log`; every chat line to `chat`.
 * Echoes are delivered on a microtask (like a real socket) in FIFO order.
 */
import type { WireCard } from '@shared/protocol';
import { FakeWs } from './fake-ws';

export type ServerZone = 'hand' | 'library' | 'graveyard' | 'exile' | 'battlefield' | 'commandZone';
export const SERVER_ZONES: readonly ServerZone[] = ['hand', 'library', 'graveyard', 'exile', 'battlefield', 'commandZone'];
const HIDDEN: readonly ServerZone[] = ['hand', 'library'];
/** Actions the live server refuses while the player's mulligan decision is pending. */
const MULLIGAN_GATED = ['view_library', 'reorder_viewed_cards', 'batch_move_cards', 'exile_x_cards', 'draw_x_cards', 'draw_card', 'move_card', 'move_to_library_position'];
export const MULLIGAN_VIEW_ERROR = "You can't view your library during the mulligan phase";
export const MULLIGAN_PENDING_ERROR = 'Finish your mulligan decision first';

export interface ServerPlayer {
  id: string;
  username: string;
  /** pristine deck, in submitted order (index 0 = first card dealt) */
  deck: WireCard[];
  zones: Record<ServerZone, WireCard[]>;
  /** stock mulligan dialog answered (Keep) */
  mulliganDecisionMade: boolean;
  mulliganCount: number;
}

export interface LogEntry {
  playerId: string;
  msg: Record<string, unknown>;
}

export interface ChatEntry {
  playerId: string;
  message: string;
}

type Frame = Record<string, unknown>;

export class FakeServer {
  readonly roomId: string;
  readonly players = new Map<string, ServerPlayer>();
  readonly sockets = new Map<string, FakeWs>();
  /** every client action, in receipt order */
  readonly log: LogEntry[] = [];
  /** every chat line, in receipt order */
  readonly chat: ChatEntry[] = [];
  /** every frame emitted, per recipient (debugging aid) */
  readonly outbox = new Map<string, Frame[]>();
  /** actions the server has no handler for */
  readonly unhandled: LogEntry[] = [];
  /**
   * `mulliganGate`: mirror the live server, which refuses library actions from a
   * player whose stock mulligan decision is still pending (false by default so
   * scenarios written before the gate keep working; call `keepHand()` first when on).
   */
  readonly options = { rejectReorder: false, handSize: 7, mulliganGate: true };

  turnSeq = 1;
  mulliganPhaseActive = false;
  currentTurnPlayerId: string | null = null;

  private rng = 0x2545f491;
  private idSeq = 0;
  private csSeq = 0;

  constructor(roomId = 'room-1') {
    this.roomId = roomId;
  }

  // ------------------------------------------------------------------ setup

  /** Deals the first `handSize` cards to the hand, the rest to the library (deck order preserved). */
  addPlayer(id: string, username: string, deck: WireCard[]): ServerPlayer {
    const p: ServerPlayer = { id, username, deck: clone(deck), zones: emptyZones(), mulliganDecisionMade: false, mulliganCount: 0 };
    this.players.set(id, p);
    this.deal(p);
    if (!this.currentTurnPlayerId) this.currentTurnPlayerId = id;
    if (this.options.mulliganGate) this.recomputeMulliganPhase();
    return p;
  }

  /**
   * The player pressed Keep in the stock dialog: the decision is made, the room's
   * mulligan phase closes once nobody is left undecided, and everyone hears `hand_kept`.
   */
  keepHand(playerId: string, cardsToBottom: string[] = []): void {
    const p = this.player(playerId);
    const moved: WireCard[] = [];
    for (const id of cardsToBottom) {
      const taken = this.take(p, id);
      if (!taken) continue;
      taken.card.zone = 'library';
      p.zones.library.push(taken.card);
      moved.push(taken.card);
    }
    if (moved.length > 0) {
      const base = { type: 'cards_moved', player_id: p.id, to_zone: 'library', from_zone: 'hand', card_ids: moved.map((c) => c.id), count: moved.length, position: -1 };
      this.broadcast((viewer) => (viewer === p.id ? { ...base, cards: moved } : base));
    }
    p.mulliganDecisionMade = true;
    this.recomputeMulliganPhase();
    this.broadcast(() => ({ type: 'hand_kept', player_id: p.id, mulligan_phase_active: this.mulliganPhaseActive, hand_count: p.zones.hand.length, library_count: p.zones.library.length }));
  }

  /** `mulligan_phase_active` stays true until every player in the room has decided. */
  private recomputeMulliganPhase(): void {
    this.mulliganPhaseActive = [...this.players.values()].some((p) => !p.mulliganDecisionMade);
  }

  private mulliganPending(p: ServerPlayer): boolean {
    return this.options.mulliganGate && !p.mulliganDecisionMade;
  }

  urlFor(playerId: string, pv: number | string = 4): string {
    this.csSeq += 1;
    return `wss://api.edhplay.com/ws/game?room_id=${this.roomId}&token=tok-${playerId}&pv=${pv}&cs=cs-${this.csSeq}`;
  }

  /** Attach a (tapped) socket for `playerId`: open it, send ping + a redacted game_state. */
  connect(ws: FakeWs, playerId: string): FakeWs {
    const p = this.player(playerId);
    const u = new URL(ws.url);
    const pv = Number(u.searchParams.get('pv') ?? '4');
    this.sockets.set(p.id, ws);
    ws.onSend = (text) => this.receive(p.id, text);
    ws.addEventListener('close', () => {
      if (this.sockets.get(p.id) === ws) this.sockets.delete(p.id);
    });
    ws.open();
    this.emit(p.id, { type: 'ping', interval: 30 });
    this.emit(p.id, this.gameStateFor(p.id, pv));
    return ws;
  }

  disconnect(playerId: string): void {
    const ws = this.sockets.get(playerId);
    this.sockets.delete(playerId);
    ws?.close();
  }

  /** Construct a fresh socket through `Ctor` (normally the tapped `win.WebSocket`) and connect it. */
  reconnect(playerId: string, Ctor: new (url: string) => unknown, pv: number | string = 4): FakeWs {
    new Ctor(this.urlFor(playerId, pv));
    return this.connect(FakeWs.last(), playerId);
  }

  /** Re-deal every player from their pristine deck and announce a new game. */
  newGame(): void {
    for (const p of this.players.values()) {
      p.zones = emptyZones();
      p.mulliganDecisionMade = false;
      p.mulliganCount = 0;
      this.deal(p);
    }
    this.turnSeq = 1;
    this.mulliganPhaseActive = true;
    this.broadcast(() => ({
      type: 'new_game_started',
      mulligan_phase_active: true,
      current_turn_player_id: this.currentTurnPlayerId,
      turn_seq: this.turnSeq,
      turn_phase: 'main_1',
    }));
    for (const id of this.sockets.keys()) this.emit(id, this.gameStateFor(id));
  }

  // ------------------------------------------------------------------ queries

  player(id: string): ServerPlayer {
    const p = this.players.get(id);
    if (!p) throw new Error(`FakeServer: unknown player ${id}`);
    return p;
  }

  zone(playerId: string, zone: ServerZone): WireCard[] {
    return this.player(playerId).zones[zone];
  }

  /** Non-chat actions of one player (or everyone), in order. */
  actions(playerId?: string): Frame[] {
    return this.log.filter((e) => (!playerId || e.playerId === playerId) && e.msg['type'] !== 'send_chat_message' && e.msg['type'] !== 'pong').map((e) => e.msg);
  }

  actionTypes(playerId?: string): string[] {
    return this.actions(playerId).map((m) => String(m['type']));
  }

  actionsOf(type: string, playerId?: string): Frame[] {
    return this.actions(playerId).filter((m) => m['type'] === type);
  }

  /** Index in `log` of the first entry matching `pred`, or -1. */
  logIndex(pred: (e: LogEntry) => boolean, from = 0): number {
    for (let i = from; i < this.log.length; i++) if (pred(this.log[i]!)) return i;
    return -1;
  }

  /** Chat lines carrying a `[HoK1] {"t":"<t>"` sync message. */
  syncLines(t: string, playerId?: string): ChatEntry[] {
    const prefix = `[HoK1] {"t":"${t}"`;
    return this.chat.filter((c) => (!playerId || c.playerId === playerId) && c.message.startsWith(prefix));
  }

  gameStateFor(viewerId: string, pv: number | string = 4): Frame {
    const players = [...this.players.values()].map((p) => {
      const own = p.id === viewerId;
      return {
        player_id: p.id,
        username: p.username,
        ...(own ? { hand: p.zones.hand, library: p.zones.library } : {}),
        revealed_hand_cards: [],
        revealed_library_cards: [],
        battlefield: p.zones.battlefield,
        graveyard: p.zones.graveyard,
        exile: p.zones.exile,
        commandZone: p.zones.commandZone,
        companionZone: [],
        stickerZone: [],
        attractionZone: [],
        hand_count: p.zones.hand.length,
        library_count: p.zones.library.length,
        deck_submitted: true,
        mulligan_decision_made: p.mulliganDecisionMade,
        mulligan_count: p.mulliganCount,
        eliminated: false,
      };
    });
    return {
      type: 'game_state',
      protocol_version: Number(pv),
      players,
      connected_player_ids: [...this.sockets.keys()],
      current_turn_player_id: this.currentTurnPlayerId,
      round_count: 1,
      turn_seq: this.turnSeq,
      turn_phase: 'main_1',
      mulligan_phase_active: this.mulliganPhaseActive,
      owner_player_id: [...this.players.keys()][0] ?? null,
      spectator_count: 0,
      stack: [],
    };
  }

  // ------------------------------------------------------------------ inbound

  private receive(playerId: string, text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return;
    const m = msg as Frame;
    if (typeof m['type'] !== 'string') return;
    this.log.push({ playerId, msg: m });
    this.handle(playerId, m);
  }

  private handle(pid: string, msg: Frame): void {
    const p = this.player(pid);
    const z = p.zones;
    const type = String(msg['type']);
    if (MULLIGAN_GATED.includes(type) && this.mulliganPending(p)) {
      this.emit(pid, { type: 'error', message: type === 'view_library' ? MULLIGAN_VIEW_ERROR : MULLIGAN_PENDING_ERROR });
      return;
    }
    switch (type) {
      case 'pong':
        return;

      case 'keep_hand': {
        const ids = Array.isArray(msg['cards_to_bottom']) ? (msg['cards_to_bottom'] as unknown[]).map(String) : [];
        this.keepHand(pid, ids);
        return;
      }

      case 'resync':
        this.emit(pid, this.gameStateFor(pid));
        return;

      case 'view_library': {
        const base = { type: 'library_viewed', player_id: pid, target_player_id: pid, location: 'all', count: null, view_count: 0 };
        this.broadcast((viewer) => (viewer === pid ? { ...base, viewed_library_cards: z.library } : base));
        return;
      }

      case 'clear_library_viewing':
        this.broadcast(() => ({ type: 'library_viewing_cleared', player_id: pid }));
        return;

      case 'reorder_viewed_cards': {
        const ids = (msg['card_ids'] as string[] | undefined) ?? [];
        const byId = new Map(z.library.map((c) => [c.id, c]));
        const sameSet = ids.length === byId.size && new Set(ids).size === ids.length && ids.every((id) => byId.has(id));
        if (this.options.rejectReorder || !sameSet) {
          this.emit(pid, { type: 'error', message: 'bad reorder' });
          return;
        }
        z.library = ids.map((id) => byId.get(id)!);
        this.broadcast(() => ({ type: 'viewed_cards_reordered', player_id: pid, position: 'top', count: ids.length, ordered: true }));
        return;
      }

      case 'batch_move_cards': {
        const items = (msg['items'] as Array<{ id: string; zone: ServerZone; to?: number }> | undefined) ?? [];
        const first = items[0];
        if (!first) return;
        const toZone = first.zone;
        const bottom = first.to === -1;
        const moved: WireCard[] = [];
        let fromZone: ServerZone | null = null;
        for (const it of items) {
          const taken = this.take(p, it.id);
          if (!taken) continue;
          fromZone ??= taken.from;
          moved.push(taken.card);
        }
        for (const c of moved) c.zone = toZone;
        z[toZone] = bottom ? [...z[toZone], ...moved] : [...moved, ...z[toZone]];
        const shuffled = msg['shuffle'] === true && toZone === 'library';
        if (shuffled) z.library = this.shuffle(z.library);
        const base = { type: 'cards_moved', player_id: pid, to_zone: toZone, from_zone: fromZone, card_ids: moved.map((c) => c.id), count: moved.length, position: bottom ? -1 : 0, ...(shuffled ? { shuffled: true } : {}) };
        this.broadcast((viewer) => (viewer !== pid && HIDDEN.includes(toZone) ? base : { ...base, cards: moved }));
        return;
      }

      case 'move_to_library_position': {
        // Card context menu → Library top (0) / bottom (-1).
        const id = String(msg['id']);
        const position = Number(msg['position'] ?? 0);
        const taken = this.take(p, id);
        if (!taken) {
          this.emit(pid, { type: 'error', message: `card ${id} not found` });
          return;
        }
        this.put(p, taken.card, 'library', position < 0 ? undefined : position);
        // The zone index does not know `move_to_library_position`; a `cards_moved` echo keeps it in step.
        const moved = { type: 'cards_moved', player_id: pid, to_zone: 'library', from_zone: taken.from, card_ids: [id], count: 1, position };
        this.broadcast((viewer) => (viewer === pid ? { ...moved, cards: [taken.card] } : moved));
        this.broadcast(() => ({ type: 'move_to_library_position', player_id: pid, id, position, from_zone: taken.from }));
        return;
      }

      case 'move_card': {
        const id = String(msg['id']);
        const zone = msg['zone'] as ServerZone;
        const to = msg['to'];
        const updates = (msg['updates'] as Partial<WireCard> | undefined) ?? {};
        const taken = this.take(p, id);
        if (!taken) {
          this.emit(pid, { type: 'error', message: `card ${id} not found` });
          return;
        }
        const card = taken.card;
        Object.assign(card, updates);
        if (typeof to === 'object' && to !== null) {
          const xy = to as { x?: number; y?: number };
          if (typeof xy.x === 'number') card.x = xy.x;
          if (typeof xy.y === 'number') card.y = xy.y;
        }
        this.put(p, card, zone, typeof to === 'number' ? to : undefined);
        const base = { type: 'move_card', player_id: pid, from_player_id: pid, id, zone, from_zone: taken.from, to, updates };
        this.broadcast((viewer) => (viewer !== pid && HIDDEN.includes(zone) ? base : { ...base, card }));
        return;
      }

      case 'exile_x_cards': {
        const n = Number(msg['count'] ?? 1);
        const faceDown = msg['face_down'] === true;
        const taken = z.library.splice(0, n);
        for (const c of taken) {
          c.zone = 'exile';
          if (faceDown) c.visibility = 'face_down';
        }
        const rev = [...taken].reverse();
        z.exile = [...rev, ...z.exile];
        this.broadcast(() => ({ type: 'cards_moved', player_id: pid, to_zone: 'exile', from_zone: 'library', cards: rev, count: rev.length, face_down: faceDown }));
        return;
      }

      case 'draw_card':
      case 'draw_x_cards': {
        const n = msg['type'] === 'draw_card' ? 1 : Number(msg['count'] ?? 1);
        const taken = z.library.splice(0, n);
        for (const c of taken) c.zone = 'hand';
        z.hand = [...taken, ...z.hand];
        const base = { type: 'cards_moved', player_id: pid, to_zone: 'hand', from_zone: 'library', count: taken.length };
        this.broadcast((viewer) => (viewer === pid ? { ...base, cards: taken, card_ids: taken.map((c) => c.id) } : base));
        return;
      }

      case 'shuffle_library':
        z.library = this.shuffle(z.library);
        this.broadcast(() => ({ type: 'library_shuffled', player_id: pid }));
        return;

      case 'send_chat_message': {
        const message = String(msg['message'] ?? '');
        this.chat.push({ playerId: pid, message });
        this.broadcast(() => ({ type: 'chat_message_received', player_id: pid, username: p.username, message, timestamp: Date.now() }));
        return;
      }

      case 'create_card': {
        const print = String(msg['card_print_id']);
        const card: WireCard = {
          id: this.newId(),
          card_id: `card-${print}`,
          card_print_id: print,
          name: `Sideboard ${print}`,
          type_line: '',
          front_image_uri: `https://cards.edhplay.com/${print}.jpg`,
          back_image_uri: null,
          can_rotate: false,
          is_token: false,
          from_sideboard: true,
          owner_id: pid,
          zone: 'battlefield',
          x: 0.1,
          y: 0.1,
          tapped: false,
          visibility: 'default',
          power: null,
          toughness: null,
        };
        z.battlefield.push(card);
        this.broadcast(() => ({ type: 'card_created', player_id: pid, token: card }));
        return;
      }

      case 'make_token_copy': {
        const srcId = String(msg['card_id']);
        let src: WireCard | null = null;
        for (const other of this.players.values()) src ??= this.find(other, srcId)?.card ?? null;
        if (!src) {
          this.emit(pid, { type: 'error', message: `card ${srcId} not found` });
          return;
        }
        const token: WireCard = { ...clone([src])[0]!, id: this.newId(), is_token: true, owner_id: pid, zone: 'battlefield', x: (src.x ?? 0.1) + 0.02, y: (src.y ?? 0.1) + 0.02 };
        z.battlefield.push(token);
        this.broadcast(() => ({ type: 'card_created', player_id: pid, token }));
        return;
      }

      case 'pass_turn': {
        const ids = [...this.players.keys()];
        const i = ids.indexOf(this.currentTurnPlayerId ?? '');
        this.currentTurnPlayerId = ids[(i + 1) % ids.length] ?? null;
        this.turnSeq += 1;
        this.broadcast(() => ({ type: 'turn_passed', new_turn_player_id: this.currentTurnPlayerId, turn_seq: this.turnSeq, round_count: 1, phase: 'main_1' }));
        return;
      }

      default:
        this.unhandled.push({ playerId: pid, msg });
    }
  }

  // ------------------------------------------------------------------ outbound

  private emit(playerId: string, frame: Frame): void {
    const ws = this.sockets.get(playerId);
    if (!ws || ws.readyState !== FakeWs.OPEN) return;
    const snapshot = JSON.parse(JSON.stringify(frame)) as Frame; // freeze the payload at send time
    let box = this.outbox.get(playerId);
    if (!box) this.outbox.set(playerId, (box = []));
    box.push(snapshot);
    void Promise.resolve().then(() => {
      if (ws.readyState === FakeWs.OPEN) ws.serverEmit(snapshot);
    });
  }

  private broadcast(build: (viewerId: string) => Frame): void {
    for (const id of this.sockets.keys()) this.emit(id, build(id));
  }

  // ------------------------------------------------------------------ state helpers

  private deal(p: ServerPlayer): void {
    const all = clone(p.deck);
    const commanders = all.filter((c) => c.zone === 'commandZone');
    const cards = all.filter((c) => c.zone !== 'commandZone');
    const n = this.options.handSize;
    p.zones.hand = cards.slice(0, n);
    p.zones.library = cards.slice(n);
    p.zones.commandZone = commanders;
    for (const c of p.zones.hand) c.zone = 'hand';
    for (const c of p.zones.library) c.zone = 'library';
  }

  private find(p: ServerPlayer, id: string): { card: WireCard; from: ServerZone; index: number } | null {
    for (const zone of SERVER_ZONES) {
      const index = p.zones[zone].findIndex((c) => c.id === id);
      if (index >= 0) return { card: p.zones[zone][index]!, from: zone, index };
    }
    return null;
  }

  private take(p: ServerPlayer, id: string): { card: WireCard; from: ServerZone } | null {
    const hit = this.find(p, id);
    if (!hit) return null;
    p.zones[hit.from].splice(hit.index, 1);
    return { card: hit.card, from: hit.from };
  }

  private put(p: ServerPlayer, card: WireCard, zone: ServerZone, position?: number): void {
    card.zone = zone;
    const list = p.zones[zone];
    if (position === undefined || position < 0 || position >= list.length) list.push(card);
    else list.splice(position, 0, card);
  }

  private shuffle<T>(arr: T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i >= 1; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** mulberry32: deterministic across runs */
  private random(): number {
    this.rng = (this.rng + 0x6d2b79f5) | 0;
    let t = this.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private newId(): string {
    this.idSeq += 1;
    return `11111111-0000-4000-8000-${this.idSeq.toString(16).padStart(12, '0')}`;
  }
}

function emptyZones(): Record<ServerZone, WireCard[]> {
  return { hand: [], library: [], graveyard: [], exile: [], battlefield: [], commandZone: [] };
}

function clone(cards: WireCard[]): WireCard[] {
  return JSON.parse(JSON.stringify(cards)) as WireCard[];
}
