import { describe, expect, it } from 'vitest';
import { applySync, emptyPeer, mappingIndex } from '@shared/sync/peers';
import type { PeerView } from '@shared/state';
import type { SyncMessage } from '@shared/sync/types';
import type { CardRef } from '@shared/packs/types';

const owners: Record<string, string> = { a1: 'alice', a2: 'alice', b1: 'bob' };
const ctx = (now = 1000, myDataVersion = 'dv1') => ({
  now,
  myDataVersion,
  ownerOf: (id: string) => owners[id] ?? null,
});
const from = (senderId: string, msg: SyncMessage) => ({ senderId, msg });
const R = (s: string) => s as CardRef;

describe('applySync', () => {
  it('creates a peer on first message and updates lastSeen without mutating input', () => {
    const before: Record<string, PeerView> = {};
    const r = applySync(before, from('alice', { t: 'need' }), ctx(42));
    expect(before).toEqual({});
    expect(r.changed).toBe(true);
    expect(r.peers.alice).toEqual({ ...emptyPeer('alice'), lastSeen: 42 });

    const r2 = applySync(r.peers, from('alice', { t: 'need' }), ctx(43));
    expect(r2.changed).toBe(false);
    expect(r2.peers.alice!.lastSeen).toBe(43);
    expect(r.peers.alice!.lastSeen).toBe(42);
    expect(r2.peers).not.toBe(r.peers);
  });

  it('hello sets versions/role and flags a data-version mismatch', () => {
    const r = applySync({}, from('alice', { t: 'hello', v: 1, n: '0.2.0', dv: 'dv9', role: 's' }), ctx(1, 'dv1'));
    expect(r.peers.alice).toMatchObject({ extVersion: '0.2.0', dataVersion: 'dv9', role: 's', dataVersionMismatch: true });

    const r2 = applySync(r.peers, from('alice', { t: 'hello', v: 1, n: '0.2.0', dv: 'dv1', role: 'p' }), ctx(2, 'dv1'));
    expect(r2.changed).toBe(true);
    expect(r2.peers.alice).toMatchObject({ role: 'p', dataVersionMismatch: false });

    const r3 = applySync(r2.peers, from('alice', { t: 'hello', v: 1, n: '0.2.0', dv: 'dv1', role: 'p' }), ctx(3, 'dv1'));
    expect(r3.changed).toBe(false);
  });

  it('state sets counts and placeholder', () => {
    const r = applySync({}, from('alice', { t: 'state', ph: 'print-7', res: 5, pile: 20, act: 3, dv: 'dv1' }), ctx());
    expect(r.peers.alice).toMatchObject({
      placeholderPrintId: 'print-7',
      reservoirCount: 5,
      pileCount: 20,
      activationCount: 3,
      dataVersion: 'dv1',
      dataVersionMismatch: false,
    });
    const r2 = applySync(r.peers, from('alice', { t: 'state', ph: null, res: 4, pile: 20, act: 3, dv: 'dv1' }), ctx());
    expect(r2.changed).toBe(true);
    expect(r2.peers.alice!.placeholderPrintId).toBeNull();
    expect(r2.peers.alice!.reservoirCount).toBe(4);
  });

  it('pack dedupes by n per sender and defaults kind/cards/foil', () => {
    const pack = (n: number, seed = `s${n}`): SyncMessage => ({ t: 'pack', n, set: 'neo', seed, dv: 'dvX' });
    let peers: Record<string, PeerView> = {};
    peers = applySync(peers, from('alice', pack(2)), ctx()).peers;
    peers = applySync(peers, from('alice', pack(1)), ctx()).peers;
    const dup = applySync(peers, from('alice', pack(1, 'other')), ctx());
    expect(dup.changed).toBe(false);
    peers = dup.peers;
    peers = applySync(peers, from('bob', pack(1)), ctx()).peers;

    expect(peers.alice!.packs).toEqual([
      { n: 1, set: 'neo', kind: 'draft', seed: 's1', dataVersion: 'dvX', cards: [], foil: [] },
      { n: 2, set: 'neo', kind: 'draft', seed: 's2', dataVersion: 'dvX', cards: [], foil: [] },
    ]);
    expect(peers.bob!.packs).toHaveLength(1);
  });

  it('map rejects blanks owned by someone else', () => {
    const r = applySync({}, from('alice', { t: 'map', m: [['a1', R('neo:1')], ['b1', R('neo:2')]] }), ctx());
    expect(r.peers.alice!.mappings).toEqual({ a1: 'neo:1' });
    expect(r.rejected).toMatch(/not owned by sender: b1/);
    expect(r.changed).toBe(true);
  });

  it('map accepts provisionally when ownership is unknown', () => {
    const r = applySync({}, from('alice', { t: 'map', m: [['unknown-id', R('chk:5')]] }), ctx());
    expect(r.peers.alice!.mappings).toEqual({ 'unknown-id': 'chk:5' });
    expect(r.rejected).toBeUndefined();
  });

  it('map keeps the first ref on conflict and reports it', () => {
    const r1 = applySync({}, from('alice', { t: 'map', m: [['a1', R('neo:1')]] }), ctx());
    const r2 = applySync(r1.peers, from('alice', { t: 'map', m: [['a1', R('neo:99')], ['a2', R('neo:2')]] }), ctx());
    expect(r2.peers.alice!.mappings).toEqual({ a1: 'neo:1', a2: 'neo:2' });
    expect(r2.rejected).toMatch(/already mapped \(kept first\): a1/);
    // identical re-announce is a no-op
    const r3 = applySync(r2.peers, from('alice', { t: 'map', m: [['a1', R('neo:1')]] }), ctx());
    expect(r3.changed).toBe(false);
    expect(r3.rejected).toBeUndefined();
    // first-wins also applies within a single message
    const r4 = applySync({}, from('bob', { t: 'map', m: [['b1', R('sok:1')], ['b1', R('sok:2')]] }), ctx());
    expect(r4.peers.bob!.mappings).toEqual({ b1: 'sok:1' });
    expect(r4.rejected).toMatch(/b1/);
  });

  it('tok stores token mappings without ownership checks, first-ref-wins', () => {
    const r1 = applySync({}, from('alice', { t: 'tok', m: [['b1', R('neo:3')]] }), ctx());
    expect(r1.peers.alice!.tokenMappings).toEqual({ b1: 'neo:3' });
    expect(r1.peers.alice!.mappings).toEqual({});
    expect(r1.rejected).toBeUndefined();
    const r2 = applySync(r1.peers, from('alice', { t: 'tok', m: [['b1', R('neo:4')]] }), ctx());
    expect(r2.peers.alice!.tokenMappings).toEqual({ b1: 'neo:3' });
    expect(r2.changed).toBe(false);
    expect(r2.rejected).toMatch(/tok: already mapped/);
  });

  it('need changes nothing but lastSeen', () => {
    const base = applySync({}, from('alice', { t: 'map', m: [['a1', R('neo:1')]] }), ctx(1)).peers;
    const r = applySync(base, from('alice', { t: 'need', from: 'bob' }), ctx(2));
    expect(r.changed).toBe(false);
    expect(r.peers.alice).toEqual({ ...base.alice!, lastSeen: 2 });
  });

  it('leaves other peers untouched by reference', () => {
    const p1 = applySync({}, from('alice', { t: 'need' }), ctx()).peers;
    const p2 = applySync(p1, from('bob', { t: 'need' }), ctx()).peers;
    expect(p2.alice).toBe(p1.alice);
  });
});

describe('mappingIndex', () => {
  it('merges mappings and tokenMappings across all peers', () => {
    let peers: Record<string, PeerView> = {};
    peers = applySync(peers, from('alice', { t: 'map', m: [['a1', R('neo:1')], ['a2', R('neo:2')]] }), ctx()).peers;
    peers = applySync(peers, from('bob', { t: 'map', m: [['b1', R('bok:9')]] }), ctx()).peers;
    peers = applySync(peers, from('bob', { t: 'tok', m: [['t1', R('sok:7')]] }), ctx()).peers;
    const idx = mappingIndex(peers);
    expect(idx.size).toBe(4);
    expect(idx.get('a1')).toBe('neo:1');
    expect(idx.get('a2')).toBe('neo:2');
    expect(idx.get('b1')).toBe('bok:9');
    expect(idx.get('t1')).toBe('sok:7');
    expect(mappingIndex({}).size).toBe(0);
  });
});
