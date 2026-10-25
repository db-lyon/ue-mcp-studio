/**
 * The project's instruction files, every common convention, read in one
 * order and given to every agent the same way on every route.
 *
 * Order (later wins where files disagree): the user's own Studio file,
 * .github/copilot-instructions.md, .cursor/rules/*.mdc and .cursorrules,
 * GEMINI.md, CLAUDE.md and .claude/CLAUDE.md, AGENTS.md, the same names in
 * subfolders (read once the agent works there), then AGENTS.local.md and
 * CLAUDE.local.md. Files the user adds go where they put them.
 *
 * A file with the same text as a later one, or one that only imports another
 * (`@AGENTS.md`), is included once, as the later file. `@path` imports in
 * CLAUDE.md and GEMINI.md are followed one level.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseDocument } from "yaml";
import type { InstructionConvention, InstructionFile, InstructionScope, InstructionSettings, InstructionsPreview, InstructionsView } from "@ue-mcp-studio/shared";

/** The most of the always-read text that goes into a prompt. */
export const MAX_INSTRUCTION_CHARS = 40_000;
/** How deep subfolders are searched for their own instruction files. */
const NESTED_DEPTH = 4;
/** Folders that hold Unreal's generated files, packages or version control: never searched. */
const SKIP = new Set([".git", ".svn", ".vs", ".vscode", ".idea", "node_modules", "Binaries", "Intermediate", "Saved", "DerivedDataCache", "Content", "Build", ".ue-mcp", ".claude", ".cursor", ".github"]);
const NESTED_NAMES = ["GEMINI.md", "CLAUDE.md", "AGENTS.md"];

export const RECOGNISED = [
  "~/.ue-mcp/studio/instructions.md",
  ".github/copilot-instructions.md",
  ".cursor/rules/*.mdc",
  ".cursorrules",
  "GEMINI.md",
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "AGENTS.md",
  "the same names in subfolders",
  "AGENTS.local.md",
  "CLAUDE.local.md",
];

export const USER_FILE = "~/.ue-mcp/studio/instructions.md";

/** Approximate tokens of a text: four characters each. */
export const tokensOf = (text: string): number => Math.ceil(text.length / 4);

/** The home Studio reads the user's own file from; tests point it elsewhere. */
export const userHome = (): string => process.env.STUDIO_USER_HOME || os.homedir();

interface Found {
  path: string;
  abs: string;
  convention: InstructionConvention;
  scope: InstructionScope;
  /** What the file adds, frontmatter removed. */
  text: string;
  imports: string[];
  missing?: boolean;
}

const slash = (p: string): string => p.replace(/\\/g, "/");

function read(abs: string): string | null {
  try {
    return fs.statSync(abs).isFile() ? fs.readFileSync(abs, "utf-8").replace(/\r\n/g, "\n") : null;
  } catch {
    return null;
  }
}

/** A path as stored and shown: relative to the project, or ~/ under the home folder, else absolute. */
export function displayPath(projectDir: string, abs: string, home = userHome()): string {
  const rel = path.relative(projectDir, abs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return slash(rel);
  const fromHome = path.relative(home, abs);
  if (fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) return `~/${slash(fromHome)}`;
  return slash(abs);
}

export function resolveDisplay(projectDir: string, p: string, home = userHome()): string {
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return path.isAbsolute(p) ? p : path.join(projectDir, p);
}

/** A .mdc rule: its body, and when it applies. Globs say for which files; alwaysApply or no globs, always. */
export function cursorRule(text: string): { body: string; scope: InstructionScope } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { body: text, scope: { kind: "always" } };
  let front: Record<string, unknown> = {};
  try {
    front = (parseDocument(m[1]).toJS() as Record<string, unknown>) ?? {};
  } catch {
    // A rule with frontmatter Studio cannot read applies always.
  }
  const body = text.slice(m[0].length);
  const raw = front.globs;
  const globs = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [])
    .map((g) => String(g).trim())
    .filter(Boolean);
  if (front.alwaysApply === true || globs.length === 0) return { body, scope: { kind: "always" } };
  return { body, scope: { kind: "globs", globs } };
}

/** `@path` imports outside code: whole words that start with @ and name a file. */
export function importsIn(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    for (const m of line.replace(/`[^`]*`/g, "").matchAll(/(?:^|\s)@([~./\w-][^\s]*)/g)) {
      const name = m[1].replace(/[.,;:)\]]+$/, "");
      if (/\.[a-z]+$/i.test(name) || name.startsWith("~/")) out.push(name);
    }
  }
  return [...new Set(out)];
}

/** The text with its import lines taken out, to tell whether a file only imports. */
const withoutImports = (text: string, imports: string[]): string =>
  imports.reduce((t, i) => t.split(`@${i}`).join(""), text).trim();

function nested(projectDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > NESTED_DEPTH || out.length > 200) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth > 0) for (const n of NESTED_NAMES) if (entries.some((e) => e.isFile() && e.name === n)) out.push(path.join(dir, n));
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(projectDir, 0);
  return out;
}

/** Every instruction file present, in reading order, with the user's added files placed where they put them. */
export function discover(projectDir: string, settings: InstructionSettings, home = userHome()): Found[] {
  const found: Found[] = [];
  const add = (abs: string, convention: InstructionConvention, scope: InstructionScope = { kind: "always" }): void => {
    const raw = read(abs);
    if (raw === null) return;
    let text = raw;
    if (abs.endsWith(".mdc")) {
      const rule = cursorRule(raw);
      text = rule.body;
      scope = rule.scope;
    }
    const imports = convention === "claude" || convention === "gemini" || convention === "local" || (convention === "nested" && !abs.endsWith("AGENTS.md")) ? importsIn(text) : [];
    found.push({ path: displayPath(projectDir, abs, home), abs, convention, scope, text, imports });
  };
  add(path.join(home, ".ue-mcp", "studio", "instructions.md"), "studio");
  add(path.join(projectDir, ".github", "copilot-instructions.md"), "copilot");
  try {
    for (const f of fs.readdirSync(path.join(projectDir, ".cursor", "rules")).filter((n) => n.endsWith(".mdc")).sort()) add(path.join(projectDir, ".cursor", "rules", f), "cursor");
  } catch {
    // No rules folder.
  }
  add(path.join(projectDir, ".cursorrules"), "cursor");
  add(path.join(projectDir, "GEMINI.md"), "gemini");
  add(path.join(projectDir, "CLAUDE.md"), "claude");
  add(path.join(projectDir, ".claude", "CLAUDE.md"), "claude");
  add(path.join(projectDir, "AGENTS.md"), "agents");
  for (const abs of nested(projectDir)) add(abs, "nested", { kind: "folder", folder: slash(path.relative(projectDir, path.dirname(abs))) });
  add(path.join(projectDir, "AGENTS.local.md"), "local");
  add(path.join(projectDir, "CLAUDE.local.md"), "local");

  for (const a of settings.added) {
    const abs = resolveDisplay(projectDir, a.path, home);
    if (found.some((f) => path.resolve(f.abs) === path.resolve(abs))) continue;
    const text = read(abs);
    const entry: Found = { path: a.path, abs, convention: "added", scope: { kind: "always" }, text: text ?? "", imports: [], ...(text === null ? { missing: true } : {}) };
    const at = a.after === null ? -1 : found.findIndex((f) => f.path === a.after);
    if (a.after !== null && at < 0) found.push(entry);
    else found.splice(at + 1, 0, entry);
  }
  return found;
}

interface Resolved extends Found {
  sameAs?: string;
  /** The text this file contributes, imports followed. */
  body: string;
}

/** Duplicates and import-only files folded into the later file they repeat; imports of files outside the list inlined. */
function resolve(projectDir: string, files: Found[], home: string): Resolved[] {
  const out: Resolved[] = files.map((f) => ({ ...f, body: f.text.trim() }));
  for (const f of out) {
    if (!f.imports.length) continue;
    const rest = withoutImports(f.text, f.imports);
    const targets = f.imports.map((i) => {
      const abs = i.startsWith("~/") ? path.join(home, i.slice(2)) : path.resolve(path.dirname(f.abs), i);
      return { i, abs, listed: out.find((x) => path.resolve(x.abs) === path.resolve(abs)) };
    });
    if (!rest && targets.length === 1 && targets[0].listed) {
      f.sameAs = targets[0].listed.path;
      f.body = "";
      continue;
    }
    // Imports of files not in the list are read here, one level; listed ones are read at their own place.
    let body = f.text;
    for (const t of targets) {
      if (t.listed) {
        body = body.split(`@${t.i}`).join(`(see ${t.listed.path})`);
        continue;
      }
      const text = read(t.abs);
      body = body.split(`@${t.i}`).join(text === null ? `@${t.i}` : `\n${text.trim()}\n`);
    }
    f.body = body.trim();
  }
  // The same text twice: keep the later copy, which is the one that wins.
  for (let i = 0; i < out.length; i++) {
    if (out[i].sameAs || !out[i].body) continue;
    const later = out.slice(i + 1).find((x) => !x.sameAs && x.body === out[i].body);
    if (later) {
      out[i].sameAs = later.path;
      out[i].body = "";
    }
  }
  void projectDir;
  return out;
}

/** GET /instructions */
export function instructionsView(projectDir: string, settings: InstructionSettings, readBy?: (file: InstructionFile) => string[], home = userHome()): InstructionsView {
  const resolved = resolve(projectDir, discover(projectDir, settings, home), home);
  const off = new Set(settings.off);
  const files: InstructionFile[] = resolved.map((f, i) => {
    const file: InstructionFile = {
      path: f.path,
      convention: f.convention,
      order: i + 1,
      tokens: f.sameAs ? 0 : tokensOf(f.body),
      on: !off.has(f.path),
      scope: f.scope,
      ...(f.sameAs ? { sameAs: f.sameAs } : {}),
      ...(f.imports.length ? { imports: f.imports } : {}),
      ...(f.missing ? { missing: true } : {}),
    };
    if (readBy) file.readBy = readBy(file);
    return file;
  });
  return {
    files,
    alwaysTokens: files.filter((f) => f.on && f.scope.kind === "always").reduce((n, f) => n + f.tokens, 0),
    hasAgentsMd: fs.existsSync(path.join(projectDir, "AGENTS.md")),
    recognised: RECOGNISED,
  };
}

/** Which files an agent reads: all that are on, none, or the ones it names. */
export type FileChoice = "all" | "none" | { only: string[] };

const chosen = (choice: FileChoice, p: string): boolean => choice === "all" || (choice !== "none" && choice.only.includes(p));

const heading = (f: Resolved): string => {
  const when = f.scope.kind === "globs" ? ` (for ${f.scope.globs.join(", ")})` : f.scope.kind === "folder" ? ` (in ${f.scope.folder})` : "";
  return `## From ${f.path}${when}`;
};

export interface Composed {
  /** The always-read part, as a prompt section, or null when there is none. */
  text: string | null;
  tokens: number;
  files: number;
  /** Files that join once the agent works in a folder or touches a matching file. */
  conditional: Array<{ path: string; scope: InstructionScope; body: string }>;
}

/** The instructions an agent is given, composed the same way for every route and vendor. */
export function compose(projectDir: string, settings: InstructionSettings, choice: FileChoice = "all", home = userHome()): Composed {
  if (choice === "none") return { text: null, tokens: 0, files: 0, conditional: [] };
  const off = new Set(settings.off);
  const resolved = resolve(projectDir, discover(projectDir, settings, home), home).filter((f) => !off.has(f.path) && chosen(choice, f.path) && !f.sameAs && f.body && !f.missing);
  const always = resolved.filter((f) => f.scope.kind === "always");
  const conditional = resolved.filter((f) => f.scope.kind !== "always").map((f) => ({ path: f.path, scope: f.scope, body: f.body }));
  if (always.length === 0) return { text: null, tokens: 0, files: 0, conditional };
  let body = always.map((f) => `${heading(f)}\n${f.body}`).join("\n\n");
  if (body.length > MAX_INSTRUCTION_CHARS) body = `${body.slice(0, MAX_INSTRUCTION_CHARS)}\n(the rest is left out)`;
  const text = `The project's own instructions for agents follow, from ${always.length} file${always.length === 1 ? "" : "s"} in the order they are read. Follow them where they apply to the task. Where two disagree, the later file wins.\n\n${body}`;
  return { text, tokens: tokensOf(text), files: always.length, conditional };
}

export function preview(projectDir: string, settings: InstructionSettings, agent: string | null, choice: FileChoice = "all", home = userHome()): InstructionsPreview {
  const c = compose(projectDir, settings, choice, home);
  return {
    agent,
    text: c.text ?? "",
    tokens: c.tokens,
    files: c.files,
    conditional: c.conditional.map((x) => ({ path: x.path, scope: x.scope, tokens: tokensOf(x.body) })),
  };
}

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

/** Whether a conditional file applies to a project path (relative, forward slashes). */
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
  if (name === "ue_mcp" || name.includes(".")) visit(input.args ?? input, 0);
  return out.flatMap((p) => {
    const r = rel(p);
    return r ? [r] : [];
  });
}

/**
 * The conditional files a call brings in, each once per conversation, as the
 * text added to its result. `sent` holds the paths a conversation already has.
 */
export function conditionalFor(c: Composed, paths: string[], sent: Set<string>): string | null {
  const due = c.conditional.filter((f) => !sent.has(f.path) && paths.some((p) => applies(f.scope, p)));
  if (due.length === 0) return null;
  for (const f of due) sent.add(f.path);
  return due.map((f) => `[Studio] Instructions from ${f.path} apply to this work${f.scope.kind === "folder" ? ` in ${f.scope.folder}` : ""}:\n${f.body}`).join("\n\n");
}

/** Files whose content can be moved into AGENTS.md and replaced with an import. */
export const IMPORTING = ["CLAUDE.md", ".claude/CLAUDE.md", "GEMINI.md"];

/**
 * Create AGENTS.md, prefilled with what the project's other shared files say.
 * `point`: those of CLAUDE.md and GEMINI.md whose text moved in now import it,
 * so nothing is read twice. Throws when AGENTS.md exists.
 */
export function createAgentsMd(projectDir: string, settings: InstructionSettings, point: string[], home = userHome()): { written: string; pointed: string[] } {
  const target = path.join(projectDir, "AGENTS.md");
  if (fs.existsSync(target)) throw new Error("AGENTS.md exists already");
  const shared = resolve(projectDir, discover(projectDir, settings, home), home)
    .filter((f) => ["copilot", "cursor", "gemini", "claude"].includes(f.convention) && f.scope.kind === "always" && !f.sameAs && f.body);
  const parts = ["# AGENTS.md", "", "Instructions for every agent that works on this project, whatever its vendor."];
  for (const f of shared) parts.push("", `## From ${f.path}`, "", f.body);
  fs.writeFileSync(target, `${parts.join("\n")}\n`);
  const pointed: string[] = [];
  for (const p of point) {
    if (!IMPORTING.includes(p) || !shared.some((f) => f.path === p)) continue;
    const abs = path.join(projectDir, p);
    const rel = slash(path.relative(path.dirname(abs), target));
    fs.writeFileSync(abs, `@${rel}\n`);
    pointed.push(p);
  }
  return { written: "AGENTS.md", pointed };
}
