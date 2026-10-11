/**
 * Waits for server echoes. Sequences register predicates over inbound frames
 * (and the zone index) and get a promise that resolves when satisfied.
 */
export interface Waiter {
  pred: (frame: Record<string, unknown>) => boolean;
  resolve: (frame: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EchoWaiter {
  private waiters = new Set<Waiter>();

  /** Feed every inbound frame here (after the zone index has been updated). */
  offer(frame: Record<string, unknown>): void {
    for (const w of [...this.waiters]) {
      let hit = false;
      try {
        hit = w.pred(frame);
      } catch {
        hit = false;
      }
      if (hit) {
        this.waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(frame);
      }
    }
  }

  waitFor(pred: (frame: Record<string, unknown>) => boolean, timeoutMs: number, label = 'echo'): Promise<Record<string, unknown>> {
    const p = new Promise<Record<string, unknown>>((resolve, reject) => {
      const w: Waiter = {
        pred,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(w);
          reject(new Error(`timeout waiting for ${label}`));
        }, timeoutMs),
      };
      this.waiters.add(w);
    });
    // A sequence that aborts (e.g. its send was refused) never awaits its wait; keep that timeout quiet.
    // Callers that do await still see the rejection.
    p.catch(() => undefined);
    return p;
  }

  waitForType<T extends Record<string, unknown>>(type: string, pred: (m: T) => boolean, timeoutMs: number): Promise<T> {
    return this.waitFor((f) => f['type'] === type && pred(f as T), timeoutMs, type) as Promise<T>;
  }

  cancelAll(reason = 'cancelled'): void {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
    this.waiters.clear();
  }

  get pending(): number {
    return this.waiters.size;
  }
}
