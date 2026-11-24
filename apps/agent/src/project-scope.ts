/**
 * Whether a shell command or a file change stays inside the project folder,
 * for the "Allow in project" approval rule. A file change names its path. A
 * command is read for the paths it names: anything that points outside the
 * folder, or that only resolves when it runs (a home folder, an environment
 * variable, a command substitution), counts as outside, so the user is asked.
 * This decides when to ask; it does not confine what a command does.
 */
import * as path from "node:path";
import { resolvePath } from "./local-tools.js";

const caseless = process.platform === "win32";

/** True when `p` is the project folder or under it. */
export function insideProject(projectDir: string, p: string): boolean {
  const root = path.resolve(projectDir);
  const target = path.resolve(p);
  const [a, b] = caseless ? [root.toLowerCase(), target.toLowerCase()] : [root, target];
  const rel = path.relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Text that only becomes a path when the command runs. */
const DYNAMIC = /(^|[^\w])~|\$HOME\b|\$\{HOME\}|\$env:|\$\{env:|%[A-Za-z_][\w()]*%|\$\(|`|\$\{?(?:USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|ProgramFiles|SystemRoot|windir)\b/i;

/** Places a command may name that are not files on disk. */
const HARMLESS = new Set(["/dev/null", "nul", "/dev/stdout", "/dev/stderr"]);

/** The words of a command that could be paths: split on spaces, quotes, redirects, pipes and assignments. */
function words(command: string): string[] {
  return command.split(/[\s"'|;&<>(),=]+/).filter(Boolean);
}

/** A word that names a place: absolute, a UNC share, or climbing with `..`. */
function namesPlace(w: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(w) || /^[\\/]/.test(w) || /(^|[\\/])\.\.([\\/]|$)/.test(w);
}

/** True when nothing in the command points outside the project folder. */
export function commandInsideProject(projectDir: string, command: string): boolean {
  if (DYNAMIC.test(command)) return false;
  // A bare cd goes to the home folder.
  if (/(^|[;&|]\s*)cd\s*($|[;&|])/.test(command.trim())) return false;
  for (const raw of words(command)) {
    // A URL is not a path. A cmd-style switch such as /s reads as a root path and asks.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue;
    if (HARMLESS.has(raw.toLowerCase())) continue;
    if (!namesPlace(raw)) continue;
    if (raw.startsWith("\\\\") || raw.startsWith("//")) return false;
    if (!insideProject(projectDir, resolvePath(projectDir, raw))) return false;
  }
  return true;
}

/** Whether a shell, write_file or edit_file call stays inside the project folder. */
export function callInsideProject(projectDir: string, name: string, input: Record<string, unknown>): boolean {
  if (name === "shell") return typeof input.command === "string" && commandInsideProject(projectDir, input.command);
  if (name === "write_file" || name === "edit_file") return typeof input.path === "string" && insideProject(projectDir, resolvePath(projectDir, input.path));
  return false;
}
