/**
 * Opening Studio in its own window: studio-window.exe on Windows and
 * studio-window (GTK and WebKitGTK) on Linux, the system browser elsewhere or
 * when the build has no window for this platform or it cannot run here.
 *
 * The exe ships in the extension's bin/ folder, but runs from a copy under
 * ~/.ue-mcp/studio/window/<version>/: a running exe locks its folder, and the
 * extension install swaps that folder by rename. It is a GUI program, so it
 * opens no console; it is started detached so it outlives this daemon. It
 * finds the daemon through the discovery file, so it follows a restart.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WindowLaunch, WindowRequest } from "@ue-mcp-studio/shared";

export const WINDOW_EXE = "studio-window.exe";

/** The window program's file name in bin/ for a platform, or null where Studio has none. */
export function windowExeName(platform: NodeJS.Platform): string | null {
  if (platform === "win32") return WINDOW_EXE;
  if (platform === "linux") return "studio-window";
  return null;
}

export interface WindowHost {
  platform: NodeJS.Platform;
  /** The extension's folder; the program is at bin/studio-window.exe, or bin/studio-window on Linux. */
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
  /**
   * Why the program cannot run here, or null when it can. On Linux it links
   * the system's GTK 4 and WebKitGTK 6 and needs a display, so a quick
   * `--probe` run checks both before the window is promised.
   */
  probe?(file: string): string | null;
  /**
   * Where the package ships no binary for this platform (Linux: a release is cut on
   * Windows): the window built on this machine, or why there is none yet
   * (linux-window-build.ts). Asking starts the build when it is not running.
   */
  buildWindow?(): { exe?: string; reason?: string };
}

/** A panel hash the window accepts (location.h's safeFragment): '#' then letters, digits and / _ - . */
const PANEL_HASH = /^#[A-Za-z0-9/_.-]{0,511}$/;

/** A body field the route accepts: a positive whole number. */
const pid = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 2 ** 32 ? v : undefined);

/** The request's fields, or why it is not one. */
export function parseWindowRequest(body: unknown): WindowRequest | string {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) return "body must be an object";
  const b = body as Record<string, unknown>;
  if (b.editorPid !== undefined && pid(b.editorPid) === undefined) return "editorPid must be a process id";
  if (b.fromEditor !== undefined && typeof b.fromEditor !== "boolean") return "fromEditor must be a boolean";
  if (b.mode !== undefined && b.mode !== "docked" && b.mode !== "window") return 'mode must be "docked" or "window"';
  if (b.location !== undefined && (typeof b.location !== "string" || !PANEL_HASH.test(b.location))) return "location must be a panel hash such as #/settings/general";
  return { editorPid: pid(b.editorPid), fromEditor: b.fromEditor as boolean | undefined, mode: b.mode as WindowRequest["mode"], location: b.location as string | undefined };
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
  if (req.mode) args.push("--mode", req.mode);
  if (req.location) args.push("--location", req.location);
  return args;
}

/**
 * The exe to run: this version's copy under runDir, made from bin/ when it is
 * missing or differs. Older versions' copies are removed when nothing runs them.
 */
export function stagedExe(host: WindowHost): string | null {
  const name = windowExeName(host.platform);
  if (!name) return null;
  const shipped = path.join(host.packageDir, "bin", name);
  if (!fs.existsSync(shipped)) return null;
  const dir = path.join(host.runDir, host.version);
  const target = path.join(dir, name);
  const same = fs.existsSync(target) && fs.statSync(target).size === fs.statSync(shipped).size;
  if (!same) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.copyFileSync(shipped, tmp);
    // An archive may not keep the executable bit; the copy needs it to run.
    if (host.platform !== "win32") fs.chmodSync(tmp, 0o755);
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
  const name = windowExeName(host.platform);
  if (!name) return inBrowser(host, "Studio's own window is for Windows and Linux");
  let exe: string | null;
  try {
    exe = stagedExe(host);
  } catch (e) {
    return inBrowser(host, `${name} could not be prepared: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!exe && host.buildWindow) {
    const built = host.buildWindow();
    if (!built.exe) return inBrowser(host, built.reason ?? `this Studio build has no ${name}`);
    exe = built.exe;
  }
  if (!exe) return inBrowser(host, `this Studio build has no ${name}`);
  const unable = host.probe?.(exe) ?? null;
  if (unable) return inBrowser(host, unable);
  try {
    return { opened: "window", pid: host.spawn(exe, windowArgs(host, req)) };
  } catch (e) {
    return inBrowser(host, `${name} did not start: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Builds that passed the probe, by path and modification time: once is enough, so later opens do not wait on it. */
const probed = new Map<string, number>();

/**
 * Whether the Linux window can run here: its libraries load and it can open a
 * display. A missing library stops it before main, with the loader's words on
 * stderr; exit 4 is no display. It runs on the route's thread, so it is short
 * and only until a build has passed once.
 */
export function probeLinuxWindow(file: string): string | null {
  let mtime = -1;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    // Missing: the run below says so.
  }
  if (mtime >= 0 && probed.get(file) === mtime) return null;
  const r = spawnSync(file, ["--probe"], { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  if (r.error) return `studio-window did not run: ${r.error.message}`;
  if (r.status === 0) {
    if (mtime >= 0) probed.set(file, mtime);
    return null;
  }
  if (r.status === 4) return "studio-window found no display to open its window on";
  const missing = /error while loading shared libraries: ([^:\s]+)/.exec(r.stderr ?? "")?.[1];
  if (missing) return `studio-window needs ${missing}: install GTK 4 and WebKitGTK 6.0 (webkitgtk6.0 on Fedora, libwebkitgtk-6.0-4 on Debian and Ubuntu)`;
  return `studio-window could not start here (exit ${r.status ?? r.signal})`;
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
