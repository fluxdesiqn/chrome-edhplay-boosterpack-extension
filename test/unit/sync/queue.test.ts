import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncQueue } from '@shared/sync/queue';
import { decodeSync } from '@shared/sync/codec';
import type { SyncMessage } from '@shared/sync/types';
import type { CardRef } from '@shared/packs/types';

const uuid = (i: number) => `0000${i.toString(16).padStart(4, '0')}-1111-4222-8333-444444444444`;
const ref = (i: number) => `neo:${String(100 + i)}` as CardRef;
const pairs = (from: number, count: number): [string, CardRef][] =>
  Array.from({ length: count }, (_, i) => [uuid(from + i), ref(from + i)]);

const hello: SyncMessage = { t: 'hello', v: 1, n: '0.1.0', dv: 'dv1', role: 'p' };
const need: SyncMessage = { t: 'need' };
const state = (res: number): Extract<SyncMessage, { t: 'state' }> => ({ t: 'state', ph: null, res, pile: 0, act: 0, dv: 'dv1' });

function setup(intervalMs?: number) {
  const sent: string[] = [];
  const q = new SyncQueue({ send: (t) => sent.push(t), intervalMs });
  const decoded = () => sent.map((s) => decodeSync(s));
  return { q, sent, decoded };
}

describe('SyncQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the first message immediately and paces the rest at 550 ms', () => {
    const { q, decoded } = setup();
    q.enqueue(hello);
    q.enqueue(need);
    q.enqueue(need);
    expect(decoded()).toEqual([]);
    vi.advanceTimersByTime(0);
    expect(decoded()).toEqual([hello]);
    vi.advanceTimersByTime(549);
    expect(decoded()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(decoded()).toHaveLength(2);
    vi.advanceTimersByTime(550);
    expect(decoded()).toHaveLength(3);
    expect(q.pendingCount()).toBe(0);
  });

  it('schedules relative to lastSentAt when the queue goes idle', () => {
    const { q, sent } = setup();
    q.enqueue(need);
    vi.advanceTimersByTime(0);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(300);
    q.enqueue(need);
    vi.advanceTimersByTime(249);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(2);
    // long idle → next send is immediate
    vi.advanceTimersByTime(5000);
    q.enqueue(need);
    vi.advanceTimersByTime(0);
    expect(sent).toHaveLength(3);
  });

  it('puts priority messages in front of pending ones, FIFO among themselves', () => {
    const { q, decoded } = setup();
    q.enqueue(need);
    q.enqueue(state(1));
    q.enqueue(hello, { priority: true, trailer: 'hi there' });
    q.enqueue({ t: 'need', from: 'x' }, { priority: true });
    vi.runAllTimers();
    expect(decoded()).toEqual([hello, { t: 'need', from: 'x' }, need, state(1)]);
  });

  it('includes the trailer on the wire', () => {
    const { q, sent } = setup();
    q.enqueue(hello, { trailer: 'human text' });
    vi.runAllTimers();
    expect(sent[0]!.endsWith(' human text')).toBe(true);
  });

  it('coalesces map pairs into a pending message up to 8 pairs', () => {
    const { q, decoded } = setup();
    q.enqueueMap(pairs(0, 3));
    q.enqueueMap(pairs(3, 3));
    expect(q.pendingCount()).toBe(1);
    q.enqueueMap(pairs(6, 5));
    expect(q.pendingCount()).toBe(2);
    vi.runAllTimers();
    const msgs = decoded();
    expect(msgs.map((m) => m && m.t === 'map' && m.m.length)).toEqual([8, 3]);
    expect(msgs.flatMap((m) => (m && m.t === 'map' ? m.m : []))).toEqual(pairs(0, 11));
  });

  it('dedupes blank ids already pending', () => {
    const { q, decoded } = setup();
    q.enqueueMap(pairs(0, 2));
    q.enqueueMap([...pairs(1, 2), ...pairs(0, 1)]);
    vi.runAllTimers();
    expect(decoded()).toEqual([{ t: 'map', m: pairs(0, 3) }]);
  });

  it('keeps tok and map separate and does not coalesce into a priority message', () => {
    const { q, decoded } = setup();
    q.enqueueMap(pairs(0, 2), { kind: 'tok' });
    q.enqueueMap(pairs(10, 2));
    q.enqueueMap(pairs(20, 1), { priority: true });
    q.enqueueMap(pairs(30, 1));
    expect(q.pendingCount()).toBe(3);
    vi.runAllTimers();
    expect(decoded()).toEqual([
      { t: 'map', m: pairs(20, 1) },
      { t: 'tok', m: pairs(0, 2) },
      { t: 'map', m: [...pairs(10, 2), ...pairs(30, 1)] },
    ]);
  });

  it('replaces a pending state message (last-wins)', () => {
    const { q, decoded } = setup();
    q.enqueue(need);
    q.enqueueState(state(1));
    q.enqueueState(state(2));
    q.enqueue(need);
    q.enqueueState(state(3));
    expect(q.pendingCount()).toBe(3);
    vi.runAllTimers();
    expect(decoded()).toEqual([need, state(3), need]);
  });

  it('flushMapNow sends immediately and resets pacing', () => {
    const { q, sent, decoded } = setup();
    q.enqueue(need);
    vi.advanceTimersByTime(0);
    expect(sent).toHaveLength(1);
    q.enqueue(hello);
    vi.advanceTimersByTime(200);
    q.flushMapNow(pairs(0, 2));
    expect(sent).toHaveLength(2);
    expect(decoded()[1]).toEqual({ t: 'map', m: pairs(0, 2) });
    // hello now waits a full interval from the flush, not from the earlier send
    vi.advanceTimersByTime(549);
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(3);
    expect(decoded()[2]).toEqual(hello);
  });

  it('flushMapNow chunks large sets and removes flushed ids from pending maps', () => {
    const { q, sent, decoded } = setup();
    q.enqueueMap(pairs(0, 4));
    q.flushMapNow(pairs(0, 12));
    expect(sent).toHaveLength(2);
    expect(decoded().map((m) => m && m.t === 'map' && m.m.length)).toEqual([8, 4]);
    expect(q.pendingCount()).toBe(0);
    q.enqueueMap(pairs(20, 2));
    q.flushMapNow(pairs(20, 1));
    vi.runAllTimers();
    expect(decoded().at(-1)).toEqual({ t: 'map', m: pairs(21, 1) });
  });

  it('dispose cancels pending sends; clear keeps the queue usable', () => {
    const { q, sent } = setup();
    q.enqueue(need);
    q.enqueue(need);
    vi.advanceTimersByTime(0);
    expect(sent).toHaveLength(1);
    q.clear();
    expect(q.pendingCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(sent).toHaveLength(1);
    q.enqueue(need);
    vi.runAllTimers();
    expect(sent).toHaveLength(2);

    q.enqueue(need);
    q.dispose();
    q.enqueue(need);
    q.enqueueMap(pairs(0, 1));
    q.enqueueState(state(1));
    q.flushMapNow(pairs(0, 1));
    vi.runAllTimers();
    expect(sent).toHaveLength(2);
    expect(q.pendingCount()).toBe(0);
  });

  it('uses injected clock and timers', () => {
    let now = 0;
    const timers: Array<{ fn: () => void; at: number }> = [];
    const sent: string[] = [];
    const q = new SyncQueue({
      send: (t) => sent.push(t),
      intervalMs: 100,
      now: () => now,
      setTimeout: ((fn: () => void, ms: number) => {
        timers.push({ fn, at: now + ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
    });
    q.enqueue(need);
    q.enqueue(need);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.at).toBe(0);
    timers[0]!.fn();
    expect(sent).toHaveLength(1);
    expect(timers).toHaveLength(2);
    expect(timers[1]!.at).toBe(100);
    now = 100;
    timers[1]!.fn();
    expect(sent).toHaveLength(2);
    expect(timers).toHaveLength(2);
  });

  it('drops a message whose encoding is too long instead of stalling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { q, decoded } = setup();
    q.enqueue({ t: 'need' }, { trailer: 'x'.repeat(600) });
    q.enqueue(need);
    vi.runAllTimers();
    expect(decoded()).toEqual([need]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
