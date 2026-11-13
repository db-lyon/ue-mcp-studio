import { describe, expect, it } from "vitest";
import type { ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";
import { sessionAgents, type ToolCallRecord as Rec, type TranscriptEntry as Entry } from "@ue-mcp-studio/shared";
import { QUIET_MS, agentView, finishedTurns, formatDuration, formatResult, listedSubagents, mainTimeline, summarize, toolLabel } from "../src/chat-model.js";

/** A subagent's status as a client shows it: the daemon's state for it (shared sessionAgents), formatted by agentView. */
function agentStatus(call: Rec, transcript: Entry[], waiting: boolean, now: number) {
  const held = transcript.some((e) => e.kind === "tool" && e.call.id === call.id);
  const t: Entry[] = held ? transcript.map((e) => (e.kind === "tool" && e.call.id === call.id ? { ...e, call } : e)) : [{ kind: "tool", call }, ...transcript];
  return agentView(sessionAgents(t, { status: waiting ? "waiting" : "running", asked: new Set() }).find((x) => x.id === call.id)!, now);
}

const T0 = Date.parse("2026-10-11T12:00:00Z");
const at = (secs: number) => new Date(T0 + secs * 1000).toISOString();

const agent = (id: string, outcome: ToolCallRecord["outcome"] = "pending", end?: number): TranscriptEntry => ({
  kind: "tool",
  call: { id, name: "agent", input: { description: `Task ${id}`, prompt: "p" }, outcome, startedAt: at(0), endedAt: end === undefined ? undefined : at(end) },
});
const step = (parent: string, id: string, outcome: ToolCallRecord["outcome"], start: number, end?: number): TranscriptEntry => ({
  kind: "tool",
  parent,
  call: { id, name: "ue_mcp", input: { action: "call", category: "level", method: "get_outliner" }, outcome, startedAt: at(start), endedAt: end === undefined ? undefined : at(end) },
});
const user = (text: string): TranscriptEntry => ({ kind: "user", text, at: at(0) });
const reply = (text: string, parent?: string): TranscriptEntry => ({ kind: "assistant", text, at: at(1), ...(parent ? { parent } : {}) });
const callOf = (e: TranscriptEntry) => (e as Extract<TranscriptEntry, { kind: "tool" }>).call;

describe("a subagent's state", () => {
  it("is working, naming the call it is running", () => {
    const a = agent("a");
    const st = agentStatus(callOf(a), [a, step("a", "s1", "pending", 2)], false, T0 + 5000);
    expect(st).toEqual({ state: "working", activity: "level.get_outliner", secs: 5 });
  });

  it("names a running command or file in a few words, never the command itself", () => {
    const a = agent("a");
    const run = (name: string, input: object): TranscriptEntry => ({ kind: "tool", at: at(2), parent: "a", call: { id: "s1", name, input, outcome: "pending", startedAt: at(2) } });
    const now = T0 + 5000;
    expect(agentStatus(callOf(a), [a, run("shell", { command: "cd /c/x && git show 488e:Docs/A.md | sed -n '1,12p'" })], false, now).activity).toBe("running a command");
    expect(agentStatus(callOf(a), [a, run("read_file", { file_path: "C:\\x\\Docs\\ARCHITECTURE.md" })], false, now).activity).toBe("reading ARCHITECTURE.md");
    expect(agentStatus(callOf(a), [a, run("grep", { pattern: "x" })], false, now).activity).toBe("searching");
  });

  it("is thinking between calls", () => {
    const a = agent("a");
    expect(agentStatus(callOf(a), [a, step("a", "s1", "done", 2, 3)], false, T0 + 10_000).activity).toBe("thinking");
  });

  it("stays working when quiet, and says how long since its last step instead of calling it stuck", () => {
    const a = agent("a");
    const st = agentStatus(callOf(a), [a, step("a", "s1", "done", 2, 3)], false, T0 + 3000 + QUIET_MS + 1000);
    expect(st.state).toBe("working");
    expect(st.activity).toBe("thinking, 1m 31s since its last step");
    expect(agentStatus(callOf(a), [a], false, T0 + QUIET_MS + 1).state).toBe("working");
  });

  it("is waiting to start while past the limit of subagents at once, and finished once it ends (#164)", () => {
    const call = { ...callOf(agent("w")), queued: true };
    expect(agentStatus(call, [], false, T0 + 5000)).toEqual({ state: "queued", activity: null, secs: 5 });
    expect(agentStatus(call, [], true, T0 + 5000).state).toBe("queued");
    expect(agentStatus({ ...call, outcome: "stopped", endedAt: at(2) }, [], false, T0 + 5000).state).toBe("stopped");
    expect(summarize(["working", "queued", "queued", "done"])).toBe("1 working, 2 waiting to start, 1 done");
  });

  it("names the running call however long it takes", () => {
    const a = agent("a");
    expect(agentStatus(callOf(a), [a, step("a", "s1", "pending", 2)], false, T0 + 10 * QUIET_MS).state).toBe("working");
  });

  it("is waiting while the session waits for the editor", () => {
    const a = agent("a");
    expect(agentStatus(callOf(a), [a], true, T0 + 1000).state).toBe("waiting");
  });

  it("maps each finished outcome, and its time stops at the end", () => {
    for (const [outcome, state] of [["done", "done"], ["error", "failed"], ["unknown", "unknown"], ["stopped", "stopped"]] as const) {
      const a = agent("a", outcome, 42);
      expect(agentStatus(callOf(a), [a], false, T0 + 999_000)).toEqual({ state, activity: null, secs: 42 });
    }
  });
});

describe("the listed subagents", () => {
  const agent = (id: string, outcome: Rec["outcome"]): Entry => ({ kind: "tool", call: { id, name: "agent", input: { description: id }, outcome, startedAt: at(0) } });
  const transcript = [agent("run", "pending"), ...Array.from({ length: 13 }, (_, i) => agent(`done${i}`, "done"))];
  const finished = Array.from({ length: 13 }, (_, i) => `done${i}`);

  it("drops finished subagents the daemon has dismissed, and keeps the running one", () => {
    const agents = sessionAgents(transcript, { status: "running", asked: new Set(), dismissed: finished.slice(0, 12) });
    expect(agents).toHaveLength(14);
    expect(listedSubagents(agents).map((a) => a.id)).toEqual(["run", "done12"]);
  });

  it("drops the viewer's dismissals before the daemon has saved them", () => {
    const agents = sessionAgents(transcript, { status: "running", asked: new Set() });
    expect(listedSubagents(agents, new Set(finished)).map((a) => a.id)).toEqual(["run"]);
  });

  it("keeps the open thread, even dismissed, and never drops a running one", () => {
    const agents = sessionAgents(transcript, { status: "running", asked: new Set(), dismissed: ["run", ...finished] });
    expect(listedSubagents(agents, new Set(), "done3").map((a) => a.id)).toEqual(["run", "done3"]);
  });
});

describe("summaries and formats", () => {
  it("counts states in a fixed order, failures together", () => {
    expect(summarize(["done", "working", "failed", "unknown", "done", "stopped"])).toBe("1 working, 2 done, 1 stopped, 2 failed");
  });

  it("formats durations", () => {
    expect([formatDuration(45), formatDuration(65), formatDuration(3720)]).toEqual(["45s", "1m 5s", "1h 2m"]);
  });

  it("indents JSON results and leaves other text alone", () => {
    expect(formatResult('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', lines: 3 });
    expect(formatResult("{not json")).toEqual({ text: "{not json", lines: 1 });
  });

  it("labels tool calls", () => {
    const c = (input: Record<string, unknown>, name = "ue_mcp") => toolLabel({ id: "x", name, input, outcome: "done", startedAt: at(0) });
    expect([
      c({ action: "call", category: "level", method: "spawn" }),
      c({ action: "search", query: "lights" }),
      c({ action: "describe", category: "level", method: "spawn" }),
      c({ operation: "rebuild" }, "editor_restart"),
    ]).toEqual(["level.spawn", 'search "lights"', "describe level.spawn", "editor rebuild"]);
  });
});

describe("the main thread", () => {
  it("leaves subagent steps out and groups subagents started together", () => {
    const items = mainTimeline([user("go"), agent("a", "done", 3), agent("b", "done", 3), step("a", "s", "done", 1, 2), reply("done")]);
    expect(items.map((i) => i.kind)).toEqual(["entry", "agents", "entry"]);
    expect(items[1].kind === "agents" && items[1].calls.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("draws every progress message where it falls, in a finished turn or a running one", () => {
    const t = [user("go"), reply("started"), agent("a", "done", 3), reply("one back"), reply("final")];
    expect(mainTimeline(t).map((i) => i.kind)).toEqual(["entry", "entry", "agents", "entry", "entry"]);
  });
});

describe("finished turns", () => {
  it("are the sessions that were running and no longer are", () => {
    const before = [{ id: "a", status: "running" as const }, { id: "b", status: "waiting" as const }, { id: "c", status: "idle" as const }];
    const after = [{ id: "a", status: "idle" as const }, { id: "b", status: "running" as const }, { id: "c", status: "idle" as const }, { id: "d", status: "idle" as const }];
    expect(finishedTurns(before, after).map((s) => s.id)).toEqual(["a"]);
  });
});
