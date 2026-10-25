/**
 * The project's playtests in one place: every PIE test script, each with its
 * newest run as a step path, when it ran and in which session (or outside
 * Studio). Filters narrow it to what needs the user and what is failing. Each
 * row is the playtest's card: Start Playtest, Assign to subagent and the full
 * card work as they do in a session, and Open in session goes to the card
 * there. A script no session has gets a session of its own on its first action.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  playtestMatches,
  playtestShown,
  qaActive,
  type PlaytestEntry,
  type PlaytestFilter,
  type PlaytestIndexAnswer,
  type QaRun,
} from "@ue-mcp-studio/shared";
import { api } from "../api";
import type { DaemonState } from "../state";
import { QaCard, QaContext, type QaCardActions, type QaLive } from "../chat/Qa";

const FILTERS: Array<{ id: PlaytestFilter; label: string; empty: string }> = [
  { id: "needs-you", label: "Needs you", empty: "Nothing needs you. A playtest that waits for a verdict, or a loop that stops for you, shows here." },
  { id: "failing", label: "Failing", empty: "No playtest is failing: every last run passed." },
  { id: "all", label: "All", empty: "No playtests in this project yet. Ask the agent for one in a session, or type /playtest." },
];
const FILTER_KEY = "studio.playtests.filter";
/** Events after which the list is read again, once they have stopped for a moment. */
const RELOAD_ON = new Set(["studio.qa.changed", "studio.session.changed", "studio.transcript.added"]);
const RELOAD_MS = 800;

function readFilter(): PlaytestFilter | null {
  try {
    const v = window.localStorage.getItem(FILTER_KEY);
    return v === "needs-you" || v === "failing" || v === "all" ? v : null;
  } catch {
    return null;
  }
}

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", or the date. */
export function ranAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.round((now - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  return new Date(t).toLocaleDateString();
}

/** The project's playtests, read again as runs change. */
export function usePlaytestIndex(daemon: Pick<DaemonState, "events" | "streaming">): { index: PlaytestIndexAnswer | null; error: string | null; reload: (fresh?: boolean) => void } {
  const [index, setIndex] = useState<PlaytestIndexAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = (fresh = false) => {
    api.qaPlaytests(fresh).then((r) => {
      setIndex(r);
      setError(null);
    }, (e: Error) => setError(e.message));
  };
  useEffect(() => {
    if (daemon.streaming) reload(true);
  }, [daemon.streaming]);
  const last = [...daemon.events].reverse().find((e) => RELOAD_ON.has(e.type));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!last) return;
    const t = setTimeout(() => reload(), RELOAD_MS);
    return () => clearTimeout(t);
  }, [last?.id]);
  return { index, error, reload };
}

export function PlaytestsView({ daemon, index: source, onOpenSession }: {
  daemon: DaemonState;
  /** The index the app keeps, which also counts what needs the user on the tab. */
  index: ReturnType<typeof usePlaytestIndex>;
  /** Go to a session and open the playtest's card there. */
  onOpenSession: (sessionId: string, runId: string) => void;
}) {
  const { index, error, reload } = source;
  const all = index?.playtests ?? [];
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, all.filter((e) => playtestMatches(e, f.id)).length])) as Record<PlaytestFilter, number>, [all]);
  const [picked, setPicked] = useState<PlaytestFilter | null>(readFilter);
  // Until the user picks one: Needs you when something does, otherwise All.
  const filter: PlaytestFilter = picked ?? (counts["needs-you"] > 0 ? "needs-you" : "all");
  const pick = (f: PlaytestFilter) => {
    setPicked(f);
    try {
      window.localStorage.setItem(FILTER_KEY, f);
    } catch {
      // The pick lasts for this page only.
    }
  };
  const rows = all.filter((e) => playtestMatches(e, filter));
  const live: QaLive = useMemo(() => ({ events: daemon.events, streaming: daemon.streaming, forms: [], sessionId: null }), [daemon.events, daemon.streaming]);

  return (
    <div className="playtests-page">
      <div className="playtests-head">
        <h1 className="playtests-title">Playtests</h1>
        <span className="dim small playtests-count">{index ? `${all.length} in this project` : ""}</span>
        <span className="spacer" />
        <button className="ghost small-button" onClick={() => reload(true)} title="List the project's scripts again">Refresh</button>
      </div>
      <div className="playtests-filters" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`filter-chip ${filter === f.id ? "active" : ""} ${f.id === "needs-you" && counts[f.id] > 0 ? "attention" : ""}`}
            aria-pressed={filter === f.id}
            onClick={() => pick(f.id)}
          >
            {f.label} <span className="filter-count">{counts[f.id]}</span>
          </button>
        ))}
      </div>
      {error && <div className="banner bad small" role="alert">{error}</div>}
      {index && !index.listed && (
        <div className="banner warn small">The editor is not connected, so scripts that have never run are not listed. Runs Studio has seen are.</div>
      )}
      {!index && !error && <p className="dim small">Loading playtests</p>}
      {index && rows.length === 0 && <p className="muted playtests-empty">{FILTERS.find((f) => f.id === filter)!.empty}</p>}
      <QaContext.Provider value={live}>
        <div className="playtests-list">
          {rows.map((e) => <PlaytestRow key={e.script} entry={e} onOpenSession={onOpenSession} onChanged={() => reload()} />)}
        </div>
      </QaContext.Provider>
    </div>
  );
}

/** Where and when the shown run ran. */
function metaOf(e: PlaytestEntry): string {
  const where = e.session ? `in ${e.session.title || "Untitled"}` : e.last ? "outside Studio" : "";
  const parts = [
    e.deleted ? "Script deleted" : null,
    e.last ? `${qaActive(e.last) ? "Started" : "Ran"} ${ranAgo(e.last.seenAt)} ${where}`.trim() : e.card ? `Never run, drafted ${where}` : "Never run",
  ].filter(Boolean);
  return parts.join(". ");
}

export function PlaytestRow({ entry, onOpenSession, onChanged }: { entry: PlaytestEntry; onOpenSession: (sessionId: string, runId: string) => void; onChanged: () => void }) {
  const shown = playtestShown(entry);
  /** The card in a session, made on the first action that needs one. */
  const card = async (): Promise<QaRun> => entry.card ?? (await api.qaPlaytestCard(entry.script)).run;
  const actions: QaCardActions = {
    start: async (o) => {
      const c = await card();
      const r = await api.qaRun(c.runId, o);
      onChanged();
      return r;
    },
    assign: async () => {
      const c = await card();
      const r = await api.qaAssign(c.runId, null);
      onChanged();
      return r;
    },
  };
  if (!shown) return null;
  const target = entry.session && entry.last?.sessionId === entry.session.id ? entry.last : entry.card;
  const open = target?.sessionId ? (
    <button className="ghost small-button" onClick={() => onOpenSession(target.sessionId!, target.runId)} title={`Open the card in ${entry.session?.title ?? "its session"}`}>Open in session</button>
  ) : null;
  return (
    <div className={`playtests-row ${entry.deleted ? "deleted" : ""}`}>
      <QaCard run={shown} actions={entry.deleted ? {} : actions} meta={metaOf(entry)} extra={open} />
    </div>
  );
}
