import type { ExtensionHandler } from "ue-mcp/daemon";

/**
 * A route whose failure answers 500 with the error and a line in the log,
 * instead of an exception the daemon has to catch (#165).
 */
export function guardedRoute(log: { warn(msg: string, err?: unknown): void }, what: string, fn: ExtensionHandler): ExtensionHandler {
  return async (req) => {
    try {
      return await fn(req);
    } catch (e) {
      log.warn(`${what} failed`, e);
      return { status: 500, body: { error: `${what} failed: ${e instanceof Error ? e.message : String(e)}` } };
    }
  };
}
