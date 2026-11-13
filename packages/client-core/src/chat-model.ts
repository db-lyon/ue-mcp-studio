/**
 * What the chat view shows, worked out from a session's transcript: no React,
 * no DOM, so every rule here is unit tested on its own.
 */
import { sessionAgents, type AgentState, type SessionAgent, type SessionDetail, type ToolCallRecord, type TranscriptEntry, type TurnStatus } from "@ue-mcp-studio/shared";
import { baseName } from "./vcs.js";

export type Call = ToolCallRecord;

/** What a subagent is doing now: the daemon's SessionAgent state. */
export type { AgentState };

export const STATE_LABEL: Record<AgentState, string> = {
  queued: "Waiting to start",
  working: "working",
  approval: "waiting on you",
  waiting: "waiting for editor",
  done: "done",
  failed: "failed",
  unknown: "outcome unknown",
  stopped: "stopped",
};

/** The states that are still running; the rest are finished. */
export const ACTIVE: readonly AgentState[] = ["queued", "working", "approval", "waiting"];
export const isActive = (state: AgentState): boolean => ACTIVE.includes(state);

/**
 * The subagents the session lists: every running one, the open thread, and the
 * finished ones not dismissed. Dismissal is the daemon's (each agent's
 * `dismissed`); `pending` holds the viewer's dismissals not saved yet. The
 * Subagents list and the bar's badge both count this, so the badge always says
 * what the list shows.
 */
export function listedSubagents<A extends { id: string; state: AgentState; dismissed?: boolean }>(agents: readonly A[], pending: ReadonlySet<string> = new Set(), open: string | null = null): A[] {
  return agents.filter((a) => isActive(a.state) || a.id === open || !(a.dismissed || pending.has(a.id)));
}

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

/**
 * The session's subagents, as the daemon worked them out from the whole
 * transcript (SessionDetail.subagents): the only source both clients use for
 * the Subagents button, the thread list, a thread's header and the subagent
 * rows in the conversation. A daemon older than 0.1.35-beta.24 sends none;
 * then the same shared rule runs over the transcript the client holds.
 */
export function subagentsOf(detail: Pick<SessionDetail, "transcript" | "status" | "approvals" | "seen" | "dismissed" | "tokens" | "context" | "subagents">): SessionAgent[] {
  if (detail.subagents) return detail.subagents;
  return sessionAgents(detail.transcript, { status: detail.status, asked: new Set((detail.approvals ?? []).map((a) => a.toolUseId)), seen: detail.seen, dismissed: detail.dismissed, tokens: detail.tokens, context: detail.context });
}

/**
 * A subagent for a call the daemon's list does not have yet (its row drawn
 * from an entry newer than the list): its state from the call's outcome alone.
 */
export function agentFor(agents: ReadonlyMap<string, SessionAgent>, call: Call): SessionAgent {
  return agents.get(call.id) ?? sessionAgents([{ kind: "tool", call }], { status: "running", asked: NONE })[0];
}

/** The short name a call shows under: ue-mcp for the editor, the tool for the machine. */
export const TOOL_TAG: Record<string, string> = {
  ue_mcp: "ue-mcp",
  editor_restart: "ue-mcp",
  shell: "shell",
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  glob: "glob",
  grep: "grep",
  web_fetch: "fetch",
  web_search: "search",
  skill: "skill",
  Skill: "skill",
};

interface CallInput {
  action?: string; category?: string; method?: string; query?: string; operation?: string; name?: string; skill?: string;
  command?: string; path?: string; file_path?: string; filePath?: string; pattern?: string; url?: string; offset?: number; limit?: number; glob?: string;
}

/**
 * The file a call names. Studio's tools take path; a built-in reached through
 * an alias records file_path, so both are read.
 */
export function callPath(call: Call): string {
  const i = (call.input ?? {}) as CallInput;
  return i.path ?? i.file_path ?? i.filePath ?? "";
}

/** The lines a read asked for: "lines 55-74", "from line 55", or "" for the whole file. */
export function lineRange(offset?: number, limit?: number): string {
  if (!offset && !limit) return "";
  const first = offset || 1;
  return limit ? `lines ${first}-${first + limit - 1}` : `from line ${first}`;
}

function label(call: Call, full: boolean): string {
  const i = (call.input ?? {}) as CallInput;
  const file = full ? callPath(call) : baseName(callPath(call));
  if (call.name === "editor_restart") return `editor ${i.operation ?? ""}`;
  if (call.name === "shell") return firstLine(i.command ?? "");
  if (call.name === "read_file") {
    const range = lineRange(i.offset, i.limit);
    return range ? `${file} (${range})` : file;
  }
  if (call.name === "write_file" || call.name === "edit_file") return file;
  if (call.name === "glob") return `${i.pattern ?? ""}${i.path ? ` in ${i.path}` : ""}`;
  if (call.name === "grep") return `/${i.pattern ?? ""}/${i.glob ? ` ${i.glob}` : ""}${i.path ? ` in ${i.path}` : ""}`;
  if (call.name === "web_fetch") return i.url ?? "";
  if (call.name === "web_search") return `"${i.query ?? ""}"`;
  if (call.name === "skill" || call.name === "Skill") return i.name ?? i.skill ?? "";
  if (call.name !== "ue_mcp") return firstString(call.input);
  if (i.action === "call") return `${i.category}.${i.method}`;
  if (i.action === "search") return `search "${i.query ?? ""}"`;
  if (i.action === "describe" || (!i.action && i.category)) return `describe ${i.category ?? ""}${i.method ? `.${i.method}` : ""}`;
  return (i.action ?? "").replace(/_/g, " ");
}

/** A tool call as one short line: the action it ran, the command, the file by name with the lines read, or the search it made. */
export const toolLabel = (call: Call): string => label(call, false);

/** The same line with paths in full, for the hover or long press on a call. */
export const toolTitle = (call: Call): string => label(call, true);

/** The first text in a tool's input, for a tool this client has no line for. */
function firstString(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const v = Object.values(input as Record<string, unknown>).find((x) => typeof x === "string" && x.trim());
  return typeof v === "string" ? firstLine(v) : "";
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

/** A token count, short: 950, 12.4k, 1.2M. */
export function tokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export interface AgentStatus {
  state: AgentState;
  /** For a running subagent: the call it is running, "thinking", or how long it has been quiet. */
  activity: string | null;
  secs: number;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * A subagent as its row and header say it now: the daemon's state, its step
 * in a few words (or the call waiting for approval, #149), and how long it
 * has run. Only the time is the client's: how long ago `now` its last step was.
 */
export function agentView(agent: SessionAgent, now: number): AgentStatus {
  const { call, state, step } = agent;
  const end = call.endedAt ? Date.parse(call.endedAt) : now;
  const secs = Math.max(1, Math.round((end - Date.parse(call.startedAt)) / 1000));
  if (state === "approval" && step) return { state, activity: `approve ${toolLabel(step)}`, secs };
  if (state !== "working") return { state, activity: null, secs };
  if (step) return { state, activity: stepActivity(step), secs };
  const last = Date.parse(agent.lastStepAt);
  if (now - last > QUIET_MS) return { state, activity: `thinking, ${formatDuration((now - last) / 1000)} since its last step`, secs };
  return { state, activity: "thinking", secs };
}

/** "3 working, 12 done, 1 failed": the states present, in a fixed order. */
export function summarize(states: AgentState[]): string {
  const n = (st: AgentState) => states.filter((s) => s === st).length;
  const failed = n("failed") + n("unknown");
  return [
    n("approval") && `${n("approval")} waiting on you`,
    n("working") && `${n("working")} working`,
    n("queued") && `${n("queued")} waiting to start`,
    n("waiting") && `${n("waiting")} waiting`,
    n("done") && `${n("done")} done`,
    n("stopped") && `${n("stopped")} stopped`,
    failed && `${failed} failed`,
  ].filter(Boolean).join(", ");
}

/** A line of a thread (the main one or a subagent's) as the view draws it. */
export type ThreadItem =
  | { kind: "entry"; entry: TranscriptEntry }
  /** Subagents started together, drawn as one block. */
  | { kind: "agents"; calls: Call[] }
  /** A run of neighbouring tool calls, whatever their outcome, folded into one summary line. */
  | { kind: "steps"; calls: Call[] };

/**
 * Whether a call folds into a run of steps: every call but a subagent and a
 * call waiting for the user's approval, which the reader needs to see now.
 */
export function foldsAway(call: Call, asked: ReadonlySet<string> = NONE): boolean {
  return call.name !== "agent" && !(call.outcome === "pending" && asked.has(call.id));
}

/** The run's call that is running now, the newest one, or null once all have finished. */
export const liveStep = (calls: Call[]): Call | null => [...calls].reverse().find((c) => c.outcome === "pending") ?? null;

/** What each kind of step counts as in a summary (the verb, the noun, whether it counts distinct files) and says while it runs. */
const STEP_KINDS: Array<{ names: string[]; verb: string; one: string; many: string; doing: string; files?: boolean }> = [
  { names: ["read_file"], verb: "read", one: "file", many: "files", doing: "reading", files: true },
  { names: ["shell"], verb: "ran", one: "command", many: "commands", doing: "running a command" },
  { names: ["glob", "grep", "web_search"], verb: "searched", one: "time", many: "times", doing: "searching" },
  { names: ["edit_file"], verb: "edited", one: "file", many: "files", doing: "editing", files: true },
  { names: ["write_file"], verb: "wrote", one: "file", many: "files", doing: "writing", files: true },
  { names: ["web_fetch"], verb: "fetched", one: "page", many: "pages", doing: "fetching a page" },
  { names: ["ue_mcp", "editor_restart"], verb: "made", one: "editor call", many: "editor calls", doing: "" },
  { names: ["skill", "Skill"], verb: "loaded", one: "skill", many: "skills", doing: "loading a skill" },
];

/**
 * A running step in a few words, the same at its first frame and its last:
 * "running a command", "reading Transcript.tsx", "level.get_outliner".
 */
export function stepActivity(call: Call): string {
  const kind = STEP_KINDS.find((k) => k.names.includes(call.name));
  if (!kind) return call.name;
  if (!kind.doing) return toolLabel(call);
  const file = kind.files ? baseName(callPath(call)) : "";
  return file ? `${kind.doing} ${file}` : kind.files ? `${kind.doing} a file` : kind.doing;
}

/** "Read 9 files, ran 2 commands": each kind of step in the order it first ran. */
export function stepsSummary(calls: Call[]): string {
  const parts = new Map<string, { kind: (typeof STEP_KINDS)[number] | null; n: number; files: Set<string> }>();
  for (const c of calls) {
    const kind = STEP_KINDS.find((k) => k.names.includes(c.name)) ?? null;
    const key = kind ? kind.verb : "other";
    const part = parts.get(key) ?? { kind, n: 0, files: new Set<string>() };
    part.n++;
    part.files.add(callPath(c) || c.id);
    parts.set(key, part);
  }
  const text = [...parts.values()].map(({ kind, n, files }) => {
    if (!kind) return `used ${n} other ${n === 1 ? "tool" : "tools"}`;
    const count = kind.files ? files.size : n;
    return `${kind.verb} ${count} ${count === 1 ? kind.one : kind.many}`;
  }).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "1 failed, 1 declined": the calls in a run that went wrong, for the summary line in the bad colour. */
export function stepsTrouble(calls: Call[]): string {
  const n = (...outcomes: Call["outcome"][]) => calls.filter((c) => outcomes.includes(c.outcome)).length;
  const failed = n("error", "unknown");
  const declined = n("declined");
  const stopped = n("stopped");
  return [failed && `${failed} failed`, declined && `${declined} declined`, stopped && `${stopped} stopped`].filter(Boolean).join(", ");
}

/**
 * A thread's lines: each run of tool calls between two other lines folds into
 * one steps item, neighbouring subagent calls group, and everything else
 * (messages, held calls, cards, dialogs, markers) is its own line.
 */
export function timeline(entries: TranscriptEntry[], asked: ReadonlySet<string> = NONE): ThreadItem[] {
  const out: ThreadItem[] = [];
  for (const t of entries) {
    const last = out[out.length - 1];
    if (t.kind === "tool" && t.call.name === "agent") {
      if (last?.kind === "agents") last.calls.push(t.call);
      else out.push({ kind: "agents", calls: [t.call] });
    } else if (t.kind === "tool" && foldsAway(t.call, asked)) {
      if (last?.kind === "steps") last.calls.push(t.call);
      else out.push({ kind: "steps", calls: [t.call] });
    } else out.push({ kind: "entry", entry: t });
  }
  return out;
}

/** The main thread: entries without a parent that `shown` accepts (a card nothing draws is not). */
export function mainTimeline(transcript: TranscriptEntry[], shown?: (t: TranscriptEntry) => boolean, asked: ReadonlySet<string> = NONE): ThreadItem[] {
  return timeline(transcript.filter((t) => !t.parent && (!shown || shown(t))), asked);
}

/** A subagent's own thread, folded the same way as the main one. */
export const subagentTimeline = (transcript: TranscriptEntry[], id: string, asked: ReadonlySet<string> = NONE): ThreadItem[] =>
  timeline(transcript.filter((t) => t.parent === id), asked);

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
