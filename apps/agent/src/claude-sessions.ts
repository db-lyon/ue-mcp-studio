/**
 * The Claude conversations behind Studio's sessions on a Claude sign-in. They
 * live in Studio's own Claude home, beside its sign-in, apart from Claude Code.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The folder Claude keeps a project's conversations in: the path with every other character a dash. */
export function projectKey(projectDir: string): string {
  return path.resolve(projectDir).replace(/[^A-Za-z0-9]/g, "-");
}

export function transcriptsDir(home: string, projectDir: string): string {
  return path.join(home, "projects", projectKey(projectDir));
}

/** A conversation's files: its transcript and the folder of its subagents' transcripts. */
const filesOf = (dir: string, id: string) => [path.join(dir, `${id}.jsonl`), path.join(dir, id)];
const valid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

/**
 * Copy back the conversations Studio's 0.1.2 betas kept in Claude Code's home,
 * so those sessions continue. Copies only what Studio's home is missing, and
 * leaves Claude Code's home as it is.
 */
export function restoreTranscripts(ids: string[], fromHome: string, toHome: string, projectDir: string): number {
  if (path.resolve(fromHome) === path.resolve(toHome)) return 0;
  const from = transcriptsDir(fromHome, projectDir);
  const to = transcriptsDir(toHome, projectDir);
  // Once per project: after this, Claude Code's copies are Claude Code's own.
  const marker = path.join(to, ".restored-from-claude-code");
  if (fs.existsSync(marker)) return 0;
  let copied = 0;
  for (const id of ids.filter(valid)) {
    const [src, srcDir] = filesOf(from, id);
    const [dst, dstDir] = filesOf(to, id);
    if (!fs.existsSync(src)) continue;
    // A turn taken during the betas went to Claude Code's home, so its copy is the newer one.
    if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) continue;
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(src, dst);
    if (fs.existsSync(srcDir)) fs.cpSync(srcDir, dstDir, { recursive: true, force: true });
    copied++;
  }
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  return copied;
}

/** Remove a deleted session's conversations from Studio's home. */
export function deleteTranscripts(ids: string[], home: string, projectDir: string): void {
  const dir = transcriptsDir(home, projectDir);
  for (const id of ids.filter(valid)) for (const f of filesOf(dir, id)) fs.rmSync(f, { recursive: true, force: true });
}
