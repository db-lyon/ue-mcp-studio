import { describe, expect, it } from "vitest";
import type { SessionAgent } from "@ue-mcp-studio/shared";
import { composerBusy, turnElapsed as formatElapsed, toolPhrase, workingStatus } from "../src/working.js";

const at = "2026-11-12T10:00:00.000Z";
const call = (name: string, input: unknown, outcome: "pending" | "done" = "pending") => ({ kind: "tool" as const, call: { id: "c", name, input, outcome, startedAt: at } });

describe("workingStatus", () => {
  it("is null while no turn runs", () => {
    expect(workingStatus({ status: "idle", waitingCause: null, transcript: [] })).toBeNull();
    expect(workingStatus(null)).toBeNull();
  });

  it("names the running tool and times the turn from its message", () => {
    const s = workingStatus({ status: "running", waitingCause: null, transcript: [{ kind: "user", text: "go", at }, call("mcp__ue-mcp__blueprint", { action: "create" })] });
    expect(s).toEqual({ label: "Running blueprint(create)", since: Date.parse(at), waiting: false });
  });

  it("reads Thinking between tools, and ignores a subagent's calls", () => {
    const s = workingStatus({ status: "running", waitingCause: null, transcript: [{ kind: "user", text: "go", at }, call("Read", {}, "done"), { ...call("Bash", {}), parent: "a1" }] });
    expect(s?.label).toBe("Thinking");
  });

  it("lets the composer send while only background subagents run", () => {
    const d = { status: "running" as const, waitingCause: null, transcript: [], mainFree: true };
    expect(composerBusy(d)).toBe(false);
    expect(composerBusy({ ...d, mainFree: false })).toBe(true);
    expect(workingStatus(d)?.label).toBe("Subagents working");
  });

  it("counts the subagents still running while the main agent is free", () => {
    const sub = (id: string, state: "working" | "queued" | "done") => ({ id, state }) as SessionAgent;
    const d = { status: "running" as const, waitingCause: null, transcript: [], mainFree: true };
    expect(workingStatus({ ...d, subagents: [sub("a", "working")] })?.label).toBe("1 subagent working");
    expect(workingStatus({ ...d, subagents: [sub("a", "working"), sub("b", "queued"), sub("c", "done")] })?.label).toBe("2 subagents working");
  });

  it("says why a turn waits", () => {
    expect(workingStatus({ status: "waiting", waitingCause: "the editor is not running", transcript: [] })).toEqual({ label: "Waiting: the editor is not running", since: null, waiting: true });
  });
});

describe("toolPhrase", () => {
  it("names a subagent plainly", () => expect(toolPhrase({ name: "Agent", input: {} })).toBe("Running a subagent"));
  it("strips a multi-part server prefix", () => expect(toolPhrase({ name: "mcp__claude_ai_docs__read", input: {} })).toBe("Running read"));
});

describe("formatElapsed", () => {
  it("reads seconds, minutes and hours", () => {
    expect(formatElapsed(7_400)).toBe("7s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
  });
});
