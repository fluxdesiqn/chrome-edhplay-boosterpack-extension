import type { Rpc } from '@shared/bridge-contract';

export async function rpc<T = unknown>(req: Rpc): Promise<T> {
  return (await chrome.runtime.sendMessage(req)) as T;
}

/** Acquire the per-room drive lock and keep it alive with heartbeats over a port. */
export class RoomLock {
  private port: chrome.runtime.Port | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  held = false;

  constructor(private readonly onChange: (held: boolean) => void) {}

  async acquire(roomId: string): Promise<boolean> {
    this.release();
    const res = await rpc<{ granted: boolean }>({ m: 'lock.acquire', roomId });
    this.held = !!res?.granted;
    this.onChange(this.held);
    try {
      this.port = chrome.runtime.connect({ name: 'hok-tab' });
      this.port.onMessage.addListener((m: { hb?: string; ok?: boolean }) => {
        if (m.hb === roomId && typeof m.ok === 'boolean' && m.ok !== this.held) {
          this.held = m.ok;
          this.onChange(this.held);
        }
      });
      this.port.onDisconnect.addListener(() => {
        this.port = null;
      });
      this.timer = setInterval(() => this.port?.postMessage({ hb: roomId }), 5000);
    } catch {
      /* extension context may be invalidated on reload */
    }
    return this.held;
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.port?.disconnect();
    } catch {
      /* ignore */
    }
    this.port = null;
    this.held = false;
  }
}
