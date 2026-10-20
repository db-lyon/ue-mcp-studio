/**
 * The Claude conversations behind Studio's sessions on a Claude login. They
 * live in the user's Claude Code home, beside the login.
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
 * Copy the conversations an older Studio kept in another Claude home, so those
 * sessions continue. Copies only what `toHome` is missing, and leaves
 * `fromHome` as it is.
 */
export function restoreTranscripts(ids: string[], fromHome: string, toHome: string, projectDir: string): number {
  if (path.resolve(fromHome) === path.resolve(toHome)) return 0;
  const from = transcriptsDir(fromHome, projectDir);
  const to = transcriptsDir(toHome, projectDir);
  // Once per project, marked in the old home so nothing is added to the new one.
  const marker = path.join(from, ".copied-to-claude-code");
  if (fs.existsSync(marker)) return 0;
  let copied = 0;
  for (const id of ids.filter(valid)) {
    const [src, srcDir] = filesOf(from, id);
    const [dst, dstDir] = filesOf(to, id);
    if (!fs.existsSync(src)) continue;
    // A copy already there that is as new stays.
    if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) continue;
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(src, dst);
    if (fs.existsSync(srcDir)) fs.cpSync(srcDir, dstDir, { recursive: true, force: true });
    copied++;
  }
  if (!fs.existsSync(from)) return copied;
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  return copied;
}

/** Remove a deleted session's conversations from the Claude home. */
export function deleteTranscripts(ids: string[], home: string, projectDir: string): void {
  const dir = transcriptsDir(home, projectDir);
  for (const id of ids.filter(valid)) for (const f of filesOf(dir, id)) fs.rmSync(f, { recursive: true, force: true });
}
