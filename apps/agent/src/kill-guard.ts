/**
 * Keeps the shell from killing an Unreal editor that belongs to another
 * project. A kill by image name is refused outright; a kill by PID is refused
 * when the PID is an editor whose command line does not name this project's
 * .uproject.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface KillTargets {
  /** Every number a kill segment names: PIDs, and a few stray numbers the lookup sorts out. */
  pids: number[];
  /** The editor image a kill segment names, as written. */
  image: string | null;
}

export interface ProcInfo {
  pid: number;
  name: string;
  commandLine: string;
}

export type ProcessLookup = (pids: number[]) => Promise<ProcInfo[]>;

const KILL_VERB = /(^|[\s|(&;`{])(taskkill|tskill|stop-process|spps|kill|pkill|killall|pskill|pskill64)(\.exe)?(?=\s|$|\))/i;
const KILL_METHOD = /\.kill\s*\(/i;
const WMI_TERMINATE = /\b(wmic|win32_process)\b[\s\S]*\b(delete|terminate)\b/i;
const EDITOR_IMAGE = /\b(unrealeditor-cmd|unrealeditor|crashreportclienteditor)(\.exe)?\b/i;
const EDITOR_NAME = /^(unrealeditor|unrealeditor-cmd|crashreportclienteditor)(\.exe)?$/i;
// A number standing alone: not a flag (-9), a path part, a version or part of a word.
const NUMBER = /(?<![\w.\-/\\:])(\d+)(?![\w.])/g;

/** The process kills a command line asks for. Segments split on ; && || and newlines; a pipeline stays whole. */
export function killTargets(command: string): KillTargets {
  const pids = new Set<number>();
  let image: string | null = null;
  for (const segment of command.split(/\r?\n|;|&&|\|\|/)) {
    if (!KILL_VERB.test(segment) && !KILL_METHOD.test(segment) && !WMI_TERMINATE.test(segment)) continue;
    const named = EDITOR_IMAGE.exec(segment);
    if (named && !image) image = named[0];
    for (const m of segment.matchAll(NUMBER)) pids.add(Number(m[1]));
  }
  return { pids: [...pids], image };
}

export const isEditorProcess = (name: string): boolean => EDITOR_NAME.test(path.basename(name.trim()));

const norm = (p: string): string => p.toLowerCase().replace(/\\/g, "/").replace(/\/+/g, "/");

/** The .uproject a command line names, or null. */
export function projectOf(commandLine: string): string | null {
  const m = /"([^"]+\.uproject)"/i.exec(commandLine) ?? /(\S+\.uproject)/i.exec(commandLine);
  return m ? m[1] : null;
}

/** The project's .uproject files, full paths. */
export function projectFiles(projectDir: string): string[] {
  try {
    return fs.readdirSync(projectDir).filter((f) => f.toLowerCase().endsWith(".uproject")).map((f) => path.join(projectDir, f));
  } catch {
    return [];
  }
}

const USE_INSTEAD = "To stop or restart this project's editor, use editor_restart or ue_mcp editor.stop_editor, never a kill from the shell.";

export const imageRefusal = (image: string): string =>
  `Refused: this kills ${image} by image name, which closes every project's editor on the machine, not only this one. ${USE_INSTEAD}`;

/** Why the kill must not run, or null when it may. */
export function killRefusal(procs: ProcInfo[], uprojects: string[]): string | null {
  const own = uprojects.map(norm);
  for (const p of procs) {
    if (!isEditorProcess(p.name)) continue;
    const cmd = norm(p.commandLine);
    if (own.some((u) => cmd.includes(u))) continue;
    const other = projectOf(p.commandLine);
    const theirs = other ? `the project ${path.basename(other, path.extname(other))} (${other})` : "a project this cannot name";
    const ours = uprojects[0] ? ` This session's project is ${uprojects[0]}.` : "";
    return `Refused: PID ${p.pid} is ${p.name}, the editor for ${theirs}, not this session's project.${ours} Never kill another project's editor. ${USE_INSTEAD}`;
  }
  return null;
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // ps exits 1 when no PID matched, with nothing on stdout.
      if (err && !stdout && (err as { code?: unknown }).code !== 1) return reject(err);
      resolve(stdout);
    });
  });

/** Name and command line of each live PID, through CIM on Windows and ps elsewhere. */
export const lookupProcesses: ProcessLookup = async (pids) => {
  if (pids.length === 0) return [];
  if (process.platform === "win32") {
    const filter = pids.map((p) => `ProcessId=${p}`).join(" OR ");
    const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; commandLine = [string]$_.CommandLine } } | ConvertTo-Json -Compress`;
    const out = (await run(ps, ["-NoProfile", "-NonInteractive", "-Command", script])).trim();
    if (!out) return [];
    const parsed = JSON.parse(out) as ProcInfo | ProcInfo[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const out = await run("ps", ["-o", "pid=,comm=,args=", "-p", pids.join(",")]);
  return out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), name: m[2], commandLine: m[3] }] : [];
  });
};

/** The refusal for a shell command that would kill another project's editor, or null. */
export async function guardShellCommand(command: string, projectDir: string, lookup: ProcessLookup = lookupProcesses): Promise<string | null> {
  const t = killTargets(command);
  if (t.image) return imageRefusal(t.image);
  if (t.pids.length === 0) return null;
  let procs: ProcInfo[];
  try {
    procs = await lookup(t.pids);
  } catch (e) {
    return `Refused: could not check what PIDs ${t.pids.join(", ")} are (${e instanceof Error ? e.message : String(e)}), so this kill could close another project's editor. ${USE_INSTEAD}`;
  }
  return killRefusal(procs, projectFiles(projectDir));
}
