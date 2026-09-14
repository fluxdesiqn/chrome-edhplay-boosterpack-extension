import type { CardRef } from '../packs/types';
import { chunkMapPairs, encodeSync } from './codec';
import { SYNC_MAX_MAP_PAIRS } from './types';
import type { SyncMessage } from './types';

export interface SyncQueueOptions {
  send: (text: string) => void;
  /** Minimum gap between two sent lines. Default 550 ms. */
  intervalMs?: number;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

type MapMessage = Extract<SyncMessage, { t: 'map' | 'tok' }>;
type StateMessage = Extract<SyncMessage, { t: 'state' }>;

interface QueueItem {
  msg: SyncMessage;
  trailer?: string;
  priority: boolean;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Paced outbound queue: at most one chat line per `intervalMs`, priority items first.
 * The clock and timer functions are injectable so tests can drive it deterministically.
 */
export class SyncQueue {
  private readonly send: (text: string) => void;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private items: QueueItem[] = [];
  private timer: TimerHandle | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(opts: SyncQueueOptions) {
    this.send = opts.send;
    this.intervalMs = opts.intervalMs ?? 550;
    this.now = opts.now ?? (() => Date.now());
    // Resolve lazily so fake timers installed after construction still apply.
    this.setTimeoutFn =
      opts.setTimeout ?? (((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms)) as typeof setTimeout);
    this.clearTimeoutFn = opts.clearTimeout ?? (((h: TimerHandle) => globalThis.clearTimeout(h)) as typeof clearTimeout);
  }

  enqueue(msg: SyncMessage, opts: { priority?: boolean; trailer?: string } = {}): void {
    if (this.disposed) return;
    this.insert({ msg, trailer: opts.trailer, priority: opts.priority ?? false });
    this.schedule();
  }

  /**
   * Enqueue map/tok pairs. Ids already pending in a message of the same kind are dropped;
   * non-priority pairs are merged into a pending non-priority message of the same kind
   * (up to SYNC_MAX_MAP_PAIRS and the 500-char line limit) before new messages are created.
   */
  enqueueMap(
    pairs: [string, CardRef][],
    opts: { priority?: boolean; kind?: 'map' | 'tok' } = {},
  ): void {
    if (this.disposed) return;
    const kind = opts.kind ?? 'map';
    const priority = opts.priority ?? false;

    const pending = new Set<string>();
    for (const item of this.items) {
      if (item.msg.t === kind) for (const [id] of item.msg.m) pending.add(id);
    }
    let fresh = pairs.filter(([id]) => {
      if (pending.has(id)) return false;
      pending.add(id);
      return true;
    });
    if (!fresh.length) return;

    if (!priority) {
      const target = this.items.find(
        (i) => !i.priority && i.msg.t === kind && i.msg.m.length < SYNC_MAX_MAP_PAIRS,
      );
      if (target) {
        const merged = chunkMapPairs([...(target.msg as MapMessage).m, ...fresh]);
        target.msg = { t: kind, m: merged[0] ?? [] } as MapMessage;
        fresh = merged.slice(1).flat();
      }
    }

    for (const chunk of chunkMapPairs(fresh)) {
      this.insert({ msg: { t: kind, m: chunk } as MapMessage, priority });
    }
    this.schedule();
  }

  /** Replace any pending state message (last-wins); otherwise enqueue a new one. */
  enqueueState(msg: StateMessage): void {
    if (this.disposed) return;
    const existing = this.items.find((i) => i.msg.t === 'state');
    if (existing) {
      existing.msg = msg;
      return;
    }
    this.insert({ msg, priority: false });
    this.schedule();
  }

  /**
   * Send map pairs right now, bypassing pacing (announce-before-move). The pairs are removed
   * from any pending map messages, and lastSentAt is updated so the paced stream resumes
   * one full interval later.
   */
  flushMapNow(pairs: [string, CardRef][]): void {
    if (this.disposed || !pairs.length) return;
    const ids = new Set(pairs.map(([id]) => id));
    this.items = this.items
      .map((item) => {
        if (item.msg.t !== 'map') return item;
        const m = item.msg.m.filter(([id]) => !ids.has(id));
        return m.length === item.msg.m.length ? item : { ...item, msg: { t: 'map', m } as MapMessage };
      })
      .filter((item) => item.msg.t !== 'map' || item.msg.m.length > 0);

    for (const chunk of chunkMapPairs(pairs)) {
      this.send(encodeSync({ t: 'map', m: chunk }));
    }
    this.lastSentAt = this.now();
    this.reschedule();
  }

  /** Remove blank ids from any pending map message (they were sent through another channel). */
  removePendingMapIds(ids: string[]): void {
    if (!ids.length) return;
    const set = new Set(ids);
    this.items = this.items
      .map((item) => {
        if (item.msg.t !== 'map') return item;
        const m = item.msg.m.filter(([id]) => !set.has(id));
        return m.length === item.msg.m.length ? item : { ...item, msg: { t: 'map', m } as MapMessage };
      })
      .filter((item) => item.msg.t !== 'map' || item.msg.m.length > 0);
  }

  pendingCount(): number {
    return this.items.length;
  }

  /** Drop everything pending; pacing state is kept. */
  clear(): void {
    this.items = [];
    this.cancelTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  // ---- internals ----

  private insert(item: QueueItem): void {
    if (item.priority) {
      let idx = 0;
      while (idx < this.items.length && this.items[idx]!.priority) idx++;
      this.items.splice(idx, 0, item);
    } else {
      this.items.push(item);
    }
  }

  private schedule(): void {
    if (this.disposed || this.timer !== null || !this.items.length) return;
    const delay = Math.max(0, this.lastSentAt + this.intervalMs - this.now());
    this.timer = this.setTimeoutFn(() => this.tick(), delay);
  }

  /** Recompute the timer after lastSentAt moved (e.g. an out-of-band send). */
  private reschedule(): void {
    this.cancelTimer();
    this.schedule();
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    this.timer = null;
    if (this.disposed) return;
    const item = this.items.shift();
    if (item) {
      try {
        this.send(encodeSync(item.msg, item.trailer));
      } catch (err) {
        console.warn('[HoK] sync send failed, dropping message', err);
      }
      this.lastSentAt = this.now();
    }
    this.schedule();
  }
}
