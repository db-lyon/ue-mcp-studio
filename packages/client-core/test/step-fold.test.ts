import { describe, expect, it } from "vitest";
import type { ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";
import { FOLD_MIN, foldSteps, foldsAway, lineRange, liveStep, mainTimeline, stepsSummary, toolLabel, toolTitle, type MainItem } from "../src/chat-model.js";

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
const agent = (id: string): TranscriptEntry => ({ kind: "tool", call: { id, name: "agent", input: { description: id }, outcome: "done", startedAt: at(0), endedAt: at(2) } });
const kinds = (items: MainItem[]) => items.map((i) => i.kind);
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

describe("folding steps", () => {
  it("folds a run of two or more steps into one item, and leaves a lone step as it was", () => {
    expect(FOLD_MIN).toBe(2);
    expect(kinds(foldSteps([read("a"), read("b"), sh("ls")]))).toEqual(["steps"]);
    expect(kinds(foldSteps([read("a"), reply("x"), read("b")]))).toEqual(["entry", "entry", "entry"]);
  });

  it("never folds a failed, declined, stopped or unknown call: it ends the run and stays visible", () => {
    for (const outcome of ["error", "declined", "stopped", "unknown"] as const) {
      const failed = sh("build", outcome);
      const items = foldSteps([read("a"), read("b"), failed, read("c"), read("d")]);
      expect(kinds(items)).toEqual(["steps", "entry", "steps"]);
      expect(items[1].kind === "entry" && items[1].entry).toBe(failed);
      expect(foldsAway(callOf(failed))).toBe(false);
    }
  });

  it("never folds a call waiting on the user's approval", () => {
    const held = sh("rm -rf Saved", "pending");
    expect(kinds(foldSteps([read("a"), read("b"), held], new Set([callOf(held).id])))).toEqual(["steps", "entry"]);
  });

  it("keeps a running step in the run and names it as the live step", () => {
    const running = read("Docs/Now.md", "pending");
    const items = foldSteps([read("a"), sh("ls"), running]);
    expect(kinds(items)).toEqual(["steps"]);
    const calls = items[0].kind === "steps" ? items[0].calls : [];
    expect(liveStep(calls)).toBe(callOf(running));
    expect(liveStep(calls.slice(0, 2))).toBeNull();
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
      const items = mainTimeline([user("go"), read("a"), read("b"), v, read("c"), read("d")], "idle");
      expect(kinds(items)).toEqual(["entry", "steps", "entry", "steps"]);
      expect(items[2].kind === "entry" && items[2].entry).toBe(v);
    }
    expect(kinds(mainTimeline([user("go"), read("a"), read("b"), agent("s1"), read("c"), read("d")], "idle"))).toEqual(["entry", "steps", "agents", "steps"]);
  });

  it("keeps the final reply after the fold", () => {
    const t = [user("go"), sh("ls"), ...Array.from({ length: 9 }, (_, i) => read(`.wiki/P${i}.md`)), sh("head"), reply("Here is what the wiki says.")];
    const items = mainTimeline(t, "idle");
    expect(kinds(items)).toEqual(["entry", "steps", "entry"]);
    expect(items[1].kind === "steps" && items[1].calls).toHaveLength(11);
  });

  it("leaves held calls out of the fold through asked", () => {
    const held = sh("git push", "pending");
    expect(kinds(mainTimeline([user("go"), read("a"), read("b"), held], "running", undefined, new Set([callOf(held).id])))).toEqual(["entry", "steps", "entry"]);
  });

  it("keeps a run's first call, and so its key, while the run grows during a turn", () => {
    const first = read("a");
    const a = mainTimeline([user("go"), first, read("b", "pending")], "running");
    const b = mainTimeline([user("go"), first, read("b"), sh("ls", "pending")], "running");
    const head = (items: MainItem[]) => (items[1].kind === "steps" ? items[1].calls[0] : null);
    expect(head(a)).toBe(callOf(first));
    expect(head(b)).toBe(callOf(first));
  });

  it("splits steps around progress replies folded in a finished turn with subagents", () => {
    const t = [user("go"), read("a"), read("b"), reply("progress"), agent("s1"), read("c"), read("d"), reply("final")];
    expect(kinds(mainTimeline(t, "idle"))).toEqual(["entry", "steps", "progress", "agents", "steps", "entry"]);
  });

  it("folds a subagent's own steps the same way", () => {
    const steps = [tool("read_file", { path: "a" }, "done", "s1"), tool("read_file", { path: "b" }, "done", "s1"), tool("shell", { command: "x" }, "error", "s1")];
    expect(kinds(foldSteps(steps))).toEqual(["steps", "entry"]);
  });
});
