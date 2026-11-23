/**
 * The hub's run history: a record per run from its QaRun, kept in an
 * append-only file that is compacted on start and capped, and read back a
 * check at a time, newest first, a page at a time.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { qaRunFromAnswer, type QaRun } from "@ue-mcp-studio/shared";
import { RunIndex, recordOf, sourceOf } from "../src/hub/run-index.js";

let root: string;
const file = () => path.join(root, "hub", "runs.jsonl");

const run = (id: string, state: string, statuses: string[], over: Partial<QaRun> = {}, startedAt = "2026-11-23T10:00:00.000Z"): QaRun => ({
  ...qaRunFromAnswer({
    run_id: id,
    script: "/Game/Tests/Door.Door",
    script_name: "Door",
    state,
    steps: statuses.map((status, index) => ({ index, instruction: `Step ${index + 1}`, judge: index === 2 ? "manual" : "auto", status })),
  }, { seenAt: startedAt })!,
  ...over,
});

beforeEach(() => void (root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-runs-"))));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("recordOf", () => {
  it("maps a finished run, with the steps that failed", () => {
    const r = recordOf(run("a", "finished", ["passed", "failed", "passed"], { sessionId: "s1" }), { now: "2026-11-23T10:01:00.000Z" })!;
    expect(r).toMatchObject({ runId: "a", kind: "script", target: "/Game/Tests/Door", outcome: "failed", failedSteps: [1], source: "person", endedAt: "2026-11-23T10:01:00.000Z", durationMs: 60_000 });
  });

  it("keeps when it started and ended, and a plan's source, from the earlier record", () => {
    const first = recordOf(run("a", "running", ["running"], { sessionId: "s1" }), { now: "t", tag: { source: "plan", planRunId: "p1" } })!;
    expect(first.endedAt).toBeNull();
    const later = recordOf(run("a", "finished", ["passed"], { sessionId: "s1" }, "2026-11-23T11:00:00.000Z"), { prev: first, now: "2026-11-23T10:05:00.000Z" })!;
    expect(later).toMatchObject({ startedAt: first.startedAt, source: "plan", planRunId: "p1", outcome: "passed", endedAt: "2026-11-23T10:05:00.000Z" });
  });

  it("is no record for a draft, inline steps, a manual run or an idle answer", () => {
    expect(recordOf({ ...run("d", "finished", []), state: "draft" }, { now: "t" })).toBeNull();
    expect(recordOf(run("i", "finished", ["passed"], { script: "inline" }), { now: "t" })).toBeNull();
    expect(recordOf(run("m", "finished", ["passed"], { manual: true }), { now: "t" })).toBeNull();
    expect(recordOf(run("x", "idle", []), { now: "t" })).toBeNull();
  });

  it("who started it, from the QaRun", () => {
    expect(sourceOf(run("a", "finished", [], { sessionId: null }))).toBe("outside");
    expect(sourceOf(run("a", "finished", [], { sessionId: "s", toolUseId: "t" }))).toBe("agent");
    expect(sourceOf(run("a", "finished", [], { sessionId: "s", toolUseId: null }))).toBe("person");
  });
});

describe("RunIndex", () => {
  it("appends a line per change, none for a record that did not change", () => {
    const changed: string[] = [];
    const idx = new RunIndex({ dataDir: root, now: () => "2026-11-23T10:01:00.000Z", changed: (id) => void changed.push(id) });
    idx.record(run("a", "running", ["running"], { sessionId: "s" }));
    idx.record(run("a", "running", ["running"], { sessionId: "s" }));
    idx.record(run("a", "finished", ["passed"], { sessionId: "s" }));
    expect(fs.readFileSync(file(), "utf-8").trim().split("\n")).toHaveLength(2);
    expect(changed).toEqual(["a", "a"]);
  });

  it("reads the newest line per run back, skips a broken line, and compacts on start", () => {
    const idx = new RunIndex({ dataDir: root, now: () => "2026-11-23T10:01:00.000Z" });
    idx.record(run("a", "running", ["running"], { sessionId: "s" }));
    idx.record(run("a", "finished", ["failed"], { sessionId: "s" }));
    fs.appendFileSync(file(), '{"runId":"cut');
    const again = new RunIndex({ dataDir: root });
    expect(again.get("a")?.outcome).toBe("failed");
    expect(fs.readFileSync(file(), "utf-8").trim().split("\n")).toHaveLength(1);
  });

  it("keeps the newest runs within the cap", () => {
    const idx = new RunIndex({ dataDir: root, max: 3, now: () => "t" });
    for (let i = 0; i < 5; i++) idx.record(run(`r${i}`, "finished", ["passed"], { sessionId: "s" }, `2026-11-2${i}T00:00:00.000Z`));
    expect(idx.size()).toBe(3);
    expect(new RunIndex({ dataDir: root, max: 3 }).all().map((r) => r.runId)).toEqual(["r4", "r3", "r2"]);
  });

  it("pages a check's runs newest first, after a run id or before a time", () => {
    const idx = new RunIndex({ dataDir: root, now: () => "t" });
    for (let i = 0; i < 5; i++) idx.record(run(`r${i}`, "finished", ["passed"], { sessionId: "s" }, `2026-11-2${i}T00:00:00.000Z`));
    const id = "script:/Game/Tests/Door";
    expect(idx.page({ check: id, limit: 2 })).toEqual({ runs: [idx.get("r4"), idx.get("r3")], more: true });
    expect(idx.page({ check: id, limit: 2, before: "r3" }).runs.map((r) => r.runId)).toEqual(["r2", "r1"]);
    expect(idx.page({ check: id, limit: 10, before: "2026-11-22T00:00:00.000Z" }).runs.map((r) => r.runId)).toEqual(["r1", "r0"]);
    expect(idx.page({ check: "script:/Game/None", limit: 5 })).toEqual({ runs: [], more: false });
  });

  it("a tag makes a run the plan's, before or after its record", () => {
    const idx = new RunIndex({ dataDir: root, now: () => "t" });
    idx.record(run("a", "running", ["running"], { sessionId: "s" }));
    idx.tag("a", { source: "schedule", planRunId: "p" });
    expect(idx.get("a")).toMatchObject({ source: "schedule", planRunId: "p" });
    idx.tag("b", { source: "plan", planRunId: "q" });
    idx.record(run("b", "finished", ["passed"], { sessionId: "s" }));
    expect(idx.get("b")).toMatchObject({ source: "plan", planRunId: "q" });
  });

  it("backfill leaves a finished record alone and takes ue-mcp's times", () => {
    const idx = new RunIndex({ dataDir: root, now: () => "2026-11-23T12:00:00.000Z" });
    idx.backfill(run("old", "finished", ["passed"]), { startedAt: "2026-11-01T00:00:00.000Z", endedAt: "2026-11-01T00:00:30.000Z" });
    expect(idx.get("old")).toMatchObject({ source: "outside", startedAt: "2026-11-01T00:00:00.000Z", durationMs: 30_000 });
    idx.backfill(run("old", "finished", ["failed"]), {});
    expect(idx.get("old")?.outcome).toBe("passed");
  });
});
