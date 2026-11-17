/**
 * Studio's own window on Linux, built on the user's machine.
 *
 * A release is cut on Windows and carries studio-window.exe, not a Linux binary.
 * It carries the Linux window's source instead (window-src/, scripts/window-source.mjs),
 * and this builds it for the package's version with the system's compiler, GTK 4 and
 * WebKitGTK 6.0, into ~/.ue-mcp/studio/window/<version>/studio-window, the folder the
 * Windows exe is staged in. It starts when the agent starts, so a first install and every
 * self-update have their window ready by the time Studio is opened; until it is, or where
 * the build cannot run, Studio opens in the browser and says why.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** The source the package carries, relative to the package folder. */
export const LINUX_WINDOW_SOURCE = path.join("window-src", "src", "linux", "main.cpp");
export const LINUX_WINDOW = "studio-window";
const LIBS = ["gtk4", "webkitgtk-6.0"];

/** What a user installs once so Studio can build its window, per family of distributions. */
export const LINUX_WINDOW_PACKAGES =
  "a C++ compiler and the development files of GTK 4 and WebKitGTK 6.0 (Fedora: gcc-c++ gtk4-devel webkitgtk6.0-devel; " +
  "Debian and Ubuntu: g++ libgtk-4-dev libwebkitgtk-6.0-dev; Arch: gcc gtk4 webkitgtk-6.0)";

export const BUILDING_REASON = "Studio's window for Linux is being built for this version; it opens there next time";
/** A failed build is tried again after this long, so packages installed meanwhile are picked up without a restart. */
export const RETRY_MS = 30_000;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface BuildDeps {
  run(cmd: string, args: string[]): Promise<RunResult>;
  /** The program's path when it is on PATH. */
  which(name: string): string | null;
  now(): number;
}

export interface LinuxWindowOptions {
  packageDir: string;
  /** Where versioned copies of the window live: ~/.ue-mcp/studio/window. */
  runDir: string;
  version: string;
  log?: (line: string) => void;
}

/** The built window's path, or why there is none yet. */
export interface LinuxWindowState {
  exe?: string;
  reason?: string;
}

function onPath(name: string): string | null {
  if (name.includes("/")) return fs.existsSync(name) ? name : null;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // Not here.
    }
  }
  return null;
}

function runProcess(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
    child.once("error", (e) => resolve({ code: null, stdout, stderr: stderr || e.message }));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export const systemDeps: BuildDeps = { run: runProcess, which: onPath, now: () => Date.now() };

/** The last lines of a compiler's complaint, short enough for a reason. */
function tail(text: string): string {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  return lines.slice(-4).join("\n").slice(-800);
}

export class LinuxWindowBuilder {
  private building: Promise<void> | null = null;
  private failure: { reason: string; at: number } | null = null;

  constructor(
    private readonly o: LinuxWindowOptions,
    private readonly deps: BuildDeps = systemDeps,
  ) {}

  target(): string {
    return path.join(this.o.runDir, this.o.version, LINUX_WINDOW);
  }

  /** The window when it is built; otherwise start building it (once at a time) and say why there is none. */
  ensure(): LinuxWindowState {
    const target = this.target();
    if (fs.existsSync(target)) return { exe: target };
    const source = path.join(this.o.packageDir, LINUX_WINDOW_SOURCE);
    if (!fs.existsSync(source)) return { reason: `this Studio build has no ${LINUX_WINDOW}` };
    if (this.building) return { reason: BUILDING_REASON };
    if (this.failure && this.deps.now() - this.failure.at < RETRY_MS) return { reason: this.failure.reason };
    this.failure = null;
    this.building = this.build(source, target)
      .catch((e: unknown) => {
        const reason = e instanceof Error ? e.message : String(e);
        this.failure = { reason, at: this.deps.now() };
        this.o.log?.(`studio-window was not built: ${reason}`);
      })
      .finally(() => {
        this.building = null;
      });
    return { reason: BUILDING_REASON };
  }

  /** Settles when no build is running; for the tests and for callers that want to wait. */
  idle(): Promise<void> {
    return this.building ?? Promise.resolve();
  }

  private async build(source: string, target: string): Promise<void> {
    if (!/^[0-9A-Za-z.-]+$/.test(this.o.version)) throw new Error(`unexpected Studio version ${this.o.version}`);
    const missing = `Studio's window on Linux is built on this computer and needs ${LINUX_WINDOW_PACKAGES}`;
    const cxx = [process.env.CXX, "g++", "c++", "clang++"].filter((n): n is string => !!n).map((n) => this.deps.which(n)).find(Boolean);
    if (!cxx) throw new Error(missing);
    const pc = await this.deps.run("pkg-config", ["--cflags", "--libs", ...LIBS]);
    if (pc.code !== 0) throw new Error(missing);
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    this.o.log?.(`building studio-window ${this.o.version}`);
    const args = ["-std=c++17", "-O2", `-DSTUDIO_WINDOW_VERSION="${this.o.version}"`, source, "-o", tmp, ...pc.stdout.trim().split(/\s+/).filter(Boolean)];
    const r = await this.deps.run(cxx, args);
    if (r.code !== 0 || !fs.existsSync(tmp)) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`building Studio's window failed: ${tail(r.stderr) || `exit ${r.code}`}`);
    }
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, target);
    this.o.log?.(`built studio-window ${this.o.version}`);
    // Older versions' windows, as stagedExe removes the Windows copies; a running one keeps its file open.
    for (const other of fs.readdirSync(this.o.runDir)) {
      if (other === this.o.version) continue;
      fs.rmSync(path.join(this.o.runDir, other), { recursive: true, force: true });
    }
  }
}

const builders = new Map<string, LinuxWindowBuilder>();

/** One builder per package and version, shared by every window request and the start-up build. */
export function linuxWindowBuilder(o: LinuxWindowOptions, deps: BuildDeps = systemDeps): LinuxWindowBuilder {
  const key = `${o.packageDir}\n${o.runDir}\n${o.version}`;
  let b = builders.get(key);
  if (!b) {
    b = new LinuxWindowBuilder(o, deps);
    builders.set(key, b);
  }
  return b;
}
