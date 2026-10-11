/**
 * MAIN-world WebSocket tap.
 *
 * Replaces `window.WebSocket` with a subclass so the extension can observe and
 * rewrite inbound game frames before the app's listeners see them, drop or
 * replace outbound frames, and write its own raw frames on the app's socket.
 *
 * Single-dispatch model: exactly one native `message` listener is registered in
 * the constructor; the app's `onmessage` and `addEventListener('message')`
 * registrations are kept in our own ordered list and invoked by `#dispatch`
 * after the pipeline has decided what (if anything) to deliver.
 */
import type { SocketCtx } from '@shared/bridge-contract';
import { GAME_WS_HOST, GAME_WS_PATH, gameStateProblems } from '@shared/protocol';
import { decodeFrame, encodeFrameLike, frameKind, safeParse } from './frame-codec';

export type FrameDecision = { kind: 'pass' } | { kind: 'drop' } | { kind: 'replace'; msg: Record<string, unknown> };
export type OutboundDecision = { kind: 'pass' } | { kind: 'drop' } | { kind: 'replace'; msgs: Record<string, unknown>[] };

export type SocketEvent = 'opened' | 'confirmed' | 'closed' | 'unsupported' | 'error';

export interface TapHandlers {
  /** Called BEFORE the app sees the frame (only for parsed JSON frames past the gate). */
  onFrame?: (ctx: SocketCtx, msg: Record<string, unknown>, raw: string) => FrameDecision;
  /** Called on app sends that decode to a JSON object with a string `type`. */
  onOutbound?: (ctx: SocketCtx, msg: Record<string, unknown>) => OutboundDecision;
  onSocket?: (ev: SocketEvent, ctx: SocketCtx, detail?: unknown) => void;
}

export interface WsTap {
  setHandlers(h: TapHandlers): void;
  /** Resolves when written to the active, confirmed socket; queued until then; rejects if the socket closes first. */
  sendRaw(msg: Record<string, unknown>): Promise<void>;
  active(): SocketCtx | null;
  activeSocket(): WebSocket | null;
}

const TAP_KEY = Symbol.for('hok.ws.tap');

/** Only `wss://api.edhplay.com/ws/game?...` URLs are game sockets. */
export function parseGameSocketUrl(url: string): { roomId: string; pv: string; spectator: boolean } | null {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== 'wss:' || u.hostname !== GAME_WS_HOST || u.pathname !== GAME_WS_PATH) return null;
  const roomId = u.searchParams.get('room_id');
  if (!roomId) return null;
  const pv = u.searchParams.get('pv') ?? '';
  const spectator = u.searchParams.get('spectator') === 'true';
  return { roomId, pv, spectator };
}

/** Internal per-socket context: SocketCtx plus the tap-private `unsupported` flag. */
interface TapCtx extends SocketCtx {
  unsupported: boolean;
}

interface PendingRaw {
  msg: Record<string, unknown>;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface MessageListenerEntry {
  cb: EventListenerOrEventListenerObject;
  once: boolean;
}

type WinLike = Window & typeof globalThis;

export function installWsTap(win: WinLike = window): WsTap {
  const existing = (win as unknown as Record<symbol, unknown>)[TAP_KEY];
  if (existing) return existing as WsTap;

  const Native = win.WebSocket;
  let handlers: TapHandlers = {};
  const pending: PendingRaw[] = [];
  /** game sockets → ctx; insertion order = construction order */
  const sockets = new Map<WebSocket, TapCtx>();
  let confirmSeq = 0;
  const confirmedAt = new WeakMap<WebSocket, number>();

  const emit = (ev: SocketEvent, ctx: TapCtx, detail?: unknown): void => {
    try {
      handlers.onSocket?.(ev, ctx, detail);
    } catch {
      /* never let a handler throw into the app */
    }
  };

  const findActive = (): [WebSocket, TapCtx] | null => {
    let best: [WebSocket, TapCtx] | null = null;
    let bestSeq = -1;
    for (const [sock, ctx] of sockets) {
      if (!ctx.confirmed || ctx.unsupported || sock.readyState !== Native.OPEN) continue;
      const seq = confirmedAt.get(sock) ?? 0;
      if (seq > bestSeq) {
        bestSeq = seq;
        best = [sock, ctx];
      }
    }
    return best;
  };

  const writeRaw = (sock: WebSocket, ctx: TapCtx, msg: Record<string, unknown>): void => {
    const frame = encodeFrameLike(JSON.stringify(msg), ctx.binaryOut ? 'binary' : 'text');
    Native.prototype.send.call(sock, frame);
  };

  const rejectPending = (reason: string): void => {
    if (pending.length === 0) return;
    const items = pending.splice(0, pending.length);
    for (const p of items) p.reject(new Error(reason));
  };

  const flushPending = (sock: WebSocket, ctx: TapCtx): void => {
    while (pending.length > 0) {
      if (sock.readyState !== Native.OPEN) return;
      const p = pending.shift()!;
      try {
        writeRaw(sock, ctx, p.msg);
        p.resolve();
      } catch (err) {
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  const onlyGameSocketRemains = (except: WebSocket): boolean => {
    for (const [sock, ctx] of sockets) {
      if (sock !== except && ctx.confirmed && !ctx.unsupported && sock.readyState === Native.OPEN) return false;
    }
    return true;
  };

  class TappedWebSocket extends Native {
    readonly #ctx: TapCtx | null;
    #onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
    readonly #listeners: MessageListenerEntry[] = [];

    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      // Some environments define `onmessage` as an own instance field; our prototype accessor must win.
      if (Object.prototype.hasOwnProperty.call(this, 'onmessage')) {
        try {
          delete (this as unknown as Record<string, unknown>).onmessage;
        } catch {
          /* ignore */
        }
      }
      const parsed = parseGameSocketUrl(String(url));
      this.#ctx = parsed ? { ...parsed, confirmed: false, binaryOut: false, protocolVersion: null, problems: [], unsupported: false } : null;

      super.addEventListener('message', (ev: Event) => this.#dispatch(ev as MessageEvent));

      if (this.#ctx) {
        const ctx = this.#ctx;
        sockets.set(this, ctx);
        super.addEventListener('open', () => emit('opened', ctx));
        super.addEventListener('close', (ev: Event) => {
          sockets.delete(this);
          if (onlyGameSocketRemains(this)) rejectPending('socket closed before raw send could be written');
          emit('closed', ctx, ev);
        });
      }
    }

    // ----- app-facing listener registry -----------------------------------

    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (!listener) return;
      if (type !== 'message') {
        super.addEventListener(type, listener, options);
        return;
      }
      if (this.#listeners.some((e) => e.cb === listener)) return; // same semantics as native: no duplicates
      const once = typeof options === 'object' && options !== null && options.once === true;
      this.#listeners.push({ cb: listener, once });
    }

    override removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      if (!listener) return;
      if (type !== 'message') {
        super.removeEventListener(type, listener, options);
        return;
      }
      const i = this.#listeners.findIndex((e) => e.cb === listener);
      if (i >= 0) this.#listeners.splice(i, 1);
    }

    /** Accessed by the prototype accessor installed below. */
    getOnMessage(): ((this: WebSocket, ev: MessageEvent) => unknown) | null {
      return this.#onmessage;
    }
    setOnMessage(fn: unknown): void {
      this.#onmessage = typeof fn === 'function' ? (fn as (this: WebSocket, ev: MessageEvent) => unknown) : null;
    }

    // ----- outbound -------------------------------------------------------

    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      const ctx = this.#ctx;
      if (!ctx) {
        super.send(data);
        return;
      }
      const kind = frameKind(data);
      ctx.binaryOut = kind === 'binary';
      if (ctx.unsupported || !handlers.onOutbound) {
        super.send(data);
        return;
      }
      const text = decodeFrame(data);
      const msg = text === null ? null : safeParse(text);
      if (!msg) {
        super.send(data);
        return;
      }
      let decision: OutboundDecision;
      try {
        decision = handlers.onOutbound(ctx, msg);
      } catch (err) {
        emit('error', ctx, err);
        super.send(data);
        return;
      }
      switch (decision.kind) {
        case 'drop':
          return;
        case 'replace': {
          const like = kind === 'binary' ? 'binary' : 'text';
          for (const m of decision.msgs) super.send(encodeFrameLike(JSON.stringify(m), like));
          return;
        }
        default:
          super.send(data);
      }
    }

    // ----- inbound --------------------------------------------------------

    #dispatch(ev: MessageEvent): void {
      const ctx = this.#ctx;
      if (!ctx) {
        this.#deliver(ev);
        return;
      }
      let action: FrameDecision = { kind: 'pass' };
      try {
        action = this.#pipeline(ctx, ev.data);
      } catch (err) {
        emit('error', ctx, err);
        action = { kind: 'pass' };
      }
      switch (action.kind) {
        case 'drop':
          return;
        case 'replace': {
          const like = frameKind(ev.data) === 'binary' ? 'binary' : 'text';
          let newData: string | ArrayBuffer;
          try {
            newData = encodeFrameLike(JSON.stringify(action.msg), like);
          } catch (err) {
            emit('error', ctx, err);
            this.#deliver(ev);
            return;
          }
          // Shadow the prototype accessor with an own property so the app sees the rewritten payload
          // while `e.target`, `origin` etc. stay intact.
          Object.defineProperty(ev, 'data', { value: newData, configurable: true, enumerable: true, writable: false });
          this.#deliver(ev);
          return;
        }
        default:
          this.#deliver(ev);
      }
    }

    #pipeline(ctx: TapCtx, data: unknown): FrameDecision {
      if (ctx.unsupported) return { kind: 'pass' };
      const text = decodeFrame(data);
      if (text === null) return { kind: 'pass' };
      const msg = safeParse(text);
      if (!msg) return { kind: 'pass' };
      if (msg.type === 'ping') return { kind: 'pass' };

      if (!ctx.confirmed) {
        if (msg.type !== 'game_state') return { kind: 'pass' };
        // Gate on shape, not on the version number: a bump that leaves what we read intact keeps working.
        ctx.protocolVersion = typeof msg.protocol_version === 'number' ? msg.protocol_version : null;
        const problems = gameStateProblems(msg);
        if (problems.length > 0) {
          ctx.unsupported = true;
          ctx.problems = problems;
          emit('unsupported', ctx, problems);
          rejectPending(`unsupported game protocol: ${problems.join('; ')}`);
          return { kind: 'pass' };
        }
        ctx.confirmed = true;
        confirmedAt.set(this, ++confirmSeq);
        emit('confirmed', ctx);
        flushPending(this, ctx);
      }

      const onFrame = handlers.onFrame;
      if (!onFrame) return { kind: 'pass' };
      try {
        const d = onFrame(ctx, msg, text);
        return d && typeof d === 'object' ? d : { kind: 'pass' };
      } catch (err) {
        emit('error', ctx, err);
        return { kind: 'pass' };
      }
    }

    #deliver(ev: MessageEvent): void {
      const fn = this.#onmessage;
      if (fn) {
        try {
          fn.call(this, ev);
        } catch (err) {
          reportListenerError(err);
        }
      }
      if (this.#listeners.length === 0) return;
      // Snapshot so listeners added/removed during dispatch don't disturb this round.
      const round = this.#listeners.slice();
      for (const entry of round) {
        if (entry.once) {
          const i = this.#listeners.indexOf(entry);
          if (i >= 0) this.#listeners.splice(i, 1);
        } else if (!this.#listeners.includes(entry)) {
          continue; // removed by an earlier listener in this round
        }
        try {
          if (typeof entry.cb === 'function') entry.cb.call(this, ev);
          else entry.cb.handleEvent(ev);
        } catch (err) {
          reportListenerError(err);
        }
      }
    }
  }

  // `onmessage` is a data property on lib.dom's WebSocket type, so it cannot be declared as a class accessor;
  // install it on the prototype instead. It never touches the native setter.
  Object.defineProperty(TappedWebSocket.prototype, 'onmessage', {
    configurable: true,
    enumerable: true,
    get(this: TappedWebSocket) {
      return this.getOnMessage();
    },
    set(this: TappedWebSocket, fn: unknown) {
      this.setOnMessage(fn);
    },
  });

  const tap: WsTap = {
    setHandlers(h) {
      handlers = h ?? {};
    },
    sendRaw(msg) {
      const act = findActive();
      if (act) {
        const [sock, ctx] = act;
        try {
          writeRaw(sock, ctx, msg);
          return Promise.resolve();
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      // No usable socket: if every registered game socket is unsupported, fail fast; otherwise queue.
      if (sockets.size > 0 && [...sockets.values()].every((c) => c.unsupported)) {
        return Promise.reject(new Error('game socket protocol version unsupported'));
      }
      return new Promise<void>((resolve, reject) => pending.push({ msg, resolve, reject }));
    },
    active() {
      const act = findActive();
      return act ? act[1] : null;
    },
    activeSocket() {
      const act = findActive();
      return act ? act[0] : null;
    },
  };

  try {
    Object.defineProperty(win, 'WebSocket', { value: TappedWebSocket, configurable: true, writable: true });
  } catch {
    (win as unknown as { WebSocket: unknown }).WebSocket = TappedWebSocket;
  }
  Object.defineProperty(win, TAP_KEY, { value: tap, configurable: true, enumerable: false });
  return tap;
}

function reportListenerError(err: unknown): void {
  // Mirror the browser: a throwing listener is reported asynchronously and does not break dispatch.
  setTimeout(() => {
    throw err;
  }, 0);
}
