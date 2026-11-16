/**
 * The JSON-lines wire between Studio's daemon and the durable harness, and
 * the files each side keeps beside it: one message per line on a local socket
 * (a named pipe on Windows), records written atomically.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type * as net from "node:net";
import { writeFileAtomic } from "../atomic-write.js";

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The daemon reads the harness's record while the harness writes it: a refused rename is tried again.
  writeFileAtomic(file, JSON.stringify(value));
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Send one message as a JSON line. False when the socket cannot take it. */
export function sendLine(socket: net.Socket | null, msg: unknown): boolean {
  if (!socket || socket.destroyed || !socket.writable) return false;
  try {
    socket.write(`${JSON.stringify(msg)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read one JSON message per line. A line that is not JSON is dropped. A
 * message whose handling throws is reported to `failed` and the next line
 * goes on: an exception in a socket's data handler is uncaught, and in the
 * daemon it would end every session.
 */
export function onLines(
  socket: net.Socket,
  handle: (msg: Record<string, unknown>) => void,
  failed: (e: unknown, msg: Record<string, unknown>) => void = (e) => console.warn("[studio] a durable harness message failed", e),
): void {
  let buf = "";
  socket.setEncoding("utf-8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!msg || typeof msg !== "object") continue;
      try {
        handle(msg as Record<string, unknown>);
      } catch (e) {
        try {
          failed(e, msg as Record<string, unknown>);
        } catch {
          // Reporting it must not throw either.
        }
      }
    }
  });
}
