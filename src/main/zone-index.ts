/**
 * Shadow index of every card we have seen on the wire, keyed by id, with the
 * owner and zone we believe it is in. Fed with inbound events; emits
 * observations describing what changed so the game logic can react.
 */
import { ALL_ZONES, HIDDEN_ZONES, isObject, type Visibility, type WireCard, type Zone } from '@shared/protocol';
import type { CardSummary } from '@shared/state';

export interface IndexedCard {
  id: string;
  ownerId: string;
  zone: Zone;
  /** latest merged wire object */
  card: WireCard;
  faceDown: boolean;
}

export interface Observation {
  cardId: string;
  ownerId: string;
  zone: Zone;
  faceDown: boolean;
  kind: 'moved' | 'seen' | 'removed' | 'revealed';
}

export function isFaceDown(v: unknown): boolean {
  return v === 'face_down' || (isObject(v) && v.base === 'face_down');
}

export function isRevealedVisibility(v: unknown): boolean {
  return v === 'revealed' || (isObject(v) && Array.isArray(v.revealed_to) && v.revealed_to.length > 0);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asZone(v: unknown): Zone | null {
  return typeof v === 'string' && (ALL_ZONES as readonly string[]).includes(v) ? (v as Zone) : null;
}

function isHidden(zone: Zone): boolean {
  return HIDDEN_ZONES.includes(zone);
}

function asCard(v: unknown): WireCard | null {
  return isObject(v) && typeof v.id === 'string' ? (v as WireCard) : null;
}

function asCards(v: unknown): WireCard[] {
  if (!Array.isArray(v)) return [];
  const out: WireCard[] = [];
  for (const c of v) {
    const card = asCard(c);
    if (card) out.push(card);
  }
  return out;
}

/** Owner ids are uuids and zones are plain words, so '|' cannot collide. */
function listKey(ownerId: string, zone: Zone): string {
  return `${ownerId}|${zone}`;
}

interface PlaceOpts {
  /** fields to merge into the stored card */
  patch?: Partial<WireCard>;
  /** insertion index within the zone list (default: append) */
  position?: number;
  /** explicit face-down flag (wins over the patch's visibility) */
  faceDown?: boolean;
  /** the event is a move: unknown cards are reported as 'moved' rather than 'seen' */
  move?: boolean;
}

export class ZoneIndex {
  localPlayerId: string | null = null;
  players = new Map<string, { id: string; name: string }>();

  private cards = new Map<string, IndexedCard>();
  /** per owner+zone ordered id lists */
  private lists = new Map<string, string[]>();

  // ---------------------------------------------------------------- queries

  get(id: string): IndexedCard | undefined {
    return this.cards.get(id);
  }

  cardsIn(zone: Zone, ownerId: string): IndexedCard[] {
    const ids = this.lists.get(listKey(ownerId, zone)) ?? [];
    const out: IndexedCard[] = [];
    for (const id of ids) {
      const c = this.cards.get(id);
      if (c) out.push(c);
    }
    return out;
  }

  ownerOf(id: string): string | null {
    return this.cards.get(id)?.ownerId ?? null;
  }

  get size(): number {
    return this.cards.size;
  }

  snapshot(): CardSummary[] {
    const out: CardSummary[] = [];
    for (const ids of this.lists.values()) {
      for (const id of ids) {
        const c = this.cards.get(id);
        if (!c) continue;
        out.push({
          id: c.id,
          card_print_id: str(c.card.card_print_id) ?? '',
          name: str(c.card.name) ?? '',
          type_line: str(c.card.type_line) ?? '',
          zone: c.zone,
          ownerId: c.ownerId,
          faceDown: c.faceDown,
          front_image_uri: str(c.card.front_image_uri) ?? '',
        });
      }
    }
    return out;
  }

  /** Forget every card (players and local id are kept). */
  reset(): void {
    this.cards = new Map();
    this.lists = new Map();
  }

  // ---------------------------------------------------------------- events

  apply(ev: Record<string, unknown>): Observation[] {
    switch (ev.type) {
      case 'game_state':
        return this.applyGameState(ev);
      case 'move_to_library_position': {
        const id = String(ev['id'] ?? '');
        const cur = this.get(id);
        const owner = typeof ev['player_id'] === 'string' ? ev['player_id'] : cur?.ownerId;
        if (!id || !owner || !cur) return [];
        const pos = typeof ev['position'] === 'number' && ev['position'] < 0 ? undefined : 0;
        return compact([this.place(id, owner, 'library', { position: pos, faceDown: false, patch: { visibility: 'default' }, move: true })]);
      }
      case 'move_card':
        return compact([this.moveOne(ev)]);
      case 'cards_moved':
        return this.applyCardsMoved(ev);
      case 'place_on_battlefield':
        return this.applyPlaceOnBattlefield(ev);
      case 'card_created': {
        const owner = str(ev.player_id);
        const token = asCard(ev.token);
        if (!owner || !token) return [];
        return compact([this.place(token.id, owner, asZone(token.zone) ?? 'battlefield', { patch: token })]);
      }
      case 'card_added': {
        const owner = str(ev.player_id);
        const card = asCard(ev.card);
        if (!owner || !card) return [];
        const zone = asZone(ev.zone) ?? asZone(card.zone) ?? 'hand';
        return compact([this.place(card.id, owner, zone, { patch: card })]);
      }
      case 'card_given': {
        const target = str(ev.target_player_id);
        const card = asCard(ev.card);
        if (!target || !card) return [];
        return compact([this.place(card.id, target, 'battlefield', { patch: card, move: true })]);
      }
      case 'batch_cards_given': {
        const target = str(ev.target_player_id);
        if (!target) return [];
        return compact(asCards(ev.cards).map((c) => this.place(c.id, target, 'battlefield', { patch: c, move: true })));
      }
      case 'remove_card': {
        const id = str(ev.card_id) ?? str(ev.id);
        return id ? compact([this.remove(id)]) : [];
      }
      case 'set_visibility':
        return this.applySetVisibility(ev);
      case 'reveal_zone_cards':
        return this.applyRevealZoneCards(ev);
      case 'library_viewed':
        return this.applyLibraryViewed(ev);
      case 'mulligan': {
        const owner = str(ev.player_id);
        return owner ? this.replaceZonesFrom(owner, ev, ['hand', 'library']) : [];
      }
      case 'deck_submitted': {
        const owner = str(ev.player_id);
        return owner ? this.replaceZonesFrom(owner, ev) : [];
      }
      case 'new_game_started':
        this.reset();
        return [];
      case 'player_joined': {
        const id = str(ev.player_id);
        if (id) this.players.set(id, { id, name: str(ev.username) ?? this.players.get(id)?.name ?? id });
        return [];
      }
      case 'player_left': {
        const id = str(ev.player_id);
        if (!id) return [];
        this.players.delete(id);
        const gone: Observation[] = [];
        for (const c of [...this.cards.values()]) if (c.ownerId === id) gone.push(...compact([this.remove(c.id)]));
        return gone;
      }
      case 'random_card_selected': {
        const owner = str(ev.player_id);
        const card = asCard(ev.card);
        const zone = asZone(ev.zone) ?? asZone(card?.zone);
        if (!owner || !card || !zone) return [];
        const known = this.cards.has(card.id);
        const obs = this.place(card.id, owner, zone, { patch: card });
        if (obs) return [obs];
        if (known && isHidden(zone)) {
          const c = this.cards.get(card.id)!;
          return [{ cardId: c.id, ownerId: c.ownerId, zone: c.zone, faceDown: c.faceDown, kind: 'revealed' }];
        }
        return [];
      }
      case 'discard_random': {
        const owner = str(ev.player_id);
        if (!owner) return [];
        return compact(asCards(ev.discarded_cards).map((c) => this.place(c.id, owner, 'graveyard', { patch: c, move: true })));
      }
      // library_shuffled / library_viewing_cleared / chat / … change no card
      default:
        return [];
    }
  }

  // ---------------------------------------------------------------- handlers

  private applyGameState(ev: Record<string, unknown>): Observation[] {
    const old = this.cards;
    this.cards = new Map();
    this.lists = new Map();
    const players = Array.isArray(ev.players) ? ev.players.filter(isObject) : [];
    this.players = new Map();
    for (const p of players) {
      const owner = str(p.player_id);
      if (!owner) continue;
      this.players.set(owner, { id: owner, name: str(p.username) ?? owner });
      for (const zone of ALL_ZONES) {
        for (const card of asCards(p[zone])) this.place(card.id, owner, zone, { patch: card });
      }
      for (const card of asCards(p.revealed_hand_cards)) this.place(card.id, owner, 'hand', { patch: card });
      for (const card of asCards(p.revealed_library_cards)) this.place(card.id, owner, 'library', { patch: card });
      const top = asCard(p.library_top_card);
      if (top && !this.cards.has(top.id)) this.place(top.id, owner, 'library', { patch: top, position: 0 });
    }
    const obs: Observation[] = [];
    for (const c of this.cards.values()) {
      const prev = old.get(c.id);
      const base = { cardId: c.id, ownerId: c.ownerId, zone: c.zone, faceDown: c.faceDown };
      if (!prev) obs.push({ ...base, kind: 'seen' });
      else if (prev.ownerId !== c.ownerId || prev.zone !== c.zone) obs.push({ ...base, kind: 'moved' });
      else if (prev.faceDown && !c.faceDown) obs.push({ ...base, kind: 'revealed' });
    }
    for (const prev of old.values()) {
      if (!this.cards.has(prev.id)) {
        obs.push({ cardId: prev.id, ownerId: prev.ownerId, zone: prev.zone, faceDown: prev.faceDown, kind: 'removed' });
      }
    }
    return obs;
  }

  private moveOne(mv: Record<string, unknown>): Observation | null {
    const id = str(mv.id);
    const owner = str(mv.player_id);
    const zone = asZone(mv.zone);
    if (!id || !owner || !zone) return null;
    const patch: Partial<WireCard> = { ...(asCard(mv.card) ?? {}), ...(isObject(mv.updates) ? (mv.updates as Partial<WireCard>) : {}) };
    if (isObject(mv.to)) {
      if (typeof mv.to.x === 'number') patch.x = mv.to.x;
      if (typeof mv.to.y === 'number') patch.y = mv.to.y;
    }
    return this.place(id, owner, zone, { patch, position: typeof mv.to === 'number' ? mv.to : undefined, move: true });
  }

  private applyCardsMoved(ev: Record<string, unknown>): Observation[] {
    const obs: Observation[] = [];
    if (Array.isArray(ev.moves)) {
      for (const mv of ev.moves) if (isObject(mv)) obs.push(...compact([this.moveOne(mv)]));
    } else {
      const owner = str(ev.player_id);
      const to = asZone(ev.to_zone);
      if (owner && to) {
        const faceDown = typeof ev.face_down === 'boolean' ? ev.face_down : undefined;
        const position = typeof ev.position === 'number' ? ev.position : undefined;
        const at = (i: number) => (position === undefined ? undefined : position + i);
        const cards = asCards(ev.cards);
        if (cards.length > 0) {
          cards.forEach((c, i) => {
            obs.push(...compact([this.place(c.id, owner, to, { patch: c, faceDown, move: true, position: at(i) })]));
          });
        } else if (Array.isArray(ev.card_ids)) {
          let i = 0;
          for (const raw of ev.card_ids) {
            const id = str(raw);
            if (!id || !this.cards.has(id)) continue; // unknown ids: nothing to move
            obs.push(...compact([this.place(id, owner, to, { faceDown, move: true, position: at(i) })]));
            i += 1;
          }
        }
      }
    }
    if (Array.isArray(ev.removed_token_ids)) {
      for (const raw of ev.removed_token_ids) {
        const id = str(raw);
        if (id) obs.push(...compact([this.remove(id)]));
      }
    }
    return obs;
  }

  private applyPlaceOnBattlefield(ev: Record<string, unknown>): Observation[] {
    const owner = str(ev.player_id);
    if (!owner || !Array.isArray(ev.items)) return [];
    const obs: Observation[] = [];
    for (const item of ev.items) {
      if (!isObject(item)) continue;
      const id = str(item.id);
      if (!id) continue;
      const zone = asZone(item.zone) ?? 'battlefield';
      const patch: Partial<WireCard> = { ...(asCard(item.card) ?? {}) };
      if (isObject(item.to)) {
        if (typeof item.to.x === 'number') patch.x = item.to.x;
        if (typeof item.to.y === 'number') patch.y = item.to.y;
      }
      obs.push(...compact([this.place(id, owner, zone, { patch, move: true })]));
    }
    return obs;
  }

  private applySetVisibility(ev: Record<string, unknown>): Observation[] {
    const id = str(ev.id);
    if (!id) return [];
    const prev = this.cards.get(id);
    const card = asCard(ev.card);
    const owner = prev?.ownerId ?? str(ev.player_id) ?? str(card?.owner_id);
    const zone = prev?.zone ?? asZone(card?.zone);
    if (!owner || !zone) return [];
    const patch: Partial<WireCard> = { ...(card ?? {}) };
    if ('visibility' in ev) patch.visibility = ev.visibility as Visibility;
    return compact([this.place(id, owner, zone, { patch })]);
  }

  private applyRevealZoneCards(ev: Record<string, unknown>): Observation[] {
    const owner = str(ev.player_id);
    const zone = asZone(ev.zone);
    if (!owner || !zone) return [];
    const hasVis = 'visibility' in ev;
    const visibility = ev.visibility as Visibility | undefined;
    const revealing = hasVis && visibility !== 'default';
    const obs: Observation[] = [];
    if (Array.isArray(ev.cards)) {
      for (const c of asCards(ev.cards)) {
        const patch: Partial<WireCard> = hasVis ? { ...c, visibility } : { ...c };
        const o = this.place(c.id, owner, zone, { patch });
        const cur = this.cards.get(c.id)!;
        if (revealing) obs.push({ cardId: cur.id, ownerId: cur.ownerId, zone: cur.zone, faceDown: cur.faceDown, kind: 'revealed' });
        else if (o) obs.push(o);
      }
    } else if (hasVis) {
      for (const c of this.cardsIn(zone, owner)) this.place(c.id, owner, zone, { patch: { visibility } });
    }
    return obs;
  }

  private applyLibraryViewed(ev: Record<string, unknown>): Observation[] {
    if (!Array.isArray(ev.viewed_library_cards)) return [];
    const target = str(ev.target_player_id) ?? str(ev.player_id);
    if (!target) return [];
    const cards = asCards(ev.viewed_library_cards);
    const viewedIds = cards.map((c) => c.id);
    const viewed = new Set(viewedIds);
    const existing = this.lists.get(listKey(target, 'library')) ?? [];
    const rest = existing.filter((id) => !viewed.has(id));
    const obs: Observation[] = [];
    for (const c of cards) obs.push(...compact([this.place(c.id, target, 'library', { patch: c })]));
    let order: string[];
    switch (ev.location) {
      case 'top':
        order = [...viewedIds, ...rest];
        break;
      case 'bottom':
        order = [...rest, ...viewedIds];
        break;
      default:
        // 'all': the viewed list IS the library; anything else we believed was there is stale
        for (const id of rest) obs.push(...compact([this.remove(id)]));
        order = viewedIds;
    }
    this.lists.set(listKey(target, 'library'), order);
    return obs;
  }

  /** Replace each of `owner`'s zones for which `src[zone]` is an array. */
  private replaceZonesFrom(owner: string, src: Record<string, unknown>, only: readonly Zone[] = ALL_ZONES): Observation[] {
    const obs: Observation[] = [];
    const zones = only.filter((zone) => Array.isArray(src[zone]));
    const byZone = zones.map((zone) => [zone, asCards(src[zone])] as const);
    // Cards absent from EVERY replaced zone are gone; cards that merely changed zone are moves.
    const next = new Set(byZone.flatMap(([, cards]) => cards.map((c) => c.id)));
    for (const zone of zones) {
      for (const id of [...(this.lists.get(listKey(owner, zone)) ?? [])]) {
        if (!next.has(id)) obs.push(...compact([this.remove(id)]));
      }
    }
    for (const [zone, cards] of byZone) {
      for (const c of cards) obs.push(...compact([this.place(c.id, owner, zone, { patch: c })]));
      this.lists.set(
        listKey(owner, zone),
        cards.map((c) => c.id),
      );
    }
    return obs;
  }

  // ---------------------------------------------------------------- core

  private place(id: string, ownerId: string, zone: Zone, o: PlaceOpts = {}): Observation | null {
    const prev = this.cards.get(id);
    const card = { ...(prev?.card ?? {}), ...(o.patch ?? {}), id } as WireCard;
    const patchHasVis = o.patch !== undefined && 'visibility' in o.patch;
    const faceDown = o.faceDown ?? (patchHasVis ? isFaceDown(o.patch?.visibility) : (prev?.faceDown ?? isFaceDown(card.visibility)));
    const entry: IndexedCard = { id, ownerId, zone, card, faceDown };
    this.cards.set(id, entry);
    const base = { cardId: id, ownerId, zone, faceDown };

    if (!prev) {
      this.insert(ownerId, zone, id, o.position);
      return { ...base, kind: o.move ? 'moved' : 'seen' };
    }
    if (prev.ownerId !== ownerId || prev.zone !== zone) {
      this.removeFromList(prev.ownerId, prev.zone, id);
      this.insert(ownerId, zone, id, o.position);
      return { ...base, kind: 'moved' };
    }
    if (o.position !== undefined) {
      this.removeFromList(ownerId, zone, id);
      this.insert(ownerId, zone, id, o.position);
    }
    const flippedUp = prev.faceDown && !faceDown;
    const nowRevealed = patchHasVis && isRevealedVisibility(o.patch?.visibility) && !isRevealedVisibility(prev.card.visibility);
    if (flippedUp || (nowRevealed && isHidden(zone))) return { ...base, kind: 'revealed' };
    return null;
  }

  private remove(id: string): Observation | null {
    const prev = this.cards.get(id);
    if (!prev) return null;
    this.cards.delete(id);
    this.removeFromList(prev.ownerId, prev.zone, id);
    return { cardId: id, ownerId: prev.ownerId, zone: prev.zone, faceDown: prev.faceDown, kind: 'removed' };
  }

  private insert(ownerId: string, zone: Zone, id: string, position?: number): void {
    const k = listKey(ownerId, zone);
    let list = this.lists.get(k);
    if (!list) {
      list = [];
      this.lists.set(k, list);
    }
    if (position === undefined || position < 0 || position >= list.length) list.push(id);
    else list.splice(position, 0, id);
  }

  private removeFromList(ownerId: string, zone: Zone, id: string): void {
    const list = this.lists.get(listKey(ownerId, zone));
    if (!list) return;
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
  }
}

function compact(xs: Array<Observation | null>): Observation[] {
  const out: Observation[] = [];
  for (const x of xs) if (x) out.push(x);
  return out;
}
