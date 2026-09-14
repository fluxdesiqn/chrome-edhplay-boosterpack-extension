/**
 * Fake native WebSocket for end-to-end scenarios. `installWsTap(win)` subclasses
 * whatever `win.WebSocket` is, so a tapped socket constructed through the tap IS
 * a FakeWs instance; every constructed instance is registered in `FakeWs.instances`
 * so the FakeServer can grab the underlying socket with `FakeWs.last()`.
 */
export class FakeWs extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWs[] = [];

  /** Most recently constructed socket (tapped or not). */
  static last(): FakeWs {
    const ws = FakeWs.instances[FakeWs.instances.length - 1];
    if (!ws) throw new Error('FakeWs.last(): no socket has been constructed');
    return ws;
  }

  static reset(): void {
    FakeWs.instances = [];
  }

  readonly url: string;
  readonly protocol = '';
  readonly extensions = '';
  readonly bufferedAmount = 0;
  readyState: number = FakeWs.CONNECTING;
  binaryType: BinaryType = 'blob';
  /** Every frame the client wrote, decoded to text, in order. */
  readonly sent: string[] = [];
  /** Server hook: receives each client frame as text. */
  onSend: ((text: string) => void) | null = null;

  constructor(url: string | URL, _protocols?: string | string[]) {
    super();
    this.url = String(url);
    FakeWs.instances.push(this);
  }

  send(data: unknown): void {
    if (this.readyState === FakeWs.CONNECTING) throw new Error('InvalidStateError: WebSocket is still in CONNECTING state');
    if (this.readyState !== FakeWs.OPEN) return; // browsers silently discard after close
    const text = decodeFrame(data);
    this.sent.push(text);
    this.onSend?.(text);
  }

  close(_code?: number, _reason?: string): void {
    if (this.readyState === FakeWs.CLOSED) return;
    this.readyState = FakeWs.CLOSED;
    this.dispatchEvent(new Event('close'));
  }

  // ----- server-side helpers -------------------------------------------------

  open(): void {
    this.readyState = FakeWs.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  /** Deliver a server frame (object → JSON text) to the socket's listeners. */
  serverEmit(obj: unknown): void {
    const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
    this.dispatchEvent(new MessageEvent('message', { data, origin: 'wss://api.edhplay.com' }));
  }
}

function decodeFrame(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  throw new Error(`FakeWs.send: unsupported frame kind ${Object.prototype.toString.call(data)}`);
}
