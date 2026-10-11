import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** A clock that ticks every second while anything is running, for live elapsed times and stuck detection. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return active ? now : Date.now();
}

/** Within this many pixels of the bottom counts as at the bottom. */
export const BOTTOM_SLACK = 48;

/**
 * Keep a scrolling list at its newest line while the reader is there. Once
 * they scroll up it stays put, and `behind` says new lines arrived below.
 */
export function useFollow<T extends HTMLElement>(content: unknown) {
  const ref = useRef<T>(null);
  const atBottom = useRef(true);
  const [behind, setBehind] = useState(false);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    if (atBottom.current) setBehind(false);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else setBehind(true);
  }, [content]);

  const jump = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setBehind(false);
  }, []);

  return { ref, onScroll, behind, jump };
}

const seenKey = (sessionId: string) => `studio.seen.${sessionId}`;

/**
 * The subagent threads this viewer has opened, per session, so the list can
 * mark finished ones that are new to them. Kept in this browser only; a
 * storage failure just means nothing is remembered.
 */
export function useSeen(sessionId: string | null): { seen: ReadonlySet<string>; markSeen: (id: string) => void } {
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!sessionId) return setSeen(new Set());
    try {
      setSeen(new Set(JSON.parse(localStorage.getItem(seenKey(sessionId)) ?? "[]") as string[]));
    } catch {
      setSeen(new Set());
    }
  }, [sessionId]);
  const markSeen = useCallback((id: string) => {
    setSeen((cur) => {
      if (cur.has(id)) return cur;
      const next = new Set(cur).add(id);
      try {
        if (sessionId) localStorage.setItem(seenKey(sessionId), JSON.stringify([...next]));
      } catch {
        // Not remembered past this view.
      }
      return next;
    });
  }, [sessionId]);
  return { seen, markSeen };
}
