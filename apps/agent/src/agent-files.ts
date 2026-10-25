/**
 * Agent files: Claude Code subagent files (code.claude.com/docs/en/sub-agents),
 * extended. `name`, `description`, `tools` and `model` keep the standard's
 * meaning and the body is the agent's instructions; every Studio-only field
 * sits under one frontmatter key, `studio:`, which other tools ignore. A file
 * Studio writes therefore still loads as a subagent anywhere, and a plain
 * subagent file from `.claude/agents/` loads here as a project agent.
 *
 * The main agent's file also carries the team's settings, under
 * `studio.main: true` and `studio.team`; there is no separate team file.
 */
import { parseDocument, stringify } from "yaml";
import {
  CONTEXT_STRATEGIES,
  FULL_SCOPE,
  IMAGE_EDGES,
  MAX_HELPERS_PER_TURN,
  MAX_PARALLEL_HELPERS,
  isSlug,
  type AgentSpec,
  type Bindings,
  type DelegationPolicy,
  type HandoffRule,
  type ImageSize,
  type InstructionChoice,
  type ModelRef,
  type SkillAttachment,
  type TeamSettings,
  type ToolScope,
} from "@ue-mcp-studio/shared";

/** The newest Anthropic model of each family the standard's aliases name. */
export const MODEL_ALIASES: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-1" };

/** The standard's effort levels. */
const STANDARD_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export interface ParsedAgent {
  /** Only the fields the file sets: a layer overrides field by field. */
  spec: Partial<AgentSpec> & { id: string };
  isMain: boolean;
  team: Partial<TeamSettings> | null;
  /** The file had no `studio:` key: a plain subagent file. */
  plain: boolean;
  /** Fields that were present but not valid, each left out. */
  problems: string[];
}

/** Front matter and body of a markdown file; null when it has no front matter. */
export function splitFrontmatter(text: string): { front: Record<string, unknown>; body: string } | null {
  const t = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (!m) return null;
  const doc = parseDocument(m[1]);
  if (doc.errors.length) throw new Error(`front matter is not valid YAML: ${doc.errors[0].message}`);
  const front = doc.toJS() as unknown;
  if (front !== null && (typeof front !== "object" || Array.isArray(front))) throw new Error("front matter must be a mapping");
  return { front: (front ?? {}) as Record<string, unknown>, body: t.slice(m[0].length).replace(/^\n+/, "") };
}

/** The standard's `tools`: a comma-separated string or a list. */
function toolNames(v: unknown): string[] | null {
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return null;
}

/** A scope from Claude Code tool names. Studio's editor restart has no standard tool, so it comes with ue-mcp. */
export function scopeFromTools(names: string[]): ToolScope {
  const has = (...n: string[]) => names.some((x) => n.includes(x));
  const ue = names.some((x) => x === "mcp__ue-mcp" || x.startsWith("mcp__ue-mcp__") || x === "mcp__ue_mcp" || x.startsWith("mcp__ue_mcp__"));
  return {
    ueMcp: ue ? "all" : "none",
    ueMcpAccess: "read-write",
    shell: has("Bash", "PowerShell"),
    files: has("Edit", "Write", "MultiEdit", "NotebookEdit") ? "read-write" : has("Read", "Glob", "Grep", "LS", "NotebookRead") ? "read" : "none",
    web: { search: has("WebSearch"), fetch: has("WebFetch") },
    editorRestart: ue,
  };
}

/** The Claude Code names for a scope; null when it is everything, which the standard writes as no list. */
export function toolsFromScope(s: ToolScope): string[] | null {
  if (JSON.stringify(s) === JSON.stringify(FULL_SCOPE)) return null;
  const out: string[] = [];
  if (s.shell) out.push("Bash");
  if (s.files !== "none") out.push("Read", "Glob", "Grep");
  if (s.files === "read-write") out.push("Edit", "Write");
  if (s.web.search) out.push("WebSearch");
  if (s.web.fetch) out.push("WebFetch");
  if (s.ueMcp !== "none") out.push("mcp__ue-mcp");
  return out;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function modelRefOf(v: unknown): ModelRef | null {
  const m = obj(v);
  if (!m || typeof m.vendor !== "string" || !m.vendor.trim() || typeof m.model !== "string" || !m.model.trim()) return null;
  return { vendor: m.vendor.trim(), model: m.model.trim() };
}

/** The standard's `model`: an alias, a full Anthropic id, or inherit. */
export function standardModel(v: unknown): ModelRef | "inherit" | null {
  if (v === undefined || v === null || v === "inherit") return "inherit";
  if (typeof v !== "string" || !v.trim()) return null;
  const id = MODEL_ALIASES[v.trim().toLowerCase()] ?? v.trim();
  return { vendor: "anthropic", model: id };
}

export function scopeOf(v: unknown): ToolScope | null {
  const t = obj(v);
  if (!t) return null;
  const ue = t.ueMcp === "all" || t.ueMcp === "none" ? t.ueMcp : obj(t.ueMcp) && Array.isArray(obj(t.ueMcp)!.only) ? { only: (obj(t.ueMcp)!.only as unknown[]).map(String).filter(Boolean) } : null;
  const files = t.files === "none" || t.files === "read" || t.files === "read-write" ? t.files : null;
  const web = obj(t.web);
  if (!ue || !files || !web || typeof t.shell !== "boolean" || typeof web.search !== "boolean" || typeof web.fetch !== "boolean") return null;
  return {
    ueMcp: ue as ToolScope["ueMcp"],
    ueMcpAccess: t.ueMcpAccess === "read" ? "read" : "read-write",
    shell: t.shell,
    files,
    web: { search: web.search, fetch: web.fetch },
    editorRestart: t.editorRestart === true,
  };
}

export function handoffOf(v: unknown): HandoffRule | null {
  const h = obj(v);
  if (!h) return null;
  if (!["named", "judged", "always", "split"].includes(h.when as string)) return null;
  if (!["shared", "brief", "brief-and-files"].includes(h.startWith as string)) return null;
  const matches = Array.isArray(h.matches) ? h.matches.map(String).filter(Boolean) : undefined;
  return { when: h.when as HandoffRule["when"], background: h.background === true, startWith: h.startWith as HandoffRule["startWith"], ...(matches?.length ? { matches } : {}) };
}

const skillsOf = (v: unknown): SkillAttachment[] | null =>
  Array.isArray(v)
    ? v.flatMap((x) => {
      if (typeof x === "string" && x.trim()) return [{ skill: x.trim(), load: "preload" as const }];
      const o = obj(x);
      return o && typeof o.skill === "string" && o.skill.trim() ? [{ skill: o.skill.trim(), load: o.load === "on-demand" ? ("on-demand" as const) : ("preload" as const) }] : [];
    })
    : null;

const instructionChoiceOf = (v: unknown): InstructionChoice | null => {
  if (v === "all" || v === "none") return v;
  const o = obj(v);
  return o && Array.isArray(o.only) ? { only: o.only.map(String) } : null;
};

export function delegationOf(v: unknown): DelegationPolicy | null {
  const d = obj(v);
  if (!d || !["never", "on-request", "auto"].includes(d.mode as string)) return null;
  const n = (x: unknown, max: number, dflt: number) => (Number.isInteger(x) && (x as number) >= 1 && (x as number) <= max ? (x as number) : dflt);
  return { mode: d.mode as DelegationPolicy["mode"], maxPerTurn: n(d.maxPerTurn, MAX_HELPERS_PER_TURN, 4), maxParallel: n(d.maxParallel, MAX_PARALLEL_HELPERS, 4) };
}

export function bindingsOf(v: unknown): Partial<Bindings> | null {
  const b = obj(v);
  if (!b) return null;
  const out: Partial<Bindings> = {};
  for (const k of ["quickAsk", "flowSteps", "assignedPlaytests"] as const) if (typeof b[k] === "string" && isSlug(b[k] as string)) out[k] = b[k] as string;
  return out;
}

/**
 * Read one agent file. `fileId` is its name without .md, the id when the
 * file has no usable `name`. Throws only when the file is not front matter
 * and markdown at all; a field that is not valid is reported and left out.
 */
export function parseAgentFile(text: string, fileId: string): ParsedAgent {
  const split = splitFrontmatter(text);
  if (!split) throw new Error("an agent file starts with YAML front matter between --- lines");
  const { front, body } = split;
  const problems: string[] = [];
  const studio = obj(front.studio);
  const plain = !studio;
  const id = typeof front.name === "string" && isSlug(front.name.trim()) ? front.name.trim() : isSlug(fileId) ? fileId : fileId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  if (typeof front.name === "string" && !isSlug(front.name.trim())) problems.push(`name "${front.name}" is not a lowercase slug, so the file name ${id} is used as the id`);
  const spec: ParsedAgent["spec"] = { id };
  if (typeof front.description === "string") spec.description = front.description.trim();
  if (body.trim()) spec.instructions = body.trim();

  // The standard's fields, which `studio:` overrides where it sets the same thing.
  if (front.tools !== undefined) {
    const names = toolNames(front.tools);
    if (names) spec.tools = scopeFromTools(names);
    else problems.push("tools must be a comma-separated string or a list");
  } else if (plain) {
    spec.tools = { ...FULL_SCOPE, web: { ...FULL_SCOPE.web } };
  }
  if (front.model !== undefined || plain) {
    const m = standardModel(front.model);
    if (m) spec.model = m;
    else problems.push("model must be an alias, a model id or inherit");
  }
  if (typeof front.effort === "string" && STANDARD_EFFORTS.includes(front.effort)) spec.effort = front.effort;
  if (Number.isInteger(front.maxTurns) && (front.maxTurns as number) > 0) spec.maxSteps = front.maxTurns as number;
  if (Array.isArray(front.skills)) spec.skills = front.skills.map((s) => ({ skill: String(s), load: "preload" as const }));
  if (front.background === true) spec.handoff = { when: "judged", background: true, startWith: "brief" };

  let isMain = false;
  let team: Partial<TeamSettings> | null = null;
  if (studio) {
    const field = <T>(key: string, read: (v: unknown) => T | null, set: (v: T) => void) => {
      if (studio[key] === undefined) return;
      const v = read(studio[key]);
      if (v === null) problems.push(`studio.${key} is not valid and is ignored`);
      else set(v);
    };
    field("displayName", (v) => (typeof v === "string" && v.trim() ? v.trim() : null), (v) => (spec.name = v));
    field("model", (v) => (v === "inherit" ? "inherit" : modelRefOf(v)), (v) => (spec.model = v as ModelRef | "inherit"));
    field("fallbacks", (v) => (Array.isArray(v) ? v.map(modelRefOf).filter((x): x is ModelRef => !!x) : null), (v) => (spec.fallbacks = v));
    field("effort", (v) => (typeof v === "string" && v.trim() ? v.trim() : null), (v) => (spec.effort = v));
    field("tools", scopeOf, (v) => (spec.tools = v));
    field("contextStrategy", (v) => ((CONTEXT_STRATEGIES as readonly unknown[]).includes(v) || v === "auto" || v === "inherit" ? (v as AgentSpec["contextStrategy"]) : null), (v) => (spec.contextStrategy = v));
    field("skills", skillsOf, (v) => (spec.skills = v));
    field("instructionFiles", instructionChoiceOf, (v) => (spec.instructionFiles = v));
    field("imageSize", (v) => (v === "inherit" || (typeof v === "string" && v in IMAGE_EDGES) ? (v as ImageSize | "inherit") : null), (v) => (spec.imageSize = v));
    field("maxSteps", (v) => (v === null ? null : Number.isInteger(v) && (v as number) > 0 && (v as number) <= 1000 ? (v as number) : null), (v) => (spec.maxSteps = v));
    field("handoff", handoffOf, (v) => (spec.handoff = v));
    isMain = studio.main === true;
    const t = obj(studio.team);
    if (t) {
      team = {};
      if (typeof t.name === "string" && t.name.trim()) team.name = t.name.trim();
      const d = t.delegation === undefined ? undefined : delegationOf(t.delegation);
      if (d) team.delegation = d;
      else if (d === null) problems.push("studio.team.delegation is not valid and is ignored");
      const b = t.bindings === undefined ? undefined : bindingsOf(t.bindings);
      if (b) team.bindings = b as Bindings;
      const df = obj(t.defaults);
      if (df) {
        const cs = (CONTEXT_STRATEGIES as readonly unknown[]).includes(df.contextStrategy) || df.contextStrategy === "auto" ? (df.contextStrategy as TeamSettings["defaults"]["contextStrategy"]) : "micro";
        const im = typeof df.imageSize === "string" && df.imageSize in IMAGE_EDGES ? (df.imageSize as ImageSize) : "standard";
        team.defaults = { contextStrategy: cs, imageSize: im };
      }
    }
  }
  if (!spec.name && plain) spec.name = id.split("-").map((w, i) => (i === 0 ? w[0]?.toUpperCase() + w.slice(1) : w)).join(" ");
  return { spec, isMain, team, plain, problems };
}

/** Write one agent file: the standard's fields with their meaning, Studio's under `studio:`, the instructions as the body. */
export function serializeAgentFile(spec: AgentSpec, opts: { main?: boolean; team?: TeamSettings } = {}): string {
  const front: Record<string, unknown> = { name: spec.id, description: spec.description || spec.name };
  const tools = toolsFromScope(spec.tools);
  if (tools) front.tools = tools.join(", ");
  if (spec.model === "inherit") front.model = "inherit";
  else if (spec.model.vendor === "anthropic") front.model = spec.model.model;
  if (spec.effort !== "inherit" && STANDARD_EFFORTS.includes(spec.effort)) front.effort = spec.effort;
  if (spec.maxSteps) front.maxTurns = spec.maxSteps;
  const preload = spec.skills.filter((s) => s.load === "preload").map((s) => s.skill);
  if (preload.length) front.skills = preload;
  if (spec.handoff?.background) front.background = true;
  const studio: Record<string, unknown> = {
    displayName: spec.name,
    model: spec.model === "inherit" ? "inherit" : { vendor: spec.model.vendor, model: spec.model.model },
    ...(spec.fallbacks.length ? { fallbacks: spec.fallbacks.map((f) => ({ vendor: f.vendor, model: f.model })) } : {}),
    effort: spec.effort,
    tools: spec.tools,
    contextStrategy: spec.contextStrategy,
    ...(spec.skills.length ? { skills: spec.skills } : {}),
    instructionFiles: spec.instructionFiles,
    imageSize: spec.imageSize,
    ...(spec.maxSteps ? { maxSteps: spec.maxSteps } : {}),
    ...(spec.handoff && !opts.main ? { handoff: spec.handoff } : {}),
    ...(opts.main ? { main: true } : {}),
    ...(opts.main && opts.team ? { team: opts.team } : {}),
  };
  front.studio = studio;
  const yaml = stringify(front, { lineWidth: 0, flowCollectionPadding: false }).trimEnd();
  return `---\n${yaml}\n---\n${spec.instructions.trim()}\n`;
}
