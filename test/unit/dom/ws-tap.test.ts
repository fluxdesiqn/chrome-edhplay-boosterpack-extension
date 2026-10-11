// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWsTap, parseGameSocketUrl, type TapHandlers, type WsTap } from '@main/ws-tap';
import type { SocketCtx } from '@shared/bridge-contract';

const GAME_URL = 'wss://api.edhplay.com/ws/game?room_id=room-1&token=jwt&pv=4&cs=uuid-1';

type OnFrame = NonNullable<TapHandlers['onFrame']>;
type OnOutbound = NonNullable<TapHandlers['onOutbound']>;
const frameFn = (d: ReturnType<OnFrame>) => vi.fn<OnFrame>(() => d);
const outboundFn = (d: ReturnType<OnOutbound>) => vi.fn<OnOutbound>(() => d);

/** Minimal native-WebSocket stand-in. */
class FakeWS extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWS[] = [];

  readonly url: string;
  readyState = FakeWS.CONNECTING;
  binaryType: BinaryType = 'blob';
  sent: unknown[] = [];

  constructor(url: string | URL, _protocols?: string | string[]) {
    super();
    this.url = String(url);
    FakeWS.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWS.CLOSED;
    this.dispatchEvent(new Event('close'));
  }

  // --- test helpers ---
  open(): void {
    this.readyState = FakeWS.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  emit(data: unknown): MessageEvent {
    const ev = new MessageEvent('message', { data, origin: 'wss://api.edhplay.com' });
    this.dispatchEvent(ev);
    return ev;
  }
}

type TappedCtor = typeof WebSocket;
interface Harness {
  win: { WebSocket: TappedCtor };
  tap: WsTap;
  events: Array<{ ev: string; ctx: SocketCtx; detail?: unknown }>;
  handlers: TapHandlers;
  Native: typeof FakeWS;
}

function setup(handlers: TapHandlers = {}): Harness {
  FakeWS.instances = [];
  const win = { WebSocket: FakeWS as unknown as TappedCtor };
  const tap = installWsTap(win as unknown as Window & typeof globalThis);
  const events: Harness['events'] = [];
  const full: TapHandlers = {
    ...handlers,
    onSocket: (ev, ctx, detail) => {
      events.push({ ev, ctx, detail });
      handlers.onSocket?.(ev, ctx, detail);
    },
  };
  tap.setHandlers(full);
  return { win, tap, events, handlers: full, Native: FakeWS };
}

function native(i = 0): FakeWS {
  return FakeWS.instances[i]!;
}

const gameState = (pv = 4) => JSON.stringify({ type: 'game_state', protocol_version: pv, players: [] });
const enc = (s: string): ArrayBuffer => {
  const b = new TextEncoder().encode(s);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const dec = (d: unknown): string => (typeof d === 'string' ? d : new TextDecoder().decode(d as ArrayBuffer));

function openConfirmed(h: Harness): WebSocket {
  const ws = new h.win.WebSocket(GAME_URL);
  native().open();
  native().emit(gameState(4));
  return ws;
}

describe('parseGameSocketUrl', () => {
  it('parses a game socket url', () => {
    expect(parseGameSocketUrl(GAME_URL)).toEqual({ roomId: 'room-1', pv: '4', spectator: false });
    expect(parseGameSocketUrl(GAME_URL + '&spectator=true')).toEqual({ roomId: 'room-1', pv: '4', spectator: true });
  });
  it('rejects other urls', () => {
    expect(parseGameSocketUrl('wss://api.edhplay.com/ws/lobby?room_id=x')).toBeNull();
    expect(parseGameSocketUrl('wss://other.example.com/ws/game?room_id=x')).toBeNull();
    expect(parseGameSocketUrl('ws://api.edhplay.com/ws/game?room_id=x')).toBeNull();
    expect(parseGameSocketUrl('wss://api.edhplay.com/ws/game')).toBeNull();
    expect(parseGameSocketUrl('not a url')).toBeNull();
  });
});

describe('installWsTap', () => {
  beforeEach(() => {
    FakeWS.instances = [];
  });

  it('is idempotent per window and keeps static constants / instanceof', () => {
    const h = setup();
    const again = installWsTap(h.win as unknown as Window & typeof globalThis);
    expect(again).toBe(h.tap);
    expect(h.win.WebSocket).not.toBe(FakeWS);
    expect(h.win.WebSocket.OPEN).toBe(1);
    expect(h.win.WebSocket.CLOSED).toBe(3);
    const ws = new h.win.WebSocket(GAME_URL);
    expect(ws).toBeInstanceOf(FakeWS);
    expect(ws).toBeInstanceOf(h.win.WebSocket);
  });

  it('passes non-game sockets straight through without a pipeline', () => {
    const onFrame = frameFn({ kind: 'pass' });
    const h = setup({ onFrame });
    const ws = new h.win.WebSocket('wss://api.edhplay.com/ws/lobby?x=1');
    const got: unknown[] = [];
    ws.onmessage = (e) => got.push(e.data);
    ws.addEventListener('message', (e) => got.push((e as MessageEvent).data));
    native().open();
    native().emit(gameState(4));
    ws.send('hi');
    expect(got).toEqual([gameState(4), gameState(4)]);
    expect(onFrame).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(h.tap.active()).toBeNull();
    expect(native().sent).toEqual(['hi']);
  });

  it('emits opened with ctx for game sockets', () => {
    const h = setup();
    new h.win.WebSocket(GAME_URL + '&spectator=true');
    native().open();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.ev).toBe('opened');
    expect(h.events[0]!.ctx).toMatchObject({ roomId: 'room-1', pv: '4', spectator: true, confirmed: false, binaryOut: false });
  });

  describe('listener registry', () => {
    it('delivers to onmessage and addEventListener listeners in order, with e.target = socket', () => {
      const h = setup();
      const ws = openConfirmed(h);
      const order: string[] = [];
      let target: unknown = null;
      ws.onmessage = (e) => {
        order.push('onmessage');
        target = e.target;
      };
      ws.addEventListener('message', () => order.push('a'));
      ws.addEventListener('message', () => order.push('b'));
      native().emit(JSON.stringify({ type: 'turn_passed' }));
      expect(order).toEqual(['onmessage', 'a', 'b']);
      expect(target).toBe(ws);
      expect(ws.onmessage).toBeTypeOf('function');
    });

    it('honors once listeners', () => {
      const h = setup();
      const ws = openConfirmed(h);
      const fn = vi.fn();
      ws.addEventListener('message', fn, { once: true });
      native().emit(JSON.stringify({ type: 'a' }));
      native().emit(JSON.stringify({ type: 'b' }));
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('removeEventListener works and onmessage can be cleared', () => {
      const h = setup();
      const ws = openConfirmed(h);
      const fn = vi.fn();
      const om = vi.fn();
      ws.addEventListener('message', fn);
      ws.onmessage = om;
      native().emit(JSON.stringify({ type: 'a' }));
      ws.removeEventListener('message', fn);
      ws.onmessage = null;
      native().emit(JSON.stringify({ type: 'b' }));
      expect(fn).toHaveBeenCalledTimes(1);
      expect(om).toHaveBeenCalledTimes(1);
      expect(ws.onmessage).toBeNull();
    });

    it('a throwing listener does not stop the others', () => {
      vi.useFakeTimers();
      try {
        const h = setup();
        const ws = openConfirmed(h);
        const second = vi.fn();
        ws.addEventListener('message', () => {
          throw new Error('boom');
        });
        ws.addEventListener('message', second);
        native().emit(JSON.stringify({ type: 'a' }));
        expect(second).toHaveBeenCalledTimes(1);
        expect(() => vi.runAllTimers()).toThrow('boom');
      } finally {
        vi.useRealTimers();
      }
    });

    it('delegates non-message listener types to the native socket', () => {
      const h = setup();
      const ws = new h.win.WebSocket(GAME_URL);
      const onOpen = vi.fn();
      ws.addEventListener('open', onOpen);
      native().open();
      expect(onOpen).toHaveBeenCalledTimes(1);
      ws.removeEventListener('open', onOpen);
      native().open();
      expect(onOpen).toHaveBeenCalledTimes(1);
    });
  });

  describe('inbound pipeline', () => {
    it('delivers ping frames byte-identical without calling onFrame', () => {
      const onFrame = frameFn({ kind: 'drop' });
      const h = setup({ onFrame });
      const ws = openConfirmed(h);
      onFrame.mockClear(); // the confirming game_state itself is handed to onFrame
      const ping = '{"type":"ping","t":1}';
      let seen: unknown;
      ws.onmessage = (e) => (seen = e.data);
      native().emit(ping);
      expect(seen).toBe(ping);
      expect(onFrame).not.toHaveBeenCalled();
    });

    it('passes non-game_state frames before the gate without calling onFrame', () => {
      const onFrame = frameFn({ kind: 'drop' });
      const h = setup({ onFrame });
      const ws = new h.win.WebSocket(GAME_URL);
      native().open();
      const seen: unknown[] = [];
      ws.onmessage = (e) => seen.push(e.data);
      native().emit(JSON.stringify({ type: 'chat_message_received', message: 'x' }));
      native().emit('not json');
      expect(seen).toHaveLength(2);
      expect(onFrame).not.toHaveBeenCalled();
      expect(h.tap.active()).toBeNull();
      expect(h.events.map((e) => e.ev)).toEqual(['opened']);
    });

    it('game_state with pv 5 but the same shape → confirmed, protocolVersion recorded', () => {
      const h = setup({ onFrame: frameFn({ kind: 'pass' }) });
      new h.win.WebSocket(GAME_URL);
      native().open();
      native().emit(gameState(5));
      expect(h.events.map((e) => e.ev)).toEqual(['opened', 'confirmed']);
      expect(h.tap.active()).toMatchObject({ confirmed: true, protocolVersion: 5, problems: [] });
    });

    it('game_state without players → unsupported; later frames untouched; sendRaw rejects', async () => {
      const onFrame = frameFn({ kind: 'drop' });
      const h = setup({ onFrame });
      const ws = new h.win.WebSocket(GAME_URL);
      native().open();
      const seen: unknown[] = [];
      ws.onmessage = (e) => seen.push(e.data);
      const bad = JSON.stringify({ type: 'game_state', protocol_version: 5, seats: [] });
      native().emit(bad);
      expect(h.events.map((e) => e.ev)).toEqual(['opened', 'unsupported']);
      expect(h.events[1]!.detail).toEqual(['game_state.players is missing']);
      const later = JSON.stringify({ type: 'move_card', id: 'x' });
      native().emit(later);
      expect(seen).toEqual([bad, later]);
      expect(onFrame).not.toHaveBeenCalled();
      expect(h.tap.active()).toBeNull();
      await expect(h.tap.sendRaw({ type: 'pong' })).rejects.toThrow(/unsupported/);
      // a further game_state does not un-flag it
      native().emit(gameState(4));
      expect(onFrame).not.toHaveBeenCalled();
      expect(native().sent).toEqual([]);
    });

    it('game_state pv 4 → confirmed, onFrame sees it and later frames', () => {
      const onFrame = frameFn({ kind: 'pass' });
      const h = setup({ onFrame });
      const ws = openConfirmed(h);
      expect(h.events.map((e) => e.ev)).toEqual(['opened', 'confirmed']);
      expect(h.tap.active()).toMatchObject({ roomId: 'room-1', confirmed: true });
      expect(h.tap.activeSocket()).toBe(ws);
      expect(onFrame).toHaveBeenCalledTimes(1);
      expect(onFrame.mock.calls[0]![1]).toMatchObject({ type: 'game_state', protocol_version: 4 });
      expect(onFrame.mock.calls[0]![2]).toBe(gameState(4));
      native().emit(JSON.stringify({ type: 'turn_passed' }));
      expect(onFrame).toHaveBeenCalledTimes(2);
    });

    it('replace yields modified data of the same kind (text)', () => {
      const h = setup({ onFrame: (_ctx, msg) => ({ kind: 'replace', msg: { ...msg, rewritten: true } }) });
      const ws = openConfirmed(h);
      let ev: MessageEvent | null = null;
      ws.onmessage = (e) => (ev = e);
      const original = native().emit(JSON.stringify({ type: 'move_card', id: 'c1' }));
      expect(ev).toBe(original);
      expect(typeof ev!.data).toBe('string');
      expect(JSON.parse(ev!.data as string)).toEqual({ type: 'move_card', id: 'c1', rewritten: true });
      expect(ev!.target).toBe(ws);
      expect(ev!.origin).toBe('wss://api.edhplay.com');
    });

    it('replace yields modified data of the same kind (binary)', () => {
      const h = setup({ onFrame: (_ctx, msg) => ({ kind: 'replace', msg: { ...msg, rewritten: true } }) });
      const ws = openConfirmed(h);
      let data: unknown;
      ws.addEventListener('message', (e) => (data = (e as MessageEvent).data));
      const input = enc(JSON.stringify({ type: 'move_card', id: 'c1' }));
      native().emit(input);
      expect(data).toBeInstanceOf(ArrayBuffer);
      expect(data).not.toBe(input);
      expect(JSON.parse(dec(data))).toEqual({ type: 'move_card', id: 'c1', rewritten: true });
    });

    it('decodes binary game_state through the gate', () => {
      const onFrame = frameFn({ kind: 'pass' });
      const h = setup({ onFrame });
      new h.win.WebSocket(GAME_URL);
      native().open();
      native().emit(enc(gameState(4)));
      expect(h.events.map((e) => e.ev)).toEqual(['opened', 'confirmed']);
      expect(onFrame).toHaveBeenCalledTimes(1);
    });

    it('drop delivers nothing', () => {
      const h = setup({ onFrame: (_ctx, msg) => (msg.type === 'secret' ? { kind: 'drop' } : { kind: 'pass' }) });
      const ws = openConfirmed(h);
      const seen: unknown[] = [];
      ws.onmessage = (e) => seen.push(e.data);
      ws.addEventListener('message', (e) => seen.push((e as MessageEvent).data));
      native().emit(JSON.stringify({ type: 'secret' }));
      expect(seen).toEqual([]);
      const ok = JSON.stringify({ type: 'fine' });
      native().emit(ok);
      expect(seen).toEqual([ok, ok]);
    });

    it('a throwing onFrame emits error and passes the frame through', () => {
      const h = setup({
        onFrame: () => {
          throw new Error('handler broke');
        },
      });
      const ws = openConfirmed(h);
      const seen: unknown[] = [];
      ws.onmessage = (e) => seen.push(e.data);
      const raw = JSON.stringify({ type: 'x' });
      native().emit(raw);
      expect(seen).toEqual([raw]);
      const errs = h.events.filter((e) => e.ev === 'error');
      expect(errs.length).toBeGreaterThanOrEqual(1);
      expect((errs.at(-1)!.detail as Error).message).toBe('handler broke');
    });
  });

  describe('outbound', () => {
    it('pass sends the original data; non-JSON is never inspected', () => {
      const onOutbound = outboundFn({ kind: 'pass' });
      const h = setup({ onOutbound });
      const ws = openConfirmed(h);
      const pong = JSON.stringify({ type: 'pong' });
      ws.send(pong);
      ws.send('garbage');
      expect(native().sent).toEqual([pong, 'garbage']);
      expect(onOutbound).toHaveBeenCalledTimes(1);
      expect(onOutbound.mock.calls[0]![1]).toEqual({ type: 'pong' });
    });

    it('drop sends nothing', () => {
      const h = setup({ onOutbound: () => ({ kind: 'drop' }) });
      const ws = openConfirmed(h);
      ws.send(JSON.stringify({ type: 'draw_card' }));
      expect(native().sent).toEqual([]);
    });

    it('replace sends msgs in order, encoded like the original kind', () => {
      const h = setup({
        onOutbound: () => ({ kind: 'replace', msgs: [{ type: 'a', n: 1 }, { type: 'b', n: 2 }] }),
      });
      const ws = openConfirmed(h);
      ws.send(JSON.stringify({ type: 'draw_card' }));
      expect(native().sent.map((d) => JSON.parse(dec(d)))).toEqual([
        { type: 'a', n: 1 },
        { type: 'b', n: 2 },
      ]);
      expect(native().sent.every((d) => typeof d === 'string')).toBe(true);

      native().sent = [];
      ws.send(enc(JSON.stringify({ type: 'draw_card' })));
      expect(native().sent.every((d) => d instanceof ArrayBuffer)).toBe(true);
      expect(native().sent.map((d) => JSON.parse(dec(d)).type)).toEqual(['a', 'b']);
    });

    it('mirrors binaryOut from the app sends and sendRaw follows it', async () => {
      const h = setup();
      const ws = openConfirmed(h);
      expect(h.tap.active()!.binaryOut).toBe(false);
      await h.tap.sendRaw({ type: 'pong' });
      expect(typeof native().sent.at(-1)).toBe('string');

      ws.send(enc(JSON.stringify({ type: 'pong' })));
      expect(h.tap.active()!.binaryOut).toBe(true);
      await h.tap.sendRaw({ type: 'resync' });
      expect(native().sent.at(-1)).toBeInstanceOf(ArrayBuffer);
      expect(JSON.parse(dec(native().sent.at(-1)))).toEqual({ type: 'resync' });

      ws.send(JSON.stringify({ type: 'pong' }));
      expect(h.tap.active()!.binaryOut).toBe(false);
    });

    it('sendRaw bypasses onOutbound', async () => {
      const onOutbound = outboundFn({ kind: 'drop' });
      const h = setup({ onOutbound });
      openConfirmed(h);
      await h.tap.sendRaw({ type: 'resync' });
      expect(onOutbound).not.toHaveBeenCalled();
      expect(native().sent).toEqual([JSON.stringify({ type: 'resync' })]);
    });
  });

  describe('sendRaw queueing', () => {
    it('queues before confirmation and flushes in FIFO order after', async () => {
      const h = setup();
      const p1 = h.tap.sendRaw({ type: 'a' });
      const p2 = h.tap.sendRaw({ type: 'b' });
      let settled = false;
      void p1.then(() => (settled = true));
      new h.win.WebSocket(GAME_URL);
      native().open();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(native().sent).toEqual([]);
      native().emit(gameState(4));
      await Promise.all([p1, p2]);
      expect(native().sent.map((d) => JSON.parse(dec(d)).type)).toEqual(['a', 'b']);
    });

    it('rejects queued sends when the socket closes first, and emits closed', async () => {
      const h = setup();
      const p = h.tap.sendRaw({ type: 'a' });
      new h.win.WebSocket(GAME_URL);
      native().open();
      native().close();
      await expect(p).rejects.toThrow(/closed/);
      expect(h.events.map((e) => e.ev)).toEqual(['opened', 'closed']);
      expect(h.tap.active()).toBeNull();
      expect(h.tap.activeSocket()).toBeNull();
    });

    it('a closed confirmed socket is no longer active; a newer confirmed socket takes over', async () => {
      const h = setup();
      const first = openConfirmed(h);
      expect(h.tap.activeSocket()).toBe(first);
      native(0).close();
      expect(h.tap.active()).toBeNull();
      const p = h.tap.sendRaw({ type: 'later' });
      const second = new h.win.WebSocket(GAME_URL + '&cs=2');
      native(1).open();
      native(1).emit(gameState(4));
      await p;
      expect(h.tap.activeSocket()).toBe(second);
      expect(native(1).sent.map((d) => JSON.parse(dec(d)).type)).toEqual(['later']);
      expect(native(0).sent).toEqual([]);
    });
  });
});
