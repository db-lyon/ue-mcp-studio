/**
 * The chat's hooks: a clock for live times, a scroll view that follows its
 * newest line, the subagents a viewer has opened or dismissed, and the
 * project's event stream as the list the web client's views read.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollViewInstance } from "react-native";
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

/** How long after a change of content its first layout may take to arrive, and how long after one layout pass the next may. */
export const SETTLE_FIRST_MS = 600;
export const SETTLE_GAP_MS = 150;

/**
 * Keep a scrolling list at its newest line while the reader is there. Once
 * they scroll up it stays put, and `behind` says new lines arrived below.
 * A change of `snap` (the reader sending a message) takes them back down
 * and following again, wherever they had scrolled. Spread `props` on the
 * ScrollView.
 */
export function useFollow(content: unknown, snap?: unknown) {
  const ref = useRef<ScrollViewInstance>(null);
  const atBottom = useRef(true);
  const [behind, setBehind] = useState(false);
  const toEnd = () => ref.current?.scrollToEnd({ animated: false });

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height <= BOTTOM_SLACK;
    if (atBottom.current) setBehind(false);  }, []);

  // New content follows the reader down while they are at the bottom; up the thread, it says so instead.
  // Only a change of `content` moves them (and the list getting shorter): opening a call in place does not.
  // The web scrolls once the new line is laid out; here layout arrives in passes after the commit, so the
  // size changes that settle it are followed, and growth after that is not, as on the web.
  const following = useRef(true);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleIn = (ms: number) => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => (following.current = false), ms);
  };
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) first.current = false;
    else if (!atBottom.current) return void setBehind(true);
    following.current = true;
    toEnd();
    settleIn(SETTLE_FIRST_MS);
  }, [content]);
  useEffect(() => () => void (settle.current && clearTimeout(settle.current)), []);

  const onContentSizeChange = useCallback(() => {
    if (!following.current) return;
    if (atBottom.current) toEnd();
    settleIn(SETTLE_GAP_MS);
  }, []);
  const height = useRef(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h < height.current && atBottom.current) toEnd();
    height.current = h;
  }, []);

  const snapped = useRef(snap);
  useLayoutEffect(() => {
    if (snapped.current === snap) return;
    snapped.current = snap;
    atBottom.current = true;
    setBehind(false);
    toEnd();
  }, [snap]);

  const jump = useCallback(() => {
    toEnd();
    atBottom.current = true;
    setBehind(false);
  }, []);

  return { ref, behind, jump, props: { ref, onScroll, onContentSizeChange, onLayout, scrollEventThrottle: 32 } };
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
