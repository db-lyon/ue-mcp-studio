/**
 * How a client reaches its daemon. The web client's transport is fetch (the
 * relay's service worker tunnels it when remote); the mobile app's seals each
 * request for the paired computer itself. Everything above this works the
 * same over either.
 */

export interface Reply {
  status: number;
  headers: Record<string, string>;
  /** The body as it arrives, already decompressed; null when there is none. Read once. */
  body: AsyncIterable<Uint8Array> | null;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** A JSON-encodable body, sent as application/json. */
  json?: unknown;
  signal?: AbortSignal;
  /** Give up when the response head takes longer than this. */
  headTimeoutMs?: number;
}

export type Transport = (method: string, path: string, options?: RequestOptions) => Promise<Reply>;

/** A request the daemon answered with an error status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function readAll(reply: Reply): Promise<Uint8Array> {
  if (!reply.body) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const p of reply.body) {
    parts.push(p);
    n += p.length;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function readText(reply: Reply): Promise<string> {
  return new TextDecoder().decode(await readAll(reply));
}

/** The body as JSON, or {} when it is empty or not JSON. */
export async function readJson<T = Record<string, unknown>>(reply: Reply): Promise<T> {
  const text = await readText(reply);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return {} as T;
  }
}

/** One request whose JSON answer the caller needs; an error status throws HttpError with the daemon's message. */
export async function requestJson<T>(transport: Transport, method: string, path: string, options?: RequestOptions): Promise<T> {
  const reply = await transport(method, path, options);
  const body = await readJson<Record<string, unknown>>(reply);
  if (reply.status < 200 || reply.status >= 300) throw new HttpError(reply.status, typeof body.error === "string" ? body.error : `${method} ${path} answered ${reply.status}.`, body);
  return body as T;
}
