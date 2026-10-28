/**
 * Settings grouped by the decision the user makes: approvals, the project's
 * instruction files and the context strategy other MCP clients get.
 * Routes under /v1/ext/studio; plans/agent-composer.md is the design.
 */

/* ── Approvals ─────────────────────────────────────────────────────── */

/**
 * Whether an agent asks before it does a kind of thing, or does it. "project"
 * does it without asking when it stays inside the project folder, and asks
 * otherwise; only the kinds with a path take it (PROJECT_SCOPED_KINDS).
 */
export type ApprovalRule = "ask" | "project" | "allow";

/** What an agent can be made to ask about. Reading files, the web and every other ue-mcp action never ask. */
export type ApprovalKind = "shell" | "files" | "editorRestart" | "destructive";
export const APPROVAL_KINDS: readonly ApprovalKind[] = ["shell", "files", "editorRestart", "destructive"];

export type Approvals = Record<ApprovalKind, ApprovalRule>;

/** The kinds whose calls name a place on disk, so "project" applies. */
export const PROJECT_SCOPED_KINDS: readonly ApprovalKind[] = ["shell", "files"];

/** Whether a rule may be stored for a kind. */
export const approvalRuleFits = (kind: ApprovalKind, rule: unknown): rule is ApprovalRule =>
  rule === "ask" || rule === "allow" || (rule === "project" && PROJECT_SCOPED_KINDS.includes(kind));

/** A new install asks about all four. Settings from before the rows existed keep what they did: see migrateApprovals. */
export const DEFAULT_APPROVALS: Approvals = { shell: "ask", files: "ask", editorRestart: "ask", destructive: "ask" };

export const APPROVAL_ROWS: ReadonlyArray<{ kind: ApprovalKind; label: string; help: string }> = [
  { kind: "shell", label: "Shell commands", help: "In project runs commands that only name paths inside the project folder; any other command asks." },
  { kind: "files", label: "File changes", help: "In project writes and edits inside the project folder; changes anywhere else ask." },
  { kind: "editorRestart", label: "Restart or rebuild the editor", help: "Unsaved editor work is lost." },
  { kind: "destructive", label: "ue-mcp actions that delete or overwrite", help: "Actions ue-mcp marks as destructive." },
];

/**
 * The rows for settings written before they existed. askBeforeChanges covered
 * shell commands and file changes; editor restarts and ue-mcp actions never
 * asked, so they stay allowed until the user changes them.
 */
export function migrateApprovals(askBeforeChanges: boolean): Approvals {
  const rule: ApprovalRule = askBeforeChanges ? "ask" : "allow";
  return { shell: rule, files: rule, editorRestart: "allow", destructive: "allow" };
}

/* ── Project instructions ─────────────────────────────────────────── */

/** When a file is part of what an agent reads. */
export type InstructionScope =
  | { kind: "always" }
  /** A rule with globs: only once the agent touches a matching file. */
  | { kind: "globs"; globs: string[] }
  /** A file in a subfolder: only once the agent works in that folder. */
  | { kind: "folder"; folder: string };

/* ── Context strategy for other MCP clients ───────────────────────── */

/** ue-mcp's own names for what an MCP client is given at the start of a session. */
export type ContextStrategy = "micro" | "lean" | "full";
export const CONTEXT_STRATEGIES: readonly ContextStrategy[] = ["micro", "lean", "full"];

export const CONTEXT_STRATEGY_INFO: Record<ContextStrategy, { name: string; sees: string; discovery: string }> = {
  micro: { name: "Micro", sees: "A single tool that finds an action, describes it and calls it.", discovery: "A search and a describe before the first call of each action." },
  lean: { name: "Lean", sees: "A tool per category with its action names; signatures on demand.", discovery: "About one round trip to learn a category." },
  full: { name: "Full", sees: "A tool per category with every action's signature inline.", discovery: "No discovery calls." },
};

/** GET /context-strategy */
export interface ClientContextStrategy {
  /** What ue-mcp.yml sets, micro when it names none. */
  strategy: ContextStrategy;
  /** ue-mcp.yml names one, or the default applies. */
  fromFile: boolean;
  /** UE_MCP_CONTEXT_STRATEGY in the daemon's environment wins over the file. */
  envOverride: ContextStrategy | null;
  /** Seed tokens per strategy for every category, as the daemon's projection measures them. */
  seeds: Record<ContextStrategy, number>;
  /** A change applies once ue-mcp restarts and the clients start a new session. */
  restarting?: boolean;
}

