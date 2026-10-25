/**
 * Each vendor's own agent files, found the way that vendor's tools find
 * them (plans/agent-composer.md section 2). Studio reads them and writes none.
 *
 *   claude  Claude Code: CLAUDE.md family, .claude/rules, .claude/agents, .claude/skills
 *   codex   Codex: AGENTS.md walk, .codex/agents/*.toml, .agents/skills
 *   gemini  Gemini CLI: GEMINI.md (or context.fileName), .gemini/agents, .agents/skills and .gemini/skills
 *   agents  custom endpoints: AGENTS.md walk and .agents/skills
 *
 * "The project folder" is where Studio starts each session; its repository
 * root is the nearest folder above it holding .git, or the project folder.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";
import type { Convention, InstructionScope, NativeFile, NativeSkill, NativeSource } from "@ue-mcp-studio/shared";
import { globRegex, tokensOf, userHome } from "./instructions.js";

/** Codex stops adding instruction files past this many bytes, its project_doc_max_bytes default. */
export const CODEX_MAX_BYTES = 32 * 1024;
/** Gemini CLI scans at most this many folders below the project, its discoveryMaxDirs default. */
export const GEMINI_MAX_DIRS = 200;
/** How deep a Claude Code subfolder CLAUDE.md is looked for. */
const CLAUDE_NESTED_DEPTH = 6;
const SKIP_DIRS = new Set([".git", "node_modules", "Binaries", "Intermediate", "Saved", "DerivedDataCache", ".vs"]);

/** One instruction file as read: its text with imports followed, and when it applies. */
export interface FoundFile extends NativeFile {
  abs: string;
  text: string;
}

export interface FoundSubagent {
  name: string;
  description: string;
  /** The body, or Codex's developer_instructions: the subagent's prompt. */
  prompt: string;
  abs: string;
  path: string;
  source: NativeSource;
  /** As written: an alias, a model id, inherit, or null. */
  model: string | null;
  effort: string | null;
  maxTurns: number | null;
  /** Tool names as written (Claude Code names, Gemini names and wildcards), null for every tool. */
  tools: string[] | null;
  /** Codex's features.shell_tool = false. */
  noShell: boolean;
  /** Claude Code skills to preload. */
  skills: string[];
  background: boolean;
  problems: string[];
}

export interface FoundSkill extends NativeSkill {
  abs: string;
  /** SKILL.md without its front matter. */
  body: string;
  /** Supporting files beside SKILL.md, relative to its folder. */
  files: string[];
  allowedTools: string[];
  /** Each vendor's own way to ask that a skill be used only when named: Codex's agents/openai.yaml, Claude Code's disable-model-invocation. */
  namedOnly: { codex: boolean; claude: boolean };
}

/** A file the convention's tool would see but does not read, and why. */
export interface SkippedFile {
  path: string;
  abs: string;
  why: string;
}

export interface Loadout {
  convention: Convention;
  instructions: FoundFile[];
  subagents: FoundSubagent[];
  skills: FoundSkill[];
  notes: string[];
  skipped: SkippedFile[];
}

const slash = (p: string): string => p.replace(/\\/g, "/");

function readText(abs: string): string | null {
  try {
    return fs.statSync(abs).isFile() ? fs.readFileSync(abs, "utf-8").replace(/^﻿/, "").replace(/\r\n/g, "\n") : null;
  } catch {
    return null;
  }
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** As shown: relative to the project, ../ above it, ~/ in the home folder. */
export function shown(projectDir: string, abs: string, home: string): string {
  const rel = path.relative(projectDir, abs);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return slash(rel);
  const h = path.relative(home, abs);
  if (!h.startsWith("..") && !path.isAbsolute(h)) return `~/${slash(h)}`;
  return rel.split(path.sep).length < 6 ? slash(rel) : slash(abs);
}

/** The nearest folder at or above the project holding .git, else the project folder. */
export function repoRoot(projectDir: string): string {
  let dir = path.resolve(projectDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(projectDir);
    dir = up;
  }
}

/** Folders from `top` down to `bottom`, both included. */
function chain(top: string, bottom: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(bottom);
  const stop = path.resolve(top);
  for (;;) {
    out.unshift(dir);
    if (dir === stop) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

/** Every ancestor of the project up to `top` (the filesystem root unless given), root first, the project last. */
const ancestors = (projectDir: string, top?: string): string[] => chain(top ?? path.parse(path.resolve(projectDir)).root, projectDir);

/** Front matter and body; front matter null when there is none. */
export function frontmatter(text: string): { front: Record<string, unknown> | null; body: string; error?: string } {
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { front: null, body: text };
  const doc = parseDocument(m[1]);
  if (doc.errors.length) return { front: null, body: text.slice(m[0].length), error: doc.errors[0].message };
  const v = doc.toJS() as unknown;
  return { front: v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}, body: text.slice(m[0].length) };
}

/**
 * @path imports followed as the vendor follows them: outside code, relative
 * to the importing file (or ~/ and absolute), up to `hops` levels, each file
 * once. A missing file is left as written.
 */
export function followImports(text: string, from: string, home: string, hops: number, seen = new Set<string>()): { text: string; imports: string[] } {
  const imports: string[] = [];
  if (hops <= 0) return { text, imports };
  let fenced = false;
  const out = text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return line;
    return line.replace(/(^|\s)@([~./\w-][^\s`]*)/g, (whole, lead: string, raw: string) => {
      const name = raw.replace(/[.,;:)\]]+$/, "");
      if (!/\.[a-z]+$/i.test(name) && !name.startsWith("~/")) return whole;
      const abs = name.startsWith("~/") ? path.join(home, name.slice(2)) : path.isAbsolute(name) ? name : path.resolve(path.dirname(from), name);
      if (seen.has(abs)) return whole;
      const body = readText(abs);
      if (body === null) return whole;
      seen.add(abs);
      imports.push(name);
      const inner = followImports(body, abs, home, hops - 1, seen);
      imports.push(...inner.imports);
      return `${lead}\n${inner.text.trim()}\n`;
    });
  });
  return { text: out.join("\n"), imports };
}

/* ── instructions ─────────────────────────────────────────────────── */

function file(projectDir: string, home: string, abs: string, source: NativeSource, scope: InstructionScope, hops: number): FoundFile | null {
  const raw = readText(abs);
  if (raw === null || !raw.trim()) return null;
  const { text, imports } = hops > 0 ? followImports(raw, abs, home, hops) : { text: raw, imports: [] };
  return { path: shown(projectDir, abs, home), abs, source, scope, text: text.trim(), tokens: tokensOf(text.trim()), ...(imports.length ? { imports } : {}) };
}

/** Folders below the project holding one of `names`, depth first, skipping generated folders. */
function below(projectDir: string, names: string[], maxDirs: number, maxDepth = 8): string[] {
  const hits: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (visited++ > maxDirs || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth > 0) for (const n of names) if (entries.some((e) => e.isFile() && e.name === n)) hits.push(path.join(dir, n));
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && e.name !== "Content") walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(projectDir, 0);
  return hits;
}

/** A Claude Code rule: a `paths` field scopes it to matching files. */
function claudeRule(projectDir: string, home: string, abs: string, source: NativeSource): FoundFile | null {
  const raw = readText(abs);
  if (raw === null) return null;
  const { front, body } = frontmatter(raw);
  const paths = front?.paths;
  const globs = (Array.isArray(paths) ? paths : typeof paths === "string" ? paths.split(",") : []).map((p) => String(p).trim()).filter(Boolean);
  if (!body.trim()) return null;
  const { text, imports } = followImports(body, abs, home, 4);
  return { path: shown(projectDir, abs, home), abs, source, scope: globs.length ? { kind: "globs", globs } : { kind: "always" }, text: text.trim(), tokens: tokensOf(text), ...(imports.length ? { imports } : {}) };
}

function mdFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".md")) out.push(path.join(d, e.name));
    }
  };
  walk(dir);
  return out;
}

export function claudeInstructions(projectDir: string, home = userHome(), top?: string, skipped: SkippedFile[] = []): FoundFile[] {
  const out: FoundFile[] = [];
  const push = (f: FoundFile | null) => f && out.push(f);
  const always: InstructionScope = { kind: "always" };
  push(file(projectDir, home, path.join(home, ".claude", "CLAUDE.md"), "user", always, 4));
  for (const r of mdFilesUnder(path.join(home, ".claude", "rules"))) push(claudeRule(projectDir, home, r, "user"));
  const dirs = ancestors(projectDir, top);
  // The home folder's .claude/CLAUDE.md is the user's file, read above, not a project one.
  const atHome = (d: string) => path.resolve(d) === path.resolve(home);
  const claudeFiles = (d: string) => [path.join(d, "CLAUDE.md"), ...(atHome(d) ? [] : [path.join(d, ".claude", "CLAUDE.md")]), path.join(d, "CLAUDE.local.md")];
  const hasClaude = dirs.some((d) => claudeFiles(d).some((f) => readText(f) !== null));
  for (const d of dirs) {
    if (hasClaude) {
      push(file(projectDir, home, path.join(d, "CLAUDE.md"), "project", always, 4));
      if (!atHome(d)) push(file(projectDir, home, path.join(d, ".claude", "CLAUDE.md"), "project", always, 4));
      // Present but passed over: said, so a reader comparing vendors sees why.
      for (const f of [path.join(d, "AGENTS.md"), path.join(d, ".claude", "AGENTS.md")]) {
        if (readText(f) !== null) skipped.push({ path: shown(projectDir, f, home), abs: f, why: "not read: Claude Code reads AGENTS.md only where there is no CLAUDE.md" });
      }
    } else {
      // Claude Code's default: AGENTS.md only where no CLAUDE.md exists here or above.
      push(file(projectDir, home, path.join(d, "AGENTS.md"), "project", always, 4));
      push(file(projectDir, home, path.join(d, ".claude", "AGENTS.md"), "project", always, 4));
    }
    if (!atHome(d)) for (const r of mdFilesUnder(path.join(d, ".claude", "rules"))) push(claudeRule(projectDir, home, r, "project"));
    if (hasClaude) push(file(projectDir, home, path.join(d, "CLAUDE.local.md"), "local", always, 4));
  }
  // A subfolder's CLAUDE.md loads once the agent works there.
  for (const abs of below(projectDir, ["CLAUDE.md"], 400, CLAUDE_NESTED_DEPTH)) {
    push(file(projectDir, home, abs, "project", { kind: "folder", folder: slash(path.relative(projectDir, path.dirname(abs))) }, 4));
  }
  return out;
}

/** Codex's fallback file names from ~/.codex/config.toml, when it lists any. */
function codexFallbacks(home: string): string[] {
  const raw = readText(path.join(home, ".codex", "config.toml"));
  if (!raw) return [];
  try {
    const v = (parseToml(raw) as Record<string, unknown>).project_doc_fallback_filenames;
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function codexInstructions(projectDir: string, home = userHome(), notes: string[] = []): FoundFile[] {
  const out: FoundFile[] = [];
  const always: InstructionScope = { kind: "always" };
  const global = [path.join(home, ".codex", "AGENTS.override.md"), path.join(home, ".codex", "AGENTS.md")].map((f) => file(projectDir, home, f, "user", always, 0)).find(Boolean);
  if (global) out.push(global);
  const names = ["AGENTS.override.md", "AGENTS.md", ...codexFallbacks(home)];
  for (const d of chain(repoRoot(projectDir), projectDir)) {
    const f = names.map((n) => file(projectDir, home, path.join(d, n), "project", always, 0)).find(Boolean);
    if (f) out.push(f);
  }
  return capBytes(out, CODEX_MAX_BYTES, notes, "Codex");
}

/** Files past a byte cap are left out, as the vendor leaves them out. */
function capBytes(files: FoundFile[], max: number, notes: string[], tool: string): FoundFile[] {
  let used = 0;
  const kept: FoundFile[] = [];
  for (const f of files) {
    const size = Buffer.byteLength(f.text, "utf-8");
    if (used + size > max) {
      notes.push(`${f.path} is past ${tool}'s ${Math.round(max / 1024)} KiB limit for instruction files, so it is not read.`);
      continue;
    }
    used += size;
    kept.push(f);
  }
  return kept;
}

/** Gemini CLI's context file names: context.fileName from the project's or the user's settings, GEMINI.md by default. */
export function geminiNames(projectDir: string, home = userHome()): string[] {
  for (const f of [path.join(projectDir, ".gemini", "settings.json"), path.join(home, ".gemini", "settings.json")]) {
    const raw = readText(f);
    if (!raw) continue;
    try {
      const v = (JSON.parse(raw) as { context?: { fileName?: unknown } }).context?.fileName;
      if (typeof v === "string" && v.trim()) return [v.trim()];
      if (Array.isArray(v) && v.length) return v.map(String).filter(Boolean);
    } catch {
      // A broken settings file: Gemini CLI would refuse it; the default stands here.
    }
  }
  return ["GEMINI.md"];
}

export function geminiInstructions(projectDir: string, home = userHome()): FoundFile[] {
  const out: FoundFile[] = [];
  const always: InstructionScope = { kind: "always" };
  const names = geminiNames(projectDir, home);
  for (const n of names) {
    const f = file(projectDir, home, path.join(home, ".gemini", n), "user", always, 5);
    if (f) out.push(f);
  }
  for (const d of chain(repoRoot(projectDir), projectDir)) {
    for (const n of names) {
      const f = file(projectDir, home, path.join(d, n), "project", always, 5);
      if (f) out.push(f);
    }
  }
  // Gemini CLI reads its subfolders' files at start, not on demand.
  for (const abs of below(projectDir, names, GEMINI_MAX_DIRS)) {
    const f = file(projectDir, home, abs, "project", always, 5);
    if (f) out.push(f);
  }
  return out;
}

export function agentsInstructions(projectDir: string, home = userHome()): FoundFile[] {
  return chain(repoRoot(projectDir), projectDir)
    .map((d) => file(projectDir, home, path.join(d, "AGENTS.md"), "project", { kind: "always" }, 0))
    .filter((f): f is FoundFile => !!f);
}

/* ── subagents ────────────────────────────────────────────────────── */

const listOf = (v: unknown): string[] | null =>
  typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : null;

/** A Claude Code or Gemini CLI subagent: markdown with front matter, the body its prompt. */
export function parseMarkdownSubagent(text: string, abs: string, shownPath: string, source: NativeSource, kind: "claude" | "gemini"): FoundSubagent | null {
  const { front, body, error } = frontmatter(text);
  if (!front) return null;
  const problems: string[] = error ? [`front matter: ${error}`] : [];
  const name = typeof front.name === "string" ? front.name.trim() : "";
  const description = typeof front.description === "string" ? front.description.trim() : "";
  if (!name) problems.push("name is required");
  if (!description) problems.push("description is required");
  if (!name || !description) return { name: name || path.basename(abs, ".md"), description, prompt: body.trim(), abs, path: shownPath, source, model: null, effort: null, maxTurns: null, tools: null, noShell: false, skills: [], background: false, problems };
  const turns = kind === "claude" ? front.maxTurns : front.max_turns;
  return {
    name,
    description,
    prompt: body.trim(),
    abs,
    path: shownPath,
    source,
    model: typeof front.model === "string" && front.model.trim() ? front.model.trim() : null,
    effort: kind === "claude" && typeof front.effort === "string" ? front.effort : null,
    maxTurns: Number.isInteger(turns) && (turns as number) > 0 ? (turns as number) : null,
    tools: front.tools === undefined ? null : listOf(front.tools),
    noShell: false,
    skills: kind === "claude" ? listOf(front.skills) ?? [] : [],
    background: kind === "claude" && front.background === true,
    problems,
  };
}

/** A Codex subagent: TOML with name, description and developer_instructions. */
export function parseCodexSubagent(text: string, abs: string, shownPath: string, source: NativeSource): FoundSubagent | null {
  let v: Record<string, unknown>;
  try {
    v = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    return { name: path.basename(abs, ".toml"), description: "", prompt: "", abs, path: shownPath, source, model: null, effort: null, maxTurns: null, tools: null, noShell: false, skills: [], background: false, problems: [`not valid TOML: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`] };
  }
  const problems: string[] = [];
  const s = (k: string) => (typeof v[k] === "string" ? (v[k] as string).trim() : "");
  for (const k of ["name", "description", "developer_instructions"]) if (!s(k)) problems.push(`${k} is required`);
  const features = (v.features && typeof v.features === "object" ? v.features : {}) as Record<string, unknown>;
  return {
    name: s("name") || path.basename(abs, ".toml"),
    description: s("description"),
    prompt: s("developer_instructions"),
    abs,
    path: shownPath,
    source,
    model: s("model") || null,
    effort: s("model_reasoning_effort") || null,
    maxTurns: null,
    tools: null,
    noShell: features.shell_tool === false,
    skills: [],
    background: false,
    problems,
  };
}

function subagentsIn(projectDir: string, home: string, dir: string, source: NativeSource, kind: "claude" | "gemini" | "codex", recursive: boolean): FoundSubagent[] {
  const ext = kind === "codex" ? ".toml" : ".md";
  let names: string[];
  try {
    names = recursive ? mdFilesUnder(dir) : fs.readdirSync(dir).filter((n) => n.endsWith(ext)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
  return names.flatMap((abs) => {
    const text = readText(abs);
    if (text === null) return [];
    const p = shown(projectDir, abs, home);
    const a = kind === "codex" ? parseCodexSubagent(text, abs, p, source) : parseMarkdownSubagent(text, abs, p, source, kind);
    return a ? [a] : [];
  });
}

/** By name, the first found wins: each list is given in the vendor's precedence. */
const firstByName = (lists: FoundSubagent[][]): FoundSubagent[] => {
  const seen = new Set<string>();
  return lists.flat().filter((a) => (seen.has(a.name) ? false : (seen.add(a.name), true)));
};

export function findSubagents(convention: Convention, projectDir: string, home = userHome()): FoundSubagent[] {
  if (convention === "claude") {
    // The closest .claude/agents wins, then the user's.
    const project = chain(repoRoot(projectDir), projectDir).reverse().map((d) => subagentsIn(projectDir, home, path.join(d, ".claude", "agents"), "project", "claude", true));
    return firstByName([...project, subagentsIn(projectDir, home, path.join(home, ".claude", "agents"), "user", "claude", true)]);
  }
  if (convention === "codex") return firstByName([subagentsIn(projectDir, home, path.join(projectDir, ".codex", "agents"), "project", "codex", false), subagentsIn(projectDir, home, path.join(home, ".codex", "agents"), "user", "codex", false)]);
  if (convention === "gemini") return firstByName([subagentsIn(projectDir, home, path.join(projectDir, ".gemini", "agents"), "project", "gemini", false), subagentsIn(projectDir, home, path.join(home, ".gemini", "agents"), "user", "gemini", false)]);
  return [];
}

/* ── skills ───────────────────────────────────────────────────────── */

function filesBeside(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (r !== "SKILL.md") out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** One SKILL.md folder, as the Agent Skills specification describes it. */
export function readSkill(projectDir: string, home: string, dir: string, source: NativeSource, owner?: string): FoundSkill | null {
  const text = readText(path.join(dir, "SKILL.md"));
  if (text === null) return null;
  const { front, body, error } = frontmatter(text);
  const problems: string[] = error ? [`front matter: ${error}`] : [];
  const folder = path.basename(dir);
  const name = typeof front?.name === "string" && front.name.trim() ? front.name.trim() : folder;
  const description = typeof front?.description === "string" ? front.description.trim() : "";
  if (!description) problems.push("description is required");
  // Codex's agents/openai.yaml can ask that a skill be used only when named.
  let codexNamed = false;
  const yaml = readText(path.join(dir, "agents", "openai.yaml"));
  if (yaml) {
    try {
      const v = parseDocument(yaml).toJS() as { policy?: { allow_implicit_invocation?: unknown } } | null;
      if (v?.policy?.allow_implicit_invocation === false) codexNamed = true;
    } catch {
      // Not readable: the skill stays implicit, Codex's default.
    }
  }
  // Claude Code's own: disable-model-invocation in the front matter.
  const claudeNamed = front?.["disable-model-invocation"] === true;
  const allowed = front?.["allowed-tools"];
  return {
    name,
    description,
    path: shown(projectDir, dir, home),
    abs: dir,
    source,
    ...(owner ? { owner } : {}),
    tokens: tokensOf(text),
    // Set per convention in loadout: each vendor reads only its own flag.
    implicit: true,
    namedOnly: { codex: codexNamed, claude: claudeNamed },
    problems,
    body: body.trim(),
    files: filesBeside(dir),
    allowedTools: typeof allowed === "string" ? allowed.split(/[\s,]+/).filter(Boolean) : Array.isArray(allowed) ? allowed.map(String) : [],
  };
}

function skillsIn(projectDir: string, home: string, root: string, source: NativeSource, owners: Map<string, string>): FoundSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const owner = owners.get(path.resolve(path.join(root, e.name)));
      const s = readSkill(projectDir, home, path.join(root, e.name), owner ? "plugin" : source, owner);
      return s ? [s] : [];
    });
}

/**
 * Skills in the vendor's places and precedence. `owners` maps a skill folder
 * to the ue-mcp plugin package that installed it, from the daemon's listing.
 */
export function findSkills(convention: Convention, projectDir: string, home = userHome(), owners = new Map<string, string>()): { skills: FoundSkill[]; notes: string[] } {
  const notes: string[] = [];
  const up = chain(repoRoot(projectDir), projectDir).reverse();
  const byName = (lists: FoundSkill[][], keepBoth = false): FoundSkill[] => {
    const seen = new Map<string, FoundSkill>();
    const out: FoundSkill[] = [];
    for (const s of lists.flat()) {
      const first = seen.get(s.name);
      if (!first) {
        seen.set(s.name, s);
        out.push(s);
      } else if (keepBoth) {
        out.push(s);
        notes.push(`Two skills are named ${s.name} (${first.path} and ${s.path}); Codex lists both.`);
      }
    }
    return out;
  };
  if (convention === "claude") {
    // A user skill wins a name clash with a project skill.
    const user = skillsIn(projectDir, home, path.join(home, ".claude", "skills"), "user", owners);
    const project = up.map((d) => skillsIn(projectDir, home, path.join(d, ".claude", "skills"), "project", owners));
    return { skills: byName([user, ...project]), notes };
  }
  if (convention === "gemini") {
    const workspace = [skillsIn(projectDir, home, path.join(projectDir, ".agents", "skills"), "project", owners), skillsIn(projectDir, home, path.join(projectDir, ".gemini", "skills"), "project", owners)];
    const user = [skillsIn(projectDir, home, path.join(home, ".agents", "skills"), "user", owners), skillsIn(projectDir, home, path.join(home, ".gemini", "skills"), "user", owners)];
    return { skills: byName([...workspace, ...user]), notes };
  }
  // Codex and the vendor-neutral files: .agents/skills up to the repository root, then the user's.
  const project = up.map((d) => skillsIn(projectDir, home, path.join(d, ".agents", "skills"), "project", owners));
  const user = skillsIn(projectDir, home, path.join(home, ".agents", "skills"), "user", owners);
  return { skills: byName([...project, user], convention === "codex"), notes };
}

/** Everything a convention loads for this project. */
export function loadout(convention: Convention, projectDir: string, home = userHome(), owners = new Map<string, string>(), top?: string): Loadout {
  const notes: string[] = [];
  const skipped: SkippedFile[] = [];
  const instructions = convention === "claude" ? claudeInstructions(projectDir, home, top, skipped)
    : convention === "codex" ? codexInstructions(projectDir, home, notes)
    : convention === "gemini" ? geminiInstructions(projectDir, home)
    : capBytes(agentsInstructions(projectDir, home), CODEX_MAX_BYTES, notes, "the AGENTS.md");
  const skills = findSkills(convention, projectDir, home, owners);
  // Only Codex reads agents/openai.yaml and only Claude Code reads disable-model-invocation; the others use every skill freely.
  const own = skills.skills.map((s) => ({ ...s, implicit: convention === "codex" ? !s.namedOnly.codex : convention === "claude" ? !s.namedOnly.claude : true }));
  return { convention, instructions, subagents: findSubagents(convention, projectDir, home), skills: own, notes: [...notes, ...skills.notes], skipped };
}

/** Whether a scoped file applies to a project path (relative, forward slashes). */
export function appliesTo(scope: InstructionScope, rel: string): boolean {
  if (scope.kind === "always") return true;
  if (scope.kind === "folder") return rel === scope.folder || rel.startsWith(`${scope.folder}/`);
  return scope.globs.some((g) => globRegex(g).test(rel));
}
