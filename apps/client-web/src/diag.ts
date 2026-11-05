/**
 * Proof that ue-mcp answers, and the page's own connection diagnostics.
 *
 * Any answer from ue-mcp (a request that came back, an identity check) is
 * proof it is up even while the event stream reconnects, so the page keeps to
 * a quiet line instead of saying ue-mcp is offline. Each stream drop and slow
 * check is recorded with its cause and timings, shown with the daemon's events
 * in Settings, Diagnostics.
 */
import type { DaemonEvent } from "ue-mcp/daemon";

type Listener<T> = (v: T) => void;

const aliveListeners = new Set<Listener<number>>();
const diagListeners = new Set<Listener<DaemonEvent>>();
let lastAlive = 0;

/** Something from ue-mcp just arrived. */
export function alive(at = Date.now()): void {
  lastAlive = at;
  for (const l of aliveListeners) l(at);
}

/** When ue-mcp last answered anything, or 0. */
export function lastAliveAt(): number {
  return lastAlive;
}

export function onAlive(l: Listener<number>): () => void {
  aliveListeners.add(l);
  return () => {
    aliveListeners.delete(l);
  };
}

export { fromUeMcp } from "@ue-mcp-studio/client-core";

/** Record one page diagnostic, as a `studio.connection.<kind>` event. */
export function recordDiag(kind: string, data: Record<string, unknown>): void {
  const e: DaemonEvent = { id: 0, type: `studio.connection.${kind}`, at: new Date().toISOString(), data };
  for (const l of diagListeners) l(e);
}

export function onDiag(l: Listener<DaemonEvent>): () => void {
  diagListeners.add(l);
  return () => {
    diagListeners.delete(l);
  };
}
