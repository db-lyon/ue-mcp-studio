/**
 * Each vendor's own project files for agents: instructions, subagents and
 * skills, read the way that vendor's tools read them. Studio writes none of
 * them; GET /v1/ext/studio/native shows what each route loads.
 */
import type { InstructionScope } from "./composer.js";

/** Whose file conventions a route reads. The model's vendor picks it, whatever the route. */
export type Convention = "claude" | "codex" | "gemini" | "agents";
export const CONVENTIONS: readonly Convention[] = ["claude", "codex", "gemini", "agents"];

export const CONVENTION_INFO: Record<Convention, { name: string; tool: string; vendor: string; reads: string; docs: string }> = {
  claude: {
    name: "Claude",
    tool: "Claude Code",
    vendor: "Anthropic models",
    reads: "CLAUDE.md and .claude/CLAUDE.md in the project and its parents, .claude/rules, CLAUDE.local.md, and your ~/.claude files; AGENTS.md only when there is no CLAUDE.md. Subagents from .claude/agents, skills from .claude/skills.",
    docs: "https://code.claude.com/docs/en/memory",
  },
  codex: {
    name: "OpenAI",
    tool: "Codex",
    vendor: "OpenAI models",
    reads: "AGENTS.md (or AGENTS.override.md) in each folder from the repository root down to the project, after your ~/.codex/AGENTS.md, up to 32 KiB. Subagents from .codex/agents, skills from .agents/skills.",
    docs: "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
  },
  gemini: {
    name: "Gemini",
    tool: "Gemini CLI",
    vendor: "Google models",
    reads: "GEMINI.md (or the names in context.fileName) from ~/.gemini, the project and its parents up to the repository root, and the project's subfolders. Subagents from .gemini/agents, skills from .agents/skills and .gemini/skills.",
    docs: "https://geminicli.com/docs/cli/gemini-md/",
  },
  agents: {
    name: "Other models",
    tool: "AGENTS.md",
    vendor: "custom endpoints",
    reads: "AGENTS.md in each folder from the repository root down to the project, and skills from .agents/skills, the files no single vendor owns.",
    docs: "https://agents.md",
  },
};

/** The convention a model's vendor reads. */
export function conventionOf(vendor: string): Convention {
  return vendor === "anthropic" ? "claude" : vendor === "openai" ? "codex" : vendor === "google" ? "gemini" : "agents";
}

/** Where a file was found: the user's own folder, the project and its parents, or this machine only. */
export type NativeSource = "user" | "project" | "local" | "plugin";

export interface NativeFile {
  /** As shown: relative to the project, ../ above it, or ~/ under the home folder. */
  path: string;
  source: NativeSource;
  tokens: number;
  scope: InstructionScope;
  /** Files it pulls in with @path, followed as the vendor follows them. */
  imports?: string[];
}

export interface NativeSubagent {
  name: string;
  description: string;
  path: string;
  source: NativeSource;
  tokens: number;
  /** The model the file names, as written; null when it names none. */
  model: string | null;
  /** How it runs on this machine: the model, and why it differs from the file when it does. */
  runs: { model: string; note?: string };
  /** The tools it may use, in Studio's words. */
  tools: string;
  effort: string | null;
  maxTurns: number | null;
  /** Fields that were not valid, each left out. */
  problems: string[];
}

export interface NativeSkill {
  name: string;
  description: string;
  /** The folder holding SKILL.md. */
  path: string;
  source: NativeSource;
  /** The ue-mcp plugin package that installed it, when one did. */
  owner?: string;
  tokens: number;
  /** false: the skill asks to be used only when named. */
  implicit: boolean;
  problems: string[];
}

export interface NativeView {
  convention: Convention;
  /** The connected routes whose models read this convention, by name. */
  routes: string[];
  instructions: NativeFile[];
  /** Tokens of the instruction files read on every call. */
  instructionTokens: number;
  subagents: NativeSubagent[];
  skills: NativeSkill[];
  /** What a reader should know: a file past the size cap, a name read twice. */
  notes: string[];
}

/** Studio's own helper for work that splits, as earlier settings left it. */
export interface WorkerView {
  model: string;
  effort: string;
  starts: "never" | "asked" | "automatic";
  /** The values come from settings the user made before these became read only. */
  fromSettings: boolean;
}

/** GET /native */
export interface NativeOverview {
  /** "Read the project's own files". */
  enabled: boolean;
  /** The convention the main agent's model reads now; null when nothing can run it. */
  main: Convention | null;
  conventions: NativeView[];
  worker: WorkerView;
}

/** GET /native/preview?convention= */
export interface NativePreview {
  convention: Convention;
  text: string;
  tokens: number;
  /** On the Claude sign-in the Agent SDK reads the files itself; this is what it reads. */
  loadedBy: "studio" | "sdk";
}
