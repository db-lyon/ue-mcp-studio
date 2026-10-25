/**
 * Agent files are Claude Code subagent files with Studio's fields under
 * `studio:`. A plain subagent file loads unchanged; a file Studio writes is a
 * valid subagent file to a tool that ignores `studio:`, and reads back the same.
 */
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { FULL_SCOPE, type AgentSpec } from "@ue-mcp-studio/shared";
import { parseAgentFile, scopeFromTools, serializeAgentFile, splitFrontmatter, toolsFromScope } from "../src/agent-files.js";

/** The fields Claude Code's subagent format defines (code.claude.com/docs/en/sub-agents). */
const STANDARD_FIELDS = new Set(["name", "description", "tools", "disallowedTools", "model", "permissionMode", "maxTurns", "autoCompactWindow", "skills", "mcpServers", "hooks", "memory", "background", "omitClaudeMd", "effort", "isolation", "color", "initialPrompt", "experimental"]);
const STANDARD_TOOLS = new Set(["Bash", "Read", "Glob", "Grep", "Edit", "Write", "WebSearch", "WebFetch"]);

/** What a tool that knows only the standard would accept: required fields, value forms, and nothing it would trip on but `studio`. */
function validSubagentFile(text: string): string[] {
  const errors: string[] = [];
  const split = splitFrontmatter(text);
  if (!split) return ["no front matter"];
  const f = split.front;
  if (typeof f.name !== "string" || !f.name || f.name.length > 256 || f.name.includes(":")) errors.push("name");
  if (typeof f.description !== "string" || !f.description) errors.push("description");
  if (f.tools !== undefined) {
    if (typeof f.tools !== "string") errors.push("tools is not a comma-separated string");
    else for (const t of f.tools.split(",").map((x) => x.trim())) if (!STANDARD_TOOLS.has(t) && !t.startsWith("mcp__")) errors.push(`unknown tool ${t}`);
  }
  if (f.model !== undefined && !(typeof f.model === "string" && (/^(sonnet|opus|haiku|fable|inherit)$/.test(f.model) || /^claude-[a-z0-9.-]+$/.test(f.model)))) errors.push("model");
  if (f.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(f.effort as string)) errors.push("effort");
  if (f.maxTurns !== undefined && !(Number.isInteger(f.maxTurns) && (f.maxTurns as number) > 0)) errors.push("maxTurns");
  if (f.skills !== undefined && !(Array.isArray(f.skills) && f.skills.every((s) => typeof s === "string"))) errors.push("skills");
  for (const k of Object.keys(f)) if (!STANDARD_FIELDS.has(k) && k !== "studio") errors.push(`unknown field ${k}`);
  if (!split.body.trim()) errors.push("empty body");
  return errors;
}

const CLAUDE_CODE_EXAMPLE = `---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
---
You are a senior code reviewer. Check for readability and naming.
`;

const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({
  id: "level-dresser",
  name: "Level dresser",
  description: "Places and arranges props, foliage and PCG volumes in a level.",
  instructions: "You dress levels for Hollowreach. Keep sight lines to the objective clear.",
  model: { vendor: "google", model: "gemini-3.1-pro-preview" },
  fallbacks: [{ vendor: "anthropic", model: "claude-sonnet-5-5" }],
  effort: "medium",
  tools: { ueMcp: { only: ["level", "asset", "foliage", "pcg", "landscape"] }, ueMcpAccess: "read-write", shell: false, files: "read", web: { search: false, fetch: false }, editorRestart: false },
  contextStrategy: "auto",
  skills: [{ skill: "hollowreach-naming", load: "preload" }, { skill: "ue-mcp-voxel", load: "on-demand" }],
  instructionFiles: "all",
  imageSize: "full",
  maxSteps: 60,
  handoff: { when: "judged", background: false, startWith: "brief" },
  ...over,
});

describe("a Claude Code subagent file", () => {
  it("loads unchanged as a project agent", () => {
    const p = parseAgentFile(CLAUDE_CODE_EXAMPLE, "code-reviewer");
    expect(p.plain).toBe(true);
    expect(p.problems).toEqual([]);
    expect(p.spec).toEqual({
      id: "code-reviewer",
      name: "Code reviewer",
      description: "Reviews code for quality and best practices",
      instructions: "You are a senior code reviewer. Check for readability and naming.",
      tools: { ueMcp: "none", ueMcpAccess: "read-write", shell: false, files: "read", web: { search: false, fetch: false }, editorRestart: false },
      model: { vendor: "anthropic", model: "claude-sonnet-5-5" },
    });
  });

  it("reads no tools as every tool, no model as inherit, and a full model id as that model", () => {
    const p = parseAgentFile("---\nname: helper\ndescription: x\n---\nDo it.", "helper");
    expect(p.spec.tools).toEqual(FULL_SCOPE);
    expect(p.spec.model).toBe("inherit");
    expect(parseAgentFile("---\nname: h\ndescription: x\nmodel: claude-opus-5-5\n---\nb", "h").spec.model).toEqual({ vendor: "anthropic", model: "claude-opus-5-5" });
  });

  it("takes the standard's effort, maxTurns, skills and background", () => {
    const p = parseAgentFile("---\nname: h\ndescription: x\neffort: low\nmaxTurns: 12\nskills: [naming]\nbackground: true\n---\nb", "h");
    expect(p.spec).toMatchObject({ effort: "low", maxSteps: 12, skills: [{ skill: "naming", load: "preload" }], handoff: { background: true } });
  });

  it("reads a list of tools, mcp tools and the edit tools", () => {
    expect(scopeFromTools(["Bash", "Edit", "mcp__ue-mcp__level", "WebFetch"])).toEqual({ ueMcp: "all", ueMcpAccess: "read-write", shell: true, files: "read-write", web: { search: false, fetch: true }, editorRestart: true });
    const p = parseAgentFile("---\nname: h\ndescription: x\ntools: [Read, Grep]\n---\nb", "h");
    expect(p.spec.tools?.files).toBe("read");
  });

  it("uses the file name when the name is not an id, and says so", () => {
    const p = parseAgentFile("---\nname: Pretty Name\ndescription: x\n---\nb", "pretty");
    expect(p.spec.id).toBe("pretty");
    expect(p.problems[0]).toMatch(/not a lowercase slug/);
  });

  it("refuses a file without front matter", () => {
    expect(() => parseAgentFile("just text", "x")).toThrow(/front matter/);
  });
});

describe("a file Studio writes", () => {
  it("is a valid subagent file for a tool that ignores studio:", () => {
    const text = serializeAgentFile(spec());
    expect(validSubagentFile(text)).toEqual([]);
    const f = splitFrontmatter(text)!.front;
    expect(f).toMatchObject({ name: "level-dresser", tools: "Read, Glob, Grep, mcp__ue-mcp", effort: "medium", maxTurns: 60, skills: ["hollowreach-naming"] });
    // Another vendor's model is not written where the standard expects an Anthropic one.
    expect(f.model).toBeUndefined();
  });

  it("writes an Anthropic model as its id and inherit as inherit, and no tools for every tool", () => {
    const a = splitFrontmatter(serializeAgentFile(spec({ model: { vendor: "anthropic", model: "claude-haiku-5-5" }, tools: FULL_SCOPE })))!.front;
    expect(a.model).toBe("claude-haiku-5-5");
    expect(a.tools).toBeUndefined();
    expect(splitFrontmatter(serializeAgentFile(spec({ model: "inherit" })))!.front.model).toBe("inherit");
    expect(validSubagentFile(serializeAgentFile(spec({ model: "inherit", effort: "inherit" })))).toEqual([]);
  });

  it("reads back to the same spec", () => {
    const s = spec();
    const p = parseAgentFile(serializeAgentFile(s), "level-dresser");
    expect(p.problems).toEqual([]);
    expect(p.plain).toBe(false);
    expect(p.spec).toEqual(s);
  });

  it("carries the team's settings in the main agent's file only", () => {
    const team = { name: "Hollowreach team", delegation: { mode: "auto" as const, maxPerTurn: 6, maxParallel: 3 }, bindings: { quickAsk: "main", flowSteps: "main", assignedPlaytests: "playtest-runner" }, defaults: { contextStrategy: "micro" as const, imageSize: "standard" as const } };
    const text = serializeAgentFile(spec({ id: "main", name: "Main", handoff: undefined }), { main: true, team });
    expect(validSubagentFile(text)).toEqual([]);
    const p = parseAgentFile(text, "main");
    expect(p.isMain).toBe(true);
    expect(p.team).toEqual(team);
    expect(parseDocument(splitFrontmatter(serializeAgentFile(spec()))!.front.studio ? "a: 1" : "").toJS()).toBeTruthy();
    expect(parseAgentFile(serializeAgentFile(spec()), "level-dresser").isMain).toBe(false);
  });

  it("reports a studio field that is not valid and keeps the rest", () => {
    const p = parseAgentFile("---\nname: h\ndescription: x\nstudio:\n  displayName: H\n  tools: { shell: maybe }\n  handoff: { when: sometimes }\n---\nb", "h");
    expect(p.spec.name).toBe("H");
    expect(p.problems).toEqual(["studio.tools is not valid and is ignored", "studio.handoff is not valid and is ignored"]);
  });

  it("maps the scope to the standard's tool names and back", () => {
    const s = spec().tools;
    expect(toolsFromScope(s)).toEqual(["Read", "Glob", "Grep", "mcp__ue-mcp"]);
    expect(toolsFromScope(FULL_SCOPE)).toBeNull();
  });
});
