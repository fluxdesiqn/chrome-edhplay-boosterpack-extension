/**
 * Decides when an owner must broadcast a blank's mapping: the first time it
 * is seen in a public zone or revealed. Pure.
 */
import type { CardRef } from '../packs/types';
import type { HokGameState } from '../state';
import { PUBLIC_ZONES, type Zone } from '../protocol';

export interface ZoneObservation {
  cardId: string;
  ownerId: string;
  zone: Zone;
  faceDown: boolean;
  kind: 'moved' | 'seen' | 'removed' | 'revealed';
}

export function isPublicExposure(o: ZoneObservation): boolean {
  if (o.kind === 'removed') return false;
  if (o.kind === 'revealed') return true;
  if (!PUBLIC_ZONES.includes(o.zone)) return false;
  // face-down cards in exile/battlefield reveal nothing
  return !o.faceDown;
}

/** Returns mapping pairs that must be broadcast now, and the updated state. */
export function announcementsFor(state: HokGameState, observations: ZoneObservation[]): { state: HokGameState; pairs: Array<[string, CardRef]> } {
  const pairs: Array<[string, CardRef]> = [];
  let mappings = state.mappings;
  let announced = state.announced;
  for (const o of observations) {
    const m = mappings[o.cardId];
    if (!m) continue;
    if (!isPublicExposure(o)) continue;
    if (!m.public) {
      if (mappings === state.mappings) mappings = { ...mappings };
      mappings[o.cardId] = { ...m, public: true };
    }
    if (!announced.includes(o.cardId)) {
      if (announced === state.announced) announced = [...announced];
      announced.push(o.cardId);
      pairs.push([o.cardId, m.ref]);
    }
  }
  if (mappings === state.mappings && announced === state.announced) return { state, pairs };
  return { state: { ...state, mappings, announced, updatedAt: Date.now() }, pairs };
}

/** All public mapping pairs (for re-broadcast to late joiners). */
export function publicPairs(state: HokGameState): Array<[string, CardRef]> {
  return Object.entries(state.mappings)
    .filter(([, m]) => m.public)
    .map(([id, m]) => [id, m.ref] as [string, CardRef]);
}

/** Zones an outbound action would put a card into, for the announce-before-move hook. */
export function outboundTargets(msg: Record<string, unknown>): Array<{ id: string; zone: Zone | null; reveal: boolean }> {
  const t = msg['type'];
  const out: Array<{ id: string; zone: Zone | null; reveal: boolean }> = [];
  if (t === 'move_card' && typeof msg['id'] === 'string') {
    out.push({ id: msg['id'], zone: (msg['zone'] as Zone) ?? null, reveal: false });
  } else if (t === 'batch_move_cards' && Array.isArray(msg['items'])) {
    for (const it of msg['items'] as Array<Record<string, unknown>>) {
      if (typeof it['id'] === 'string') out.push({ id: it['id'], zone: (it['zone'] as Zone) ?? null, reveal: false });
    }
  } else if (t === 'place_on_battlefield' && Array.isArray(msg['items'])) {
    for (const it of msg['items'] as Array<Record<string, unknown>>) {
      if (typeof it['id'] === 'string') out.push({ id: it['id'], zone: 'battlefield', reveal: false });
    }
  } else if (t === 'give_card' && typeof msg['id'] === 'string') {
    out.push({ id: msg['id'], zone: 'battlefield', reveal: false });
  } else if (t === 'set_visibility' && typeof msg['id'] === 'string') {
    const v = msg['visibility'];
    const reveal = v === 'revealed' || (typeof v === 'object' && v !== null && 'revealed_to' in (v as object));
    out.push({ id: msg['id'], zone: null, reveal });
  } else if (t === 'add_to_stack' && typeof msg['card_id'] === 'string') {
    out.push({ id: msg['card_id'], zone: null, reveal: true });
  }
  return out;
}

/** Mapping pairs that must be announced before the given outbound action goes out. */
export function preAnnouncePairs(state: HokGameState, msg: Record<string, unknown>): Array<[string, CardRef]> {
  const pairs: Array<[string, CardRef]> = [];
  for (const tgt of outboundTargets(msg)) {
    const m = state.mappings[tgt.id];
    if (!m || state.announced.includes(tgt.id)) continue;
    const goesPublic = tgt.reveal || (tgt.zone !== null && PUBLIC_ZONES.includes(tgt.zone));
    if (goesPublic) pairs.push([tgt.id, m.ref]);
  }
  return pairs;
}

export function markAnnounced(state: HokGameState, ids: string[]): HokGameState {
  const add = ids.filter((id) => !state.announced.includes(id));
  if (!add.length) return state;
  const mappings = { ...state.mappings };
  for (const id of add) if (mappings[id]) mappings[id] = { ...mappings[id]!, public: true };
  return { ...state, mappings, announced: [...state.announced, ...add], updatedAt: Date.now() };
}
