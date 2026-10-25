/**
 * studio.qa.attention: a playtest loop stopped and needs the user. Studio's
 * window shows a Windows notification with the reason; clicking it brings
 * Studio forward and opens the playtest's card. A page without the window's
 * notify (an older window, the editor's own tab) flashes the window with the
 * reason instead, and a plain browser does nothing beyond the card. Only events
 * that arrive after the page mounts notify, so a reload does not repeat one.
 */
import { useEffect, useRef } from "react";
import type { DaemonEvent } from "ue-mcp/daemon";
import { native } from "./native";

export const ATTENTION_EVENT = "studio.qa.attention";
/** The DOM event Studio's window dispatches when its notification is clicked. */
export const NOTIFICATION_CLICK = "studio-notification";

export interface AttentionTarget {
  sessionId: string;
  runId: string;
}

/** Tell the user, outside the card. */
export async function notifyUser(title: string, text: string, target: AttentionTarget): Promise<void> {
  const n = native();
  const shown = n.notify ? await n.notify(JSON.stringify({ title, text, target })).catch(() => false) : false;
  if (!shown) await n.drawattention?.(text).catch(() => false);
}

/** Scroll a playtest's card into view once the session has drawn it, and mark it for a moment. */
export function focusRun(runId: string, waitMs = 5000): void {
  const end = Date.now() + waitMs;
  const look = () => {
    const el = document.querySelector(`[data-run-id="${runId.replace(/["\\]/g, "\\$&")}"]`);
    if (el) {
      el.scrollIntoView?.({ block: "center", behavior: "smooth" });
      el.classList.add("attention");
      setTimeout(() => el.classList.remove("attention"), 2400);
      return;
    }
    if (Date.now() < end) setTimeout(look, 100);
  };
  look();
}

const targetOf = (v: unknown): AttentionTarget | null => {
  const t = v as Partial<AttentionTarget> | null;
  return t && typeof t.sessionId === "string" && typeof t.runId === "string" ? { sessionId: t.sessionId, runId: t.runId } : null;
};

export function useAttention(events: DaemonEvent[], onOpen: (t: AttentionTarget) => void): void {
  const seen = useRef<number | null>(null);
  if (seen.current === null) seen.current = events.length ? events[events.length - 1].id : 0;
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    const after = seen.current ?? 0;
    const fresh = events.filter((e) => e.id > after);
    if (fresh.length === 0) return;
    seen.current = fresh[fresh.length - 1].id;
    for (const e of fresh) {
      if (e.type !== ATTENTION_EVENT) continue;
      const t = targetOf(e.data);
      if (t) void notifyUser(String(e.data.title ?? "UE-MCP Studio"), String(e.data.text ?? "A playtest needs you."), t);
    }
  }, [events]);
  useEffect(() => {
    const click = (e: Event) => {
      const t = targetOf((e as CustomEvent).detail);
      if (t) open.current(t);
    };
    window.addEventListener(NOTIFICATION_CLICK, click);
    return () => window.removeEventListener(NOTIFICATION_CLICK, click);
  }, []);
}
