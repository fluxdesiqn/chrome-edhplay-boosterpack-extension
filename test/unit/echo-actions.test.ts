import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EchoWaiter } from '@main/echo';
import { ActionSender } from '@main/actions';

describe('EchoWaiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves when a matching frame is offered and clears the waiter', async () => {
    const w = new EchoWaiter();
    const p = w.waitForType<{ id: string }>('move_card', (m) => m.id === 'a', 1000);
    w.offer({ type: 'move_card', id: 'b' });
    expect(w.pending).toBe(1);
    w.offer({ type: 'move_card', id: 'a' });
    await expect(p).resolves.toMatchObject({ id: 'a' });
    expect(w.pending).toBe(0);
  });

  it('rejects on timeout with the label', async () => {
    const w = new EchoWaiter();
    const p = w.waitFor(() => false, 500, 'exile echo');
    const assertion = expect(p).rejects.toThrow(/exile echo/);
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    expect(w.pending).toBe(0);
  });

  it('a throwing predicate is treated as no match', async () => {
    const w = new EchoWaiter();
    const p = w.waitFor(() => {
      throw new Error('boom');
    }, 300);
    w.offer({ type: 'x' });
    const assertion = expect(p).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
  });

  it('cancelAll rejects everything', async () => {
    const w = new EchoWaiter();
    const p1 = w.waitFor(() => false, 5000);
    const p2 = w.waitFor(() => false, 5000);
    const a1 = expect(p1).rejects.toThrow(/socket closed/);
    const a2 = expect(p2).rejects.toThrow(/socket closed/);
    w.cancelAll('socket closed');
    await Promise.all([a1, a2]);
  });
});

describe('ActionSender', () => {
  it('paces sends by action type and keeps a ledger', async () => {
    let now = 1000;
    const sleeps: number[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const sender = new ActionSender(
      { sendRaw: async (m) => void sent.push(m) },
      () => now,
      async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    );
    await sender.send({ type: 'move_card', id: 'abcdefgh-1', zone: 'hand' });
    await sender.send({ type: 'move_card', id: 'abcdefgh-2', zone: 'hand' });
    await sender.send({ type: 'exile_x_cards', count: 50, face_down: true });
    expect(sent.map((m) => m['type'])).toEqual(['move_card', 'move_card', 'exile_x_cards']);
    expect(sleeps).toEqual([150, 850]);
    const ledger = sender.ledger();
    expect(ledger).toHaveLength(3);
    expect(ledger[2]?.summary).toMatch(/exile top 50 face down/);
  });

  it('continues the chain after a failed send', async () => {
    let fail = true;
    const sent: string[] = [];
    const sender = new ActionSender(
      {
        sendRaw: async (m) => {
          if (fail) {
            fail = false;
            throw new Error('closed');
          }
          sent.push(String(m['type']));
        },
      },
      () => 0,
      async () => undefined,
    );
    await expect(sender.send({ type: 'shuffle_library' })).rejects.toThrow(/closed/);
    await sender.send({ type: 'draw_card' });
    expect(sent).toEqual(['draw_card']);
  });
});
