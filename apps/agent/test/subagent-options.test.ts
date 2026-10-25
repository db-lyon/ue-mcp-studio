/** The Agent SDK options for subagents, by the Usage settings. */
import { describe, expect, it } from "vitest";
import { STUDIO_TOOLS, subagentOptions } from "../src/subscription.js";

const pre = (n: number) => ({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: {}, tool_use_id: `t${n}`, session_id: "s", transcript_path: "", cwd: "" }) as never;

describe("subagent options", () => {
  it("leave the subagent tool out entirely while subagents are off", () => {
    const o = subagentOptions({ mode: "off", perTurn: 4, model: "claude-opus-5-5", effort: "high" }, "sub");
    expect(o.tools).toEqual(["WebSearch"]);
    expect(o.allowedTools).not.toContain("Agent");
    expect(o).not.toHaveProperty("agents");
  });

  it("run the subagent on its own model and effort", () => {
    const o = subagentOptions({ mode: "asked", perTurn: 4, model: "claude-haiku-5-5", effort: "low" }, "sub prompt");
    expect(o.tools).toEqual(["Agent", "WebSearch"]);
    expect(o.agents!["editor-worker"]).toMatchObject({ prompt: "sub prompt", model: "claude-haiku-5-5", effort: "low", tools: [...STUDIO_TOOLS, "WebSearch"] });
  });

  it("refuse the agent calls past the turn's allowance", async () => {
    const o = subagentOptions({ mode: "automatic", perTurn: 2, model: "m", effort: "medium" }, "sub");
    const hook = o.hooks!.PreToolUse[0];
    expect(hook.matcher).toBe("Agent");
    const signal = new AbortController().signal;
    const answers = [];
    for (let i = 0; i < 3; i++) answers.push(await hook.hooks[0](pre(i), `t${i}`, { signal }));
    expect(answers[0]).toEqual({});
    expect(answers[1]).toEqual({});
    expect(answers[2]).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("its 2 subagents") } });
  });
});
