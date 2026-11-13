/**
 * The working line above the composer while a turn runs: what the agent is
 * doing right now and how long the turn has run. Web and phone draw it from
 * this one function, beside a spinner.
 */
import type { SessionDetail, ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";

export interface WorkingStatus {
  /** What the agent is doing, in a few words. */
  label: string;
  /** When the turn started, in ms since the epoch; null when it cannot be told. */
  since: number | null;
  /** Waiting on the user or the editor rather than working. */
  waiting: boolean;
}

type Detail = Pick<SessionDetail, "status" | "waitingCause" | "transcript">;

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

const main = (e: TranscriptEntry) => !e.parent;

export function workingStatus(detail: Detail | null | undefined): WorkingStatus | null {
  if (!detail || (detail.status !== "running" && detail.status !== "waiting")) return null;
  const t = detail.transcript ?? [];
  let since: number | null = null;
  for (let i = t.length - 1; i >= 0; i--) {
    const e = t[i];
    if (e.kind === "user" && main(e)) { since = time(e.at); break; }
  }
  if (detail.status === "waiting") {
    return { label: detail.waitingCause ? `Waiting: ${detail.waitingCause}` : "Waiting for you", since, waiting: true };
  }
  let label = "Thinking";
  for (let i = t.length - 1; i >= 0; i--) {
    const e = t[i];
    if (!main(e)) continue;
    if (e.kind === "tool" && e.call.outcome === "pending") label = toolPhrase(e.call);
    break;
  }
  return { label: capital(label), since, waiting: false };
}

/** 7s, 1m 05s, 1h 02m. */
export function turnElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
