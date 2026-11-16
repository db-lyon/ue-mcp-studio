/**
 * A Windows transport and peer authentication for pi-server and pi-client
 * (#463 L6), which upstream ships with a Unix socket and no authentication
 * only. createPipeListener is a pi-server `ServerListener`, and
 * createPipeTransport a pi-client `ByteTransportFactory`: plain byte streams
 * on a named pipe on Windows (a Unix socket elsewhere), each opened with a
 * token preamble the listener checks in constant time before pi-server sees a
 * byte. A wrong or missing token, or none in time, closes the connection.
 *
 * Both are typed structurally, so this module needs neither package at run
 * time; Studio's own harness pipe (client.ts, harness-main.ts) speaks the same
 * framing guarantee (ordered bytes after an authenticated hello).
 */
import * as crypto from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** "SPP1", then the token's length (2 bytes, big-endian), then the token in UTF-8. */
const MAGIC = Buffer.from("SPP1", "ascii");
const MAX_TOKEN_BYTES = 1024;
/** How long a connection has to send its preamble. */
export const PIPE_HANDSHAKE_MS = 5000;

/** pi-server's view of an accepted, authorized connection. */
export interface PipeConnection {
  readonly closed: boolean;
  send(chunk: Uint8Array): Promise<void>;
  close(finalChunk?: Uint8Array): void | Promise<void>;
}
export interface PipeConnectionHandler {
  onData(chunk: Uint8Array): void;
  onClose(): void;
  onError(error: Error): void;
}
/** pi-server's ServerListener. */
export interface PipeListener {
  start(accept: (connection: PipeConnection) => PipeConnectionHandler): Promise<void>;
  close(): Promise<void>;
}
/** pi-client's ByteTransport and its factory. */
export interface PipeTransport {
  send(chunk: Uint8Array): Promise<void>;
  close(): void;
}
export type PipeTransportFactory = (handlers: PipeConnectionHandler) => Promise<PipeTransport>;

/** The address for a pipe name: a named pipe on Windows, a socket in the temp folder elsewhere. */
export function pipePath(name: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

export function preamble(token: string): Buffer {
  const t = Buffer.from(token, "utf-8");
  if (t.length === 0 || t.length > MAX_TOKEN_BYTES) throw new Error("the pipe token must be 1 to 1024 bytes");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(t.length);
  return Buffer.concat([MAGIC, len, t]);
}

/** Equal in constant time, whatever the lengths. */
function sameToken(a: Buffer, b: Buffer): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

const write = (sock: net.Socket, chunk: Uint8Array): Promise<void> =>
  new Promise((resolve, reject) => {
    if (sock.destroyed) return reject(new Error("the pipe is closed"));
    sock.write(chunk, (e) => (e ? reject(e) : resolve()));
  });

/** A pi-server ServerListener on `address` that admits only connections opening with `token`. */
export function createPipeListener(o: { path: string; token: string; handshakeMs?: number; onRefused?: (why: string) => void }): PipeListener {
  const expected = Buffer.from(o.token, "utf-8");
  let server: net.Server | null = null;
  const sockets = new Set<net.Socket>();
  return {
    start: (accept) => new Promise<void>((resolve, reject) => {
      const srv = net.createServer((sock) => {
        sockets.add(sock);
        sock.on("close", () => sockets.delete(sock));
        let held = Buffer.alloc(0);
        let handler: PipeConnectionHandler | null = null;
        const refuse = (why: string) => {
          o.onRefused?.(why);
          sock.destroy();
        };
        const timer = setTimeout(() => refuse("no token in time"), o.handshakeMs ?? PIPE_HANDSHAKE_MS);
        sock.on("data", (d: Buffer) => {
          if (handler) return handler.onData(new Uint8Array(d));
          held = Buffer.concat([held, d]);
          if (held.length < MAGIC.length + 2) return;
          if (!held.subarray(0, MAGIC.length).equals(MAGIC)) return refuse("not a Studio pipe client");
          const len = held.readUInt16BE(MAGIC.length);
          if (len === 0 || len > MAX_TOKEN_BYTES) return refuse("bad token length");
          const end = MAGIC.length + 2 + len;
          if (held.length < end) return;
          clearTimeout(timer);
          if (!sameToken(held.subarray(MAGIC.length + 2, end), expected)) return refuse("wrong token");
          const rest = held.subarray(end);
          held = Buffer.alloc(0);
          const conn: PipeConnection = {
            get closed() {
              return sock.destroyed;
            },
            send: (chunk) => write(sock, chunk),
            close: (final) => {
              if (final?.length) sock.end(final);
              else sock.end();
            },
          };
          handler = accept(conn);
          if (rest.length) handler.onData(new Uint8Array(rest));
        });
        sock.on("close", () => {
          clearTimeout(timer);
          handler?.onClose();
        });
        sock.on("error", (e) => handler?.onError(e));
      });
      srv.once("error", reject);
      srv.listen(o.path, () => {
        srv.off("error", reject);
        server = srv;
        resolve();
      });
    }),
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      if (!server) return resolve();
      server.close(() => resolve());
      server = null;
    }),
  };
}

/** A pi-client ByteTransportFactory: each attempt connects to `path` and opens with `token`. */
export function createPipeTransport(o: { path: string; token: string }): PipeTransportFactory {
  const hello = preamble(o.token);
  return (handlers) => new Promise<PipeTransport>((resolve, reject) => {
    const sock = net.connect(o.path);
    let open = false;
    sock.once("connect", () => {
      open = true;
      sock.write(hello);
      resolve({ send: (chunk) => write(sock, chunk), close: () => sock.destroy() });
    });
    sock.on("data", (d: Buffer) => handlers.onData(new Uint8Array(d)));
    sock.on("close", () => {
      if (open) handlers.onClose();
    });
    sock.on("error", (e) => (open ? handlers.onError(e) : reject(e)));
  });
}
