/**
 * Frame encode/decode helpers for the game WebSocket tap.
 *
 * The app normally exchanges bare-JSON string frames, but can switch to UTF-8
 * binary (ArrayBuffer) frames; these helpers let the tap treat both uniformly
 * while re-emitting frames "like" the original kind.
 */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function frameKind(data: unknown): 'text' | 'binary' | 'other' {
  if (typeof data === 'string') return 'text';
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return 'binary';
  return 'other';
}

/** string → itself; ArrayBuffer / ArrayBufferView → UTF-8 decoded; Blob or anything else → null. */
export function decodeFrame(data: unknown): string | null {
  if (typeof data === 'string') return data;
  try {
    if (data instanceof ArrayBuffer) return decoder.decode(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) {
      return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  } catch {
    return null;
  }
  return null;
}

/** Returns the JSON string as-is for 'text', or a fresh ArrayBuffer of its UTF-8 bytes for 'binary'. */
export function encodeFrameLike(json: string, like: 'text' | 'binary'): string | ArrayBuffer {
  if (like === 'text') return json;
  const bytes = encoder.encode(json);
  // Copy into an exactly-sized standalone ArrayBuffer (encode() may return a view over a larger buffer).
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Parses JSON and returns it only when it's a plain object carrying a string `type`. */
export function safeParse(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  // Cheap pre-check: protocol messages are always JSON objects.
  const first = text.charCodeAt(0);
  if (first !== 0x7b /* { */ && !/^\s*\{/.test(text)) return null;
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    if (typeof (v as Record<string, unknown>).type !== 'string') return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}
