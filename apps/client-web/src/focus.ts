/**
 * studio.session.focus: the agent asks the panel to show a session, as the
 * editor's quick ask does with the session it just started. Only events that
 * arrive after the caller mounts count, so a view that mounts later does not
 * replay an old request; App writes the session into the hash for that view.
 */
import { useEffect, useRef } from "react";
import type { DaemonEvent } from "ue-mcp/daemon";

export const FOCUS_EVENT = "studio.session.focus";

export function useSessionFocus(events: DaemonEvent[], onFocus: (sessionId: string) => void): void {
  const seen = useRef<number | null>(null);
  if (seen.current === null) seen.current = events.length ? events[events.length - 1].id : 0;
  const handler = useRef(onFocus);
  handler.current = onFocus;
  useEffect(() => {
    const after = seen.current ?? 0;
    const fresh = events.filter((e) => e.id > after);
    if (fresh.length === 0) return;
    seen.current = fresh[fresh.length - 1].id;
    const last = fresh.filter((e) => e.type === FOCUS_EVENT && typeof e.data.sessionId === "string").pop();
    if (last) handler.current(last.data.sessionId as string);
  }, [events]);
}
