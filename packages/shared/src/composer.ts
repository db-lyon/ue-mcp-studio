/**
 * Settings grouped by the decision the user makes: approvals, the project's
 * instruction files and the context strategy other MCP clients get.
 * Routes under /v1/ext/studio; plans/agent-composer.md is the design.
 */

/* ── Approvals ─────────────────────────────────────────────────────── */

/** Whether an agent asks before it does a kind of thing, or does it. */
export type ApprovalRule = "ask" | "allow";

/** What an agent can be made to ask about. Reading files, the web and every other ue-mcp action never ask. */
export type ApprovalKind = "shell" | "files" | "editorRestart" | "destructive";
export const APPROVAL_KINDS: readonly ApprovalKind[] = ["shell", "files", "editorRestart", "destructive"];

export type Approvals = Record<ApprovalKind, ApprovalRule>;

/** A new install asks about all four. Settings from before the rows existed keep what they did: see migrateApprovals. */
export const DEFAULT_APPROVALS: Approvals = { shell: "ask", files: "ask", editorRestart: "ask", destructive: "ask" };

export const APPROVAL_ROWS: ReadonlyArray<{ kind: ApprovalKind; label: string; help: string }> = [
  { kind: "shell", label: "Shell commands", help: "Waits in the chat for Allow or Deny." },
  { kind: "files", label: "File changes", help: "Writes and edits on this machine." },
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

/** Studio's own agent: a ue-mcp strategy, or auto, which picks one from a measurement. */
export type AgentContextStrategy = ContextStrategy | "auto";
export const AGENT_CONTEXT_STRATEGIES: readonly AgentContextStrategy[] = ["micro", "lean", "full", "auto"];

/** GET /context-strategy/agent: Studio's own agent's choice and what each would cost. */
export interface AgentContextView {
  strategy: AgentContextStrategy;
  /** The strategy turns run on now, auto resolved. */
  effective: ContextStrategy;
  /** Seed tokens per strategy for every category, as the daemon's projection measures them; null when it failed. */
  seeds: Record<ContextStrategy, number> | null;
  /** Auto is offered only when a measurement ships; null otherwise. */
  measurement: { measuredAt: string; ueMcpVersion: string; runs: number } | null;
  /** Why the effective strategy differs from the choice, when it does. */
  note: string | null;
}

