/** Mapping the vendors' subagent fields onto Studio's tools and models. */
import { describe, expect, it } from "vitest";
import { AGENT_TOOL } from "../src/tools.js";
import { agentTool, modelOf, sdkAgents, sdkTools, skillResult, toolsFor } from "../src/native-runtime.js";
import type { Loadout } from "../src/native.js";

describe("tools a subagent file allows", () => {
  it("maps Claude Code names, Gemini names and wildcards, and MCP names for ue-mcp", () => {
    expect(toolsFor({ tools: ["Bash", "Edit", "WebFetch"], noShell: false }).allowed).toEqual(new Set(["shell", "edit_file", "web_fetch"]));
    expect(toolsFor({ tools: ["read_file", "run_shell_command", "mcp_*"], noShell: false }).allowed).toEqual(new Set(["read_file", "shell", "ue_mcp", "editor_restart"]));
    expect(toolsFor({ tools: ["mcp__ue-mcp__level"], noShell: false }).allowed).toEqual(new Set(["ue_mcp", "editor_restart"]));
    expect(toolsFor({ tools: ["NotATool"], noShell: false })).toEqual({ allowed: new Set(), unknown: ["NotATool"] });
  });

  it("gives every tool when the file names none, less the shell when Codex turns it off", () => {
    expect(toolsFor({ tools: null, noShell: false }).allowed).toBeNull();
    expect(toolsFor({ tools: ["*"], noShell: true }).allowed!.has("shell")).toBe(false);
    expect(sdkTools(new Set(["read_file", "web_search"]))).toEqual(["mcp__studio__read_file", "WebSearch"]);
    expect(sdkTools(null)).toBeUndefined();
  });
});

describe("a subagent's model", () => {
  it("reads Claude Code aliases, Codex and Gemini ids, and inherit", () => {
    expect(modelOf("claude", "sonnet")).toEqual({ vendor: "anthropic", model: "claude-sonnet-5-5" });
    expect(modelOf("claude", "claude-haiku-5-5")).toEqual({ vendor: "anthropic", model: "claude-haiku-5-5" });
    expect(modelOf("codex", "gpt-6-luna")).toEqual({ vendor: "openai", model: "gpt-6-luna" });
    expect(modelOf("gemini", "models/gemini-3.8-flash")).toEqual({ vendor: "google", model: "gemini-3.8-flash" });
    expect(modelOf("claude", "inherit")).toBeNull();
    expect(modelOf("agents", "anything")).toBeNull();
  });
});

describe("the SDK's agents", () => {
  it("carry every field as written and leave out a file missing its name", () => {
    const l = { subagents: [
      { name: "reviewer", description: "R", prompt: "P", tools: ["Read"], model: "haiku", effort: "low", maxTurns: 5, skills: ["s"], background: true, noShell: false, problems: [] },
      { name: "broken", description: "", prompt: "", tools: null, model: null, effort: null, maxTurns: null, skills: [], background: false, noShell: false, problems: ["description is required"] },
    ] } as unknown as Loadout;
    expect(sdkAgents(l)).toEqual({ reviewer: { description: "R", prompt: "P", tools: ["mcp__studio__read_file"], model: "haiku", effort: "low", maxTurns: 5, skills: ["s"], background: true } });
  });
});

describe("the agent and skill tools", () => {
  it("keep the agent tool as it was when the project has no helpers", () => {
    expect(agentTool(AGENT_TOOL, [])).toBe(AGENT_TOOL);
  });

  it("answer an unknown skill with the names there are", () => {
    expect(skillResult([], "x")).toEqual({ text: "No skill named x. The skills are: none.", isError: true });
  });
});
