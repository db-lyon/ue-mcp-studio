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

interface ActionLine {
  action: string;
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
  // ue-mcp from 1.4.11 answers a category with signature lines, earlier ones with a schema per action.
  const names = Array.isArray(r.signatures) && r.signatures.every((x) => typeof x === "string")
    ? (r.signatures as string[]).map((s) => s.replace(/\(.*$/s, "").trim())
    : Array.isArray(r.actions)
      ? (r.actions as ActionLine[]).map((a) => a.action).filter((a) => typeof a === "string")
      : null;
  if (!names) return compactJson(text);
  const category = String(r.category ?? r.tool ?? "");
  const total = typeof r.count === "number" && r.count > names.length ? ` of ${r.count}` : "";
  return `${category}: ${names.length} actions${total}. Describe one (category + method) for its parameters, or search by intent.\n${names.join(", ")}`;
}
