/**
 * /action <category.method>: run one ue-mcp action from the chat, without the
 * model. The composer completes the name from the agent's
 * GET /v1/ext/studio/actions, the action's parameters
 * (GET /v1/ext/studio/actions/<name>, ue-mcp's project(describe_action))
 * become a form, and POST /v1/ext/studio/sessions/:id/action runs it as a
 * ue_mcp call the session's approval rules apply to.
 */
import type { FormField } from "./index.js";
import { flowValue } from "./flows.js";

/** One action of the catalog: `category.method`, what it does in a line, and what ue-mcp says it does to the editor. */
export interface ActionListing {
  name: string;
  category: string;
  method: string;
  summary?: string;
  /** ue-mcp's effect class: read, mutate, or unknown. */
  effect?: string;
  destructive?: boolean;
}

/** A parameter, or a field of one, as ue-mcp's describe_action reports it. */
export interface ActionValue {
  type?: string;
  required?: boolean;
  description?: string;
  enumValues?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, ActionValue>;
  items?: ActionValue;
  variants?: ActionValue[];
}

export interface ActionParam extends ActionValue {
  name: string;
  aliases?: string[];
  /** Index into the action's alternatives when the parameter is one of a choice. */
  alternativeGroup?: number;
}

/** One action's parameters, as describe_action reports them. */
export interface ActionDescription {
  tool: string;
  action: string;
  description?: string;
  /** read, mutate or unknown. */
  class?: string;
  params: ActionParam[];
  alternatives?: Array<{ branches: string[][]; required: boolean }>;
}

/** POST /v1/ext/studio/sessions/:id/action: run an action in the session. `text` is the message the chat shows. */
export interface ActionRunRequest {
  category: string;
  method: string;
  args: Record<string, unknown>;
  text?: string;
}

/** The most rows the /action menu shows at once: past it the user types more of the name. */
export const ACTION_MENU_ROWS = 50;

/** `category.method` as its parts, or null when it is not one. */
export function splitActionName(name: string): { category: string; method: string } | null {
  const m = /^([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)$/.exec(name.trim());
  return m ? { category: m[1], method: m[2] } : null;
}

/**
 * While the draft is /action and the start of an action's name: what of the
 * name is typed. Null once the name is followed by anything.
 */
export function actionNameQuery(draft: string): string | null {
  const m = /^\/action\s+(\S*)$/.exec(draft);
  return m ? m[1] : null;
}

/**
 * The actions whose names match what was typed, best first: the name itself,
 * the full name starting with it, then the method starting with it, then the name holding
 * it. A query with a dot or underscore in it matches the name as written;
 * words split by them must each appear otherwise. At most `limit`.
 */
export function matchActions<T extends { name: string; method?: string }>(query: string, actions: readonly T[], limit = ACTION_MENU_ROWS): T[] {
  const q = query.toLowerCase();
  if (!q) return actions.slice(0, limit);
  const tiers: T[][] = [[], [], [], [], []];
  const parts = q.split(/[._]+/).filter(Boolean);
  for (const a of actions) {
    const name = a.name.toLowerCase();
    const method = (a.method ?? name.slice(name.indexOf(".") + 1)).toLowerCase();
    if (name === q) tiers[0].push(a);
    else if (name.startsWith(q)) tiers[1].push(a);
    else if (method.startsWith(q)) tiers[2].push(a);
    else if (name.includes(q)) tiers[3].push(a);
    else if (parts.length > 1 && parts.every((p) => name.includes(p))) tiers[4].push(a);
  }
  const out: T[] = [];
  for (const t of tiers) {
    for (const a of t) {
      if (out.length >= limit) return out;
      out.push(a);
    }
  }
  return out;
}

/** describe_action's types a text field reads as JSON. */
const JSON_TYPES = new Set(["object", "array", "any", "union", "tuple", "record"]);

/** A parameter's form type: the one it reads as, or null for text read as JSON. */
function formType(p: ActionValue): "string" | "number" | "integer" | "boolean" | "enum" | null {
  const t = p.type ?? "any";
  if (p.enumValues?.length) return "enum";
  if (t === "string" || t === "number" || t === "integer" || t === "boolean") return t;
  if (t === "literal" || t === "enum") return "enum";
  if (t.endsWith("[]") || JSON_TYPES.has(t)) return null;
  return null;
}

/** A value's shape in a line, for a parameter typed as JSON. */
function shape(v: ActionValue, depth = 0): string {
  if (v.properties && depth < 2) return `{${Object.entries(v.properties).map(([k, f]) => `${k}${f.required ? "" : "?"}: ${shape(f, depth + 1)}`).join(", ")}}`;
  if (v.items) return `${shape(v.items, depth + 1)}[]`;
  if (v.variants?.length && depth < 2) return v.variants.map((x) => shape(x, depth + 1)).join(" | ");
  return v.type ?? "any";
}

/** The text a value is shown as in a text field: a string as it is, anything else as JSON. */
const asText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** The value read for a parameter: its form type, then JSON where the type is open. */
export function actionValue(raw: string, param: ActionValue | undefined): unknown {
  const t = param ? formType(param) : null;
  if (t === "enum" || t === "string") return raw;
  return flowValue(raw, param ? t : null);
}

/** What a choice of parameters says on each member: which others it is instead of. */
function choiceNote(d: ActionDescription, p: ActionParam): string {
  if (p.alternativeGroup === undefined) return "";
  const g = d.alternatives?.[p.alternativeGroup];
  if (!g) return "";
  const others = g.branches.map((b) => b.join(" + ")).filter((b) => b !== p.name);
  return others.length ? `${g.required ? "Give this or" : "Or"} ${others.join(" or ")}.` : "";
}

/**
 * The form an action's parameters make: a field per parameter, required ones
 * first. Numbers, booleans and enums get their control; an optional boolean
 * or enum with no default starts as Not set, so the action's own default
 * holds. Objects, arrays and open types are text read as JSON.
 */
export function actionFormFields(d: ActionDescription): { fields: Record<string, FormField>; required: string[] } {
  const fields: Record<string, FormField> = {};
  const ordered = [...d.params].sort((a, b) => Number(!!b.required) - Number(!!a.required));
  for (const p of ordered) {
    const t = formType(p);
    const aliases = p.aliases?.length ? `Also ${p.aliases.join(", ")}.` : "";
    const json = t === null ? `JSON: ${shape(p)}.` : "";
    const range = p.minimum !== undefined || p.maximum !== undefined ? `Range ${p.minimum ?? ""}..${p.maximum ?? ""}.` : "";
    const description = [p.description ?? "", json, range, choiceNote(d, p), aliases].filter(Boolean).join(" ") || undefined;
    const unset = !p.required && p.default === undefined;
    if (t === "boolean") {
      fields[p.name] = unset
        ? { type: "string", description, enum: ["", "true", "false"], enumNames: ["Not set", "true", "false"] }
        : { type: "boolean", description, ...(typeof p.default === "boolean" ? { default: p.default } : {}) };
    } else if (t === "number" || t === "integer") {
      fields[p.name] = { type: t, description, ...(typeof p.default === "number" ? { default: p.default } : {}) };
    } else if (t === "enum" && p.enumValues?.length) {
      const values = p.enumValues.map(String);
      fields[p.name] = {
        type: "string",
        description,
        enum: unset ? ["", ...values] : values,
        ...(unset ? { enumNames: ["Not set", ...values] } : {}),
        ...(p.default !== undefined ? { default: String(p.default) } : {}),
      };
    } else {
      fields[p.name] = { type: "string", description, ...(p.default !== undefined ? { default: asText(p.default) } : {}) };
    }
  }
  return { fields, required: ordered.filter((p) => p.required).map((p) => p.name) };
}

/** A pair typed after the name, as the value its field starts with. */
export function actionPrefill(raw: string, field: FormField | undefined): unknown {
  if (field?.type === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  return raw;
}

/**
 * The action's args from the form: each value read as its parameter's type,
 * blanks left out. Pairs typed for no parameter go too, read as JSON when
 * they parse.
 */
export function actionArgs(d: ActionDescription, content: Record<string, unknown>, typed: Record<string, string> = {}): Record<string, unknown> {
  const byName = new Map(d.params.map((p) => [p.name, p]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(typed)) if (!byName.has(k)) out[k] = flowValue(v, null);
  for (const [k, v] of Object.entries(content)) {
    if (v === "") continue;
    const p = byName.get(k);
    out[k] = typeof v === "string" && p ? actionValue(v, p) : v;
  }
  return out;
}

/**
 * The text after /action: the action's name, then key=value pairs that
 * prefill its form. A value wrapped whole in quotes loses them, so
 * `label="Key Light"` and `location='{"x": 0}'` keep their spaces; quotes
 * inside a value stay, so `location={"x":0}` is JSON as typed. Words that are
 * not a pair are kept in `rest`.
 */
export function parseActionArgs(args: string): { name: string; values: Record<string, string>; rest: string[] } {
  const words = [...args.trim().matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)].map((m) => m[0]);
  const unquote = (v: string) => (/^"[^"]*"$|^'[^']*'$/.test(v) ? v.slice(1, -1) : v);
  const [name = "", ...more] = words;
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (const w of more) {
    const eq = w.indexOf("=");
    if (eq > 0) values[w.slice(0, eq)] = unquote(w.slice(eq + 1));
    else rest.push(unquote(w));
  }
  return { name: unquote(name), values, rest };
}

/** The /action message a run shows: the name and the args it was given, as parseActionArgs reads them back. */
export function actionCommandText(category: string, method: string, args: Record<string, unknown>): string {
  const pairs = Object.entries(args).map(([k, v]) => {
    const s = asText(v);
    if (s !== "" && !/\s/.test(s) && !/^"[^"]*"$|^'[^']*'$/.test(s)) return `${k}=${s}`;
    return `${k}=${s.includes('"') && !s.includes("'") ? `'${s}'` : `"${s}"`}`;
  });
  return [`/action ${category}.${method}`, ...pairs].join(" ");
}
