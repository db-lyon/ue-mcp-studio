/**
 * What a playtest card reads from the page around it: the daemon's recent
 * events and whether the stream is up, the session's waiting forms, and the
 * run kept current from the script.* and studio.qa.changed events, read again
 * after a drop (from its last seq) or a gap (from the start).
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { newerRun, type StreamEvent } from "@ue-mcp-studio/client-core";
import { qaApplyStreamEvent, qaEnded, qaIsDraft, qaMergeAnswer, type PendingForm, type QaRun } from "@ue-mcp-studio/shared";
import type { Project } from "../../connection";
import { useProjectNav } from "../../nav";

export interface QaLive {
  events: StreamEvent[];
  streaming: boolean;
  forms: PendingForm[];
  /** The session on screen, where a subagent for a run started elsewhere runs. */
  sessionId?: string | null;
  /** Open a subagent's thread, by its agent call id. */
  onThread?: (callId: string) => void;
}

export const QaContext = createContext<QaLive | null>(null);

/** How many recent events a page keeps for its cards. */
const KEEP = 500;

/** The project's recent events and whether its stream is up, for a page of cards. */
export function useDaemonEvents(project: Project): { events: StreamEvent[]; streaming: boolean } {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  useEffect(() => project.onEvent((e) => setEvents((cur) => (cur.length >= KEEP ? [...cur.slice(cur.length - KEEP + 1), e] : [...cur, e]))), [project]);
  return { events, streaming: project.live === "live" };
}

export function useLiveRun(run: QaRun, live: Pick<QaLive, "events" | "streaming"> | null): [QaRun, (f: (r: QaRun) => QaRun) => void] {
  const { api } = useProjectNav();
  const [cur, setCur] = useState(run);
  const seen = useRef(0);
  const latest = useRef(cur);
  latest.current = cur;
  useEffect(() => setCur((c) => newerRun(run, c)), [run]);

  const resync = (since?: number) => {
    void api.qaStatus(run.runId, since).then((r) => setCur((c) => qaMergeAnswer(r.run ? newerRun(r.run, c) : c, r.answer)), () => undefined);
  };

  const events = live?.events;
  useEffect(() => {
    if (!events) return;
    const fresh = events.filter((e) => e.id > seen.current);
    if (fresh.length === 0) return;
    seen.current = fresh[fresh.length - 1].id;
    const gap = fresh.some((e) => e.type === "gap");
    setCur((c) => {
      let next = c;
      for (const e of fresh) {
        const data = e.data as Record<string, unknown>;
        if (e.type.startsWith("script.")) next = qaApplyStreamEvent(next, e.type, data);
        else if (e.type === "studio.qa.changed" && (data.run as QaRun | undefined)?.runId === c.runId) next = newerRun(data.run as QaRun, next);
        // A draft's run took its card: the card goes live.
        else if (e.type === "studio.qa.changed" && data.replaces === c.runId && data.run) next = data.run as QaRun;
      }
      return next;
    });
    if (gap && !qaEnded(latest.current.state) && !qaIsDraft(latest.current)) resync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  const streaming = live?.streaming;
  const was = useRef(streaming);
  useEffect(() => {
    const back = was.current === false && streaming === true;
    was.current = streaming;
    if (back && !qaEnded(latest.current.state) && !qaIsDraft(latest.current)) resync(latest.current.lastSeq);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  return [cur, setCur];
}

export const useQaLive = () => useContext(QaContext);

/** Brings a card to the top of the scroller it is in; nothing where none is given. */
export interface Measurable {
  measureLayout(relativeTo: unknown, onSuccess: (x: number, y: number) => void, onFail?: () => void): void;
}
export const RevealContext = createContext<(node: Measurable | null) => void>(() => undefined);

/** The theme's body line height as a multiple, as CSS's unitless line-height carries to smaller text: 1.55 in ue-mcp, 1.5 in the editor themes. */
export const lhOf = (t: { base: { size: number; lineHeight: number } }): number => t.base.lineHeight / t.base.size;
