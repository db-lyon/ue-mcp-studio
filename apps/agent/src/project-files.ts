/**
 * The files a chat link may show: the project (and the repository it sits
 * in), the agents' own folders in the home folder, and any file the native
 * view lists. A path is checked as written and again after its symlinks
 * resolve, so a link inside the project cannot reach a file outside it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { FILE_READ_MAX_BYTES, FILE_SHOW_BYTES, type FileReadResponse } from "@ue-mcp-studio/shared";
import { repoRoot, shown } from "./native.js";

/** The agents' folders in the home folder that Studio reads. */
export const HOME_AGENT_DIRS = [".claude", ".codex", ".gemini", ".agents"];

export interface FileScope {
  projectDir: string;
  home: string;
  /** Absolute paths of the files the native view lists; they show wherever they are. */
  listed?: () => Set<string>;
}

export type Resolved = { ok: true; abs: string; real: string; shown: string } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): Resolved => ({ ok: false, status, error });

/** Whether `p` is `root` or inside it. */
function inside(root: string, p: string): boolean {
  const r = path.relative(root, p);
  return r === "" || (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** `~/` is the home folder; anything else resolves against `base`. */
function expand(p: string, base: string, home: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) return path.resolve(home, p.slice(2));
  return path.resolve(base, p);
}

/**
 * A requested path as an existing file in scope. Relative paths resolve
 * against the project, or against the folder of `from` (a file the viewer
 * shows) when a link inside it is followed. A skill's folder is its SKILL.md.
 */
export function resolveProjectFile(scope: FileScope, request: unknown, from?: unknown): Resolved {
  if (typeof request !== "string" || !request.trim()) return fail(400, "path is required");
  if (/[\0-\x1f]/.test(request) || (typeof from === "string" && /[\0-\x1f]/.test(from))) return fail(400, "path holds a control character");
  const { projectDir, home } = scope;
  const base = typeof from === "string" && from ? path.dirname(expand(from, projectDir, home)) : projectDir;
  let abs = expand(request, base, home);
  const listed = scope.listed?.() ?? new Set<string>();
  if (listed.has(path.join(abs, "SKILL.md"))) abs = path.join(abs, "SKILL.md");
  const roots = [projectDir, repoRoot(projectDir), ...HOME_AGENT_DIRS.map((d) => path.join(home, d))];
  const where = shown(projectDir, abs, home);
  const refused = fail(403, `Studio shows files in the project and in ${HOME_AGENT_DIRS.map((d) => `~/${d}`).join(", ")}, not ${where}.`);
  if (!listed.has(abs) && !roots.some((r) => inside(path.resolve(r), abs))) return refused;
  const real = realOrNull(abs);
  if (!real) return fail(404, `${where} does not exist.`);
  if (!listed.has(abs) && !roots.some((r) => { const rr = realOrNull(r); return rr !== null && inside(rr, real); })) return refused;
  return { ok: true, abs, real, shown: where };
}

/** A file in scope as the viewer shows it: refused when it is a folder, too large or not text. */
export function readProjectFile(scope: FileScope, request: unknown, from?: unknown): { status: number; body: FileReadResponse | { error: string } } {
  const r = resolveProjectFile(scope, request, from);
  if (!r.ok) return { status: r.status, body: { error: r.error } };
  const stat = fs.statSync(r.real);
  if (stat.isDirectory()) return { status: 400, body: { error: `${r.shown} is a folder.` } };
  if (stat.size > FILE_READ_MAX_BYTES) return { status: 413, body: { error: `${r.shown} is ${(stat.size / 1048576).toFixed(1)} MB; Studio shows files up to ${FILE_READ_MAX_BYTES / 1048576} MB.` } };
  const buf = fs.readFileSync(r.real);
  const text = decodeText(buf.subarray(0, FILE_SHOW_BYTES));
  if (text === null) return { status: 415, body: { error: `${r.shown} is not a text file.` } };
  return { status: 200, body: { path: r.shown, text, size: stat.size, ...(buf.length > FILE_SHOW_BYTES ? { truncated: true } : {}) } };
}

/** UTF-8, or UTF-16 with its byte order mark; null for bytes with a NUL in them, which no text file holds. */
function decodeText(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))).swap16().toString("utf16le");
  if (buf.includes(0)) return null;
  const text = buf.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
