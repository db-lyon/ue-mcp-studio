/**
 * Editor results as the model is given them.
 *
 * Every result stays in the conversation and is read again by every later
 * model call, so its size is paid for many times over. The transcript keeps
 * what ue-mcp answered; the model gets the same content in fewer tokens.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The most of one editor result the conversation keeps; the rest is saved to a file the model can read. */
export const RESULT_KEEP_CHARS = 12_000;
/** How long a saved result is kept for a session that comes back to it. */
export const SAVED_RESULT_DAYS = 7;
/** The longest string a cut-down result keeps whole. */
const LONG_STRING_CHARS = 400;

/**
 * A JSON answer without its indentation: ue-mcp answers pretty-printed, and
 * the model reads the same content in a quarter fewer tokens without the
 * whitespace. Anything that is not JSON comes back as it came.
 */
export function compactJson(text: string): string {
  if (!text.includes("\n")) return text;
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return text;
  try {
    return JSON.stringify(JSON.parse(t));
  } catch {
    return text;
  }
}

const more = (left: number, total: number): string => `... ${left} more of ${total}`;

/**
 * A JSON value cut down to about `max` characters, keeping its shape: the
 * largest arrays keep their first items and end with how many more there
 * were, then over-long strings keep their start. Every field stays, so
 * counts and flags after a long list still reach the model.
 */
export function shrinkJson(value: unknown, max: number): string {
  const keep = new Map<unknown[], number>();
  let strings = Infinity;
  const render = (v: unknown): unknown => {
    if (typeof v === "string") return v.length > strings ? `${v.slice(0, strings)}... (${v.length} chars)` : v;
    if (Array.isArray(v)) {
      const n = keep.get(v) ?? v.length;
      const items = v.slice(0, n).map(render);
      return n < v.length ? [...items, more(v.length - n, v.length)] : items;
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, render(x)]));
    return v;
  };
  /** The rendered length of v, and of every array in it that can still lose items. */
  const sizes = new Map<unknown[], number>();
  const measure = (v: unknown): number => {
    if (Array.isArray(v)) {
      const n = keep.get(v) ?? v.length;
      let len = 2 + Math.max(0, n - 1);
      for (let i = 0; i < n; i++) len += measure(v[i]);
      if (n < v.length) len += 3 + more(v.length - n, v.length).length;
      if (n > 1) sizes.set(v, len);
      return len;
    }
    if (v && typeof v === "object") {
      const entries = Object.entries(v);
      let len = 2 + Math.max(0, entries.length - 1);
      for (const [k, x] of entries) len += JSON.stringify(k).length + 1 + measure(x);
      return len;
    }
    return JSON.stringify(render(v))?.length ?? 4;
  };
  let out = JSON.stringify(render(value));
  for (let round = 0; out.length > max && round < 200; round++) {
    // Shorten the array that costs the most, among those with more than one item left, by about what is over.
    sizes.clear();
    measure(value);
    let worst: unknown[] | null = null;
    let worstSize = 0;
    for (const [a, s] of sizes) if (s > worstSize) [worst, worstSize] = [a, s];
    if (!worst) break;
    const n = keep.get(worst) ?? worst.length;
    const fits = Math.floor(n * (1 - (out.length - max) / worstSize));
    keep.set(worst, Math.max(1, Math.min(n - 1, fits)));
    out = JSON.stringify(render(value));
  }
  if (out.length > max) {
    strings = LONG_STRING_CHARS;
    out = JSON.stringify(render(value));
  }
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

/**
 * A result for the conversation: whole when it is small, else cut down to
 * `max` with a note saying where the whole of it was saved, so the model
 * reads on with read_file or asks again with select or omit instead of
 * carrying all of it through every later call.
 */
export function keepForModel(text: string, save: () => string | null, max = RESULT_KEEP_CHARS): string {
  if (text.length <= max) return text;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const head = value !== null && typeof value === "object" ? shrinkJson(value, max) : `${text.slice(0, max)}...`;
  const file = save();
  const where = file
    ? `The whole result is saved in ${file}: read_file it with offset and limit for what was left out, or call again`
    : "Call again";
  return `${head}\n[Studio] This result is ${text.length} characters, so it was cut to ${max}: lists end with how many items were left out. ${where} with select or omit to get only the fields you need.`;
}

/**
 * Save a result whole under the data folder, indented so read_file can page
 * it by lines; results older than SAVED_RESULT_DAYS go. The file's path, or
 * null when it could not be written.
 */
export function saveResult(dataDir: string, name: string, text: string, now = Date.now()): string | null {
  const dir = path.join(dataDir, "results");
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (now - fs.statSync(p).mtimeMs > SAVED_RESULT_DAYS * 24 * 60 * 60 * 1000) fs.rmSync(p, { force: true });
      } catch {
        // Gone already, or in use: the next save tries again.
      }
    }
    let body = text;
    try {
      body = JSON.stringify(JSON.parse(text), null, 1);
    } catch {
      // Not JSON: saved as it came.
    }
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${name.replace(/[^\w.-]+/g, "_")}-${Math.random().toString(36).slice(2, 6)}.json`);
    fs.writeFileSync(file, body);
    return file;
  } catch {
    return null;
  }
}
