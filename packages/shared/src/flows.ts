/**
 * /flow <name>: run one of the project's flows from the chat. The composer
 * completes the name from the daemon's GET /v1/flows, the plan's `inputs`
 * (GET /v1/flows/<name>/plan) become a form, and the agent runs the flow
 * through POST /v1/flows/<name>/run, its card following the flow.* events.
 */
import type { FormField } from "./index.js";

/** A step that reads an input: its path (`3`, `2/1` in a nested flow, `on_start/1` for a hook), task and the flow it is declared in. */
export interface FlowInputStep {
  path: string;
  task: string;
  flow: string;
}

/**
 * One input a run may pass, as the plan reports it (ue-mcp#1508): a parameter
 * of its step actions the steps leave unset. Required inputs come first.
 */
export interface FlowInput {
  name: string;
  /** A JSON schema type, or every distinct type when the steps disagree (`conflict`). */
  type: string | string[];
  conflict?: true;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  required: boolean;
  /** The steps that read it. */
  steps: FlowInputStep[];
}

/** A flow GET /v1/flows lists. */
export interface FlowListing {
  name: string;
  description?: string;
  stepCount?: number;
}

/** A step of the plan, as GET /v1/flows/<name>/plan reports it. */
export interface FlowPlanStep {
  stepNumber?: number;
  name?: string;
  type?: string;
  skipped?: boolean;
  options?: Record<string, unknown>;
}

/** POST /v1/ext/studio/sessions/:id/flow: run a flow in the session. `text` is the message the chat shows. */
export interface FlowRunRequest {
  name: string;
  params: Record<string, unknown>;
  text?: string;
}

/** A step of a /flow's run, as its card shows it. */
export interface FlowStepProgress {
  /** The step's number, or its path ("2/1") inside a nested flow. */
  id: string;
  name: string;
  /** How deep in nested flows: 0 for the flow's own steps. */
  depth?: number;
  state: "running" | "done" | "failed" | "skipped";
  error?: string;
}

/** Where a /flow's run is. */
export type FlowRunState = "running" | "succeeded" | "failed" | "stopped";

/** The plan's inputs, or null when this ue-mcp's plan does not report them. */
export function flowInputsOf(plan: unknown): FlowInput[] | null {
  const list = (plan as { inputs?: unknown } | null | undefined)?.inputs;
  if (!Array.isArray(list)) return null;
  return list.filter((x): x is FlowInput => !!x && typeof x === "object" && typeof (x as FlowInput).name === "string");
}

/**
 * How a flow takes its params: `flat` spreads every param into every step,
 * `step` reads each key as a step selector. Flat unless the plan says so.
 */
export function flowOptionsScope(plan: unknown): "flat" | "step" {
  const p = plan as { options_scope?: unknown; definition?: { options_scope?: unknown } } | null | undefined;
  return (p?.options_scope ?? p?.definition?.options_scope) === "step" ? "step" : "flat";
}

/**
 * A step-scoped flow's params: each value under the path of every step that
 * reads it. Null when a param is read by a nested or hook step, or by no
 * step, which a step selector cannot address.
 */
export function stepScopedParams(inputs: FlowInput[], params: Record<string, unknown>): Record<string, Record<string, unknown>> | null {
  const byName = new Map(inputs.map((i) => [i.name, i]));
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(params)) {
    const steps = byName.get(k)?.steps ?? [];
    if (!steps.length || steps.some((s) => s.path.includes("/"))) return null;
    for (const s of steps) (out[s.path] ??= {})[k] = v;
  }
  return out;
}

/** The plan's steps, in run order. */
export function flowPlanSteps(plan: unknown): FlowPlanStep[] {
  const list = (plan as { steps?: unknown } | null | undefined)?.steps;
  return Array.isArray(list) ? list.filter((x): x is FlowPlanStep => !!x && typeof x === "object") : [];
}

/** An input's one type, or null when it has none or two steps disagree. */
export function singleType(input: FlowInput): string | null {
  if (input.conflict) return null;
  if (Array.isArray(input.type)) return input.type.length === 1 ? input.type[0] : null;
  return input.type ?? null;
}

/**
 * The form a flow's inputs make: a field per input, defaults filled in. An
 * array, an object, an input two steps type differently, or one with no type
 * is a text field whose value is read as JSON when it parses.
 */
export function flowFormFields(inputs: FlowInput[]): { fields: Record<string, FormField>; required: string[] } {
  const fields: Record<string, FormField> = {};
  for (const i of inputs) {
    const type = singleType(i);
    const read = (i.steps ?? []).map((s) => `${s.path} (${s.task})`);
    const steps = read.length ? `Read by ${read.length === 1 ? "step" : "steps"} ${read.join(", ")}.` : "";
    const conflict = i.conflict && Array.isArray(i.type) ? `Steps type it differently (${i.type.join(", ")}).` : "";
    const json = type === "array" || type === "object" ? "JSON." : "";
    const description = [i.description ?? "", json, conflict, steps].filter(Boolean).join(" ") || undefined;
    if (type === "boolean") {
      fields[i.name] = { type: "boolean", description, ...(typeof i.default === "boolean" ? { default: i.default } : {}) };
    } else if (type === "number" || type === "integer") {
      fields[i.name] = { type, description, ...(typeof i.default === "number" ? { default: i.default } : {}) };
    } else if (type === "string" && i.enum?.length) {
      const values = i.enum.map(String);
      fields[i.name] = { type: "string", description, enum: values, ...(i.default !== undefined ? { default: String(i.default) } : {}) };
    } else {
      const d = i.default === undefined ? undefined : typeof i.default === "string" ? i.default : JSON.stringify(i.default);
      fields[i.name] = { type: "string", description, ...(d !== undefined ? { default: d } : {}) };
    }
  }
  return { fields, required: inputs.filter((i) => i.required).map((i) => i.name) };
}

/**
 * A value typed as text, for an input of `type`: a number or boolean as
 * one, an array or object (or an input of no single type) as JSON when it
 * parses, otherwise the text.
 */
export function flowValue(raw: string, type: string | null): unknown {
  const t = raw.trim();
  if (type === "string") return raw;
  if (type === "number" || type === "integer") return t !== "" && Number.isFinite(Number(t)) ? Number(t) : raw;
  if (type === "boolean") return t === "true" ? true : t === "false" ? false : raw;
  if (/^(true|false|null)$/.test(t) || /^-?\d+(\.\d+)?$/.test(t) || /^[[{"]/.test(t)) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Words of a command's text, a quoted run kept as one: `a="b c" d` is ["a=b c", "d"]. */
function words(text: string): string[] {
  const out: string[] = [];
  const re = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  for (const m of text.matchAll(re)) out.push(m[0].replace(/"([^"]*)"|'([^']*)'/g, (_, a: string | undefined, b: string | undefined) => a ?? b ?? ""));
  return out;
}

/**
 * The text after /flow: the flow's name, then key=value pairs that prefill
 * its form. Words that are not a pair are kept in `rest`.
 */
export function parseFlowArgs(args: string): { name: string; values: Record<string, string>; rest: string[] } {
  const [name = "", ...more] = words(args.trim());
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (const w of more) {
    const eq = w.indexOf("=");
    if (eq > 0) values[w.slice(0, eq)] = w.slice(eq + 1);
    else rest.push(w);
  }
  return { name, values, rest };
}

/** key=value pairs, one per line or space apart, as the key=value field takes them. */
export function parsePairs(text: string): Record<string, string> {
  return parseFlowArgs(`_ ${text.replace(/\n/g, " ")}`).values;
}

/** The /flow message a run shows: the name and the params it was given. */
export function flowCommandText(name: string, params: Record<string, unknown>): string {
  const pairs = Object.entries(params).map(([k, v]) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}=${/\s/.test(s) || s === "" ? `"${s}"` : s}`;
  });
  return [`/flow ${name}`, ...pairs].join(" ");
}

/**
 * While the draft is /flow and the start of a flow's name: what of the name
 * is typed. Null once the name is followed by anything.
 */
export function flowNameQuery(draft: string): string | null {
  const m = /^\/flow\s+(\S*)$/.exec(draft);
  return m ? m[1] : null;
}

/** The flows whose names start with what was typed, then those that contain it. */
export function matchFlows<T extends { name: string }>(query: string, flows: readonly T[]): T[] {
  const q = query.toLowerCase();
  const starts = flows.filter((f) => f.name.toLowerCase().startsWith(q));
  const contains = flows.filter((f) => !f.name.toLowerCase().startsWith(q) && f.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/** The names closest to one that is not a flow: those that contain it or it contains first, then by edit distance. */
export function closestNames(name: string, names: readonly string[], count = 3): string[] {
  const n = name.toLowerCase();
  return names
    .map((x) => {
      const l = x.toLowerCase();
      return { x, score: l.includes(n) || n.includes(l) ? 0 : distance(n, l) };
    })
    .filter((c) => c.score <= Math.max(2, Math.ceil(n.length / 2)))
    .sort((a, b) => a.score - b.score || a.x.localeCompare(b.x))
    .slice(0, count)
    .map((c) => c.x);
}
