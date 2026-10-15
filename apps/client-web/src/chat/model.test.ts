import { describe, expect, it } from "vitest";
import type { ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";
import { QUIET_MS, agentStatus, finishedTurns, formatDuration, formatResult, mainTimeline, summarize, toolLabel } from "./model";

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
    const items = mainTimeline([user("go"), agent("a", "done", 3), agent("b", "done", 3), step("a", "s", "done", 1, 2), reply("done")], "idle");
    expect(items.map((i) => i.kind)).toEqual(["entry", "agents", "entry"]);
    expect(items[1].kind === "agents" && items[1].calls.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("folds a finished turn's progress messages behind its final answer", () => {
    const t = [user("go"), reply("started"), agent("a", "done", 3), reply("one back"), reply("final")];
    const items = mainTimeline(t, "idle");
    expect(items.map((i) => i.kind)).toEqual(["entry", "progress", "agents", "progress", "entry"]);
    expect(items[4].kind === "entry" && items[4].entry).toBe(t[4]);
  });

  it("does not fold while the turn is still running, nor a turn without subagents", () => {
    expect(mainTimeline([user("go"), reply("started"), agent("a"), reply("one back")], "running").some((i) => i.kind === "progress")).toBe(false);
    expect(mainTimeline([user("go"), reply("a"), reply("b")], "idle").some((i) => i.kind === "progress")).toBe(false);
  });

  it("folds an earlier finished turn while a later one runs", () => {
    const items = mainTimeline([user("1"), reply("p"), agent("a", "done", 2), reply("f"), user("2"), reply("working")], "running");
    expect(items.map((i) => i.kind)).toEqual(["entry", "progress", "agents", "entry", "entry", "entry"]);
  });
});

describe("finished turns", () => {
  it("are the sessions that were running and no longer are", () => {
    const before = [{ id: "a", status: "running" as const }, { id: "b", status: "waiting" as const }, { id: "c", status: "idle" as const }];
    const after = [{ id: "a", status: "idle" as const }, { id: "b", status: "running" as const }, { id: "c", status: "idle" as const }, { id: "d", status: "idle" as const }];
    expect(finishedTurns(before, after).map((s) => s.id)).toEqual(["a"]);
  });
});
