/**
 * The agent composer's data model: agents (a main agent and helpers), how a
 * team resolves from layers, how each agent runs on this machine, and the
 * routes under /v1/ext/studio that read and change them. plans/agent-composer.md
 * sections 2 and 6 are the design.
 */
import type { ContextStrategy } from "./composer.js";
import type { ImageSize, SignInId } from "./index.js";

/** A vendor in the catalog. Open-ended: a custom endpoint is its own vendor, `endpoint:<id>`. */
export type VendorId = string;

/** How a model is reached: a sign-in, the vendor's key, or a custom endpoint. */
export type RouteId = SignInId | "key" | `endpoint:${string}`;

export interface ModelRef {
  vendor: VendorId;
  model: string;
  /** auto: the first connected route in the user's route order. Never written to shared files. */
  route?: RouteId | "auto";
}

/** What an agent can reach at all. Approvals decide separately whether a reachable tool asks first. */
export interface ToolScope {
  /** ue-mcp categories: all, none, or a list. */
  ueMcp: "all" | "none" | { only: string[] };
  /** read: only the actions ue-mcp marks as reads. */
  ueMcpAccess: "read" | "read-write";
  shell: boolean;
  files: "none" | "read" | "read-write";
  web: { search: boolean; fetch: boolean };
  editorRestart: boolean;
}

export const FULL_SCOPE: ToolScope = { ueMcp: "all", ueMcpAccess: "read-write", shell: true, files: "read-write", web: { search: true, fetch: true }, editorRestart: true };

export interface SkillAttachment {
  skill: string;
  load: "preload" | "on-demand";
}

export interface HandoffRule {
  /** named: when the user names it. judged: when its description fits. always: work matching `matches`. split: parallel copies of independent parts. */
  when: "named" | "judged" | "always" | "split";
  matches?: string[];
  /** Runs beside the main agent without blocking its turn. */
  background: boolean;
  /** shared: the main agent's conversation, then the brief (same model and route only). brief: the brief alone. brief-and-files: and the files the main agent read this turn. */
  startWith: "shared" | "brief" | "brief-and-files";
}

/** Which project instruction files an agent reads. */
export type InstructionChoice = "all" | "none" | { only: string[] };

export interface AgentSpec {
  /** Slug; the file name, and the `name` a subagent file carries. */
  id: string;
  /** What the UI shows. */
  name: string;
  /** When to hand work to this agent. The main agent reads it to decide. */
  description: string;
  /** Persona and standing instructions, markdown: the file's body. */
  instructions: string;
  model: ModelRef | "inherit";
  /** Tried in order when the model is not reachable on this machine. */
  fallbacks: ModelRef[];
  /** In the vendor's own levels; "inherit" takes the main agent's, mapped to the nearest. */
  effort: string | "inherit";
  tools: ToolScope;
  contextStrategy: ContextStrategy | "auto" | "inherit";
  skills: SkillAttachment[];
  instructionFiles: InstructionChoice;
  imageSize: ImageSize | "inherit";
  /** Model calls before the agent must report. null: the default for its role. */
  maxSteps: number | null;
  /** Helpers only. */
  handoff?: HandoffRule;
}

export interface DelegationPolicy {
  /** never: no helpers. on-request: only helpers the user names. auto: each helper's rule applies. */
  mode: "never" | "on-request" | "auto";
  maxPerTurn: number;
  maxParallel: number;
}

/** Entry points other than the chat, and the agent each starts. The chat always starts the main agent. */
export interface Bindings {
  quickAsk: string;
  flowSteps: string;
  assignedPlaytests: string;
}

/** What a team carries beside its agents. Lives in the main agent's file, under `studio.team`. */
export interface TeamSettings {
  name: string;
  delegation: DelegationPolicy;
  bindings: Bindings;
  defaults: { contextStrategy: ContextStrategy | "auto"; imageSize: ImageSize };
}

export const MAX_HELPERS_PER_TURN = 16;
export const MAX_PARALLEL_HELPERS = 8;

/** Where a value came from, lowest first. Later layers win per agent and per field. */
export type LayerKind = "template" | "user" | "project" | "local";

export type Origin =
  | { kind: "template"; template: string }
  | { kind: "user"; path: string }
  | { kind: "project"; path: string; format: "studio" | "subagent" }
  | { kind: "local"; path: string };

/** How an agent runs on this machine now: the route it will take, which may be a fallback. */
export interface EffectiveRun {
  vendor: VendorId;
  model: string;
  /** The model's name for display. */
  modelName: string;
  route: RouteId | null;
  /** "Claude sign-in", "OpenAI key", "Workstation endpoint". */
  routeName: string;
  /** Nothing on this machine can run it. */
  runs: boolean;
  /** Runs a fallback, standing in for this configured model. */
  insteadOf?: ModelRef;
  /** Why the configured model is not used, or why nothing runs. */
  why?: string;
  /** The level sent to the vendor, in its own words. */
  effort: string;
  /** The vendor's levels, for the effort control. */
  efforts: string[];
  /** On the Agent SDK (the Claude sign-in) rather than Studio's own loop. */
  sdk: boolean;
}

/** One way a helper's run differs from the main agent's on this machine. */
export interface CompatRow {
  label: string;
  value: string;
}

export interface ResolvedAgent {
  spec: AgentSpec;
  isMain: boolean;
  /** The highest layer that defines it. */
  origin: Origin;
  /** Each field's layer, for the "from the project" marks. */
  fieldSources: Partial<Record<keyof AgentSpec, LayerKind>>;
  effective: EffectiveRun;
  /** Helpers: what a hand-off starts from on this machine, and why when it is not what the rule asked for. */
  start?: { kind: "shared" | "fresh"; why: string };
  /** Rows where this agent's run differs from the main agent's; empty when none do. */
  compat: CompatRow[];
  warnings: string[];
  /** Approximate tokens it reads before any work, by part. */
  seed?: { system: number; instructions: number; skills: number; tools: number; total: number; strategy: ContextStrategy; sharedPrefix?: boolean };
}

/** GET /team */
export interface TeamView {
  name: string;
  main: string;
  agents: ResolvedAgent[];
  delegation: DelegationPolicy;
  bindings: Bindings;
  defaults: TeamSettings["defaults"];
  /** The template the team started from, when one did. */
  template: string | null;
  /** The files the team is read from, by layer. */
  files: { project: string[]; user: string[]; local: boolean };
  /** User-level agents that are not in this team, for "Add from yours". */
  library: Array<{ id: string; name: string; description: string; path: string }>;
  warnings: string[];
}

/** PUT /agents/:id and POST /agents: where it is written. Project and user are files; local is this machine only. */
export type WriteLayer = "project" | "user" | "local";

/** A template, filled for this machine: GET /templates. */
export interface TemplateView {
  id: string;
  name: string;
  why: string;
  /** Relative, from the measured context costs and the models picked; never currency. */
  cost: "Lightest" | "Moderate" | "Heaviest";
  agents: Array<{ id: string; name: string; role: string; model: ModelRef | null; modelName: string; routeName: string; effort: string; note?: string }>;
}

/** The vendors a template can be filled from: every connected one, custom endpoints included. */
export interface TemplateVendor {
  vendor: VendorId;
  name: string;
  connected: boolean;
  routeName: string;
}

/** POST /delegation/try */
export interface DelegationTry {
  /** Which helpers the current rules would pick, and why, in the order the main agent would hand over. */
  picks: Array<{ helper: string; why: string }>;
  /** What the main agent keeps for itself. */
  keeps: string;
  /** The model that answered and what the question cost. */
  model: string;
  tokens: number;
}

/** Effort levels each vendor takes, in its own words. A vendor not listed takes none. */
export const VENDOR_EFFORTS: Record<string, Array<{ id: string; name: string }>> = {
  anthropic: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }, { id: "xhigh", name: "Extra high" }, { id: "max", name: "Max" }],
  openai: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }, { id: "xhigh", name: "Extra high" }],
  google: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }, { id: "high", name: "High" }],
};

/** A level in another vendor's terms: the same one when it has it, else the nearest below, else its highest. */
export function nearestEffort(level: string, vendor: VendorId): string {
  const order = ["low", "medium", "high", "xhigh", "max"];
  const own = (VENDOR_EFFORTS[vendor] ?? []).map((e) => e.id);
  if (own.length === 0) return "";
  if (own.includes(level)) return level;
  const at = order.indexOf(level);
  for (let i = at; i >= 0; i--) if (own.includes(order[i])) return order[i];
  return own[own.length - 1];
}

export const effortName = (vendor: VendorId, level: string): string => VENDOR_EFFORTS[vendor]?.find((e) => e.id === level)?.name ?? level;

/** A spec's tool scope in a sentence of tags, for cards and tables. */
export function scopeSummary(t: ToolScope): string {
  const ue = t.ueMcp === "all" ? "all categories" : t.ueMcp === "none" ? "no ue-mcp" : `${t.ueMcp.only.length} ${t.ueMcp.only.length === 1 ? "category" : "categories"}`;
  return t.ueMcpAccess === "read" && t.ueMcp !== "none" ? `${ue}, read only` : ue;
}

export const isSlug = (s: string): boolean => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);

/** A slug from a display name: "Level dresser" gives "level-dresser". */
export const slugOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "agent";
