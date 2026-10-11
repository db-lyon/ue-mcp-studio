/**
 * Which source control the project is under, and where it stands: Git,
 * Perforce, Unity Version Control (Plastic) or Subversion. Each is found by
 * its folder or its client's own answer, read with its command-line tool when
 * that is installed, and every command has a short timeout, so a server
 * asking for a login never holds anything up.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { VcsStatus } from "@ue-mcp-studio/shared";

/** Run a tool in a folder; null when it is missing, fails or takes too long. */
export type Run = (cmd: string, args: string[], cwd: string) => Promise<string | null>;

const TIMEOUT_MS = 4000;

export const run: Run = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout) =>
      resolve(err ? null : stdout.toString()));
  });

/** The nearest folder at or above `dir` that holds `name`. */
export function findUp(dir: string, name: string): string | null {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, name))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** `git status --porcelain=v2 --branch`: the branch, ahead and behind its upstream, and the changed paths. */
export function parseGitStatus(out: string): { branch: string | null; ahead: number; behind: number; changes: number } {
  let branch: string | null = null;
  let oid: string | null = null;
  let ahead = 0;
  let behind = 0;
  let changes = 0;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
    else if (line.startsWith("# branch.oid ")) oid = line.slice(13).trim();
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
    } else if (line && !line.startsWith("#")) changes++;
  }
  // A detached HEAD reports "(detached)"; its short commit says more.
  if (branch === "(detached)") branch = oid && oid !== "(initial)" ? oid.slice(0, 8) : "detached";
  return { branch, ahead, behind, changes };
}

/** The branch a Plastic workspace's selector names. */
export function parsePlasticSelector(text: string): string | null {
  const m = /\b(?:smartbranch|br|branch)\s+"([^"]+)"/i.exec(text);
  return m ? m[1] : null;
}

/** `p4 -ztag -F %clientName%|%clientRoot%|%clientStream%|%userName% info`. */
export function parseP4Info(out: string): { client: string; root: string; stream: string; user: string } | null {
  const [client, root, stream, user] = out.trim().split("|");
  if (!client || client === "*unknown*" || !root) return null;
  return { client, root, stream: stream ?? "", user: user ?? "" };
}

const lines = (out: string | null): number | null => (out === null ? null : out.split(/\r?\n/).filter((l) => l.trim()).length);

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

async function git(dir: string, r: Run): Promise<VcsStatus | null> {
  const root = findUp(dir, ".git");
  if (!root) return null;
  const out = await r("git", ["status", "--porcelain=v2", "--branch"], dir);
  if (out !== null) {
    const s = parseGitStatus(out);
    return { kind: "git", name: "Git", branch: s.branch, changes: s.changes, ahead: s.ahead, behind: s.behind, root };
  }
  // No git on PATH: the branch is still in HEAD.
  try {
    const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf-8").trim();
    const m = /^ref: refs\/heads\/(.+)$/.exec(head);
    return { kind: "git", name: "Git", branch: m ? m[1] : head.slice(0, 8), changes: null, root };
  } catch {
    return { kind: "git", name: "Git", branch: null, changes: null, root };
  }
}

async function plastic(dir: string, r: Run): Promise<VcsStatus | null> {
  const root = findUp(dir, ".plastic");
  if (!root) return null;
  let branch: string | null = null;
  try {
    branch = parsePlasticSelector(fs.readFileSync(path.join(root, ".plastic", "plastic.selector"), "utf-8"));
  } catch {
    // An older workspace keeps no selector file; the CLI still knows.
  }
  if (!branch) {
    const wi = await r("cm", ["wi"], dir);
    branch = wi ? parsePlasticSelector(wi) ?? (/Branch\s+(\S+)/.exec(wi)?.[1] ?? null) : null;
  }
  return { kind: "plastic", name: "Unity Version Control", branch, changes: lines(await r("cm", ["status", "--short"], dir)), root };
}

async function svn(dir: string, r: Run): Promise<VcsStatus | null> {
  const root = findUp(dir, ".svn");
  if (!root) return null;
  const url = await r("svn", ["info", "--show-item", "relative-url"], dir);
  return { kind: "svn", name: "Subversion", branch: url?.trim() || null, changes: lines(await r("svn", ["status", "-q"], dir)), root };
}

async function perforce(dir: string, r: Run): Promise<VcsStatus | null> {
  const info = await r("p4", ["-ztag", "-F", "%clientName%|%clientRoot%|%clientStream%|%userName%", "info"], dir);
  const p = info ? parseP4Info(info) : null;
  if (!p || !inside(dir, p.root)) return null;
  const opened = await r("p4", ["-ztag", "-F", "%depotFile%", "opened", "-C", p.client], dir);
  return {
    kind: "perforce",
    name: "Perforce",
    branch: p.stream || p.client,
    detail: p.stream ? `workspace ${p.client}` : undefined,
    changes: lines(opened),
    root: p.root,
  };
}

/** The project's source control, nearest first by kind; null when it has none this can see. */
export async function detectVcs(projectDir: string, r: Run = run): Promise<VcsStatus | null> {
  for (const probe of [git, plastic, svn, perforce]) {
    const found = await probe(projectDir, r);
    if (found) return found;
  }
  return null;
}

/** One changed file, its path relative to the repository root. */
export interface VcsChange {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  /** Perforce: the changelist the file is open in. */
  changelist?: string;
}

/** `git status --porcelain=v1 -z`: entries are XY path, renames carry the old path after them. */
export function parseGitChanges(out: string): VcsChange[] {
  const parts = out.split("\0").filter(Boolean);
  const changes: VcsChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const xy = parts[i].slice(0, 2);
    const p = parts[i].slice(3);
    let status: VcsChange["status"] = "modified";
    if (xy === "??") status = "untracked";
    else if (xy.includes("U") || xy === "AA" || xy === "DD") status = "conflicted";
    else if (xy.includes("R")) {
      status = "renamed";
      i++;
    } else if (xy.includes("A")) status = "added";
    else if (xy.includes("D")) status = "deleted";
    changes.push({ path: p, status });
  }
  return changes;
}

/** `p4 -ztag -F %depotFile%|%action%|%change% opened`. */
export function parseP4Opened(out: string): VcsChange[] {
  return out.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const [file, action, change] = l.split("|");
    const status: VcsChange["status"] = /add|branch/.test(action) ? "added" : /delete/.test(action) ? "deleted" : /move/.test(action) ? "renamed" : "modified";
    return { path: file, status, changelist: change };
  });
}

/** `svn status -q` and `cm status --short` both lead with a status letter. */
export function parseLetterStatus(out: string): VcsChange[] {
  return out.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const m = /^\s*([A-Z?!]{1,2})\s+(.+)$/.exec(l) ?? [];
    const code = m[1] ?? "M";
    const status: VcsChange["status"] = code.startsWith("A") ? "added" : code.startsWith("D") || code === "!" ? "deleted" : code === "?" ? "untracked" : code.startsWith("C") && code !== "CH" ? "conflicted" : code.startsWith("MV") || code.startsWith("R") ? "renamed" : "modified";
    return { path: (m[2] ?? l).trim(), status };
  });
}

/** Every changed file in the project's source control, at most `limit` of them. */
export async function listChanges(projectDir: string, r: Run = run, limit = 2000): Promise<{ vcs: VcsStatus | null; changes: VcsChange[]; truncated: boolean }> {
  const vcs = await detectVcs(projectDir, r);
  if (!vcs) return { vcs: null, changes: [], truncated: false };
  let changes: VcsChange[] = [];
  if (vcs.kind === "git") changes = parseGitChanges((await r("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], vcs.root)) ?? "");
  else if (vcs.kind === "perforce") changes = parseP4Opened((await r("p4", ["-ztag", "-F", "%depotFile%|%action%|%change%", "opened"], projectDir)) ?? "");
  else if (vcs.kind === "plastic") changes = parseLetterStatus((await r("cm", ["status", "--short"], vcs.root)) ?? "");
  else if (vcs.kind === "svn") changes = parseLetterStatus((await r("svn", ["status", "-q"], vcs.root)) ?? "");
  return { vcs, changes: changes.slice(0, limit), truncated: changes.length > limit };
}

const BINARY_EXT = /\.(uasset|umap|ubulk|uexp|png|jpe?g|tga|exr|hdr|psd|fbx|obj|wav|ogg|mp3|mp4|dll|pdb|exe|lib|zip|bin)$/i;
const MAX_DIFF = 200 * 1024;

/** The diff of one changed file, or why there is none to show. */
export async function diffOf(projectDir: string, file: string, r: Run = run): Promise<{ diff: string | null; reason?: string }> {
  const vcs = await detectVcs(projectDir, r);
  if (!vcs) return { diff: null, reason: "The project is not under source control." };
  if (BINARY_EXT.test(file)) return { diff: null, reason: "A binary file: open it in the editor to see it." };
  if (file.includes("\0") || /(^|[\/])\.\.([\/]|$)/.test(file)) return { diff: null, reason: "Not a path in this project." };
  let out: string | null = null;
  if (vcs.kind === "git") {
    out = await r("git", ["diff", "--no-color", "HEAD", "--", file], vcs.root);
    // An untracked file has no diff against HEAD: show it as added.
    if (!out) {
      const full = path.join(vcs.root, file);
      if (fs.existsSync(full) && fs.statSync(full).size <= MAX_DIFF) out = fs.readFileSync(full, "utf-8").split(/\r?\n/).map((l) => `+${l}`).join("\n");
    }
  } else if (vcs.kind === "perforce") out = await r("p4", ["diff", "-du", file], projectDir);
  else if (vcs.kind === "svn") out = await r("svn", ["diff", file], vcs.root);
  else if (vcs.kind === "plastic") out = await r("cm", ["diff", file], vcs.root);
  if (!out) return { diff: null, reason: "No text changes to show." };
  return { diff: out.length > MAX_DIFF ? `${out.slice(0, MAX_DIFF)}\n(shortened)` : out };
}
