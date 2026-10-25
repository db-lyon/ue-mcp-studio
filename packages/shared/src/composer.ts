/**
 * Settings grouped by the decision the user makes: approvals, the project's
 * instruction files, budgets, and the context strategy other MCP clients get.
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
  { kind: "shell", label: "Shell commands", help: "Each command waits in the chat for Allow or Deny." },
  { kind: "files", label: "File changes", help: "Writes and edits to files on this machine." },
  { kind: "editorRestart", label: "Restart or rebuild the editor", help: "Unsaved work in the editor is lost on a restart." },
  { kind: "destructive", label: "ue-mcp actions that delete or overwrite", help: "Deleting assets or actors, clearing, reverting, overwriting. Read from ue-mcp's own action metadata." },
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

/** The file conventions Studio reads, in the order it reads them. */
export type InstructionConvention =
  | "studio" // ~/.ue-mcp/studio/instructions.md, the user's own
  | "copilot" // .github/copilot-instructions.md
  | "cursor" // .cursor/rules/*.mdc, .cursorrules
  | "gemini" // GEMINI.md
  | "claude" // CLAUDE.md, .claude/CLAUDE.md
  | "agents" // AGENTS.md
  | "nested" // any of those in a subfolder
  | "local" // AGENTS.local.md, CLAUDE.local.md
  | "added"; // a file the user added

/** When a file is part of what an agent reads. */
export type InstructionScope =
  | { kind: "always" }
  /** A rule with globs: only once the agent touches a matching file. */
  | { kind: "globs"; globs: string[] }
  /** A file in a subfolder: only once the agent works in that folder. */
  | { kind: "folder"; folder: string };

export interface InstructionFile {
  /** As shown and stored: relative to the project with forward slashes, or ~/... for the user's own. */
  path: string;
  convention: InstructionConvention;
  /** 1-based position in reading order. Later wins where files disagree. */
  order: number;
  /** Approximate tokens of what it adds (0 when it is included as another file). */
  tokens: number;
  /** The user's switch. Off: no agent reads it. */
  on: boolean;
  scope: InstructionScope;
  /** Included once, as this file: the same text, or a file that only imports it. */
  sameAs?: string;
  /** Files it imports with @path, followed one level. */
  imports?: string[];
  /** The file is gone: an added path that no longer exists. */
  missing?: boolean;
  /** Agent ids that read it, when the team is known. */
  readBy?: string[];
}

/** GET /instructions */
export interface InstructionsView {
  files: InstructionFile[];
  /** Tokens of every file that is on and always read, duplicates once. */
  alwaysTokens: number;
  /** The project has an AGENTS.md: when false, POST /instructions/agents-md creates one. */
  hasAgentsMd: boolean;
  /** The conventions Studio recognises, for the page's footer. */
  recognised: string[];
}

/** PUT /instructions: which files are off, and files the user added with where they go in the order. */
export interface InstructionSettings {
  off: string[];
  /** after: the path it is read after; null reads it first. */
  added: Array<{ path: string; after: string | null }>;
}

export const DEFAULT_INSTRUCTION_SETTINGS: InstructionSettings = { off: [], added: [] };

/** GET /instructions/preview?agent= */
export interface InstructionsPreview {
  agent: string | null;
  /** What the agent is given, as composed. */
  text: string;
  tokens: number;
  /** Files read only in some folders or for some files, which join when the agent works there. */
  conditional: Array<{ path: string; scope: InstructionScope; tokens: number }>;
  files: number;
}

/* ── Budgets ──────────────────────────────────────────────────────── */

/**
 * What a budget counts, everywhere: input + cache writes + output. Cached
 * reads are excluded (every vendor bills them far below fresh input) and
 * reported separately in Usage.
 */
export const BUDGET_DEFINITION =
  "Budgets count input, cache writes and output. Cached reads are left out, because every vendor bills them far below fresh input. A run is one turn of the main agent's own calls, or one assigned playtest with every attempt in it.";

export type BudgetLimitAction = "stop-and-report" | "ask" | "fallback-model";

export interface Budget {
  /** One run: a main agent's turn (its own calls, not its helpers'), or one hand-off to a helper. */
  perRunTokens: number | null;
  perRunMinutes: number | null;
  /** The local calendar day, this machine. */
  perDayTokens: number | null;
  onLimit: BudgetLimitAction;
}

export const NO_BUDGET: Budget = { perRunTokens: null, perRunMinutes: null, perDayTokens: null, onLimit: "stop-and-report" };

/** Every budget, edited in Usage > Budgets only. Per machine, never in a shared file. */
export interface Budgets {
  team: { perDayTokens: number | null; perMonthTokens: number | null; onLimit: "ask" | "stop" };
  agents: Record<string, Budget>;
  /** The share of any budget at which Studio warns: 0.5 to 0.95. */
  warnAt: number;
}

/** The ids budgets use for the two runs Studio had limits for before agents had names. */
export const MAIN_AGENT_ID = "main";
export const PLAYTEST_RUNNER_ID = "playtest-runner";

export const DEFAULT_BUDGETS: Budgets = {
  team: { perDayTokens: null, perMonthTokens: null, onLimit: "ask" },
  agents: {},
  warnAt: 0.8,
};

/** Bounds every budget field is checked against. */
export const BUDGET_LIMITS = {
  minTokens: 10_000,
  maxTokens: 1_000_000_000,
  maxMinutes: 1440,
  minWarn: 0.5,
  maxWarn: 0.95,
} as const;

/* ── Context strategy for other MCP clients ───────────────────────── */

/** ue-mcp's own names for what an MCP client is given at the start of a session. */
export type ContextStrategy = "micro" | "lean" | "full";
export const CONTEXT_STRATEGIES: readonly ContextStrategy[] = ["micro", "lean", "full"];

export const CONTEXT_STRATEGY_INFO: Record<ContextStrategy, { name: string; sees: string; discovery: string }> = {
  micro: { name: "Micro", sees: "One gateway tool fronts everything: search, describe, call.", discovery: "A search and a describe before the first call of each action." },
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
  /** Seed tokens per strategy for every category, and where the numbers come from. */
  seeds: Record<ContextStrategy, number>;
  seedSource: "measured by this ue-mcp" | "ue-mcp's published figures";
  /** A change applies once ue-mcp restarts and the clients start a new session. */
  restarting?: boolean;
}

/** ue-mcp's published seed figures, until the daemon can project them. */
export const PUBLISHED_SEEDS: Record<ContextStrategy, number> = { micro: 2200, lean: 19000, full: 51000 };
