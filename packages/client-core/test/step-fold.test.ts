import { describe, expect, it } from "vitest";
import type { ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";
import { foldsAway, lineRange, liveStep, mainTimeline, stepActivity, stepsSummary, stepsTrouble, subagentTimeline, timeline, toolLabel, toolTitle, type ThreadItem } from "../src/chat-model.js";

const at = (s: number) => new Date(Date.parse("2026-11-07T10:00:00Z") + s * 1000).toISOString();
let n = 0;
const tool = (name: string, input: Record<string, unknown>, outcome: ToolCallRecord["outcome"] = "done", parent?: string): TranscriptEntry => ({
  kind: "tool",
  ...(parent ? { parent } : {}),
  call: { id: `c${++n}`, name, input, outcome, startedAt: at(n), ...(outcome === "pending" ? {} : { endedAt: at(n) }) },
});
const read = (path: string, outcome: ToolCallRecord["outcome"] = "done", extra: Record<string, unknown> = {}) => tool("read_file", { path, ...extra }, outcome);
const sh = (command: string, outcome: ToolCallRecord["outcome"] = "done") => tool("shell", { command }, outcome);
const user = (text: string): TranscriptEntry => ({ kind: "user", text, at: at(0) });
const reply = (text: string): TranscriptEntry => ({ kind: "assistant", text, at: at(1) });
const agent = (id: string, outcome: ToolCallRecord["outcome"] = "done"): TranscriptEntry => ({ kind: "tool", call: { id, name: "agent", input: { description: id }, outcome, startedAt: at(0), ...(outcome === "pending" ? {} : { endedAt: at(2) }) } });
const edit = (path: string) => tool("edit_file", { path, old_string: "a", new_string: "b" });
const folds = (items: ThreadItem[]) => items.flatMap((i) => (i.kind === "steps" ? [i.calls] : []));
const kinds = (items: ThreadItem[]) => items.map((i) => i.kind);
const callOf = (e: TranscriptEntry) => (e as Extract<TranscriptEntry, { kind: "tool" }>).call;

describe("a read names its file", () => {
  it("by base name, with the full path for hover, either slash and either argument name", () => {
    const c = callOf(read("C:/Users/dev/Vale/.wiki/Caravan-Exposure.md"));
    expect(toolLabel(c)).toBe("Caravan-Exposure.md");
    expect(toolTitle(c)).toBe("C:/Users/dev/Vale/.wiki/Caravan-Exposure.md");
    // A built-in reached through an alias records file_path, which used to leave the line blank.
    const aliased = callOf(tool("read_file", { file_path: "Docs\\WorldGen\\PASSES.md" }));
    expect(toolLabel(aliased)).toBe("PASSES.md");
    expect(toolTitle(aliased)).toBe("Docs\\WorldGen\\PASSES.md");
  });

  it("with the lines read when given", () => {
    expect(toolLabel(callOf(read("a/b.md", "done", { offset: 55 })))).toBe("b.md (from line 55)");
    expect(toolLabel(callOf(read("a/b.md", "done", { offset: 55, limit: 20 })))).toBe("b.md (lines 55-74)");
    expect(toolLabel(callOf(read("a/b.md", "done", { limit: 20 })))).toBe("b.md (lines 1-20)");
    expect(lineRange()).toBe("");
  });

  it("and edits, writes, skills and unknown tools name their target too", () => {
    expect(toolLabel(callOf(tool("edit_file", { file_path: "Source/A.cpp", old_string: "a", new_string: "b" })))).toBe("A.cpp");
    expect(toolLabel(callOf(tool("write_file", { path: "Config/DefaultDoor.ini", content: "" })))).toBe("DefaultDoor.ini");
    expect(toolLabel(callOf(tool("skill", { name: "lighting-pass" })))).toBe("lighting-pass");
    expect(toolLabel(callOf(tool("Skill", { skill: "lighting-pass" })))).toBe("lighting-pass");
    expect(toolLabel(callOf(tool("mystery", { target: "BP_Door" })))).toBe("BP_Door");
    expect(toolLabel(callOf(tool("ue_mcp", { action: "list_categories" })))).toBe("list categories");
  });
});

describe("the summary line", () => {
  it("counts each kind in the order it first ran, files counted once", () => {
    const calls = [sh("ls .wiki"), ...Array.from({ length: 8 }, (_, i) => read(`.wiki/P${i}.md`)), read(".wiki/P0.md", "done", { offset: 55 }), sh("head -12 x")].map(callOf);
    expect(stepsSummary(calls)).toBe("Ran 2 commands, read 8 files");
  });

  it("names searches, edits, fetches, editor calls and other tools", () => {
    const calls = [tool("grep", { pattern: "x" }), tool("glob", { pattern: "*" }), tool("edit_file", { path: "a" }), tool("web_fetch", { url: "u" }), tool("ue_mcp", { action: "call", category: "level", method: "spawn" }), tool("editor_restart", { operation: "rebuild" }), tool("mystery", {})].map(callOf);
    expect(stepsSummary(calls)).toBe("Searched 2 times, edited 1 file, fetched 1 page, made 2 editor calls, used 1 other tool");
  });
});

describe("the trouble line", () => {
  it("counts the calls that went wrong, and is empty when none did", () => {
    const calls = [sh("a", "error"), sh("b", "unknown"), sh("c", "declined"), sh("d", "stopped"), sh("e")].map(callOf);
    expect(stepsTrouble(calls)).toBe("2 failed, 1 declined, 1 stopped");
    expect(stepsTrouble([callOf(sh("ok"))])).toBe("");
  });
});

describe("folding tool calls", () => {
  it("folds each run of calls between two messages, a lone call included, and never folds a message", () => {
    // The shape of the owner's screenshot: a lone call, progress, steps, progress, steps with a failure, progress, a call, the reply.
    const failed = sh("npm run build", "error");
    const progress = [reply("Looking at the wiki."), reply("Found the pages, editing."), reply("The build failed, fixing it.")];
    const final = reply("Done: the pages are linked.");
    const t = [user("go"), sh("ls"), progress[0], sh("a"), sh("b"), edit("x"), edit("y"), edit("z"), progress[1], edit("p"), edit("q"), sh("c"), failed, progress[2], sh("d"), final];
    const items = mainTimeline(t);
    expect(kinds(items)).toEqual(["entry", "steps", "entry", "steps", "entry", "steps", "entry", "steps", "entry"]);
    const runs = folds(items);
    expect(runs).toHaveLength(4);
    expect(runs.map(stepsSummary)).toEqual(["Ran 1 command", "Ran 2 commands, edited 3 files", "Edited 2 files, ran 2 commands", "Ran 1 command"]);
    expect(runs.map(stepsTrouble)).toEqual(["", "", "1 failed", ""]);
    expect(runs[2]).toContain(callOf(failed));
    const shown = items.flatMap((i) => (i.kind === "entry" ? [i.entry] : []));
    expect(shown).toEqual([t[0], ...progress.slice(0, 2), progress[2], final]);
  });

  it("folds failed, declined, stopped and unknown calls into the run", () => {
    for (const outcome of ["error", "declined", "stopped", "unknown"] as const) {
      expect(kinds(timeline([read("a"), sh("build", outcome), read("c")]))).toEqual(["steps"]);
      expect(foldsAway(callOf(sh("build", outcome)))).toBe(true);
    }
  });

  it("keeps a call waiting on approval and a running subagent outside, and names the live step", () => {
    const held = sh("git push", "pending");
    const running = read("Docs/Now.md", "pending");
    const t = [user("go"), reply("Starting."), read("a"), running, agent("s1", "pending"), held];
    const items = mainTimeline(t, undefined, new Set([callOf(held).id]));
    expect(kinds(items)).toEqual(["entry", "entry", "steps", "agents", "entry"]);
    expect(items[4].kind === "entry" && items[4].entry).toBe(held);
    const run = folds(items)[0];
    expect(liveStep(run)).toBe(callOf(running));
    expect(stepActivity(liveStep(run)!)).toBe("reading Now.md");
    expect(liveStep(run.slice(0, 1))).toBeNull();
  });

  it("draws a turn with no calls without a fold", () => {
    expect(kinds(mainTimeline([user("hi"), reply("Hello.")]))).toEqual(["entry", "entry"]);
  });
});

describe("the main thread folds steps", () => {
  it("and never folds replies, notes, dialogs, review, QA, flow, cards, compaction, playtests or subagents", () => {
    const visible: TranscriptEntry[] = [
      reply("Looking at the wiki."),
      { kind: "note", text: "note", at: at(1) },
      { kind: "dialog", dialog: { id: "d", title: "Save?", openedAt: Date.parse(at(1)) } as never },
      { kind: "review", review: { at: at(1) } as never },
      { kind: "qa", run: { seenAt: at(1) } as never },
      { kind: "flow", name: "f", params: {}, state: "running", steps: [], at: at(1) } as never,
      { kind: "card", ext: "x", type: "y", data: {}, at: at(1) } as never,
      { kind: "compaction", at: at(1) } as never,
      { kind: "playtest", state: "drafting", request: {} as never, attempt: 1, at: at(1) },
    ];
    for (const v of visible) {
      const items = mainTimeline([user("go"), read("a"), read("b"), v, read("c"), read("d")]);
      expect(kinds(items)).toEqual(["entry", "steps", "entry", "steps"]);
      expect(items[2].kind === "entry" && items[2].entry).toBe(v);
    }
    expect(kinds(mainTimeline([user("go"), read("a"), read("b"), agent("s1"), read("c"), read("d")]))).toEqual(["entry", "steps", "agents", "steps"]);
  });

  it("keeps a run's first call, and so its key, while the run grows during a turn", () => {
    const first = read("a");
    const a = mainTimeline([user("go"), first, read("b", "pending")]);
    const b = mainTimeline([user("go"), first, read("b"), sh("ls", "pending")]);
    const head = (items: ThreadItem[]) => (items[1].kind === "steps" ? items[1].calls[0] : null);
    expect(head(a)).toBe(callOf(first));
    expect(head(b)).toBe(callOf(first));
  });

  it("folds a subagent's own thread the same way", () => {
    const t = [user("go"), agent("s1"), tool("read_file", { path: "a" }, "done", "s1"), tool("shell", { command: "x" }, "error", "s1"), { kind: "assistant", text: "Found it.", at: at(1), parent: "s1" } as TranscriptEntry];
    const items = subagentTimeline(t, "s1");
    expect(kinds(items)).toEqual(["steps", "entry"]);
    expect(stepsTrouble(folds(items)[0])).toBe("1 failed");
  });
});
