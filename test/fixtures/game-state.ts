/**
 * Builders for realistic edhplay wire payloads (pv = 4) used by the unit tests.
 * Ids are deterministic uuid-shaped strings from a counter so tests are stable.
 */
import type { GameStateEvent, WireCard, WirePlayer, Zone } from '@shared/protocol';

let counter = 0;

/** Reset the id counter (call in beforeEach for reproducible ids). */
export function resetIds(): void {
  counter = 0;
}

/** Deterministic uuid-like id: 00000000-0000-4000-8000-000000000001, … */
export function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}

export const WASTES_PRINT_ID = 'print-wastes-oath-of-the-gatewatch';
export const WASTES_CARD_ID = 'card-wastes';
export const PLAINS_PRINT_ID = 'print-plains-m21';
export const PLAINS_CARD_ID = 'card-plains';
export const IMG = 'https://cards.edhplay.com/';

export function makeCard(overrides: Partial<WireCard> = {}): WireCard {
  const id = overrides.id ?? uuid();
  return {
    id,
    card_id: 'card-generic',
    card_print_id: 'print-generic',
    name: 'Generic Creature',
    type_line: 'Creature — Human Wizard',
    front_image_uri: `${IMG}generic.jpg`,
    back_image_uri: null,
    can_rotate: false,
    is_token: false,
    from_sideboard: false,
    tapped: false,
    rotated: false,
    visibility: 'default',
    custom_counters: {},
    power: '2',
    toughness: '2',
    power_modifier: 0,
    toughness_modifier: 0,
    attached_to: null,
    ...overrides,
  };
}

/** `n` copies of a basic land sharing one print id. */
export function makeBasic(
  n: number,
  name: string,
  ownerId: string,
  zone: Zone,
  ids: { printId: string; cardId: string } = { printId: `print-${name.toLowerCase()}`, cardId: `card-${name.toLowerCase()}` },
): WireCard[] {
  const out: WireCard[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      makeCard({
        card_id: ids.cardId,
        card_print_id: ids.printId,
        name,
        type_line: `Basic Land — ${name === 'Wastes' ? '' : name}`.trimEnd(),
        front_image_uri: `${IMG}${name.toLowerCase()}.jpg`,
        power: null,
        toughness: null,
        owner_id: ownerId,
        zone,
      }),
    );
  }
  return out;
}

export function makeWastes(n: number, ownerId: string, zone: Zone): WireCard[] {
  return makeBasic(n, 'Wastes', ownerId, zone, { printId: WASTES_PRINT_ID, cardId: WASTES_CARD_ID });
}

export function makePlains(n: number, ownerId: string, zone: Zone): WireCard[] {
  return makeBasic(n, 'Plains', ownerId, zone, { printId: PLAINS_PRINT_ID, cardId: PLAINS_CARD_ID });
}

/** `n` distinct "real" (non-blank) cards. */
export function makeReal(n: number, ownerId: string, zone: Zone): WireCard[] {
  const out: WireCard[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      makeCard({
        card_id: `card-real-${i}`,
        card_print_id: `print-real-${i}`,
        name: `Real Card ${i}`,
        owner_id: ownerId,
        zone,
      }),
    );
  }
  return out;
}

export interface OpponentOpts {
  username?: string;
  handCount?: number;
  libraryCount?: number;
  battlefield?: number;
  graveyard?: number;
}

/** A remote player: public zones only, hidden zones as counts. */
export function makeOpponent(playerId: string, opts: OpponentOpts = {}): WirePlayer {
  const bf = makeReal(opts.battlefield ?? 2, playerId, 'battlefield');
  return {
    player_id: playerId,
    username: opts.username ?? `user-${playerId}`,
    battlefield: bf,
    graveyard: makeReal(opts.graveyard ?? 1, playerId, 'graveyard'),
    exile: [],
    commandZone: [makeCard({ name: 'Commander', type_line: 'Legendary Creature — Spirit', owner_id: playerId, zone: 'commandZone' })],
    companionZone: [],
    stickerZone: [],
    attractionZone: [],
    revealed_hand_cards: [],
    revealed_library_cards: [],
    hand_count: opts.handCount ?? 7,
    library_count: opts.libraryCount ?? 92,
    deck_submitted: true,
    mulligan_decision_made: true,
    mulligan_count: 0,
    eliminated: false,
  };
}

export interface GameStateOpts {
  me: string;
  opponents?: string[];
  /** blanks dealt into my hand */
  wastesInHand?: number;
  /** blanks in my library */
  wastesInLibrary?: number;
  /** real cards in my library (appended after the blanks) */
  realCards?: number;
  /** real cards in my hand */
  realInHand?: number;
  /** extra cards appended to my library (e.g. a second basic land) */
  extraLibrary?: WireCard[];
  /** whether the payload carries my `library` array (default true); `library_count` is always set */
  includeLibrary?: boolean;
  mulliganActive?: boolean;
  deckSubmitted?: boolean;
  decisionMade?: boolean;
  currentTurnPlayerId?: string | null;
  turnPhase?: string | null;
  turnSeq?: number;
  roundCount?: number;
  myBattlefield?: WireCard[];
}

export interface BuiltGameState {
  event: GameStateEvent;
  hand: WireCard[];
  library: WireCard[];
}

export function buildGameState(opts: GameStateOpts): BuiltGameState {
  const me = opts.me;
  const hand = [...makeWastes(opts.wastesInHand ?? 0, me, 'hand'), ...makeReal(opts.realInHand ?? 0, me, 'hand')];
  const library = [
    ...makeWastes(opts.wastesInLibrary ?? 0, me, 'library'),
    ...makeReal(opts.realCards ?? 0, me, 'library'),
    ...(opts.extraLibrary ?? []),
  ];
  const includeLibrary = opts.includeLibrary ?? true;
  const mine: WirePlayer = {
    player_id: me,
    username: `user-${me}`,
    hand,
    ...(includeLibrary ? { library } : {}),
    revealed_hand_cards: [],
    revealed_library_cards: [],
    battlefield: opts.myBattlefield ?? [],
    graveyard: [],
    exile: [],
    commandZone: [],
    companionZone: [],
    stickerZone: [],
    attractionZone: [],
    hand_count: hand.length,
    library_count: library.length,
    deck_submitted: opts.deckSubmitted ?? true,
    mulligan_decision_made: opts.decisionMade ?? false,
    mulligan_count: 0,
    eliminated: false,
  };
  const opponents = (opts.opponents ?? []).map((id) => makeOpponent(id));
  const players = [mine, ...opponents];
  const event: GameStateEvent = {
    type: 'game_state',
    protocol_version: 4,
    players,
    connected_player_ids: players.map((p) => p.player_id),
    current_turn_player_id: opts.currentTurnPlayerId === undefined ? me : opts.currentTurnPlayerId,
    round_count: opts.roundCount ?? 1,
    turn_seq: opts.turnSeq ?? 1,
    turn_phase: opts.turnPhase === undefined ? 'main_1' : opts.turnPhase,
    mulligan_phase_active: opts.mulliganActive ?? false,
    owner_player_id: me,
    spectator_count: 0,
    stack: [],
  };
  return { event, hand, library };
}

/** Shorthand returning just the `game_state` payload. */
export function makeGameState(opts: GameStateOpts): GameStateEvent {
  return buildGameState(opts).event;
}

/** `mulligan` echo: the owner receives the fresh hand and the reshuffled library. */
export function makeMulligan(playerId: string, opts: { wastesInHand?: number; realInHand?: number; wastesInLibrary?: number; realCards?: number } = {}) {
  const hand = [...makeWastes(opts.wastesInHand ?? 0, playerId, 'hand'), ...makeReal(opts.realInHand ?? 0, playerId, 'hand')];
  const library = [...makeWastes(opts.wastesInLibrary ?? 0, playerId, 'library'), ...makeReal(opts.realCards ?? 0, playerId, 'library')];
  return { type: 'mulligan' as const, player_id: playerId, hand, library, mulligan_count: 1 };
}
