/**
 * ue_mcp search and describe answers as the model is sent them.
 *
 * project(search_tools) and project(describe_action) with a category answer in
 * pretty-printed JSON with every action's full description and parameter
 * schema. The model needs where an action lives and what it does to choose
 * one, and reads one action's parameters with describe before calling it, so
 * a search goes out as one line per hit and a category as its action names.
 * Every later model call reads them again from the conversation.
 */

import { compactJson } from "./model-text.js";

/** The longest description a search or category line keeps. */
export const LINE_SUMMARY_CHARS = 80;

/** The parameter names a description lists after "Params:", as a signature's inside. */
export function paramList(description: string): string {
  const m = /Params?:\s*([\s\S]*)$/.exec(description);
  if (!m) return "";
  return m[1]
    .replace(/\s*\(#\d+(?:,\s*#\d+)*\)/g, "")
    .split(",")
    .map((p) => /^\s*([A-Za-z_][\w.]*\??)/.exec(p)?.[1])
    .filter((p): p is string => !!p && p.toLowerCase() !== "none")
    .join(", ");
}

/** A description's opening, without its parameter list or issue references. */
export function summary(description: string, max = LINE_SUMMARY_CHARS): string {
  const text = description
    .replace(/\s*Params?:[\s\S]*$/, "")
    .replace(/\s*\(#\d+(?:,\s*#\d+)*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 3).replace(/\s+\S*$/, "")}...`;
}

const parse = (text: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

interface SearchHit {
  tool: string;
  action: string;
  description?: string;
}

/** search_tools' answer as one line per hit; any other text as it came. */
export function compactSearch(text: string): string {
  const r = parse(text);
  const hits = r?.results;
  if (!Array.isArray(hits)) return text;
  const lines = (hits as SearchHit[])
    .filter((h) => typeof h?.tool === "string" && typeof h.action === "string")
    .map((h) => `${h.tool}.${h.action}(${paramList(h.description ?? "")}): ${summary(h.description ?? "")}`);
  if (lines.length === 0) return typeof r?.hint === "string" ? `No matches. ${r.hint}` : "No matches.";
  return [...lines, "Describe one (category + method) for its parameters before calling it."].join("\n");
}

/** One parameter, or one field of a parameter, as describe_action reports it. */
interface Field {
  type?: string;
  required?: boolean;
  description?: string;
  aliases?: unknown[];
  items?: Field;
  properties?: Record<string, Field>;
  variants?: Field[];
  enumValues?: unknown[];
  minimum?: number;
  maximum?: number;
  truncated?: boolean;
  discriminator?: string;
  [key: string]: unknown;
}

interface ActionSchema {
  tool: string;
  action: string;
  description?: string;
  class?: string;
  params: Array<Field & { name: string }>;
  alternatives?: Array<{ branches?: unknown[][]; required?: boolean }>;
  timeoutMs?: number;
  drift?: unknown[];
}

/** Options every call takes; the tool's own description says what select and omit do. */
const PER_CALL = new Set(["select", "omit", "timeoutMs"]);
/** What a field says that the rendering below already shows, or that the model has no use for. */
const SHOWN = new Set(["type", "required", "description", "name", "aliases", "items", "properties", "variants", "enumValues", "minimum", "maximum", "truncated", "discriminator", "sources", "alternativeGroup"]);

const oneLine = (s: string): string => s.replace(/\s*\(#\d+(?:[/,]\s*#?\d+)*\)/g, "").replace(/\s+/g, " ").trim();

/** A field's type, with what else constrains it. */
function fieldType(f: Field): string {
  const structured = (x: Field | undefined) => !!(x?.properties || x?.variants?.some((v) => v.properties));
  let t = f.type ?? "any";
  if (f.variants?.length && !f.variants.some((v) => v.properties)) t = f.variants.map(fieldType).join(" | ");
  else if (f.items && !structured(f.items) && !t.endsWith("[]")) t = t === "object" ? `{[key]: ${fieldType(f.items)}}` : `${fieldType(f.items)}[]`;
  const extra: string[] = [];
  if (f.enumValues?.length) extra.push(`one of ${f.enumValues.map((v) => String(v)).join("|")}`);
  if (f.minimum !== undefined || f.maximum !== undefined) extra.push(`${f.minimum ?? ""}..${f.maximum ?? ""}`);
  if (f.discriminator) extra.push(`variant picked by ${f.discriminator}`);
  if (f.truncated) extra.push("more fields than listed");
  for (const [k, v] of Object.entries(f)) if (!SHOWN.has(k) && v !== undefined) extra.push(`${k} ${JSON.stringify(v)}`);
  return extra.length ? `${t} (${extra.join("; ")})` : t;
}

/** A field as one line, then its own fields indented under it. */
function fieldLines(name: string, f: Field, indent: string, out: string[], depth = 0): void {
  const aliases = f.aliases?.length ? ` (or ${f.aliases.join(", ")})` : "";
  const desc = f.description ? ` - ${oneLine(f.description)}` : "";
  out.push(`${indent}- ${name}${f.required ? "" : "?"}${aliases}: ${fieldType(f)}${desc}`);
  if (depth > 6) return;
  const inner = f.items?.properties || f.items?.variants ? f.items : f;
  for (const [k, v] of Object.entries(inner.properties ?? {})) fieldLines(k, v, `${indent}  `, out, depth + 1);
  if (inner.variants?.some((v) => v.properties)) {
    inner.variants.forEach((v, i) => {
      out.push(`${indent}  variant ${i + 1}${v.description ? `: ${oneLine(v.description)}` : ""}`);
      for (const [k, x] of Object.entries(v.properties ?? {})) fieldLines(k, x, `${indent}    `, out, depth + 1);
    });
  }
}

const isSchema = (v: unknown): v is ActionSchema => {
  const s = v as ActionSchema;
  return !!s && typeof s.tool === "string" && typeof s.action === "string" && Array.isArray(s.params);
};

/**
 * One action's schema as a line per parameter: name, type, what it is for,
 * and its fields indented under it. Everything describe_action says about
 * a parameter stays except where ue-mcp's schema came from; the per-call
 * options, which every action takes, are named once at the end.
 */
export function schemaText(s: ActionSchema): string {
  const out = [`${s.tool}.${s.action}${s.class ? ` [${s.class}]` : ""}: ${oneLine(summary(s.description ?? "", Infinity))}`];
  const own = s.params.filter((p) => !PER_CALL.has(p.name));
  if (own.length === 0) out.push("No parameters.");
  for (const p of own) fieldLines(p.name, p, "", out);
  for (const a of s.alternatives ?? []) {
    const branches = (a.branches ?? []).map((b) => (Array.isArray(b) ? b.join(" + ") : String(b)));
    if (branches.length) out.push(`${a.required ? "Give one of" : "At most one of"}: ${branches.join(" | ")}`);
  }
  if (typeof s.timeoutMs === "number") out.push(`Waits up to ${s.timeoutMs} ms unless timeoutMs says otherwise.`);
  if (s.drift?.length) out.push(`drift: ${JSON.stringify(s.drift)}`);
  out.push("Every call also takes select?, omit? and timeoutMs?.");
  return out.join("\n");
}

/**
 * describe_action's answer for a whole category as its action names on one
 * line; one action's answer as unindented JSON. A category holds up to a few
 * hundred actions, and a line each with its parameters and purpose ran to
 * 19k to 27k characters for level and asset, carried through every later
 * call. The names say what there is; describe of one action says how to call
 * it, and the model describes an action before its first call anyway.
 */
export function compactDescribe(text: string): string {
  const r = parse(text);
  if (!r) return text;
  if (isSchema(r)) return schemaText(r);
  // A bare action name several categories provide: each one's schema.
  if (Array.isArray(r.matches) && r.matches.every(isSchema)) {
    return [typeof r.hint === "string" ? r.hint : `${r.matches.length} actions match.`, ...(r.matches as ActionSchema[]).map(schemaText)].join("\n\n");
  }
  // ue-mcp answers a category with signature lines.
  const names = Array.isArray(r.signatures) && r.signatures.every((x) => typeof x === "string")
    ? (r.signatures as string[]).map((s) => s.replace(/\(.*$/s, "").trim())
    : null;
  if (!names) return compactJson(text);
  const category = String(r.category ?? r.tool ?? "");
  const total = typeof r.count === "number" && r.count > names.length ? ` of ${r.count}` : "";
  return `${category}: ${names.length} actions${total}. Describe one (category + method) for its parameters, or search by intent.\n${names.join(", ")}`;
}
