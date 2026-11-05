/**
 * Agents > the project's agent files, as a client lists them: the vendors'
 * conventions in one fixed order, the one open first, the same file read
 * under another convention, and each file's scope in words. Shared by
 * client-web's NativePanel and the mobile app's.
 */
import { CONVENTIONS, type Convention, type NativeFile, type NativeOverview, type NativeView } from "@ue-mcp-studio/shared";

/** When a file is read, in words. */
export function scopeLine(f: NativeFile): string {
  if (f.scope.kind === "globs") return `when the agent touches ${f.scope.globs.join(", ")}`;
  if (f.scope.kind === "folder") return `when the agent works in ${f.scope.folder}`;
  return f.source === "user" ? "yours, every project" : f.source === "local" ? "this machine only" : "every call";
}

export const SOURCE_NAME: Record<string, string> = { user: "User", project: "Project", local: "This machine", plugin: "Plugin" };

/** Where each convention keeps its subagents and skills, for the empty states. */
export const SUBAGENT_DIR: Record<Convention, string | null> = { claude: ".claude/agents and ~/.claude/agents", codex: ".codex/agents and ~/.codex/agents", gemini: ".gemini/agents and ~/.gemini/agents", agents: null };
export const SKILL_DIR: Record<Convention, string> = { claude: ".claude/skills and ~/.claude/skills", codex: ".agents/skills and ~/.agents/skills", gemini: ".agents/skills, .gemini/skills, ~/.agents/skills and ~/.gemini/skills", agents: ".agents/skills and ~/.agents/skills" };
export const INSTRUCTION_FILE: Record<Convention, string> = { claude: "CLAUDE.md", codex: "AGENTS.md", gemini: "GEMINI.md", agents: "AGENTS.md" };

/** How many files a convention gives its models. */
export const fileCount = (v: NativeView): number => v.instructions.length + v.subagents.length + v.skills.length;

/** Tabs in one fixed order, the vendors' order everywhere in Settings. */
export function conventionOrder(o: NativeOverview): NativeView[] {
  return [...o.conventions].sort((a, b) => CONVENTIONS.indexOf(a.convention) - CONVENTIONS.indexOf(b.convention));
}

/** The tab open first: the main agent's convention, else one a route reads, else the first in the fixed order. */
export function firstTab(o: NativeOverview): Convention {
  if (o.main) return o.main;
  const ordered = conventionOrder(o);
  return (ordered.find((v) => v.routes.length) ?? ordered[0])?.convention ?? "claude";
}

/** The same files read under another tab by a connected route: an AGENTS.md or a skill folder can belong to several conventions. */
export function sharedWith(view: NativeView, o: NativeOverview): Array<{ convention: Convention; paths: string[]; routes: string[] }> {
  const mine = new Set([...view.instructions.map((f) => f.path), ...view.skills.map((s) => s.path)]);
  return conventionOrder(o)
    .filter((v) => v.convention !== view.convention && v.routes.length)
    .map((v) => ({ convention: v.convention, paths: [...v.instructions.map((f) => f.path), ...v.skills.map((s) => s.path)].filter((p) => mine.has(p)), routes: v.routes }))
    .filter((x) => x.paths.length);
}

/** Tokens as people read them: 950, 12k, 1.4M. */
export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "none";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

/** Whether a choice's names are too long to share a row on a narrow panel: then one per line. */
export function segStacks(names: string[]): boolean {
  return names.some((n) => n.length > 22) || names.reduce((n, s) => n + s.length, 0) > 48;
}
