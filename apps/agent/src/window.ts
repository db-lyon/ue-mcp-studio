/**
 * Opening Studio in its own window: studio-window.exe on Windows, the system
 * browser elsewhere or when the exe is missing.
 *
 * The exe ships in the extension's bin/ folder, but runs from a copy under
 * ~/.ue-mcp/studio/window/<version>/: a running exe locks its folder, and the
 * extension install swaps that folder by rename. It is a GUI program, so it
 * opens no console; it is started detached so it outlives this daemon. It
 * finds the daemon through the discovery file, so it follows a restart.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WindowLaunch, WindowRequest } from "@ue-mcp-studio/shared";

export const WINDOW_EXE = "studio-window.exe";

export interface WindowHost {
  platform: NodeJS.Platform;
  /** The extension's folder; the exe is at bin/studio-window.exe. */
  packageDir: string;
  /** Where versioned copies of the exe run from. */
  runDir: string;
  version: string;
  projectDir: string;
  /** The daemon's discovery file for this project; its name is the project key. */
  discoveryFile: string;
  /** Where the window keeps its position and size for this project. */
  stateFile: string;
  nodePath: string;
  /** The ue-mcp package npx starts the daemon with, e.g. ue-mcp@1.4.0. */
  ueMcpPackage: string;
  editors(): Array<{ connected: boolean; pid: number | null }>;
  /** The UI address with its token, or null when the daemon is not published. */
  uiUrl(): string | null;
  spawn(file: string, args: string[]): number | undefined;
  openUrl(url: string): void;
}

/** A body field the route accepts: a positive whole number. */
const pid = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 2 ** 32 ? v : undefined);

/** The request's fields, or why it is not one. */
export function parseWindowRequest(body: unknown): WindowRequest | string {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) return "body must be an object";
  const b = body as Record<string, unknown>;
  if (b.editorPid !== undefined && pid(b.editorPid) === undefined) return "editorPid must be a process id";
  if (b.fromEditor !== undefined && typeof b.fromEditor !== "boolean") return "fromEditor must be a boolean";
  return { editorPid: pid(b.editorPid), fromEditor: b.fromEditor as boolean | undefined };
}

/** The project's name, for the window title: its .uproject, else its folder. */
export function projectName(projectDir: string): string {
  try {
    const f = fs.readdirSync(projectDir).find((n) => n.endsWith(".uproject"));
    if (f) return f.slice(0, -".uproject".length);
  } catch {
    // An unreadable folder still has a name.
  }
  return path.basename(projectDir);
}

export function windowArgs(host: WindowHost, req: WindowRequest): string[] {
  const editorPid = req.editorPid ?? host.editors().find((e) => e.connected && e.pid)?.pid ?? undefined;
  const args = [
    "--key", path.basename(host.discoveryFile, ".json"),
    "--project", host.projectDir,
    "--discovery", host.discoveryFile,
    "--state", host.stateFile,
    "--title", projectName(host.projectDir),
    "--node", host.nodePath,
    "--ue-mcp", host.ueMcpPackage,
  ];
  if (editorPid) args.push("--editor-pid", String(editorPid));
  if (editorPid && req.fromEditor && req.editorPid) args.push("--close-with-editor");
  return args;
}

/**
 * The exe to run: this version's copy under runDir, made from bin/ when it is
 * missing or differs. Older versions' copies are removed when nothing runs them.
 */
export function stagedExe(host: WindowHost): string | null {
  const shipped = path.join(host.packageDir, "bin", WINDOW_EXE);
  if (!fs.existsSync(shipped)) return null;
  const dir = path.join(host.runDir, host.version);
  const target = path.join(dir, WINDOW_EXE);
  const same = fs.existsSync(target) && fs.statSync(target).size === fs.statSync(shipped).size;
  if (!same) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.copyFileSync(shipped, tmp);
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      // A copy of this version already running: it is the same build, so use it.
      if (!fs.existsSync(target)) throw e;
    }
  }
  for (const other of fs.readdirSync(host.runDir)) {
    if (other === host.version) continue;
    try {
      fs.rmSync(path.join(host.runDir, other), { recursive: true });
    } catch {
      // Still running; removed on a later open.
    }
  }
  return target;
}

function inBrowser(host: WindowHost, reason: string): WindowLaunch {
  const url = host.uiUrl();
  if (!url) return { opened: "none", reason: `${reason}, and the daemon has no address to open` };
  host.openUrl(url);
  return { opened: "browser", reason };
}

export function openWindow(host: WindowHost, req: WindowRequest): WindowLaunch {
  if (host.platform !== "win32") return inBrowser(host, "Studio's own window is Windows only");
  let exe: string | null;
  try {
    exe = stagedExe(host);
  } catch (e) {
    return inBrowser(host, `studio-window.exe could not be prepared: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!exe) return inBrowser(host, "this Studio build has no studio-window.exe");
  try {
    return { opened: "window", pid: host.spawn(exe, windowArgs(host, req)) };
  } catch (e) {
    return inBrowser(host, `studio-window.exe did not start: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Start a GUI program detached: no console, and it outlives this daemon. */
export function spawnDetached(file: string, args: string[]): number | undefined {
  const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => {});
  child.unref();
  return child.pid;
}

/** The system browser, without a console window on Windows. */
export function openInSystemBrowser(url: string): void {
  const [file, args] = process.platform === "win32"
    ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}
