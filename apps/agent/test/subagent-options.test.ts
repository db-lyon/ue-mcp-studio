/** The Agent SDK options for subagents, by the Usage settings. */
import { describe, expect, it } from "vitest";
import { STUDIO_TOOLS, subagentOptions } from "../src/subscription.js";
import { SubagentSlots } from "../src/subagent-slots.js";

const pre = (n: number) => ({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: {}, tool_use_id: `t${n}`, session_id: "s", transcript_path: "", cwd: "" }) as never;

const post = (n: number, tool_response: unknown) => ({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: {}, tool_response, tool_use_id: `t${n}`, session_id: "s", transcript_path: "", cwd: "" }) as never;
const failed = (n: number) => ({ hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_input: {}, error: "x", tool_use_id: `t${n}`, session_id: "s", transcript_path: "", cwd: "" }) as never;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("subagent options", () => {
  it("leave the subagent tool out entirely while subagents are off, and disallow it by both names", () => {
    const o = subagentOptions({ mode: "off", perTurn: 4, model: "claude-opus-5-5", effort: "high" }, "sub");
    expect(o.tools).toEqual(["WebSearch"]);
    expect(o.allowedTools).not.toContain("Agent");
    expect(o.disallowedTools).toEqual(["Agent", "Task"]);
    expect(o).not.toHaveProperty("agents");
  });

  it("run no project subagent while subagents are off (#173)", () => {
    const native = { settingSources: ["project" as const], agents: { reviewer: { description: "Reviews", prompt: "Review." } }, skills: false };
    const o = subagentOptions({ mode: "off", perTurn: 4, model: "m", effort: "high" }, "sub", native);
    expect(o.tools).not.toContain("Agent");
    expect(o.disallowedTools).toEqual(["Agent", "Task"]);
    expect(o).not.toHaveProperty("agents");
  });

  it("with no limit (-1), let all 5 agent calls start at once and queue none (#173)", async () => {
    const slots = new SubagentSlots(-1);
    const queued: string[] = [];
    const o = subagentOptions({ mode: "automatic", perTurn: -1, model: "m", effort: "medium" }, "sub", undefined, undefined, { slots, onQueued: (id, cancel) => cancel && queued.push(id) });
    const signal = new AbortController().signal;
    const done = new Map<number, unknown>();
    for (let i = 0; i < 5; i++) void o.hooks!.PreToolUse[0].hooks[0](pre(i), `t${i}`, { signal }).then((r) => done.set(i, r));
    await tick();
    expect([...done.keys()].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(queued).toEqual([]);
    expect(slots.counts).toEqual({ running: 5, waiting: 0 });
  });

  it("run the subagent on its own model and effort", () => {
    const o = subagentOptions({ mode: "asked", perTurn: 4, model: "claude-haiku-5-5", effort: "low" }, "sub prompt");
    expect(o.tools).toEqual(["Agent", "WebSearch"]);
    expect(o.agents!["editor-worker"]).toMatchObject({ prompt: "sub prompt", model: "claude-haiku-5-5", effort: "low", tools: [...STUDIO_TOOLS, "WebSearch"] });
  });

  it("hold the agent calls past the limit until a running one finishes, and refuse none (#164)", async () => {
    const slots = new SubagentSlots(2);
    const queued: string[] = [];
    const o = subagentOptions({ mode: "automatic", perTurn: 2, model: "m", effort: "medium" }, "sub", undefined, undefined, { slots, onQueued: (id, cancel) => cancel && queued.push(id) });
    const hook = o.hooks!.PreToolUse[0];
    expect(hook.matcher).toBe("Agent");
    expect(hook.timeout).toBeGreaterThanOrEqual(60 * 60);
    const signal = new AbortController().signal;
    const done = new Map<number, unknown>();
    for (let i = 0; i < 5; i++) void hook.hooks[0](pre(i), `t${i}`, { signal }).then((r) => done.set(i, r));
    await tick();
    expect([...done.keys()].sort()).toEqual([0, 1]);
    expect(queued).toEqual(["t2", "t3", "t4"]);
    // A foreground call returning frees its slot; a background launch does not, its task notification does.
    await o.hooks!.PostToolUse[0].hooks[0](post(0, { agentId: "x", content: [] }), "t0", { signal });
    await tick();
    expect([...done.keys()].sort()).toEqual([0, 1, 2]);
    await o.hooks!.PostToolUse[0].hooks[0](post(1, { status: "async_launched", agentId: "y" }), "t1", { signal });
    await tick();
    expect(done.has(3)).toBe(false);
    slots.release("t1");
    await o.hooks!.PostToolUseFailure[0].hooks[0](failed(2), "t2", { signal });
    await tick();
    expect([...done.keys()].sort()).toEqual([0, 1, 2, 3, 4]);
    expect([...done.values()].every((r) => JSON.stringify(r) === "{}")).toBe(true);
  });

  it("cancel the waiting agent calls on Stop, and never send a refusal", async () => {
    const slots = new SubagentSlots(1);
    const o = subagentOptions({ mode: "automatic", perTurn: 1, model: "m", effort: "medium" }, "sub", undefined, undefined, { slots });
    const hook = o.hooks!.PreToolUse[0].hooks[0];
    const stop = new AbortController();
    const first = await hook(pre(0), "t0", { signal: stop.signal });
    const second = hook(pre(1), "t1", { signal: stop.signal });
    slots.cancelAll();
    expect(first).toEqual({});
    const answer = JSON.stringify(await second);
    expect(answer).toContain("Stopped by the user.");
    expect(answer).not.toMatch(/yourself|allows/);
  });

  it("stop one waiting agent call on its own", async () => {
    const slots = new SubagentSlots(1);
    let stopIt: (() => void) | null = null;
    const o = subagentOptions({ mode: "automatic", perTurn: 1, model: "m", effort: "medium" }, "sub", undefined, undefined, { slots, onQueued: (_id, cancel) => { if (cancel) stopIt = cancel; } });
    const hook = o.hooks!.PreToolUse[0].hooks[0];
    const signal = new AbortController().signal;
    await hook(pre(0), "t0", { signal });
    const waiting = hook(pre(1), "t1", { signal });
    await tick();
    stopIt!();
    expect(JSON.stringify(await waiting)).toContain("stopped this subagent before it started");
  });
});
