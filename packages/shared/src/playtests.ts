/**
 * Playtests as the project has them, beside the chat: which ones need the
 * user now, and the project-wide list the Playtests page shows. A playtest is
 * a ue-mcp PIE test script; its runs are QaRuns, each in the session whose
 * call started it, or in no session when a run started outside Studio.
 */
import { qaEnded, qaIsDraft, qaSummaryOf, type QaRun } from "./qa.js";

/** A playtest waiting for the user: a step's verdict, or a loop that stopped for them. */
export const qaNeedsYou = (run: QaRun): boolean =>
  !run.deleted && (run.state === "awaiting_verdict" || run.steps.some((s) => s.status === "awaiting_verdict") || run.assignment?.loop?.state === "needs_you");

/**
 * A playtest that is live in its session: armed, running, waiting for a
 * verdict, or in an assigned loop that runs or needs the user. Drafts and
 * ended runs are not.
 */
export function qaActive(run: QaRun): boolean {
  if (run.deleted) return false;
  if (run.assignment?.state === "running" || run.assignment?.loop?.state === "needs_you") return true;
  if (qaIsDraft(run) || run.state === "idle") return false;
  return !qaEnded(run.state);
}

/** A run with a step that failed, or a loop that broke. */
export function qaFailing(run: QaRun): boolean {
  if (qaIsDraft(run) || run.deleted) return false;
  return (run.summary ?? qaSummaryOf(run.steps)).failed > 0 || run.assignment?.loop?.state === "failed";
}

/** One playtest script on the Playtests page. */
export interface PlaytestEntry {
  /** The script's asset path, without its object name. */
  script: string;
  name: string;
  /** The newest run, wherever it started: a session's, one started elsewhere, or its results.json. Null when it never ran. */
  last: QaRun | null;
  /**
   * The card Start Playtest and Assign to subagent act on: the newest run or
   * draft that has a session. Null when no session has one yet; POST
   * /qa/playtests/card makes one.
   */
  card: QaRun | null;
  /** The script's steps as it is saved, for a script with no run and no card. */
  draft: QaRun | null;
  /** The session the newest run is in, or the card's when it never ran; null for a run started outside Studio. */
  session: { id: string; title: string } | null;
  /** The script is gone from the project: only its runs are left. */
  deleted?: boolean;
}

/** GET /v1/ext/studio/qa/playtests */
export interface PlaytestIndexAnswer {
  playtests: PlaytestEntry[];
  /** Whether the editor listed the project's scripts; without it, scripts that never ran are missing. */
  listed: boolean;
}

/** The run a page row shows: the newest run, else the card, else the saved script. */
export const playtestShown = (e: PlaytestEntry): QaRun | null => e.last ?? e.card ?? e.draft;

export type PlaytestFilter = "needs-you" | "failing" | "all";

export function playtestMatches(e: PlaytestEntry, filter: PlaytestFilter): boolean {
  if (filter === "all") return true;
  const runs = [e.last, e.card].filter((r): r is QaRun => !!r);
  if (filter === "needs-you") return runs.some(qaNeedsYou);
  return !!e.last && qaFailing(e.last);
}

/** Page order: what needs the user, then what is live, then the newest run, then scripts that never ran by name. */
export function playtestOrder(a: PlaytestEntry, b: PlaytestEntry): number {
  const rank = (e: PlaytestEntry) => {
    const runs = [e.last, e.card].filter((r): r is QaRun => !!r);
    return runs.some(qaNeedsYou) ? 0 : runs.some(qaActive) ? 1 : e.last ? 2 : 3;
  };
  const d = rank(a) - rank(b);
  if (d !== 0) return d;
  const at = (e: PlaytestEntry) => e.last?.seenAt ?? "";
  if (at(a) !== at(b)) return at(a) < at(b) ? 1 : -1;
  return a.name.localeCompare(b.name);
}
