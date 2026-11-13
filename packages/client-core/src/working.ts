/**
 * The working line above the composer while a turn runs: what the agent is
 * doing right now and how long the turn has run. Web and phone draw it from
 * this one function, beside a spinner.
 */
import { workingFacts, type SessionDetail, type ToolCallRecord } from "@ue-mcp-studio/shared";
import { isActive } from "./chat-model.js";

export interface WorkingStatus {
  /** What the agent is doing, in a few words. */
  label: string;
  /** When the turn started, in ms since the epoch; null when it cannot be told. */
  since: number | null;
  /** Waiting on the user or the editor rather than working. */
  waiting: boolean;
}

type Detail = Pick<SessionDetail, "status" | "waitingCause" | "transcript"> & Partial<Pick<SessionDetail, "working" | "subagents">> & { mainFree?: boolean };

/** The composer queues behind the turn: the main agent is working. False while only background subagents run. */
export const composerBusy = (detail: Pick<Detail, "status" | "mainFree"> | null | undefined): boolean =>
  !!detail && (detail.status === "running" || detail.status === "waiting") && !detail.mainFree;

const time = (at: string | undefined): number | null => {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : null;
};

const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "mcp__ue-mcp__blueprint" with action "create" reads "blueprint(create)". */
export function toolPhrase(call: Pick<ToolCallRecord, "name" | "input">): string {
  if (call.name === "Agent" || call.name === "Task") return "Running a subagent";
  const name = call.name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
  const input = call.input as { action?: unknown } | null;
  const action = input && typeof input.action === "string" ? input.action : null;
  return `Running ${action ? `${name}(${action})` : name}`;
}

/**
 * The working line, from the daemon's facts (SessionDetail.working), worked
 * out from the whole transcript so a client holding a page shows the same
 * start time and call. A daemon older than 0.1.35-beta.24 sends none; then
 * the same shared rule runs over the transcript the client holds.
 */
export function workingStatus(detail: Detail | null | undefined): WorkingStatus | null {
  if (!detail || (detail.status !== "running" && detail.status !== "waiting")) return null;
  const facts = detail.working ?? workingFacts(detail.transcript ?? []);
  const since = time(facts.since ?? undefined);
  if (detail.status === "waiting") {
    return { label: detail.waitingCause ? `Waiting: ${detail.waitingCause}` : "Waiting for you", since, waiting: true };
  }
  if (detail.mainFree) {
    const n = detail.subagents?.filter((a) => isActive(a.state)).length ?? 0;
    return { label: n > 0 ? `${n} ${n === 1 ? "subagent" : "subagents"} working` : "Subagents working", since, waiting: false };
  }
  return { label: capital(facts.step ? toolPhrase(facts.step) : "Thinking"), since, waiting: false };
}

/** 7s, 1m 05s, 1h 02m. */
export function turnElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
