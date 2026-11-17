/**
 * studio.session.focus: the agent asks the panel to show a session, as the
 * editor's quick ask does with the session it just started. Only events that
 * arrive after the caller mounts count, so a view that mounts later does not
 * replay an old request; App writes the session into the hash for that view.
 */
import { useEffect, useRef } from "react";
import type { DaemonEvent } from "ue-mcp/daemon";

export const FOCUS_EVENT = "studio.session.focus";

/**
 * `onSection`: the same event naming a Settings section instead of a session,
 * as the quick ask does when no model is connected: it shows the model picker.
 */
export function useSessionFocus(events: DaemonEvent[], onFocus: (sessionId: string) => void, onSection?: (section: string) => void): void {
  const seen = useRef<number | null>(null);
  if (seen.current === null) seen.current = events.length ? events[events.length - 1].id : 0;
  const handler = useRef(onFocus);
  handler.current = onFocus;
  const sectionHandler = useRef(onSection);
  sectionHandler.current = onSection;
  useEffect(() => {
    const after = seen.current ?? 0;
    const fresh = events.filter((e) => e.id > after);
    if (fresh.length === 0) return;
    seen.current = fresh[fresh.length - 1].id;
    const last = fresh.filter((e) => e.type === FOCUS_EVENT && (typeof e.data.sessionId === "string" || typeof e.data.section === "string")).pop();
    if (!last) return;
    if (typeof last.data.sessionId === "string") handler.current(last.data.sessionId);
    else sectionHandler.current?.(last.data.section as string);
  }, [events]);
}
