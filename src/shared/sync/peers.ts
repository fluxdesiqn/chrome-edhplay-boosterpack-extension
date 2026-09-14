import type { CardRef } from '../packs/types';
import type { PeerView } from '../state';
import type { ReceivedSync } from './types';

export interface ApplySyncContext {
  now: number;
  myDataVersion: string;
  /** Owner of a blank card id, or null when we don't know the card (yet). */
  ownerOf: (cardId: string) => string | null;
}

export interface ApplySyncResult {
  peers: Record<string, PeerView>;
  /** True when anything other than `lastSeen` changed (including peer creation). */
  changed: boolean;
  /** Human-readable note about pairs that were dropped, if any. */
  rejected?: string;
}

export function emptyPeer(ownerId: string): PeerView {
  return {
    ownerId,
    packs: [],
    mappings: {},
    tokenMappings: {},
    dataVersionMismatch: false,
    lastSeen: 0,
  };
}

/**
 * Fold one received sync message into the peers table. Never mutates its inputs; the returned
 * `peers` object is new, and only the sender's entry is replaced.
 */
export function applySync(
  peers: Record<string, PeerView>,
  received: ReceivedSync,
  ctx: ApplySyncContext,
): ApplySyncResult {
  const { senderId, msg } = received;
  const prev = peers[senderId];
  let peer: PeerView = prev ? { ...prev, lastSeen: ctx.now } : { ...emptyPeer(senderId), lastSeen: ctx.now };
  let changed = !prev;
  let rejected: string | undefined;

  switch (msg.t) {
    case 'hello': {
      const mismatch = msg.dv !== ctx.myDataVersion;
      if (
        peer.extVersion !== msg.n ||
        peer.dataVersion !== msg.dv ||
        peer.role !== msg.role ||
        peer.dataVersionMismatch !== mismatch
      ) {
        peer = { ...peer, extVersion: msg.n, dataVersion: msg.dv, role: msg.role, dataVersionMismatch: mismatch };
        changed = true;
      }
      break;
    }
    case 'state': {
      const mismatch = msg.dv !== ctx.myDataVersion;
      if (
        peer.placeholderPrintId !== msg.ph ||
        peer.reservoirCount !== msg.res ||
        peer.pileCount !== msg.pile ||
        peer.activationCount !== msg.act ||
        peer.dataVersion !== msg.dv ||
        peer.dataVersionMismatch !== mismatch
      ) {
        peer = {
          ...peer,
          placeholderPrintId: msg.ph,
          reservoirCount: msg.res,
          pileCount: msg.pile,
          activationCount: msg.act,
          dataVersion: msg.dv,
          dataVersionMismatch: mismatch,
        };
        changed = true;
      }
      break;
    }
    case 'pack': {
      if (!peer.packs.some((p) => p.n === msg.n)) {
        const packs = [...peer.packs, { n: msg.n, set: msg.set, kind: msg.k ?? 'draft', seed: msg.seed, dataVersion: msg.dv, cards: msg.c ?? [], foil: msg.f ?? [] }];
        packs.sort((a, b) => a.n - b.n);
        peer = { ...peer, packs };
        changed = true;
      }
      break;
    }
    case 'shuf': {
      break;
    }
    case 'map': {
      const notOwned: string[] = [];
      const conflicts: string[] = [];
      let mappings: Record<string, CardRef> | null = null;
      for (const [blankId, ref] of msg.m) {
        const owner = ctx.ownerOf(blankId);
        if (owner !== null && owner !== senderId) {
          notOwned.push(blankId);
          continue;
        }
        const existing = (mappings ?? peer.mappings)[blankId];
        if (existing !== undefined) {
          if (existing !== ref) conflicts.push(blankId);
          continue;
        }
        mappings ??= { ...peer.mappings };
        mappings[blankId] = ref;
      }
      if (mappings) {
        peer = { ...peer, mappings };
        changed = true;
      }
      rejected = describeRejected('map', notOwned, conflicts);
      break;
    }
    case 'tok': {
      const conflicts: string[] = [];
      let tokenMappings: Record<string, CardRef> | null = null;
      for (const [tokenId, ref] of msg.m) {
        const existing = (tokenMappings ?? peer.tokenMappings)[tokenId];
        if (existing !== undefined) {
          if (existing !== ref) conflicts.push(tokenId);
          continue;
        }
        tokenMappings ??= { ...peer.tokenMappings };
        tokenMappings[tokenId] = ref;
      }
      if (tokenMappings) {
        peer = { ...peer, tokenMappings };
        changed = true;
      }
      rejected = describeRejected('tok', [], conflicts);
      break;
    }
    case 'need':
      break;
  }

  const result: ApplySyncResult = { peers: { ...peers, [senderId]: peer }, changed };
  if (rejected) result.rejected = rejected;
  return result;
}

function describeRejected(kind: string, notOwned: string[], conflicts: string[]): string | undefined {
  const parts: string[] = [];
  if (notOwned.length) parts.push(`not owned by sender: ${notOwned.join(', ')}`);
  if (conflicts.length) parts.push(`already mapped (kept first): ${conflicts.join(', ')}`);
  return parts.length ? `${kind}: ${parts.join('; ')}` : undefined;
}

/** Every known blank/token id → ref across all peers. Token mappings are merged after card mappings. */
export function mappingIndex(peers: Record<string, PeerView>): Map<string, CardRef> {
  const index = new Map<string, CardRef>();
  for (const peer of Object.values(peers)) {
    for (const [id, ref] of Object.entries(peer.mappings)) index.set(id, ref);
  }
  for (const peer of Object.values(peers)) {
    for (const [id, ref] of Object.entries(peer.tokenMappings)) index.set(id, ref);
  }
  return index;
}
