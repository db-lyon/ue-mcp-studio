/**
 * studio.session.focus: the agent asks the panel to show a session, as the
 * editor's quick ask does with the session it just started. Only events that
 * arrive after the caller mounts count (apps/client-web/src/focus.ts).
 */
import { useEffect, useRef } from "react";
import type { DaemonEvent } from "./state";

export const FOCUS_EVENT = "studio.session.focus";

/** `onSection`: the same event naming a Settings section instead of a session (the model picker when no model is connected). */
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
