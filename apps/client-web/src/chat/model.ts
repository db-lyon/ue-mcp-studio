/**
 * What the chat view shows, worked out from a session's transcript: no React,
 * no DOM, so every rule here is unit tested on its own.
 */
import type { ToolCallRecord, TranscriptEntry, TurnStatus } from "@ue-mcp-studio/shared";

export type Call = ToolCallRecord;

/** What a subagent is doing now. */
export type AgentState = "working" | "waiting" | "done" | "failed" | "unknown" | "stopped";

export const STATE_LABEL: Record<AgentState, string> = {
  working: "working",
  waiting: "waiting for editor",
  done: "done",
  failed: "failed",
  unknown: "outcome unknown",
  stopped: "stopped",
};

/** The states that are still running; the rest are finished. */
export const ACTIVE: readonly AgentState[] = ["working", "waiting"];
export const isActive = (state: AgentState): boolean => ACTIVE.includes(state);

/**
 * A running subagent quiet for this long says how long. Quiet is not stuck: a
 * model thinking through a long answer writes nothing until it is done, so the
 * time is shown and no verdict is drawn from it.
 */
export const QUIET_MS = 90_000;

export const OUTCOME_LABEL: Record<ToolCallRecord["outcome"], string> = {
  pending: "running",
  done: "done",
  error: "failed",
  unknown: "outcome unknown",
  stopped: "stopped",
  declined: "declined",
};

export const describe = (c: Call): string => (c.input as { description?: string }).description ?? "Subagent";

export const callsIn = (transcript: TranscriptEntry[], id: string): number =>
  transcript.filter((t) => t.parent === id && t.kind === "tool").length;

/** Every agent call in the session, in the order they started. */
export function agentCalls(transcript: TranscriptEntry[]): Call[] {
  return transcript.flatMap((t) => (t.kind === "tool" && t.call.name === "agent" ? [t.call] : []));
}

/** The short name a call shows under: ue-mcp for the editor, the tool for the machine. */
export const TOOL_TAG: Record<string, string> = {
  ue_mcp: "ue-mcp",
  editor_restart: "ue-mcp",
  pie: "ue-mcp",
  shell: "shell",
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  glob: "glob",
  grep: "grep",
  web_fetch: "fetch",
  web_search: "search",
};

/** A tool call as one short line: the action it ran, the command, the file, or the search it made. */
export function toolLabel(call: Call): string {
  const i = call.input as {
    action?: string; category?: string; method?: string; query?: string; operation?: string;
    command?: string; path?: string; pattern?: string; url?: string; offset?: number; limit?: number; glob?: string;
  };
  if (call.name === "editor_restart") return `editor ${i.operation ?? ""}`;
  // A /playtest's pie tool names its action inline.
  if (call.name === "pie") return `pie.${i.action ?? ""}`;
  if (call.name === "shell") return firstLine(i.command ?? "");
  if (call.name === "read_file") return i.offset || i.limit ? `${i.path ?? ""} (from line ${i.offset ?? 1})` : i.path ?? "";
  if (call.name === "write_file" || call.name === "edit_file") return i.path ?? "";
  if (call.name === "glob") return `${i.pattern ?? ""}${i.path ? ` in ${i.path}` : ""}`;
  if (call.name === "grep") return `/${i.pattern ?? ""}/${i.glob ? ` ${i.glob}` : ""}${i.path ? ` in ${i.path}` : ""}`;
  if (call.name === "web_fetch") return i.url ?? "";
  if (call.name === "web_search") return `"${i.query ?? ""}"`;
  if (i.action === "call") return `${i.category}.${i.method}`;
  if (i.action === "search") return `search "${i.query ?? ""}"`;
  return `describe ${i.category ?? ""}${i.method ? `.${i.method}` : ""}`;
}

/** A command's first line, with a mark when it has more. */
function firstLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} (+${lines.length - 1} lines)` : lines[0];
}

/** 45s, 1m 5s, 1h 2m. */
export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const timeOf = (t: TranscriptEntry): number =>
  t.kind === "dialog" ? t.dialog.openedAt : t.kind === "qa" ? Date.parse(t.run.seenAt) : Date.parse(t.kind === "tool" ? t.call.endedAt ?? t.call.startedAt : t.at);

export interface AgentStatus {
  state: AgentState;
  /** For a running subagent: the call it is running, "thinking", or how long it has been quiet. */
  activity: string | null;
  secs: number;
}

/** A subagent's state, from its call and its own transcript entries. */
export function agentStatus(call: Call, transcript: TranscriptEntry[], sessionWaiting: boolean, now: number): AgentStatus {
  const end = call.endedAt ? Date.parse(call.endedAt) : now;
  const secs = Math.max(1, Math.round((end - Date.parse(call.startedAt)) / 1000));
  if (call.outcome === "done") return { state: "done", activity: null, secs };
  if (call.outcome === "error") return { state: "failed", activity: null, secs };
  if (call.outcome === "unknown") return { state: "unknown", activity: null, secs };
  if (call.outcome === "stopped") return { state: "stopped", activity: null, secs };
  if (sessionWaiting) return { state: "waiting", activity: null, secs };
  const steps = transcript.filter((t) => t.parent === call.id);
  const running = [...steps].reverse().find((t) => t.kind === "tool" && t.call.outcome === "pending");
  if (running?.kind === "tool") return { state: "working", activity: toolLabel(running.call), secs };
  const last = Math.max(Date.parse(call.startedAt), ...steps.map(timeOf));
  if (now - last > QUIET_MS) return { state: "working", activity: `thinking, ${formatDuration((now - last) / 1000)} since its last step`, secs };
  return { state: "working", activity: "thinking", secs };
}

/** "3 working, 12 done, 1 failed": the states present, in a fixed order. */
export function summarize(states: AgentState[]): string {
  const n = (st: AgentState) => states.filter((s) => s === st).length;
  const failed = n("failed") + n("unknown");
  return [
    n("working") && `${n("working")} working`,
    n("waiting") && `${n("waiting")} waiting`,
    n("done") && `${n("done")} done`,
    n("stopped") && `${n("stopped")} stopped`,
    failed && `${failed} failed`,
  ].filter(Boolean).join(", ");
}

/** A line of the main thread as the view draws it. */
export type MainItem =
  | { kind: "entry"; entry: TranscriptEntry }
  /** Subagents the main agent started together, drawn as one block. */
  | { kind: "agents"; calls: Call[] }
  /** The main agent's progress messages from a finished turn, folded behind its final answer. */
  | { kind: "progress"; entries: TranscriptEntry[] };

/**
 * The main thread: the entries without a parent, with neighbouring agent calls
 * grouped, and in a finished turn that ran subagents, every message the main
 * agent wrote before its final one folded into one progress line.
 */
export function mainTimeline(transcript: TranscriptEntry[], status: TurnStatus): MainItem[] {
  const main = transcript.filter((t) => !t.parent);
  // Turns: each starts at a user message.
  const turns: TranscriptEntry[][] = [];
  for (const t of main) {
    if (t.kind === "user" || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(t);
  }
  const busy = status === "running" || status === "waiting";
  const out: MainItem[] = [];
  turns.forEach((turn, ti) => {
    const finished = ti < turns.length - 1 || !busy;
    const ranAgents = turn.some((t) => t.kind === "tool" && t.call.name === "agent");
    const replies = turn.filter((t) => t.kind === "assistant");
    const folded = new Set<TranscriptEntry>(finished && ranAgents && replies.length > 1 ? replies.slice(0, -1) : []);
    let progress: TranscriptEntry[] = [];
    for (const t of turn) {
      if (folded.has(t)) {
        progress.push(t);
        continue;
      }
      if (progress.length > 0) {
        out.push({ kind: "progress", entries: progress });
        progress = [];
      }
      const last = out[out.length - 1];
      if (t.kind === "tool" && t.call.name === "agent") {
        if (last?.kind === "agents") last.calls.push(t.call);
        else out.push({ kind: "agents", calls: [t.call] });
      } else {
        out.push({ kind: "entry", entry: t });
      }
    }
    if (progress.length > 0) out.push({ kind: "progress", entries: progress });
  });
  return out;
}

/** A tool result for reading: JSON indented, and how many lines it has. */
export function formatResult(text: string): { text: string; lines: number } {
  let out = text;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      out = JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // Not JSON after all: show it as it came.
    }
  }
  return { text: out, lines: out.split("\n").length };
}

/** How many lines of a result show before "Show all". */
export const RESULT_PREVIEW_LINES = 30;

/** Sessions whose turn was running in `before` and has ended in `after`. */
export function finishedTurns<S extends { id: string; status: TurnStatus }>(before: S[], after: S[]): S[] {
  const was = new Map(before.map((s) => [s.id, s.status]));
  return after.filter((s) => {
    const prev = was.get(s.id);
    return (prev === "running" || prev === "waiting") && s.status !== "running" && s.status !== "waiting";
  });
}
