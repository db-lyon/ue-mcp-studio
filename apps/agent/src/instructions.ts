/**
 * Helpers for the instruction text an agent is given: the composed result,
 * and the files that join a conversation once the agent works where they
 * apply. Which files a route reads is each vendor's own convention (native.ts).
 */
import * as os from "node:os";
import * as path from "node:path";
import type { InstructionScope } from "@ue-mcp-studio/shared";

/** Approximate tokens of a text: four characters each. */
export const tokensOf = (text: string): number => Math.ceil(text.length / 4);

/** The home folder the user's own files are read from; tests point it elsewhere. */
export const userHome = (): string => process.env.STUDIO_USER_HOME || os.homedir();

/** What an agent is given from the project's own files. */
export interface Composed {
  /** The files read on every call, as a prompt section, or null when there are none. */
  text: string | null;
  tokens: number;
  files: number;
  /** Files that join once the agent works in a folder or touches a matching file. */
  conditional: Array<{ path: string; scope: InstructionScope; body: string }>;
}

export const NOTHING: Composed = { text: null, tokens: 0, files: 0, conditional: [] };

const slash = (p: string): string => p.replace(/\\/g, "/");

/** A glob as a regular expression: ** any depth, * one segment, ? one character. */
export function globRegex(glob: string): RegExp {
  let re = "";
  const g = slash(glob.trim()).replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      re += ".*";
      i++;
      if (g[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A glob without a folder matches the name anywhere, as editors read them.
  return new RegExp(g.includes("/") ? `^${re}$` : `(^|/)${re}$`, "i");
}

/** Whether a scoped file applies to a project path (relative, forward slashes). */
export function applies(scope: InstructionScope, rel: string): boolean {
  if (scope.kind === "always") return true;
  if (scope.kind === "folder") return rel === scope.folder || rel.startsWith(`${scope.folder}/`);
  return scope.globs.some((g) => globRegex(g).test(rel));
}

/**
 * The project paths a tool call works on: a file tool's path, a search's
 * folder, and the Content files of the /Game assets an editor call names.
 */
export function pathsOf(projectDir: string, name: string, input: Record<string, unknown>): string[] {
  const rel = (p: string): string | null => {
    const r = slash(path.relative(projectDir, path.resolve(projectDir, p)));
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : null;
  };
  const out: string[] = [];
  if ((name === "read_file" || name === "write_file" || name === "edit_file") && typeof input.path === "string") out.push(input.path);
  if ((name === "glob" || name === "grep") && typeof input.path === "string") out.push(input.path);
  if (name === "glob" && typeof input.pattern === "string") {
    const dir = input.pattern.split(/[*?[]/)[0];
    if (dir.includes("/")) out.push(dir.replace(/\/+$/, ""));
  }
  const visit = (v: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof v === "string" && /^\/Game\//.test(v)) out.push(`Content/${v.slice(6).split(".")[0]}.uasset`);
    else if (Array.isArray(v)) v.slice(0, 50).forEach((x) => visit(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).slice(0, 50).forEach((x) => visit(x, depth + 1));
  };
  if (name === "ue_mcp") visit(input.args ?? input, 0);
  return out.flatMap((p) => {
    const r = rel(p);
    return r ? [r] : [];
  });
}

/**
 * The scoped files a call brings in, each once per conversation, as the text
 * added to its result. `sent` holds the paths a conversation already has.
 */
export function conditionalFor(c: Composed, paths: string[], sent: Set<string>): string | null {
  const due = c.conditional.filter((f) => !sent.has(f.path) && paths.some((p) => applies(f.scope, p)));
  if (due.length === 0) return null;
  for (const f of due) sent.add(f.path);
  return due.map((f) => `[Studio] Instructions from ${f.path} apply to this work${f.scope.kind === "folder" ? ` in ${f.scope.folder}` : ""}:\n${f.body}`).join("\n\n");
}
