import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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
 * A change of `snap` (the reader sending a message) takes them back down
 * and following again, wherever they had scrolled.
 */
export function useFollow<T extends HTMLElement>(content: unknown, snap?: unknown) {
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

  const snapped = useRef(snap);
  useLayoutEffect(() => {
    if (snapped.current === snap) return;
    snapped.current = snap;
    const el = ref.current;
    atBottom.current = true;
    setBehind(false);
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap]);

  // The list getting shorter (the composer growing under it) keeps a reader at the bottom there.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const jump = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setBehind(false);
  }, []);

  return { ref, onScroll, behind, jump };
}

/**
 * The subagent threads the user has opened, per session, so the list marks a
 * finished one new only until it is opened. Kept with the session in Studio,
 * since the page's own storage is lost whenever the daemon's port changes.
 * `stored` is what the session says; `save` records one more.
 */
/**
 * The finished subagents the user dismissed: the session's list, with the
 * user's own dismissals applied at once while they are saved.
 */
export function useDismissed(sessionId: string | null, stored: readonly string[] | undefined, save: (sessionId: string, ids: string[]) => Promise<unknown>): { dismissed: ReadonlySet<string>; dismiss: (ids: string[]) => void } {
  const [mine, setMine] = useState<Set<string>>(() => new Set());
  useEffect(() => setMine(new Set()), [sessionId]);
  const dismissed = useMemo(() => new Set([...(stored ?? []), ...mine]), [stored, mine]);
  const dismiss = useCallback((ids: string[]) => {
    if (!sessionId || ids.length === 0) return;
    setMine((cur) => new Set([...cur, ...ids]));
    // A failed save puts the rows back.
    void save(sessionId, ids).catch(() => setMine((cur) => new Set([...cur].filter((id) => !ids.includes(id)))));
  }, [sessionId, save]);
  return { dismissed, dismiss };
}

export function useSeen(sessionId: string | null, stored: readonly string[] | undefined, save: (sessionId: string, id: string) => Promise<unknown>): { seen: ReadonlySet<string>; markSeen: (id: string) => void } {
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  useEffect(() => setSeen(new Set()), [sessionId]);
  useEffect(() => {
    if (!stored?.length) return;
    setSeen((cur) => (stored.every((id) => cur.has(id)) ? cur : new Set([...cur, ...stored])));
  }, [stored]);
  const markSeen = useCallback((id: string) => {
    setSeen((cur) => {
      if (cur.has(id)) return cur;
      if (sessionId) void save(sessionId, id).catch(() => {});
      return new Set(cur).add(id);
    });
  }, [sessionId, save]);
  return { seen, markSeen };
}
