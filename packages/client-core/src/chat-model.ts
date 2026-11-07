/**
 * What the chat view shows, worked out from a session's transcript: no React,
 * no DOM, so every rule here is unit tested on its own.
 */
import type { ToolCallRecord, TranscriptEntry, TurnStatus } from "@ue-mcp-studio/shared";
import { baseName } from "./vcs.js";

export type Call = ToolCallRecord;

/** What a subagent is doing now. */
export type AgentState = "queued" | "working" | "approval" | "waiting" | "done" | "failed" | "unknown" | "stopped";

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

const timeOf = (t: TranscriptEntry): number =>
  t.kind === "dialog" ? t.dialog.openedAt : t.kind === "qa" ? Date.parse(t.run.seenAt) : t.kind === "review" ? Date.parse(t.review.at) : Date.parse(t.kind === "tool" ? t.call.endedAt ?? t.call.startedAt : t.at);

export interface AgentStatus {
  state: AgentState;
  /** For a running subagent: the call it is running, "thinking", or how long it has been quiet. */
  activity: string | null;
  secs: number;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * A subagent's state, from its call and its own transcript entries. `asked`:
 * the tool call ids waiting for the user's approval, which make a subagent
 * that runs one wait on the user rather than work (#149).
 */
export function agentStatus(call: Call, transcript: TranscriptEntry[], sessionWaiting: boolean, now: number, asked: ReadonlySet<string> = NONE): AgentStatus {
  const end = call.endedAt ? Date.parse(call.endedAt) : now;
  const secs = Math.max(1, Math.round((end - Date.parse(call.startedAt)) / 1000));
  if (call.outcome === "done") return { state: "done", activity: null, secs };
  if (call.outcome === "error") return { state: "failed", activity: null, secs };
  if (call.outcome === "unknown") return { state: "unknown", activity: null, secs };
  if (call.outcome === "stopped") return { state: "stopped", activity: null, secs };
  // Past the limit of subagents at once: it starts when a running one finishes.
  if (call.queued) return { state: "queued", activity: null, secs };
  const steps = transcript.filter((t) => t.parent === call.id);
  const held = steps.find((t) => t.kind === "tool" && t.call.outcome === "pending" && asked.has(t.call.id));
  if (held?.kind === "tool") return { state: "approval", activity: `approve ${toolLabel(held.call)}`, secs };
  if (sessionWaiting) return { state: "waiting", activity: null, secs };
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
    n("approval") && `${n("approval")} waiting on you`,
    n("working") && `${n("working")} working`,
    n("queued") && `${n("queued")} waiting to start`,
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
  | { kind: "progress"; entries: TranscriptEntry[] }
  /** Consecutive working steps (reads, commands, searches, edits, editor calls) folded into one summary line. */
  | { kind: "steps"; calls: Call[] };

/** A thread's lines when only the step fold applies: a subagent's own thread. */
export type StepItem = Extract<MainItem, { kind: "entry" | "steps" }>;

/** The fewest neighbouring steps that fold; a lone step is already one line. */
export const FOLD_MIN = 2;

/**
 * Whether a call folds into a run of steps: finished or running, not a
 * subagent, and not waiting for the user's approval. A failed, declined,
 * stopped or unknown call stays its own line and ends the run, so nothing that
 * went wrong is hidden behind a summary.
 */
export function foldsAway(call: Call, asked: ReadonlySet<string> = NONE): boolean {
  if (call.name === "agent") return false;
  return call.outcome === "done" || (call.outcome === "pending" && !asked.has(call.id));
}

/** The run's call that is running now, the newest one, or null once all have finished. */
export const liveStep = (calls: Call[]): Call | null => [...calls].reverse().find((c) => c.outcome === "pending") ?? null;

/** What each kind of step counts as in a summary: the verb, the noun, and whether it counts distinct files. */
const STEP_KINDS: Array<{ names: string[]; verb: string; one: string; many: string; files?: boolean }> = [
  { names: ["read_file"], verb: "read", one: "file", many: "files", files: true },
  { names: ["shell"], verb: "ran", one: "command", many: "commands" },
  { names: ["glob", "grep", "web_search"], verb: "searched", one: "time", many: "times" },
  { names: ["edit_file"], verb: "edited", one: "file", many: "files", files: true },
  { names: ["write_file"], verb: "wrote", one: "file", many: "files", files: true },
  { names: ["web_fetch"], verb: "fetched", one: "page", many: "pages" },
  { names: ["ue_mcp", "editor_restart"], verb: "made", one: "editor call", many: "editor calls" },
  { names: ["skill", "Skill"], verb: "loaded", one: "skill", many: "skills" },
];

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

/**
 * Groups runs of neighbouring steps: each run of FOLD_MIN or more calls that
 * fold away becomes one steps item, and everything else (replies, failed
 * calls, calls waiting on the user, cards, markers) stays its own line and
 * ends the run.
 */
export function foldSteps(entries: TranscriptEntry[], asked: ReadonlySet<string> = NONE): StepItem[] {
  const out: StepItem[] = [];
  let run: TranscriptEntry[] = [];
  const flush = () => {
    if (run.length >= FOLD_MIN) out.push({ kind: "steps", calls: run.map((t) => (t as Extract<TranscriptEntry, { kind: "tool" }>).call) });
    else for (const t of run) out.push({ kind: "entry", entry: t });
    run = [];
  };
  for (const t of entries) {
    if (t.kind === "tool" && foldsAway(t.call, asked)) run.push(t);
    else {
      flush();
      out.push({ kind: "entry", entry: t });
    }
  }
  flush();
  return out;
}

/**
 * The main thread: entries without a parent that `shown` accepts (a card nothing draws is not),
 * neighbouring agent calls grouped, runs of working steps folded into one line (foldSteps; `asked`
 * holds the calls waiting on the user, which never fold), and in a finished turn that ran
 * subagents, every message the main agent wrote before its final one folded into one progress line.
 */
export function mainTimeline(transcript: TranscriptEntry[], status: TurnStatus, shown?: (t: TranscriptEntry) => boolean, asked: ReadonlySet<string> = NONE): MainItem[] {
  const main = transcript.filter((t) => !t.parent && (!shown || shown(t)));
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
    let run: TranscriptEntry[] = [];
    const flushRun = () => {
      if (run.length > 0) out.push(...foldSteps(run, asked));
      run = [];
    };
    for (const t of turn) {
      if (folded.has(t)) {
        flushRun();
        progress.push(t);
        continue;
      }
      if (progress.length > 0) {
        out.push({ kind: "progress", entries: progress });
        progress = [];
      }
      if (t.kind === "tool" && foldsAway(t.call, asked)) {
        run.push(t);
        continue;
      }
      flushRun();
      const last = out[out.length - 1];
      if (t.kind === "tool" && t.call.name === "agent") {
        if (last?.kind === "agents") last.calls.push(t.call);
        else out.push({ kind: "agents", calls: [t.call] });
      } else {
        out.push({ kind: "entry", entry: t });
      }
    }
    flushRun();
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
