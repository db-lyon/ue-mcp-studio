/**
 * Studio runs inside the ue-mcp daemon. An exception Studio's code lets escape
 * (from a socket's data handler, a timer, a promise nobody awaits) would end
 * the daemon, and with it every session and the editor bridge. The guard logs
 * such an exception and goes on.
 *
 * Only Studio's own: an exception whose stack never passes through this
 * package ends the daemon as it would without Studio, unless the daemon has a
 * handler of its own.
 */

type Log = { warn(msg: string, e?: unknown): void };

const norm = (s: string): string => {
  let t = s;
  try {
    t = decodeURI(s);
  } catch {
    // A stack with a stray % stays as it is.
  }
  return t.replace(/\\/g, "/").toLowerCase();
};

/** Whether the error's stack passes through files under `dir`. */
export function fromPackage(e: unknown, dir: string): boolean {
  const stack = e instanceof Error ? e.stack : typeof e === "object" && e && "stack" in e ? String((e as { stack: unknown }).stack) : null;
  if (!stack) return false;
  const root = norm(dir).replace(/\/+$/, "");
  return root.length > 0 && norm(stack).includes(`${root}/`);
}

export interface CrashGuardOptions {
  /** The extension's package folder: its dist/ is what a stack names. */
  dir: string;
  log: Log;
  /** For tests: the process to guard, and how to end it. */
  proc?: Pick<NodeJS.Process, "on" | "off" | "listenerCount">;
  exit?: (code: number) => void;
}

/** Install the guard; returns its removal. */
export function installCrashGuard(o: CrashGuardOptions): () => void {
  const proc = o.proc ?? process;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const onException = (e: unknown): void => {
    if (fromPackage(e, o.dir)) {
      o.log.warn("Studio contained an unexpected error; the daemon and the other sessions go on", e);
      return;
    }
    // Not Studio's: the daemon's own handler decides, or it ends as it would have without this listener.
    if (proc.listenerCount("uncaughtException") > 1) return;
    console.error(e);
    exit(1);
  };
  const onRejection = (reason: unknown): void => {
    if (fromPackage(reason, o.dir)) {
      o.log.warn("Studio contained an unhandled rejection; the daemon and the other sessions go on", reason);
      return;
    }
    if (proc.listenerCount("unhandledRejection") > 1) return;
    // As without this listener: the rejection becomes an uncaught exception.
    onException(reason);
  };
  proc.on("uncaughtException", onException);
  proc.on("unhandledRejection", onRejection);
  return () => {
    proc.off("uncaughtException", onException);
    proc.off("unhandledRejection", onRejection);
  };
}
