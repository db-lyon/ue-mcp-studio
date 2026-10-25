/**
 * ue_mcp search and describe answers as the model is sent them.
 *
 * project(search_tools) and project(describe_action) with a category answer in
 * pretty-printed JSON with every action's full description and parameter
 * schema. The model needs where an action lives and what it does to choose
 * one, and reads one action's parameters with describe before calling it, so
 * those two answers go out as one line per action. Every later model call
 * reads them again from the conversation.
 */

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

interface ParamLine {
  name: string;
  required?: boolean;
}

interface ActionLine {
  tool: string;
  action: string;
  description?: string;
  class?: string;
  params?: ParamLine[];
}

/** describe_action's answer for a whole category as one line per action; one action's answer as it came. */
export function compactDescribe(text: string): string {
  const r = parse(text);
  if (!r) return text;
  const footer = "Describe one (category + method) for its full parameters.";
  // ue-mcp from 1.4.11 answers a category with signature lines already: drop only the JSON around them.
  if (Array.isArray(r.signatures) && r.signatures.every((x) => typeof x === "string")) {
    const sigs = r.signatures as string[];
    return [`${String(r.category ?? r.tool ?? "")}: ${sigs.length} actions${typeof r.count === "number" && r.count > sigs.length ? ` of ${r.count}` : ""}. ${footer}`, ...sigs].join("\n");
  }
  if (!Array.isArray(r.actions)) return text;
  const lines = (r.actions as ActionLine[]).map((a) => {
    const params = (a.params ?? []).map((p) => `${p.name}${p.required ? "" : "?"}`).join(", ");
    const kind = a.class === "read" ? "" : ` [${a.class ?? "mutate"}]`;
    return `${a.action}(${params})${kind}: ${summary(a.description ?? "", 100)}`;
  });
  return [`${String(r.tool)}: ${lines.length} actions. ${footer}`, ...lines].join("\n");
}
