/**
 * postMessage bridge between the MAIN-world script and the ISOLATED content
 * script. Both run in the same window but different JS realms, so
 * window.postMessage is the only channel. A hello/ack handshake establishes a
 * nonce; messages sent before the handshake are buffered.
 */
import { BRIDGE_TAG, BRIDGE_VERSION, type BridgeEnvelope } from './bridge-contract';

type Dir = 'm2i' | 'i2m';

export interface BridgeOptions<Out, In> {
  role: 'main' | 'iso';
  win?: Window;
  onMessage: (msg: In) => void;
  onReady?: () => void;
}

export class Bridge<Out extends { type: string }, In extends { type: string }> {
  private readonly win: Window;
  private readonly outDir: Dir;
  private readonly inDir: Dir;
  private nonce: string | null = null;
  private buffer: Out[] = [];
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onMessage: (msg: In) => void;
  private readonly onReady: (() => void) | undefined;
  private readonly listener: (ev: MessageEvent) => void;

  constructor(private readonly opts: BridgeOptions<Out, In>) {
    this.win = opts.win ?? window;
    this.outDir = opts.role === 'main' ? 'm2i' : 'i2m';
    this.inDir = opts.role === 'main' ? 'i2m' : 'm2i';
    this.onMessage = opts.onMessage;
    this.onReady = opts.onReady;
    this.listener = (ev) => this.handle(ev);
    this.win.addEventListener('message', this.listener);
    if (opts.role === 'main') this.startHello();
  }

  get ready(): boolean {
    return this.nonce !== null;
  }

  send(msg: Out): void {
    if (!this.ready) {
      this.buffer.push(msg);
      return;
    }
    this.post(msg);
  }

  dispose(): void {
    this.win.removeEventListener('message', this.listener);
    if (this.helloTimer) clearInterval(this.helloTimer);
  }

  private startHello(): void {
    const started = Date.now();
    const tick = () => {
      if (this.ready || Date.now() - started > 15_000) {
        if (this.helloTimer) clearInterval(this.helloTimer);
        this.helloTimer = null;
        return;
      }
      this.postRaw({ type: 'hello' } as unknown as Out, null);
    };
    tick();
    this.helloTimer = setInterval(tick, 250);
  }

  private post(msg: Out): void {
    this.postRaw(msg, this.nonce);
  }

  private postRaw(msg: Out, nonce: string | null): void {
    const env: BridgeEnvelope<Out> = { [BRIDGE_TAG]: BRIDGE_VERSION, dir: this.outDir, nonce, payload: msg };
    this.win.postMessage(env, this.win.location.origin);
  }

  private flush(): void {
    const b = this.buffer;
    this.buffer = [];
    for (const m of b) this.post(m);
  }

  private handle(ev: MessageEvent): void {
    if (ev.source !== this.win || ev.origin !== this.win.location.origin) return;
    const env = ev.data as BridgeEnvelope<In> | undefined;
    if (!env || typeof env !== 'object' || env[BRIDGE_TAG] !== BRIDGE_VERSION || env.dir !== this.inDir) return;
    const payload = env.payload;
    if (!payload || typeof payload.type !== 'string') return;

    if (this.opts.role === 'iso' && payload.type === 'hello') {
      if (!this.nonce) this.nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
      this.postRaw({ type: 'hello_ack', nonce: this.nonce } as unknown as Out, this.nonce);
      this.flush();
      this.onReady?.();
      return;
    }
    if (this.opts.role === 'main' && payload.type === 'hello_ack') {
      const n = (payload as unknown as { nonce: string }).nonce;
      if (!this.nonce) {
        this.nonce = n;
        this.flush();
        this.onReady?.();
      }
      return;
    }
    if (this.nonce && env.nonce !== this.nonce) return;
    this.onMessage(payload);
  }
}
