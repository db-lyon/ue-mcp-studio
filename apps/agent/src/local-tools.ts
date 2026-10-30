/**
 * Studio's own tools on the user's machine: a shell, files, search and the
 * web. They run in the daemon's process against the project folder; a relative
 * path is resolved there, an absolute one is taken as it is.
 *
 * shell, write_file and edit_file change things, so the runner asks the user
 * before each one (approvalFor builds what the panel shows). The rest only read.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { lineDiff, type ApprovalRequest, type DiffLine } from "@ue-mcp-studio/shared";
import { IMAGE_EXTENSIONS, MAX_IMAGE_FILE_BYTES, describeImage, prepareImage, sniffImage, type ToolImage } from "./images.js";
import { guardShellCommand } from "./kill-guard.js";

export const LOCAL_TOOL_NAMES = ["shell", "read_file", "write_file", "edit_file", "glob", "grep", "web_fetch"] as const;
export type LocalToolName = (typeof LOCAL_TOOL_NAMES)[number];
export const isLocalTool = (name: string): name is LocalToolName => (LOCAL_TOOL_NAMES as readonly string[]).includes(name);

/** The tools that change something: each waits for the user unless the setting is off. */
export const CHANGING_TOOLS: readonly LocalToolName[] = ["shell", "write_file", "edit_file"];

export const SHELL_TIMEOUT_DEFAULT_S = 120;
export const SHELL_TIMEOUT_MAX_S = 600;
/** How much of a command's output the model sees: this much from the start and this much from the end. */
export const OUTPUT_HEAD = 15_000;
export const OUTPUT_TAIL = 15_000;
const READ_LINES_DEFAULT = 2000;
const READ_LINE_MAX = 2000;
const READ_FILE_MAX = 20 * 1024 * 1024;
const LIST_MAX = 500;
const GREP_MAX = 300;
const GREP_FILE_MAX = 4 * 1024 * 1024;
const TEXT_MAX = 30_000;
const FETCH_DEFAULT = 50_000;
const FETCH_MAX = 200_000;
const FETCH_TIMEOUT_MS = 30_000;
/** Folders a walk skips unless the pattern names them: version control, packages and Unreal's generated files. */
const SKIP_DIRS = [".git", ".svn", ".vs", "node_modules", "Intermediate", "DerivedDataCache"];

export interface LocalResult {
  text: string;
  isError: boolean;
  /** Images the model sees with the text: read_file on an image file. */
  images?: ToolImage[];
}

const fail = (text: string): LocalResult => ({ text, isError: true });

// ---------------------------------------------------------------------------
// The shell

export interface ShellInfo {
  kind: "bash" | "powershell";
  exe: string;
  /** What the tool description tells the model it gets. */
  name: string;
}

/** A program on PATH, or null. WSL's bash in System32 is not Git Bash and is skipped. */
function onPath(names: string[], env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    if (/\\(system32|windowsapps)(\\|$)/i.test(d)) continue;
    for (const n of names) {
      const f = path.join(d, n);
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

/**
 * The shell commands run in. On Windows, Git Bash from the usual Git install
 * folders or PATH, otherwise PowerShell; elsewhere bash, or sh.
 */
export function detectShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ShellInfo {
  if (platform !== "win32") {
    const bash = ["/bin/bash", "/usr/bin/bash"].find((f) => fs.existsSync(f));
    return bash ? { kind: "bash", exe: bash, name: "bash" } : { kind: "bash", exe: "/bin/sh", name: "sh" };
  }
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")]
    .filter((r): r is string => !!r);
  for (const r of roots) {
    const f = path.join(r, "Git", "bin", "bash.exe");
    if (fs.existsSync(f)) return { kind: "bash", exe: f, name: "Git Bash" };
  }
  const bash = onPath(["bash.exe"], env);
  if (bash) return { kind: "bash", exe: bash, name: "Git Bash" };
  const root = env.SystemRoot ?? "C:\\Windows";
  return { kind: "powershell", exe: path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), name: "Windows PowerShell" };
}

let shellCache: ShellInfo | null = null;
export const shell = (): ShellInfo => (shellCache ??= detectShell());

/** Keeps the start and the end of a long output, and counts what it dropped. */
export class OutputTail {
  private head = "";
  private tail = "";
  private total = 0;

  constructor(private readonly headMax = OUTPUT_HEAD, private readonly tailMax = OUTPUT_TAIL) {}

  push(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < this.headMax) {
      const room = this.headMax - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    this.tail = (this.tail + chunk).slice(-this.tailMax);
  }

  text(): string {
    const dropped = this.total - this.head.length - this.tail.length;
    if (dropped <= 0) return this.head + this.tail;
    return `${this.head}\n\n[${dropped} characters cut from the middle: ${this.total} in all, showing the first ${this.head.length} and the last ${this.tail.length}]\n\n${this.tail}`;
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** Run one command in the project folder. Never opens a console window. */
export function runShell(command: string, cwd: string, timeoutS: number, signal?: AbortSignal, sh: ShellInfo = shell()): Promise<LocalResult> {
  const timeout = Math.min(Math.max(1, timeoutS), SHELL_TIMEOUT_MAX_S);
  const args = sh.kind === "bash" ? ["-c", command] : ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command];
  return new Promise((resolve) => {
    const out = new OutputTail();
    let child: ChildProcess;
    try {
      child = spawn(sh.exe, args, {
        cwd,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        // Nothing may wait for a password or open a pager: there is no one at this terminal.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat", CHERE_INVOKING: "1" },
      });
    } catch (e) {
      return resolve(fail(`Could not start ${sh.name}: ${e instanceof Error ? e.message : String(e)}`));
    }
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout * 1000);
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf-8").on("data", (d: string) => out.push(d));
    child.stderr?.setEncoding("utf-8").on("data", (d: string) => out.push(d));
    const finish = (code: number | null, error?: string) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const body = out.text().replace(/\s+$/, "");
      const shown = body ? `${body}\n` : "(no output)\n";
      if (error) return resolve(fail(`${shown}Could not run the command: ${error}`));
      if (timedOut) return resolve(fail(`${shown}Timed out after ${timeout} s; the command was stopped.`));
      if (aborted) return resolve(fail(`${shown}Stopped by the user.`));
      resolve({ text: `${shown}Exit code: ${code ?? "none"}`, isError: code !== 0 });
    };
    child.once("error", (e) => finish(null, e.message));
    child.once("close", (code) => finish(code));
  });
}

// ---------------------------------------------------------------------------
// Paths and files

/** A path the model gave, absolute. Relative ones resolve against the project; Git Bash's /c/... form is read as C:\... on Windows. */
export function resolvePath(projectDir: string, p: string): string {
  let q = p.trim();
  if (process.platform === "win32") {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(q);
    if (m) q = `${m[1].toUpperCase()}:${(m[2] ?? "/").replace(/\//g, "\\")}`;
  }
  return path.resolve(projectDir, q);
}

const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8000).includes(0);

/** A text file's content, or why it cannot be read as text. */
function readText(file: string): { text: string } | { error: string } {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { error: `No such file: ${file}` };
  }
  if (st.isDirectory()) return { error: `${file} is a folder; list it with glob` };
  if (st.size > READ_FILE_MAX) return { error: `${file} is ${st.size} bytes, too large to read whole; search it with grep` };
  const buf = fs.readFileSync(file);
  if (isBinary(buf)) return { error: `${file} is a binary file (${st.size} bytes); read_file opens text, and PNG, JPEG, GIF and WebP images` };
  return { text: buf.toString("utf-8") };
}

/** An image file as the model sees it: a line on what it is, and the image, scaled to fit when large. */
async function readImage(file: string, buf: Buffer, mediaType: string): Promise<LocalResult> {
  try {
    const img = await prepareImage(buf, mediaType, file);
    return { text: describeImage(img, file, buf.length), isError: false, images: [img] };
  } catch (e) {
    return fail(`${file} looks like a ${mediaType.replace("image/", "").toUpperCase()} image but could not be decoded: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A text file with line numbers, or an image file as an image. */
export async function readFile(projectDir: string, input: { path: string; offset?: number; limit?: number }): Promise<LocalResult> {
  const file = resolvePath(projectDir, input.path);
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(file);
  } catch {
    // readText says so.
  }
  if (st?.isFile() && st.size <= MAX_IMAGE_FILE_BYTES) {
    const head = Buffer.alloc(16);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const mediaType = sniffImage(head);
    if (mediaType) return readImage(file, fs.readFileSync(file), mediaType);
  } else if (st?.isFile() && IMAGE_EXTENSIONS[path.extname(file).toLowerCase()]) {
    return fail(`${file} is ${st.size} bytes, too large an image to open (at most ${MAX_IMAGE_FILE_BYTES / 1024 / 1024} MB)`);
  }
  const r = readText(file);
  if ("error" in r) return fail(r.error);
  if (r.text === "") return { text: `${file} is empty.`, isError: false };
  const lines = r.text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const start = Math.max(1, Math.floor(input.offset ?? 1));
  const limit = Math.max(1, Math.floor(input.limit ?? READ_LINES_DEFAULT));
  if (start > lines.length) return fail(`${file} has ${lines.length} lines; offset ${start} is past the end`);
  const end = Math.min(lines.length, start + limit - 1);
  const width = String(end).length;
  const body = lines.slice(start - 1, end).map((l, i) => {
    const text = l.length > READ_LINE_MAX ? `${l.slice(0, READ_LINE_MAX)} [line cut at ${READ_LINE_MAX} characters]` : l;
    return `${String(start + i).padStart(width)}\t${text}`;
  }).join("\n");
  const more = end < lines.length ? `\n[lines ${start} to ${end} of ${lines.length}; read on with offset=${end + 1}]` : "";
  return { text: body + more, isError: false };
}

export function writeFile(projectDir: string, input: { path: string; content: string }): LocalResult {
  const file = resolvePath(projectDir, input.path);
  const existed = fs.existsSync(file);
  if (existed && fs.statSync(file).isDirectory()) return fail(`${file} is a folder`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, input.content);
  const n = input.content === "" ? 0 : input.content.split("\n").length;
  return { text: `${existed ? "Wrote" : "Created"} ${file} (${n} ${n === 1 ? "line" : "lines"}).`, isError: false };
}

export interface EditInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * The file after an edit, or why the edit cannot be made. old_string must be
 * found exactly, and once unless replace_all. A file with Windows line endings
 * matches an old_string written with plain newlines.
 */
export function planEdit(content: string, input: EditInput): { next: string; count: number } | { error: string } {
  if (input.old_string === "") return { error: "old_string is empty; use write_file to create or replace a whole file" };
  if (input.old_string === input.new_string) return { error: "old_string and new_string are the same" };
  let oldS = input.old_string;
  let newS = input.new_string;
  let count = content.split(oldS).length - 1;
  if (count === 0 && content.includes("\r\n") && oldS.includes("\n") && !oldS.includes("\r\n")) {
    oldS = oldS.replace(/\n/g, "\r\n");
    newS = newS.replace(/\r?\n/g, "\r\n");
    count = content.split(oldS).length - 1;
  }
  if (count === 0) return { error: "old_string was not found in the file. Read the file and copy the text exactly, whitespace included." };
  if (count > 1 && !input.replace_all) {
    return { error: `old_string appears ${count} times. Add surrounding lines so it is unique, or set replace_all to change every one.` };
  }
  const next = input.replace_all ? content.split(oldS).join(newS) : content.replace(oldS, () => newS);
  return { next, count: input.replace_all ? count : 1 };
}

export function editFile(projectDir: string, input: EditInput): LocalResult {
  const file = resolvePath(projectDir, input.path);
  if (!fs.existsSync(file)) return fail(`No such file: ${file}. write_file creates a new one.`);
  const r = readText(file);
  if ("error" in r) return fail(r.error);
  const plan = planEdit(r.text, input);
  if ("error" in plan) return fail(`${file}: ${plan.error}`);
  fs.writeFileSync(file, plan.next);
  return { text: `Edited ${file}: ${plan.count} ${plan.count === 1 ? "replacement" : "replacements"}.`, isError: false };
}

// ---------------------------------------------------------------------------
// Glob and grep

/** A glob as a regular expression over a forward-slash relative path. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  // A pattern without a folder matches a file name at any depth.
  if (!g.includes("/")) g = `**/${g}`;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = g.indexOf("}", i);
      if (close < 0) re += "\\{";
      else {
        re += `(?:${g.slice(i + 1, close).split(",").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("|")})`;
        i = close;
      }
    } else if (c === "[") {
      const close = g.indexOf("]", i);
      if (close < 0) re += "\\[";
      else {
        re += `[${g.slice(i + 1, close).replace(/^!/, "^")}]`;
        i = close;
      }
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}

/**
 * How long a glob or a grep without ripgrep may search before it answers with
 * what it found. Each one reads the disk asynchronously, so the daemon keeps
 * answering while it runs (#165), and this bounds a search of a whole drive.
 */
export const SEARCH_BUDGET_MS = 60_000;

/** A search that ran out of time or was stopped: how far it got, for the model. */
interface SearchLimit {
  signal?: AbortSignal;
  /** Date.now() past which the search stops. */
  deadline: number;
  stopped?: "time" | "abort";
}

const searchLimit = (signal?: AbortSignal): SearchLimit => ({ signal, deadline: Date.now() + SEARCH_BUDGET_MS });

/** True when the search should stop now, and records why. */
function searchOver(limit: SearchLimit): boolean {
  if (limit.signal?.aborted) limit.stopped = "abort";
  else if (Date.now() > limit.deadline) limit.stopped = "time";
  return limit.stopped !== undefined;
}

const stoppedNote = (limit: SearchLimit): string =>
  limit.stopped === "time" ? `\n[search stopped after ${SEARCH_BUDGET_MS / 1000} s; these are the results so far; narrow the path or the glob]`
    : limit.stopped === "abort" ? "\n[search stopped]" : "";

/**
 * Every file under a folder, relative with forward slashes, skipping generated
 * folders the pattern does not name. Reads each folder asynchronously, so a
 * walk of a large tree never holds the daemon's event loop.
 */
async function* walk(base: string, pattern: string, limit: SearchLimit): AsyncGenerator<string> {
  const named = new Set(SKIP_DIRS.filter((d) => pattern.toLowerCase().includes(d.toLowerCase())));
  const stack = [""];
  while (stack.length) {
    if (searchOver(limit)) return;
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(base, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.includes(e.name) || named.has(e.name)) stack.push(r);
      } else if (e.isFile()) yield r;
    }
  }
}

async function isFolder(p: string): Promise<boolean | null> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return null;
  }
}

export async function glob(projectDir: string, input: { pattern: string; path?: string }, signal?: AbortSignal): Promise<LocalResult> {
  const base = resolvePath(projectDir, input.path ?? ".");
  if ((await isFolder(base)) !== true) return fail(`No such folder: ${base}`);
  const re = globToRegExp(input.pattern);
  const limit = searchLimit(signal);
  const hits: Array<{ rel: string; mtime: number }> = [];
  for await (const rel of walk(base, input.pattern, limit)) {
    if (!re.test(rel)) continue;
    let mtime = 0;
    try {
      mtime = (await fs.promises.stat(path.join(base, rel))).mtimeMs;
    } catch {
      // Gone since the listing.
    }
    hits.push({ rel, mtime });
    if (hits.length >= LIST_MAX * 20) break;
  }
  const note = stoppedNote(limit);
  if (hits.length === 0) return { text: `No files match ${input.pattern} under ${base}.${note}`, isError: false };
  hits.sort((a, b) => b.mtime - a.mtime);
  const shown = hits.slice(0, LIST_MAX);
  const more = hits.length > shown.length ? `\n[${hits.length - shown.length} more not shown; narrow the pattern]` : "";
  return { text: `${hits.length} ${hits.length === 1 ? "file" : "files"} under ${base}, newest first:\n${shown.map((h) => h.rel).join("\n")}${more}${note}`, isError: false };
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
}

let rgCache: string | null | undefined;
/** Set which ripgrep the grep tool uses: a path, null for none, or undefined to look on PATH again. */
export function setRipgrep(rg: string | null | undefined): void {
  rgCache = rg;
}
/** ripgrep, when it is on PATH. */
export function ripgrep(): string | null {
  if (rgCache !== undefined) return rgCache;
  const r = spawnSync("rg", ["--version"], { windowsHide: true, stdio: "ignore" });
  return (rgCache = r.status === 0 ? "rg" : null);
}

const capText = (s: string): string => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}\n[output cut at ${TEXT_MAX} characters; narrow the search]` : s);

function grepRg(rg: string, target: string, isDir: boolean, input: GrepInput, signal?: AbortSignal): Promise<LocalResult> {
  const args = ["--line-number", "--no-heading", "--color", "never", "--max-columns", "400", "--max-columns-preview", "--hidden", "--glob", "!.git"];
  if (input.ignore_case) args.push("--ignore-case");
  if (input.glob) args.push("--glob", input.glob);
  args.push("--regexp", input.pattern, isDir ? "." : target);
  return new Promise((resolve) => {
    const child = spawn(rg, args, { cwd: isDir ? target : path.dirname(target), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    let buf = "";
    let err = "";
    let more = false;
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf-8").on("data", (d: string) => {
      buf += d;
      let cut: number;
      while ((cut = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, cut).replace(/\r$/, "");
        buf = buf.slice(cut + 1);
        if (lines.length < GREP_MAX) lines.push(line.replace(/^\.\//, ""));
        else if (!more) {
          more = true;
          child.kill();
        }
      }
    });
    child.stderr.setEncoding("utf-8").on("data", (d: string) => (err += d));
    child.once("error", (e) => resolve(fail(`ripgrep failed: ${e.message}`)));
    child.once("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 2 && !more && lines.length === 0) return resolve(fail(`ripgrep: ${err.trim() || "failed"}`));
      resolve(grepReport(target, input.pattern, lines, more));
    });
  });
}

function grepReport(target: string, pattern: string, lines: string[], more: boolean): LocalResult {
  if (lines.length === 0) return { text: `No matches for ${pattern} in ${target}.`, isError: false };
  const tail = more ? `\n[more matches not shown after ${GREP_MAX}; narrow the pattern or the path]` : "";
  return { text: capText(`Matches in ${target} (path:line:text):\n${lines.join("\n")}${tail}`), isError: false };
}

/** grep without ripgrep: asynchronous reads, so the daemon keeps answering while it searches (#165). */
async function grepJs(target: string, isDir: boolean, input: GrepInput, signal?: AbortSignal): Promise<LocalResult> {
  let re: RegExp;
  try {
    re = new RegExp(input.pattern, input.ignore_case ? "i" : "");
  } catch (e) {
    return fail(`Not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`);
  }
  const filter = input.glob ? globToRegExp(input.glob) : null;
  const limit = searchLimit(signal);
  const one = async function* (): AsyncGenerator<string> {
    yield path.basename(target);
  };
  const files = isDir ? walk(target, input.glob ?? "", limit) : one();
  const root = isDir ? target : path.dirname(target);
  const lines: string[] = [];
  for await (const rel of files) {
    if (filter && !filter.test(rel)) continue;
    if (searchOver(limit)) break;
    const file = path.join(root, rel);
    let buf: Buffer;
    try {
      if ((await fs.promises.stat(file)).size > GREP_FILE_MAX) continue;
      buf = await fs.promises.readFile(file);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    const text = buf.toString("utf-8").split(/\r?\n/);
    for (let i = 0; i < text.length; i++) {
      if (!re.test(text[i])) continue;
      if (lines.length >= GREP_MAX) return grepReport(target, input.pattern, lines, true);
      lines.push(`${rel}:${i + 1}:${text[i].slice(0, 400)}`);
    }
  }
  const r = grepReport(target, input.pattern, lines, false);
  return { ...r, text: r.text + stoppedNote(limit) };
}

export async function grep(projectDir: string, input: GrepInput, signal?: AbortSignal, useRg = true): Promise<LocalResult> {
  const target = resolvePath(projectDir, input.path ?? ".");
  const isDir = await isFolder(target);
  if (isDir === null) return fail(`No such file or folder: ${target}`);
  const rg = useRg ? ripgrep() : null;
  return rg ? grepRg(rg, target, isDir, input, signal) : grepJs(target, isDir, input, signal);
}

// ---------------------------------------------------------------------------
// The web

/** Named entities by code point; nbsp reads as a plain space. */
const ENTITIES: Record<string, number> = { amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, nbsp: 32, mdash: 0x2014, ndash: 0x2013, hellip: 0x2026, copy: 0xa9, reg: 0xae };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const n = ENTITIES[e.toLowerCase()];
    return n === undefined ? m : String.fromCodePoint(n);
  });
}

/** An HTML page as readable markdown-like text: headings, links, lists and paragraphs kept; scripts and styles gone. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<head\b[\s\S]*?<\/head>/i, (h) => {
      const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h);
      return t ? `# ${t[1].trim()}\n\n` : "";
    });
  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`)
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) => {
      const label = t.replace(/<[^>]+>/g, "").trim();
      return label ? `[${label}](${href})` : "";
    })
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, t: string) => `\n\n\`\`\`\n${t.replace(/<[^>]+>/g, "")}\n\`\`\`\n\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, t: string) => `\`${t.replace(/<[^>]+>/g, "")}\``)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|tr|ul|ol|table|blockquote|li|dd|dt)>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s)
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function webFetch(input: { url: string; max_length?: number }, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<LocalResult> {
  const max = Math.min(Math.max(1000, Math.floor(input.max_length ?? FETCH_DEFAULT)), FETCH_MAX);
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetchImpl(input.url, { signal: sig, redirect: "follow", headers: { "user-agent": "UE-MCP-Studio (+https://github.com/db-lyon/ue-mcp-studio)", accept: "text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5" } });
  } catch (e) {
    return fail(`Could not fetch ${input.url}: ${timeout.aborted ? `no answer in ${FETCH_TIMEOUT_MS / 1000} s` : e instanceof Error ? e.message : String(e)}`);
  }
  const type = res.headers.get("content-type") ?? "";
  const head = `${res.url || input.url} (${res.status}${type ? `, ${type.split(";")[0]}` : ""})`;
  const textual = !type || /^text\/|json|xml|javascript|yaml|markdown|csv/i.test(type);
  if (!textual) return { text: `${head}\nNot text: ${type}. Download it with the shell if you need the file.`, isError: !res.ok };
  const raw = await res.text();
  const body = /html/i.test(type) || /^\s*<(!doctype html|html)/i.test(raw) ? htmlToText(raw) : raw;
  const cut = body.length > max ? `${body.slice(0, max)}\n\n[cut at ${max} of ${body.length} characters; raise max_length to read more]` : body;
  return { text: `${head}\n\n${cut}`, isError: !res.ok };
}

// ---------------------------------------------------------------------------
// Tool definitions, validation and dispatch

const S = (description: string) => ({ type: "string", description });
const N = (description: string) => ({ type: "number", description });

export function localToolDefinitions(sh: ShellInfo = shell()): Anthropic.Beta.BetaToolUnion[] {
  return [
    {
      name: "shell",
      description:
        `Run a command in ${sh.name} on the user's machine, in the project folder. Use it for git, builds, scripts and anything the files tools do not cover. `
        + `Each call is a fresh shell: cd and variables do not carry over, so chain with ${sh.kind === "bash" ? "&&" : ";"}. Nothing can be typed in, so never start an interactive program. `
        + `The output keeps its start and end when long, and ends with the exit code. Timeout ${SHELL_TIMEOUT_DEFAULT_S} s by default, at most ${SHELL_TIMEOUT_MAX_S}. The user may be asked to allow it first.`,
      input_schema: {
        type: "object",
        properties: {
          command: S("The command line"),
          timeout: N(`Seconds before it is stopped, ${SHELL_TIMEOUT_DEFAULT_S} by default, at most ${SHELL_TIMEOUT_MAX_S}`),
          description: S("A few words on what it does, shown to the user"),
        },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "Read a text file, with line numbers, or look at an image file (PNG, JPEG, GIF or WebP): you see the image itself, scaled down when it is large. A relative path is under the project folder; an absolute one is fine. For a large text file, read a range with offset (first line, from 1) and limit (lines).",
      input_schema: {
        type: "object",
        properties: { path: S("The file"), offset: N("First line to read, from 1"), limit: N(`How many lines, ${READ_LINES_DEFAULT} by default`) },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Create a file, or replace a whole file, with the given content. Folders are created as needed. Prefer edit_file to change part of an existing file. The user may be asked to allow it first.",
      input_schema: {
        type: "object",
        properties: { path: S("The file"), content: S("The complete new content") },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description: "Change a file by replacing old_string with new_string. old_string must match the file exactly, whitespace included, and only once, unless replace_all is set. Read the file first. The user may be asked to allow it first.",
      input_schema: {
        type: "object",
        properties: {
          path: S("The file"),
          old_string: S("The exact text to replace"),
          new_string: S("The text to put in its place"),
          replace_all: { type: "boolean", description: "Replace every occurrence" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    {
      name: "glob",
      description: "Find files by name pattern, such as Source/**/*.cpp or *.uplugin, newest first. A pattern without a slash matches file names at any depth. Searches the project folder unless path names another.",
      input_schema: {
        type: "object",
        properties: { pattern: S("The glob"), path: S("The folder to search") },
        required: ["pattern"],
      },
    },
    {
      name: "grep",
      description: "Search file contents for a regular expression. Answers path:line:text. Searches the project folder unless path names a file or folder; glob narrows the files, such as *.h.",
      input_schema: {
        type: "object",
        properties: {
          pattern: S("The regular expression"),
          path: S("The file or folder to search"),
          glob: S("Only files matching this glob"),
          ignore_case: { type: "boolean" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "web_fetch",
      description: "Fetch a URL over http or https and read it as text: a web page comes back as markdown, JSON and plain text as they are. Long pages are cut at max_length characters.",
      input_schema: {
        type: "object",
        properties: { url: S("The http(s) URL"), max_length: N(`Characters to keep, ${FETCH_DEFAULT} by default, at most ${FETCH_MAX}`) },
        required: ["url"],
      },
    },
  ];
}

const str = (v: unknown): v is string => typeof v === "string";
const optNum = (v: unknown): boolean => v === undefined || (typeof v === "number" && Number.isFinite(v));

/** Check one of these tools' inputs; null when it is fine. */
export function validateLocal(name: LocalToolName, i: Record<string, unknown>): string | null {
  switch (name) {
    case "shell":
      if (!str(i.command) || !i.command.trim()) return "shell needs command";
      return optNum(i.timeout) ? null : "timeout must be a number of seconds";
    case "read_file":
      if (!str(i.path) || !i.path.trim()) return "read_file needs path";
      return optNum(i.offset) && optNum(i.limit) ? null : "offset and limit must be numbers";
    case "write_file":
      if (!str(i.path) || !i.path.trim()) return "write_file needs path";
      return str(i.content) ? null : "write_file needs content";
    case "edit_file":
      if (!str(i.path) || !i.path.trim()) return "edit_file needs path";
      if (!str(i.old_string) || !str(i.new_string)) return "edit_file needs old_string and new_string";
      return i.replace_all === undefined || typeof i.replace_all === "boolean" ? null : "replace_all must be a boolean";
    case "glob":
      return str(i.pattern) && i.pattern.trim() ? null : "glob needs pattern";
    case "grep":
      return str(i.pattern) && i.pattern ? null : "grep needs pattern";
    case "web_fetch":
      return str(i.url) && /^https?:\/\//i.test(i.url) ? null : "web_fetch needs an http or https url";
  }
}

export async function runLocal(projectDir: string, name: LocalToolName, input: Record<string, unknown>, signal?: AbortSignal): Promise<LocalResult> {
  try {
    switch (name) {
      case "shell": {
        const refused = await guardShellCommand(String(input.command), projectDir);
        if (refused) return fail(refused);
        return await runShell(String(input.command), projectDir, typeof input.timeout === "number" ? input.timeout : SHELL_TIMEOUT_DEFAULT_S, signal);
      }
      case "read_file":
        return await readFile(projectDir, input as { path: string; offset?: number; limit?: number });
      case "write_file":
        return writeFile(projectDir, input as { path: string; content: string });
      case "edit_file":
        return editFile(projectDir, input as unknown as EditInput);
      case "glob":
        return await glob(projectDir, input as { pattern: string; path?: string }, signal);
      case "grep":
        return await grep(projectDir, input as unknown as GrepInput, signal);
      case "web_fetch":
        return await webFetch(input as { url: string; max_length?: number }, signal);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** The most diff lines an approval card carries. */
const APPROVAL_DIFF_MAX = 400;

const capDiff = (d: DiffLine[]): DiffLine[] =>
  d.length > APPROVAL_DIFF_MAX ? [...d.slice(0, APPROVAL_DIFF_MAX), { op: "gap", count: d.length - APPROVAL_DIFF_MAX }] : d;

export type ApprovalPreview = Pick<ApprovalRequest, "tool" | "command" | "cwd" | "path" | "diff" | "creates" | "operation" | "reason" | "call">;

/**
 * What the user is asked to allow for a changing call, or null when the call
 * needs no asking: it changes nothing, or it will fail without touching anything.
 */
export function approvalFor(projectDir: string, name: string, input: Record<string, unknown>): ApprovalPreview | null {
  if (name === "shell") return { tool: "shell", command: String(input.command), cwd: projectDir };
  if (name === "write_file") {
    const file = resolvePath(projectDir, String(input.path));
    const before = fs.existsSync(file) ? readText(file) : null;
    const old = before && "text" in before ? before.text : "";
    return { tool: "write_file", path: file, creates: !before, diff: capDiff(lineDiff(old, String(input.content))) };
  }
  if (name === "edit_file") {
    const file = resolvePath(projectDir, String(input.path));
    const r = readText(file);
    if ("error" in r) return null;
    const plan = planEdit(r.text, input as unknown as EditInput);
    if ("error" in plan) return null;
    return { tool: "edit_file", path: file, diff: capDiff(lineDiff(r.text, plan.next)) };
  }
  return null;
}
