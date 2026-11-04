/**
 * The chat's hooks: a clock for live times, a scroll view that follows its
 * newest line, the subagents a viewer has opened or dismissed, and the
 * project's event stream as the list the web client's views read.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollViewInstance } from "react-native";
import type { StreamEvent } from "@ue-mcp-studio/client-core";
import type { Project } from "../connection";

/** A clock that ticks every second while anything is running, for live elapsed times and how long a subagent has been quiet. */
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
 * Keep a scroll view at its newest line while the reader is there. Once they
 * scroll up it stays put, and `behind` says new lines arrived below. A change
 * of `snap` (the reader sending a message) takes them back down and following.
 * Spread `props` on the ScrollView.
 */
export function useFollow(content: unknown, snap?: unknown) {
  const ref = useRef<ScrollViewInstance>(null);
  const atBottom = useRef(true);
  const [behind, setBehind] = useState(false);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height <= BOTTOM_SLACK;
    if (atBottom.current) setBehind(false);
  }, []);
  // New content, or a shorter view (the composer growing), keeps a reader at the bottom there.
  const stick = useCallback(() => {
    if (atBottom.current) ref.current?.scrollToEnd({ animated: false });
  }, []);

  useEffect(() => {
    if (!atBottom.current) setBehind(true);
  }, [content]);

  const snapped = useRef(snap);
  useEffect(() => {
    if (snapped.current === snap) return;
    snapped.current = snap;
    atBottom.current = true;
    setBehind(false);
    ref.current?.scrollToEnd({ animated: false });
  }, [snap]);

  const jump = useCallback(() => {
    ref.current?.scrollToEnd({ animated: true });
    atBottom.current = true;
    setBehind(false);
  }, []);

  return { ref, behind, jump, props: { ref, onScroll, onContentSizeChange: stick, onLayout: stick, scrollEventThrottle: 32 } };
}

/**
 * The finished subagents the user dismissed: the session's list, with the
 * user's own dismissals applied at once while they are saved.
 */
export function useDismissed(sessionId: string | null, stored: readonly string[] | undefined, save: (sessionId: string, ids: string[]) => Promise<unknown>): { dismissed: ReadonlySet<string>; dismiss: (ids: string[]) => void } {
  const [mine, setMine] = useState<Set<string>>(() => new Set());
  useEffect(() => setMine(new Set()), [sessionId]);
  const dismissed = useMemo(() => new Set([...(stored ?? []), ...mine]), [stored, mine]);
  const dismiss = useCallback(
    (ids: string[]) => {
      if (!sessionId || ids.length === 0) return;
      setMine((cur) => new Set([...cur, ...ids]));
      // A failed save puts the rows back.
      void save(sessionId, ids).catch(() => setMine((cur) => new Set([...cur].filter((id) => !ids.includes(id)))));
    },
    [sessionId, save],
  );
  return { dismissed, dismiss };
}

/**
 * The subagent threads the user has opened, per session, so the list marks a
 * finished one new only until it is opened. Kept with the session in Studio.
 */
export function useSeen(sessionId: string | null, stored: readonly string[] | undefined, save: (sessionId: string, id: string) => Promise<unknown>): { seen: ReadonlySet<string>; markSeen: (id: string) => void } {
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  useEffect(() => setSeen(new Set()), [sessionId]);
  useEffect(() => {
    if (!stored?.length) return;
    setSeen((cur) => (stored.every((id) => cur.has(id)) ? cur : new Set([...cur, ...stored])));
  }, [stored]);
  const markSeen = useCallback(
    (id: string) => {
      setSeen((cur) => {
        if (cur.has(id)) return cur;
        if (sessionId) void save(sessionId, id).catch(() => {});
        return new Set(cur).add(id);
      });
    },
    [sessionId, save],
  );
  return { seen, markSeen };
}

/** The project's event stream as the web client's DaemonState holds it: the recent events, and whether the stream is up. */
export interface DaemonState {
  events: StreamEvent[];
  streaming: boolean;
}

/** How many events the list keeps; older ones have been acted on. */
export const EVENTS_KEPT = 300;

export function useDaemonState(project: Pick<Project, "onEvent" | "live">): DaemonState {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const { onEvent } = project;
  useEffect(() => onEvent((e) => setEvents((cur) => (cur.length >= EVENTS_KEPT ? [...cur.slice(cur.length - EVENTS_KEPT + 1), e] : [...cur, e]))), [onEvent]);
  return useMemo(() => ({ events, streaming: project.live === "live" }), [events, project.live]);
}
