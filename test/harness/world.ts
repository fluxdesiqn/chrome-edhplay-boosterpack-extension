/**
 * One "world" = one MAIN-world engine with its own fake `window`, its own ISO
 * bridge and its own tapped WebSocket. Several worlds can share a FakeServer
 * (two players in one room) without their bridges cross-talking.
 *
 * Scenarios must run under `vi.useFakeTimers({ shouldAdvanceTime: false })`:
 * the engine paces actions with real timers, so use `advance()` / `until()`.
 */
import { vi } from 'vitest';
import { Engine } from '@main/engine';
import type { CubeRuntime } from '@main/cube/runtime';
import { installWsTap, type WsTap } from '@main/ws-tap';
import { Bridge } from '@shared/bridge';
import type { Diag, IsoToMain, MainToIso } from '@shared/bridge-contract';
import type { WireCard } from '@shared/protocol';
import { defaultConfig, type Config, type HokGameState, type PeerView } from '@shared/state';
import type { FakeServer } from './fake-server';
import { FakeWs } from './fake-ws';

export const ORIGIN = 'https://edhplay.com';

type WinLike = Window & typeof globalThis;
type Frame = Record<string, unknown>;

// ---------------------------------------------------------------- fake window

/** `header.payload.sig` with payload `{sub}` base64url-encoded (what `localIdFromStorage` decodes). */
export function fakeJwt(sub: string): string {
  const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify({ sub, exp: 4102444800 }))}.sig`;
}

/**
 * A minimal stand-in for the page window: the tap replaces `WebSocket`, the engine
 * reads `localStorage`, and the Bridge uses `addEventListener('message')`,
 * `postMessage(env, origin)`, `ev.source === win` and `ev.origin === location.origin`.
 * Messages are delivered asynchronously (microtask) like real postMessage.
 */
export function makeFakeWindow(playerId: string): WinLike {
  const target = new EventTarget();
  const store = new Map<string, string>([['access_token', fakeJwt(playerId)]]);
  const win: Record<string, unknown> = {
    WebSocket: FakeWs,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    },
    location: { origin: ORIGIN, href: `${ORIGIN}/room/room-1`, hostname: 'edhplay.com', protocol: 'https:' },
    addEventListener: (t: string, l: EventListenerOrEventListenerObject, o?: unknown) => target.addEventListener(t, l, o as AddEventListenerOptions),
    removeEventListener: (t: string, l: EventListenerOrEventListenerObject, o?: unknown) => target.removeEventListener(t, l, o as EventListenerOptions),
    dispatchEvent: (e: Event) => target.dispatchEvent(e),
    postMessage: (data: unknown, _origin?: unknown) => {
      void Promise.resolve().then(() => {
        const ev = new MessageEvent('message', { data, origin: ORIGIN, source: win as unknown as Window });
        if (ev.source !== (win as unknown)) Object.defineProperty(ev, 'source', { value: win, configurable: true });
        target.dispatchEvent(ev);
      });
    },
  };
  return win as unknown as WinLike;
}

// ---------------------------------------------------------------- iso bridge

/** The content-script side of the bridge: records every MainToIso message. */
export class IsoBridge {
  readonly messages: MainToIso[] = [];
  private readonly bridge: Bridge<IsoToMain, MainToIso>;

  constructor(win: WinLike) {
    this.bridge = new Bridge<IsoToMain, MainToIso>({ role: 'iso', win, onMessage: (m) => this.messages.push(m) });
  }

  get ready(): boolean {
    return this.bridge.ready;
  }

  send(msg: IsoToMain): void {
    this.bridge.send(msg);
  }

  of<T extends MainToIso['type']>(type: T): Extract<MainToIso, { type: T }>[] {
    return this.messages.filter((m): m is Extract<MainToIso, { type: T }> => m.type === type);
  }

  last<T extends MainToIso['type']>(type: T): Extract<MainToIso, { type: T }> | undefined {
    const all = this.of(type);
    return all[all.length - 1];
  }

  state(): HokGameState | null {
    return this.last('state')?.state ?? null;
  }

  offer(): Extract<MainToIso, { type: 'offer' }> | undefined {
    return this.last('offer');
  }

  peers(): PeerView[] {
    return this.last('peers')?.peers ?? [];
  }

  peer(ownerId: string): PeerView | undefined {
    return this.peers().find((p) => p.ownerId === ownerId);
  }

  diags(): Diag[] {
    return this.of('diag').map((d) => d.diag);
  }

  socketEvents(): string[] {
    return this.of('socket').map((s) => s.ev);
  }

  dispose(): void {
    this.bridge.dispose();
  }
}

// ---------------------------------------------------------------- world

export interface WorldOptions {
  playerId: string;
  roomId?: string;
  cube?: CubeRuntime;
}

export interface World {
  readonly playerId: string;
  readonly roomId: string;
  readonly win: WinLike;
  readonly iso: IsoBridge;
  readonly tap: WsTap;
  readonly engine: Engine;
  /** Frames the page's own listeners received (after the tap's pipeline), parsed. */
  readonly appFrames: Frame[];
  /** The tapped socket (after `connect`). */
  readonly socket: WebSocket;
  /** ISO → MAIN `hydrate` (state null = fresh room). */
  hydrate(state?: HokGameState | null, config?: Config, readOnly?: boolean): void;
  send(msg: IsoToMain): void;
  /** Construct the page's socket through the tapped constructor and attach it to the server. */
  connect(server: FakeServer, opts?: { pv?: number | string }): WebSocket;
  /** Send a frame the way the page would (through the tapped socket's `send`). */
  appSend(msg: Frame): void;
  /** Frames the page saw that mention `cardId` anywhere. */
  framesFor(cardId: string): Frame[];
  /** The card object for `cardId` from the last frame the page saw mentioning it. */
  lastCardSeen(cardId: string): WireCard | null;
  dispose(): void;
}

export function createWorld(opts: WorldOptions): World {
  const roomId = opts.roomId ?? 'room-1';
  const win = makeFakeWindow(opts.playerId);
  const iso = new IsoBridge(win); // registered before the engine so the first `hello` lands
  const tap = installWsTap(win);
  const engine = new Engine(tap, win, opts.cube ?? null);
  const appFrames: Frame[] = [];
  let socket: WebSocket | null = null;

  const world: World = {
    playerId: opts.playerId,
    roomId,
    win,
    iso,
    tap,
    engine,
    appFrames,
    get socket() {
      if (!socket) throw new Error('world.socket: connect() first');
      return socket;
    },
    hydrate(state = null, config = defaultConfig, readOnly = false) {
      iso.send({ type: 'hydrate', roomId, state, config, readOnly });
    },
    send(msg) {
      iso.send(msg);
    },
    connect(server, o = {}) {
      const url = server.urlFor(opts.playerId, o.pv ?? 4);
      socket = new win.WebSocket(url);
      socket.addEventListener('message', (e) => {
        const parsed = parseFrame((e as MessageEvent).data);
        if (parsed) appFrames.push(parsed);
      });
      server.connect(FakeWs.last(), opts.playerId);
      return socket;
    },
    appSend(msg) {
      world.socket.send(JSON.stringify(msg));
    },
    framesFor(cardId) {
      return appFrames.filter((f) => findCard(f, cardId) !== null);
    },
    lastCardSeen(cardId) {
      for (let i = appFrames.length - 1; i >= 0; i--) {
        const c = findCard(appFrames[i], cardId);
        if (c) return c;
      }
      return null;
    },
    dispose() {
      iso.dispose();
      socket?.close();
    },
  };
  return world;
}

// ---------------------------------------------------------------- time

export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Flush microtasks and zero-delay timers. */
export async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Advance virtual time in `step` ms slices until `pred()` holds (or `maxMs` elapsed → throws). */
export async function until(pred: () => boolean, what = 'condition', opts: { maxMs?: number; step?: number } = {}): Promise<void> {
  const maxMs = opts.maxMs ?? 40_000;
  const step = opts.step ?? 200;
  let elapsed = 0;
  while (true) {
    if (pred()) return;
    if (elapsed >= maxMs) throw new Error(`until(${what}): not satisfied after ${maxMs} ms of virtual time`);
    await advance(step);
    elapsed += step;
  }
}

// ---------------------------------------------------------------- frame helpers

export function parseFrame(data: unknown): Frame | null {
  let text: string | null = null;
  if (typeof data === 'string') text = data;
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(data));
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Frame) : null;
  } catch {
    return null;
  }
}

/** Deep search for a card-like object (`id` plus `name`/`card_print_id`) with the given id. */
export function findCard(node: unknown, id: string): WireCard | null {
  if (typeof node !== 'object' || node === null) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findCard(child, id);
      if (hit) return hit;
    }
    return null;
  }
  const o = node as Record<string, unknown>;
  if (o['id'] === id && ('name' in o || 'card_print_id' in o)) return o as WireCard;
  for (const v of Object.values(o)) {
    const hit = findCard(v, id);
    if (hit) return hit;
  }
  return null;
}
