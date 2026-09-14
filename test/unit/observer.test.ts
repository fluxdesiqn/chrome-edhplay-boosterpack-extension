import { describe, expect, it } from 'vitest';
import { announcementsFor, markAnnounced, preAnnouncePairs, publicPairs } from '@shared/game/observer';
import { emptyGameState } from '@shared/state';

function withMapping(id: string, pub = false) {
  const s = emptyGameState('r', 'me');
  s.mappings[id] = { ref: 'neo:1', public: pub, assignedAt: 1 };
  return s;
}

describe('observer announcements', () => {
  it('announces a private blank the first time it lands on the battlefield', () => {
    const s = withMapping('b1');
    const out = announcementsFor(s, [{ cardId: 'b1', ownerId: 'me', zone: 'battlefield', faceDown: false, kind: 'moved' }]);
    expect(out.pairs).toEqual([['b1', 'neo:1']]);
    expect(out.state.mappings['b1']?.public).toBe(true);
    expect(out.state.announced).toContain('b1');
  });

  it('does not announce hand/library moves or face-down public cards', () => {
    const s = withMapping('b1');
    const out = announcementsFor(s, [
      { cardId: 'b1', ownerId: 'me', zone: 'hand', faceDown: false, kind: 'moved' },
      { cardId: 'b1', ownerId: 'me', zone: 'exile', faceDown: true, kind: 'moved' },
    ]);
    expect(out.pairs).toEqual([]);
    expect(out.state).toBe(s);
  });

  it('announces reveals in hidden zones', () => {
    const s = withMapping('b1');
    const out = announcementsFor(s, [{ cardId: 'b1', ownerId: 'me', zone: 'hand', faceDown: false, kind: 'revealed' }]);
    expect(out.pairs).toHaveLength(1);
  });

  it('is idempotent once announced', () => {
    const s = markAnnounced(withMapping('b1'), ['b1']);
    const out = announcementsFor(s, [{ cardId: 'b1', ownerId: 'me', zone: 'graveyard', faceDown: false, kind: 'moved' }]);
    expect(out.pairs).toEqual([]);
    expect(publicPairs(s)).toEqual([['b1', 'neo:1']]);
  });

  it('computes pre-announce pairs for outbound moves into public zones only', () => {
    const s = withMapping('b1');
    expect(preAnnouncePairs(s, { type: 'move_card', id: 'b1', zone: 'battlefield' })).toEqual([['b1', 'neo:1']]);
    expect(preAnnouncePairs(s, { type: 'move_card', id: 'b1', zone: 'library' })).toEqual([]);
    expect(preAnnouncePairs(s, { type: 'batch_move_cards', items: [{ id: 'b1', zone: 'graveyard' }] })).toHaveLength(1);
    expect(preAnnouncePairs(s, { type: 'set_visibility', id: 'b1', visibility: 'revealed' })).toHaveLength(1);
    expect(preAnnouncePairs(s, { type: 'set_visibility', id: 'b1', visibility: 'face_down' })).toHaveLength(0);
    expect(preAnnouncePairs(s, { type: 'move_card', id: 'other', zone: 'battlefield' })).toEqual([]);
  });
});
