/**
 * The session's live playtests, pinned under its header: every run that is
 * armed, running or waiting for a verdict, and every assigned loop that runs
 * or needs the user, each as a live compact card. A waiting card takes its
 * verdict in place. The strip is not drawn while nothing is live. With
 * several, a line sums them up, the list has a bounded height, and the line
 * folds the list away.
 *
 * A pinned run's card in the transcript gives way to one line that points at
 * the strip, so the same card is never on screen twice; it comes back in full
 * when the run ends. A run that just ended stays a few seconds, so its result
 * is seen where it was watched.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { DaemonEvent } from "ue-mcp/daemon";
import { qaActive, qaNeedsYou, type QaRun, type TranscriptEntry } from "@ue-mcp-studio/shared";
import { QaCard, newerRun } from "./Qa";
import { focusRun } from "../attention";
import { NARROW, useMedia } from "../layout";

/** How long a run that ended stays on the strip. */
export const ENDED_GRACE_MS = 6000;
/** Where a viewer's hidden needs-you loops are kept. */
const HIDDEN_KEY = "studio.playtest-strip.hidden";

/** The session's runs as they are now: its transcript's, with every studio.qa.changed since the transcript was read. */
export interface SessionRuns {
  runs: QaRun[];
  /** A run id the transcript may still hold (a draft's, before its run took the card) to the run that holds it now. */
  alias: ReadonlyMap<string, string>;
}

export function useSessionRuns(sessionId: string | null, transcript: TranscriptEntry[] | undefined, events: DaemonEvent[]): SessionRuns {
  // Events up to the read are in the transcript already; only later ones are applied.
  const read = useRef<{ transcript: TranscriptEntry[] | undefined; after: number }>({ transcript: undefined, after: 0 });
  if (read.current.transcript !== transcript) read.current = { transcript, after: events.length ? events[events.length - 1].id : 0 };
  const after = read.current.after;
  return useMemo(() => {
    const byId = new Map<string, QaRun>();
    const alias = new Map<string, string>();
    for (const t of transcript ?? []) if (t.kind === "qa") byId.set(t.run.runId, t.run);
    for (const e of events) {
      if (e.id <= after || e.type !== "studio.qa.changed") continue;
      const run = e.data.run as QaRun | undefined;
      if (!run?.runId) continue;
      const replaces = typeof e.data.replaces === "string" ? e.data.replaces : null;
      if (replaces && byId.has(replaces)) {
        byId.delete(replaces);
        alias.set(replaces, run.runId);
        byId.set(run.runId, run);
      } else if (byId.has(run.runId)) {
        byId.set(run.runId, newerRun(run, byId.get(run.runId)!));
      } else if (sessionId && run.sessionId === sessionId) {
        byId.set(run.runId, run);
      }
    }
    // An alias chain (draft, manual run, full run) resolves to the run at its end.
    for (const [from, to] of alias) {
      let end = to;
      for (let i = 0; i < 8 && alias.has(end); i++) end = alias.get(end)!;
      alias.set(from, end);
    }
    return { runs: [...byId.values()], alias };
  }, [sessionId, transcript, events, after]);
}

const hiddenKey = (r: QaRun) => `${r.runId}:${r.assignment?.loop?.id ?? ""}`;
function readHidden(): Set<string> {
  try {
    const v = JSON.parse(window.localStorage.getItem(HIDDEN_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function writeHidden(s: Set<string>): void {
  try {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...s].slice(-200)));
  } catch {
    // Storage blocked: the hide lasts for this page only.
  }
}

/** The runs the strip shows, needs-you first, then live, then ones that just ended; and their ids the transcript gives way to. */
export function usePinned(runs: QaRun[], alias: ReadonlyMap<string, string>): { pinned: QaRun[]; ids: ReadonlyMap<string, QaRun>; hide: (r: QaRun) => void } {
  const [hidden, setHidden] = useState<Set<string>>(readHidden);
  const [ending, setEnding] = useState<ReadonlySet<string>>(new Set());
  const wasActive = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const active = runs.filter((r) => qaActive(r) && !(r.assignment?.loop?.state === "needs_you" && !qaNeedsYouStep(r) && hidden.has(hiddenKey(r))));
  const activeIds = active.map((r) => r.runId).join(",");

  useEffect(() => {
    const now = new Set(active.map((r) => r.runId));
    const ended = [...wasActive.current].filter((id) => !now.has(id) && runs.some((r) => r.runId === id && !qaActive(r)));
    wasActive.current = now;
    if (ended.length === 0) return;
    setEnding((cur) => new Set([...cur, ...ended]));
    for (const id of ended) {
      clearTimeout(timers.current.get(id));
      timers.current.set(id, setTimeout(() => {
        timers.current.delete(id);
        setEnding((cur) => new Set([...cur].filter((x) => x !== id)));
      }, ENDED_GRACE_MS));
    }
  }, [activeIds]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const shown = [...active, ...runs.filter((r) => ending.has(r.runId) && !active.includes(r))];
  const rank = (r: QaRun) => (qaNeedsYou(r) ? 0 : qaActive(r) ? 1 : 2);
  shown.sort((a, b) => rank(a) - rank(b) || (a.seenAt < b.seenAt ? -1 : a.seenAt > b.seenAt ? 1 : 0));
  const ids = new Map(shown.map((r) => [r.runId, r]));
  for (const [from, to] of alias) if (ids.has(to)) ids.set(from, ids.get(to)!);
  return {
    pinned: shown,
    ids,
    hide: (r) => setHidden((cur) => {
      const next = new Set(cur).add(hiddenKey(r));
      writeHidden(next);
      return next;
    }),
  };
}

/** A step waits for a verdict: that never hides, only a loop's own stop does. */
const qaNeedsYouStep = (r: QaRun) => r.steps.some((s) => s.status === "awaiting_verdict");

/** One line for several: how many, and how many need the user. */
export function stripSummary(runs: QaRun[]): string {
  const you = runs.filter(qaNeedsYou).length;
  const live = runs.filter((r) => qaActive(r) && !qaNeedsYou(r)).length;
  const done = runs.length - you - live;
  const parts = [you && `${you} need${you === 1 ? "s" : ""} you`, live && `${live} running`, done && `${done} just ended`].filter(Boolean);
  return `${runs.length} playtests: ${parts.join(", ")}`;
}

/** How many cards the strip shows before the rest wait behind "N more". */
export const STRIP_SHOWN = 2;
/** The DOM event a pinned line sends to bring its card into view, wherever it is on the strip. */
const REVEAL = "studio-reveal-playtest";

export function PlaytestStrip({ runs, onHide }: { runs: QaRun[]; onHide: (r: QaRun) => void }) {
  const [folded, setFolded] = useState(false);
  const [all, setAll] = useState(false);
  // Narrow, one card and the rest named under it; the strip must leave the conversation room.
  const first = useMedia(NARROW) ? 1 : STRIP_SHOWN;
  useEffect(() => {
    const reveal = (e: Event) => {
      const runId = (e as CustomEvent<string>).detail;
      setFolded(false);
      setAll(true);
      // Drawn on the next frame: then opened and scrolled to.
      requestAnimationFrame(() => focusRun(runId));
    };
    window.addEventListener(REVEAL, reveal);
    return () => window.removeEventListener(REVEAL, reveal);
  }, []);
  if (runs.length === 0) return null;
  const many = runs.length > 1;
  // Every one that needs the user is shown; the rest fill up to the first few.
  const you = runs.filter(qaNeedsYou);
  const shown = all ? runs : [...you, ...runs.filter((r) => !qaNeedsYou(r)).slice(0, Math.max(0, first - you.length))];
  const rest = runs.filter((r) => !shown.includes(r));
  return (
    <section className={`playtest-strip ${many ? "many" : ""} ${you.length ? "needs-you" : ""}`} aria-label="Live playtests">
      {many && (
        <button className="strip-head" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
          <span className="qa-chevron" aria-hidden="true">{folded ? "▸" : "▾"}</span>
          <span className="eyebrow">Live</span>
          <span className="strip-summary">{stripSummary(runs)}</span>
        </button>
      )}
      {!folded && (
        <div className="strip-list">
          {shown.map((r) => (
            <QaCard key={r.runId} run={r} dense onHide={r.assignment?.loop?.state === "needs_you" && !qaNeedsYouStep(r) ? () => onHide(r) : undefined} />
          ))}
          {rest.length > 0 && (
            <button className="small-button strip-more" onClick={() => setAll(true)} aria-label={`Show ${rest.length} more: ${rest.map((r) => r.scriptName).join(", ")}`}>
              Show {rest.length} more:{" "}
              {rest.map((r, i) => (
                <span key={r.runId}>
                  {i > 0 && ", "}
                  {r.scriptName} <span className="strip-more-state">({pinnedState(r).replace(/^is /, "")})</span>
                </span>
              ))}
            </button>
          )}
          {all && runs.length > Math.max(first, you.length) && (
            <button className="ghost small-button strip-more" onClick={() => setAll(false)}>Show fewer</button>
          )}
        </div>
      )}
    </section>
  );
}

/** Bring a run's card on the strip into view and open it, showing every card when it is past the first ones. */
export function revealPinned(runId: string): void {
  window.dispatchEvent(new CustomEvent(REVEAL, { detail: runId }));
}

/** What a pinned run is doing, for its line in the transcript. */
const pinnedState = (r: QaRun): string => (qaNeedsYou(r) ? "needs you" : r.state === "armed" ? "is starting" : qaActive(r) ? "is running" : "just ended");

/** The runs on the strip: every id the transcript may hold for one, to the run its card there shows. */
export const PinnedContext = createContext<ReadonlyMap<string, QaRun>>(new Map());

/** A transcript's qa entry: its full card, or one line pointing at its live card on the strip. */
export function TranscriptPlaytest({ run }: { run: QaRun }) {
  const live = useContext(PinnedContext).get(run.runId);
  if (!live) return <QaCard run={run} />;
  return (
    <div className="qa-pinned small" role="note">
      <span className="qa-pinned-mark" aria-hidden="true">{"↑"}</span>
      <span className="qa-pinned-text">
        Playtest <strong>{live.scriptName}</strong> {pinnedState(live)} on the strip above.
      </span>
      <button className="ghost small-button" onClick={() => revealPinned(live.runId)}>Show it</button>
    </div>
  );
}
