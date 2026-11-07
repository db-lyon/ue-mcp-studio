/**
 * The chat's hooks: a clock for live times, a list that follows its newest
 * line, the subagents a viewer has opened or dismissed, and the
 * project's event stream as the list the web client's views read.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
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
 * Keep an inverted list (newest line at offset 0, at the bottom) at its newest
 * line while the reader is there. Once they scroll up it stays put, and
 * `behind` says new lines arrived below; `up` says the reader is up the thread,
 * where the list holds the line being read in place as lines arrive. A change
 * of `snap` (the reader sending a message) takes them back down, wherever they
 * had scrolled. Spread `props` on the FlatList.
 */
export function useFollow(content: unknown, snap?: unknown) {
  const ref = useRef<FlatList<never>>(null);
  const atBottom = useRef(true);
  const [behind, setBehind] = useState(false);
  const [up, setUp] = useState(false);
  const toBottom = () => ref.current?.scrollToOffset({ offset: 0, animated: false });

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const at = e.nativeEvent.contentOffset.y <= BOTTOM_SLACK;
    atBottom.current = at;
    setUp(!at);
    if (at) setBehind(false);
  }, []);

  // A new line below the reader: followed at the bottom, announced up the thread.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    if (atBottom.current) toBottom();
    else setBehind(true);
  }, [content]);

  const snapped = useRef(snap);
  useEffect(() => {
    if (snapped.current === snap) return;
    snapped.current = snap;
    atBottom.current = true;
    setBehind(false);
    setUp(false);
    toBottom();
  }, [snap]);

  const jump = useCallback(() => {
    toBottom();
    atBottom.current = true;
    setBehind(false);
    setUp(false);
  }, []);

  return { ref, behind, up, jump, props: { ref, onScroll, scrollEventThrottle: 32 } };
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
