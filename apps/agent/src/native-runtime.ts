/**
 * How the vendors' own files run (plans/agent-composer.md 2.2 and 2.6):
 * the instruction text for Studio's loop, each subagent as a helper of the
 * agent tool with its tools mapped onto Studio's, the skill tool, and the
 * Agent SDK options for the Claude sign-in.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { CONVENTION_INFO, type Convention } from "@ue-mcp-studio/shared";
import type { Composed } from "./instructions.js";
import { tokensOf } from "./instructions.js";
import { appliesTo, type FoundSkill, type FoundSubagent, type Loadout } from "./native.js";

/** Studio's own tools a helper can be given. */
export const STUDIO_TOOL_NAMES = ["ue_mcp", "editor_restart", "shell", "read_file", "write_file", "edit_file", "glob", "grep", "web_fetch", "web_search"] as const;
export type StudioToolName = (typeof STUDIO_TOOL_NAMES)[number];

/** Claude Code's and Gemini CLI's tool names for Studio's tools. */
const TOOL_MAP: Record<string, StudioToolName[]> = {
  // Claude Code
  Bash: ["shell"], PowerShell: ["shell"], Read: ["read_file"], Write: ["write_file"], Edit: ["edit_file"], MultiEdit: ["edit_file"], NotebookEdit: ["edit_file"],
  Glob: ["glob"], Grep: ["grep"], LS: ["glob"], WebFetch: ["web_fetch"], WebSearch: ["web_search"],
  // Gemini CLI
  run_shell_command: ["shell"], read_file: ["read_file"], read_many_files: ["read_file"], write_file: ["write_file"], replace: ["edit_file"],
  glob: ["glob"], list_directory: ["glob"], search_file_content: ["grep"], grep: ["grep"], web_fetch: ["web_fetch"], google_web_search: ["web_search"],
  // Studio's own names, which any file may use
  shell: ["shell"], edit_file: ["edit_file"], ue_mcp: ["ue_mcp"], editor_restart: ["editor_restart"], web_search: ["web_search"],
};

/** Whether a tool name grants ue-mcp: an MCP name for a server called ue-mcp, or a wildcard over MCP tools. */
const grantsUeMcp = (t: string): boolean => /^mcp__ue[-_]mcp(__|$)/.test(t) || /^mcp_ue[-_]mcp_/.test(t) || t === "mcp__*" || t === "mcp_*";

/** The Studio tools a subagent file allows; null for every tool. A name Studio has no tool for is reported, not granted. */
export function toolsFor(a: Pick<FoundSubagent, "tools" | "noShell">): { allowed: Set<StudioToolName> | null; unknown: string[] } {
  if (a.tools === null || a.tools.includes("*")) {
    if (!a.noShell) return { allowed: null, unknown: [] };
    return { allowed: new Set(STUDIO_TOOL_NAMES.filter((t) => t !== "shell")), unknown: [] };
  }
  const allowed = new Set<StudioToolName>();
  const unknown: string[] = [];
  for (const t of a.tools) {
    if (grantsUeMcp(t)) {
      allowed.add("ue_mcp");
      allowed.add("editor_restart");
      continue;
    }
    const m = TOOL_MAP[t] ?? (t.endsWith("*") ? STUDIO_TOOL_NAMES.filter((n) => n.startsWith(t.slice(0, -1))) : undefined);
    if (m && m.length) for (const x of m) allowed.add(x);
    else unknown.push(t);
  }
  if (a.noShell) allowed.delete("shell");
  return { allowed, unknown };
}

/** Studio's tools for each Claude Code built-in name, for the Agent SDK's toolAliases. */
export const SDK_TOOL_ALIASES: Record<string, string> = {
  Bash: "mcp__studio__shell",
  Read: "mcp__studio__read_file",
  Write: "mcp__studio__write_file",
  Edit: "mcp__studio__edit_file",
  MultiEdit: "mcp__studio__edit_file",
  Glob: "mcp__studio__glob",
  Grep: "mcp__studio__grep",
  WebFetch: "mcp__studio__web_fetch",
};

/** A subagent's tools in the Agent SDK's names: Studio's tools, and its web search. */
export function sdkTools(allowed: Set<StudioToolName> | null): string[] | undefined {
  if (allowed === null) return undefined;
  return [...allowed].map((t) => (t === "web_search" ? "WebSearch" : `mcp__studio__${t}`));
}

/** The Anthropic model a Claude Code alias names. */
const ALIASES: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-1" };

/** The model a subagent file names, as a vendor and id; null when it inherits the main agent's. */
export function modelOf(convention: Convention, written: string | null): { vendor: string; model: string } | null {
  if (!written || written === "inherit") return null;
  if (convention === "claude") return { vendor: "anthropic", model: ALIASES[written.toLowerCase()] ?? written };
  if (convention === "codex") return { vendor: "openai", model: written };
  if (convention === "gemini") return { vendor: "google", model: written.replace(/^models\//, "") };
  return null;
}

/** The instructions an agent on Studio's loop is given from its convention's files. */
export function composeNative(l: Loadout): Composed {
  const always = l.instructions.filter((f) => f.scope.kind === "always");
  const conditional = l.instructions.filter((f) => f.scope.kind !== "always").map((f) => ({ path: f.path, scope: f.scope, body: f.text }));
  if (always.length === 0) return { text: null, tokens: 0, files: 0, conditional };
  const tool = CONVENTION_INFO[l.convention].tool;
  const body = always.map((f) => `## From ${f.path}\n${f.text}`).join("\n\n");
  const text = `The project's own instructions for agents follow, from ${always.length} file${always.length === 1 ? "" : "s"}, read as ${tool} reads them. Follow them where they apply to the task. Where two disagree, the later file wins.\n\n${body}`;
  return { text, tokens: tokensOf(text), files: always.length, conditional };
}

/** The skills section of a prompt: each skill's name and when to use it. */
export function skillsSection(skills: FoundSkill[]): string | null {
  const listed = skills.filter((s) => !s.problems.some((p) => p.startsWith("front matter")));
  if (!listed.length) return null;
  const lines = listed.map((s) => `- ${s.name}: ${s.description || "(no description)"}${s.implicit ? "" : " (use only when the user names it)"}`);
  return `The project has skills: guides with instructions and files for particular work. Load one with the skill tool when its description fits the task, then follow it.\n${lines.join("\n")}`;
}

/** The skill tool on Studio's loop: the same contract as the vendors' own. */
export const SKILL_TOOL: Anthropic.Beta.BetaToolUnion = {
  name: "skill",
  description: "Load one of the project's skills by name: returns its instructions and the files beside it, which read_file can open. A skill never widens what you may do.",
  input_schema: { type: "object", properties: { name: { type: "string", description: "The skill's name, as the list in your instructions gives it" } }, required: ["name"] },
};

/** What the skill tool answers. */
export function skillResult(skills: FoundSkill[], name: unknown): { text: string; isError: boolean } {
  const s = typeof name === "string" ? skills.find((x) => x.name === name) : undefined;
  if (!s) return { text: `No skill named ${String(name)}. The skills are: ${skills.map((x) => x.name).join(", ") || "none"}.`, isError: true };
  const files = s.files.length ? `\n\nFiles beside it, read with read_file from ${s.abs}:\n${s.files.map((f) => `- ${f}`).join("\n")}` : "";
  return { text: `Skill ${s.name} (${s.path}):\n\n${s.body}${files}`, isError: false };
}

/** The agent tool with the project's subagents to choose from, beside Studio's own worker. */
export function agentTool(base: Anthropic.Beta.BetaToolUnion, helpers: Array<{ name: string; description: string }>): Anthropic.Beta.BetaToolUnion {
  if (!helpers.length) return base;
  const b = base as Anthropic.Beta.BetaTool;
  const list = helpers.map((h) => `- ${h.name}: ${h.description}`).join("\n");
  return {
    ...b,
    description: `${b.description}\n\nThe project defines these helpers; name one in helper when its description fits the task, or leave helper out for Studio's own worker:\n${list}`,
    input_schema: {
      ...b.input_schema,
      properties: {
        ...(b.input_schema as { properties: Record<string, unknown> }).properties,
        helper: { type: "string", enum: helpers.map((h) => h.name), description: "Which of the project's helpers runs it; omit for Studio's own worker" },
      },
    },
  };
}

/** The scoped files a conversation should be given for the paths a call touched. */
export function dueFiles(l: Loadout, paths: string[], sent: Set<string>): string | null {
  const due = l.instructions.filter((f) => f.scope.kind !== "always" && !sent.has(f.path) && paths.some((p) => appliesTo(f.scope, p)));
  if (!due.length) return null;
  for (const f of due) sent.add(f.path);
  return due.map((f) => `[Studio] Instructions from ${f.path} apply to this work:\n${f.text}`).join("\n\n");
}

/** A project subagent as Studio's loop runs it. */
export interface NativeHelper {
  name: string;
  description: string;
  prompt: string;
  /** Studio's tools it may use; null for all. */
  allowed: Set<StudioToolName> | null;
  maxTurns: number | null;
  /** The level as written, sent when the model takes it. */
  effort: string | null;
  /** The provider and model it runs on; absent: the main agent's. */
  run?: { provider: () => import("./providers.js").ModelProvider; model: string; vendor: string; route: string };
  /** Why it runs on another model than its file names, for the view. */
  note?: string;
}

/** Everything the runner needs from the main agent's convention. */
export interface NativeRun {
  convention: Convention;
  loadout: Loadout;
  composed: Composed;
  helpers: NativeHelper[];
  skills: FoundSkill[];
  /** On the Claude sign-in the Agent SDK reads the files itself: Studio adds no instruction text. */
  sdkLoads: boolean;
}

/** The project's Claude Code subagents as the Agent SDK takes them, their tools in Studio's names. Invalid files are left out. */
export function sdkAgents(l: Loadout): Record<string, import("./subscription.js").NativeAgentDefinition> {
  const out: Record<string, import("./subscription.js").NativeAgentDefinition> = {};
  for (const a of l.subagents) {
    if (a.problems.some((p) => p.endsWith("is required"))) continue;
    const tools = sdkTools(toolsFor(a).allowed);
    out[a.name] = {
      description: a.description,
      prompt: a.prompt,
      ...(tools ? { tools } : {}),
      ...(a.model ? { model: a.model } : {}),
      ...(a.effort && ["low", "medium", "high", "xhigh", "max"].includes(a.effort) ? { effort: a.effort as never } : {}),
      ...(a.maxTurns ? { maxTurns: a.maxTurns } : {}),
      ...(a.skills.length ? { skills: a.skills } : {}),
      ...(a.background ? { background: true } : {}),
    };
  }
  return out;
}
