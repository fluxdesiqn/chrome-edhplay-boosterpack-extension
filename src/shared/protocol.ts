/**
 * edhplay game protocol (pv = 4) — the subset this extension reads or sends.
 *
 * Every OUTBOUND message the extension sends corresponds to a gesture the stock
 * UI can perform; the equivalent gesture is documented next to each type so the
 * "interface-equivalent" rule from the plan stays auditable.
 */

/** The protocol version this build was verified against in a live room. */
export const PROTOCOL_VERSION = 4;
/**
 * Versions known to work. Any other version is still accepted when its frames
 * have the shape the extension depends on (see `gameStateProblems` and
 * `frameProblems`), so a version bump that changes nothing we use is harmless.
 */
export const TESTED_PROTOCOL_VERSIONS: readonly number[] = [PROTOCOL_VERSION];
export const GAME_WS_HOST = 'api.edhplay.com';
export const GAME_WS_PATH = '/ws/game';

export type Zone =
  | 'hand'
  | 'library'
  | 'graveyard'
  | 'exile'
  | 'commandZone'
  | 'companionZone'
  | 'battlefield'
  | 'stickerZone'
  | 'attractionZone';

export const PUBLIC_ZONES: readonly Zone[] = ['battlefield', 'graveyard', 'exile', 'commandZone', 'companionZone', 'stickerZone'];
export const HIDDEN_ZONES: readonly Zone[] = ['hand', 'library', 'attractionZone'];
export const ALL_ZONES: readonly Zone[] = [...PUBLIC_ZONES, ...HIDDEN_ZONES];

export type Visibility =
  | 'default'
  | 'face_down'
  | 'flipped'
  | 'revealed'
  | { revealed_to: string[] }
  | { base: 'default' | 'face_down' | 'flipped'; revealed_to: string[] };

/** Card object as it travels on the wire. Fields marked optional are not always present. */
export interface WireCard {
  id: string;
  card_id?: string;
  card_print_id?: string;
  name?: string;
  type_line?: string;
  front_image_uri?: string;
  back_image_uri?: string | null;
  can_rotate?: boolean;
  is_token?: boolean;
  from_sideboard?: boolean;
  owner_id?: string;
  zone?: Zone;
  x?: number;
  y?: number;
  tapped?: boolean;
  rotated?: boolean;
  visibility?: Visibility;
  custom_counters?: Record<string, unknown>;
  power?: string | null;
  toughness?: string | null;
  power_modifier?: number;
  toughness_modifier?: number;
  attached_to?: string | null;
  drawn_turn?: number;
  drawn_ordinal?: number;
  [extra: string]: unknown;
}

export interface WirePlayer {
  player_id: string;
  username?: string;
  hand?: WireCard[];
  library?: WireCard[];
  revealed_hand_cards?: WireCard[];
  revealed_library_cards?: WireCard[];
  battlefield?: WireCard[];
  graveyard?: WireCard[];
  exile?: WireCard[];
  commandZone?: WireCard[];
  companionZone?: WireCard[];
  stickerZone?: WireCard[];
  attractionZone?: WireCard[];
  hand_count?: number;
  library_count?: number;
  deck_submitted?: boolean;
  mulligan_decision_made?: boolean;
  mulligan_count?: number;
  eliminated?: boolean;
  library_top_card?: WireCard;
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Inbound events (server → client). Only the fields we read are typed.
// ---------------------------------------------------------------------------

export interface GameStateEvent {
  type: 'game_state';
  protocol_version: number;
  players: WirePlayer[];
  connected_player_ids?: string[];
  current_turn_player_id?: string | null;
  round_count?: number;
  turn_seq?: number;
  turn_phase?: string | null;
  mulligan_phase_active?: boolean;
  owner_player_id?: string;
  spectator_count?: number;
  stack?: Array<{ card_id?: string; card?: WireCard; [k: string]: unknown }>;
  [extra: string]: unknown;
}

export interface MoveCardEvent {
  type: 'move_card';
  player_id: string;
  from_player_id?: string;
  id: string;
  zone: Zone;
  from_zone?: Zone;
  to?: number | { x: number; y: number };
  updates?: Partial<WireCard>;
  card?: WireCard;
  [extra: string]: unknown;
}

export interface CardsMovedEvent {
  type: 'cards_moved';
  player_id?: string;
  to_zone?: Zone;
  from_zone?: Zone;
  cards?: WireCard[];
  card_ids?: string[];
  count?: number;
  position?: number;
  face_down?: boolean;
  shuffled?: boolean;
  moves?: MoveCardEvent[];
  removed_token_ids?: string[];
  library_top_card_id?: string;
  [extra: string]: unknown;
}

export interface LibraryViewedEvent {
  type: 'library_viewed';
  player_id: string;
  target_player_id?: string;
  location?: 'top' | 'bottom' | 'all';
  count?: number | null;
  view_count?: number;
  viewed_library_cards?: WireCard[];
  [extra: string]: unknown;
}

export interface ChatMessageEvent {
  type: 'chat_message_received';
  player_id: string;
  message: string;
  [extra: string]: unknown;
}

export interface TurnPassedEvent {
  type: 'turn_passed';
  new_turn_player_id?: string | null;
  round_count?: number;
  turn_seq?: number;
  phase?: string;
  mulligan_phase_active?: boolean;
  [extra: string]: unknown;
}

export interface GenericEvent {
  type: string;
  player_id?: string;
  [extra: string]: unknown;
}

export type InboundEvent =
  | GameStateEvent
  | MoveCardEvent
  | CardsMovedEvent
  | LibraryViewedEvent
  | ChatMessageEvent
  | TurnPassedEvent
  | GenericEvent;

// ---------------------------------------------------------------------------
// Outbound actions (client → server) that the extension may emit.
// ---------------------------------------------------------------------------

/** Stock card updates the UI attaches when moving a card into a non-battlefield zone. */
export function stockNonBattlefieldUpdates(visibility: 'default' | 'face_down' = 'default') {
  return { tapped: false, visibility, power_modifier: 0, toughness_modifier: 0, custom_counters: {} } as const;
}

export type OutboundAction =
  /** UI gesture: drag a card onto a zone (or use the card context menu). */
  | { type: 'move_card'; id: string; zone: Zone; to?: number | { x: number; y: number }; updates?: Record<string, unknown>; target_player_id?: string }
  /** UI gesture: multi-select cards → "Move to …" (or pile menu → "Move all to …"). */
  | { type: 'batch_move_cards'; items: Array<{ id: string; zone: Zone; to?: number }>; target_player_id?: string; shuffle?: boolean }
  /** UI gesture: library menu → View all. */
  | { type: 'view_library'; location: 'top' | 'bottom' | 'all'; count: number | null; target_player_id?: string }
  /** UI gesture: drag-reorder inside the library viewer. */
  | { type: 'reorder_viewed_cards'; card_ids: string[] }
  /** UI gesture: close the library viewer. */
  | { type: 'clear_library_viewing'; target_player_id?: string }
  /** UI gesture: library menu → Exile top X (face down). */
  | { type: 'exile_x_cards'; count: number; face_down: boolean }
  /** UI gesture: library menu → Draw X. */
  | { type: 'draw_x_cards'; count: number }
  /** UI gesture: press the draw shortcut / click the library. */
  | { type: 'draw_card' }
  /** UI gesture: library menu → Shuffle. */
  | { type: 'shuffle_library' }
  /** UI gesture: card context menu → Library top (0) / Library bottom (-1). */
  | { type: 'move_to_library_position'; id: string; position: number }
  /** UI gesture: the Keep button of the mulligan dialog (cards chosen for the bottom, in order). */
  | { type: 'keep_hand'; cards_to_bottom: string[] }
  /** UI gesture: type into the chat box. */
  | { type: 'send_chat_message'; message: string }
  /** UI gesture: create card dialog → Sideboard tab. */
  | { type: 'create_card'; card_print_id: string }
  /** UI gesture: create card dialog → Tokens tab → pick a card (the client sends the whole card). */
  | { type: 'create_card'; card: WireCard }
  /** Stock client action the app itself issues when it detects inconsistency. */
  | { type: 'resync' }
  | { type: 'pong' };

/** Card identity fields the rewrite engine overlays on a mapped blank. */
export interface CardIdentity {
  card_id: string;
  card_print_id: string;
  name: string;
  type_line: string;
  front_image_uri: string;
  back_image_uri: string | null;
  can_rotate: boolean;
  power: string | null;
  toughness: string | null;
  /** Optional extras, applied only if the target object already carries the key. */
  mana_cost?: string;
  cmc?: number;
  color_identity?: string[];
  rarity?: string;
  set_name?: string;
}

export const IDENTITY_ALWAYS_FIELDS = [
  'card_id',
  'card_print_id',
  'name',
  'type_line',
  'front_image_uri',
  'back_image_uri',
  'can_rotate',
  'power',
  'toughness',
] as const;

export const IDENTITY_IF_PRESENT_FIELDS = ['mana_cost', 'cmc', 'color_identity', 'rarity', 'set_name'] as const;

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Shape checks. The extension gates on what the frames contain rather than on
// the protocol version number, so it only stops when edhplay changes something
// it actually relies on. Each function returns human-readable problems; [] = OK.
// ---------------------------------------------------------------------------

const CARD_LIST_KEYS = [...ALL_ZONES, 'revealed_hand_cards', 'revealed_library_cards'] as const;

function cardListProblems(where: string, list: unknown, out: string[]): Record<string, unknown>[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    out.push(`${where} is not a list`);
    return [];
  }
  const cards: Record<string, unknown>[] = [];
  for (const c of list) {
    if (!isObject(c) || typeof c['id'] !== 'string') {
      out.push(`${where} has a card without a string id`);
      return cards;
    }
    cards.push(c);
  }
  return cards;
}

/** Everything the engine needs from the first `game_state` of a socket. */
export function gameStateProblems(msg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const players = msg['players'];
  if (!Array.isArray(players)) return ['game_state.players is missing'];
  const named: Record<string, unknown>[] = [];
  for (const p of players) {
    if (!isObject(p) || typeof p['player_id'] !== 'string') {
      out.push('a player has no string player_id');
      continue;
    }
    for (const key of CARD_LIST_KEYS) {
      for (const c of cardListProblems(`player.${key}`, p[key], out)) if (typeof c['name'] === 'string') named.push(c);
    }
  }
  // The re-skin overlays these fields; if edhplay renamed them the app would ignore the overlay.
  if (named.length > 0) {
    for (const f of ['card_print_id', 'front_image_uri'] as const) {
      if (!named.some((c) => typeof c[f] === 'string')) out.push(`visible cards no longer carry ${f}`);
    }
  }
  return out;
}

/**
 * Checks the later frames the engine reads. Unknown frame types pass: new
 * event types are harmless, only a change to one we read matters.
 */
export function frameProblems(msg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const str = (k: string): void => {
    if (typeof msg[k] !== 'string') out.push(`${String(msg['type'])}.${k} is not a string`);
  };
  switch (msg['type']) {
    case 'move_card':
      str('id');
      str('zone');
      break;
    case 'cards_moved':
      if (msg['cards'] === undefined && msg['moves'] === undefined && msg['card_ids'] === undefined && msg['count'] === undefined) {
        out.push('cards_moved has none of cards/moves/card_ids/count');
      }
      cardListProblems('cards_moved.cards', msg['cards'], out);
      if (msg['moves'] !== undefined && !Array.isArray(msg['moves'])) out.push('cards_moved.moves is not a list');
      break;
    case 'library_viewed':
      cardListProblems('library_viewed.viewed_library_cards', msg['viewed_library_cards'], out);
      break;
    case 'chat_message_received':
      str('player_id');
      str('message');
      break;
  }
  return out;
}
