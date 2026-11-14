import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILDING_REASON, LINUX_WINDOW_PACKAGES, LINUX_WINDOW_SOURCE, LinuxWindowBuilder, RETRY_MS, type BuildDeps, type RunResult } from "../src/linux-window-build.js";
import { openWindow, type WindowHost } from "../src/window.js";

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A package with the Linux window's source, as release.mjs and install-dev.mjs lay it out. */
function pkgWithSource(): string {
  const pkg = tmp("studio-pkg-");
  fs.mkdirSync(path.dirname(path.join(pkg, LINUX_WINDOW_SOURCE)), { recursive: true });
  fs.writeFileSync(path.join(pkg, LINUX_WINDOW_SOURCE), "// main.cpp");
  return pkg;
}

/** A compiler and pkg-config that answer as told; a successful compile writes the -o file. */
function fakeDeps(o: { compiler?: boolean; pkgConfig?: boolean; compiles?: boolean; now?: () => number } = {}) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const deps: BuildDeps = {
    which: (n) => (o.compiler === false ? null : n === "g++" ? "/usr/bin/g++" : null),
    now: o.now ?? (() => 0),
    run: async (cmd, args): Promise<RunResult> => {
      calls.push({ cmd, args });
      if (cmd === "pkg-config") return o.pkgConfig === false ? { code: 1, stdout: "", stderr: "Package gtk4 was not found" } : { code: 0, stdout: "-I/usr/include/gtk-4.0 -lgtk-4 -lwebkitgtk-6.0\n", stderr: "" };
      if (o.compiles === false) return { code: 1, stdout: "", stderr: "main.cpp:1: error: something\nmore\n" };
      fs.writeFileSync(args[args.indexOf("-o") + 1], "ELF");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { deps, calls };
}

describe("the Linux window, built from the package's source", () => {
  it("builds it for the package's version, executable, then reuses it", async () => {
    const pkg = pkgWithSource();
    const runDir = tmp("studio-run-");
    const { deps, calls } = fakeDeps();
    const b = new LinuxWindowBuilder({ packageDir: pkg, runDir, version: "0.1.40" }, deps);
    expect(b.ensure()).toEqual({ reason: BUILDING_REASON });
    // A second ask while it builds starts nothing new.
    expect(b.ensure()).toEqual({ reason: BUILDING_REASON });
    await b.idle();
    const exe = path.join(runDir, "0.1.40", "studio-window");
    expect(b.ensure()).toEqual({ exe });
    // Windows reports an execute bit only for .exe, .cmd, .bat and .com files, so this checks where it means something.
    if (process.platform !== "win32") expect(fs.statSync(exe).mode & 0o111).not.toBe(0);
    const compile = calls.filter((c) => c.cmd === "/usr/bin/g++");
    expect(compile).toHaveLength(1);
    expect(compile[0].args).toEqual(expect.arrayContaining(["-std=c++17", '-DSTUDIO_WINDOW_VERSION="0.1.40"', path.join(pkg, LINUX_WINDOW_SOURCE), "-lgtk-4", "-lwebkitgtk-6.0"]));
  });

  it("removes other versions' windows once this one is built", async () => {
    const pkg = pkgWithSource();
    const runDir = tmp("studio-run-");
    fs.mkdirSync(path.join(runDir, "0.1.39"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "0.1.39", "studio-window"), "old");
    const b = new LinuxWindowBuilder({ packageDir: pkg, runDir, version: "0.1.40" }, fakeDeps().deps);
    b.ensure();
    await b.idle();
    expect(fs.readdirSync(runDir)).toEqual(["0.1.40"]);
  });

  it("names the packages to install when the tools are missing, and tries again later", async () => {
    let now = 1000;
    const pkg = pkgWithSource();
    const runDir = tmp("studio-run-");
    const missing = fakeDeps({ pkgConfig: false, now: () => now });
    const b = new LinuxWindowBuilder({ packageDir: pkg, runDir, version: "0.1.40" }, missing.deps);
    b.ensure();
    await b.idle();
    const failed = b.ensure();
    expect(failed.exe).toBeUndefined();
    expect(failed.reason).toContain(LINUX_WINDOW_PACKAGES);
    expect(failed.reason).toContain("webkitgtk6.0-devel");
    // Within the wait, the same answer and no new build.
    expect(missing.calls.filter((c) => c.cmd === "pkg-config")).toHaveLength(1);
    now += RETRY_MS + 1;
    expect(b.ensure()).toEqual({ reason: BUILDING_REASON });
    await b.idle();
    expect(missing.calls.filter((c) => c.cmd === "pkg-config")).toHaveLength(2);
  });

  it("says so when there is no compiler", async () => {
    const b = new LinuxWindowBuilder({ packageDir: pkgWithSource(), runDir: tmp("studio-run-"), version: "0.1.40" }, fakeDeps({ compiler: false }).deps);
    b.ensure();
    await b.idle();
    expect(b.ensure().reason).toContain("C++ compiler");
  });

  it("reports the compiler's last lines when the build fails, and leaves no partial file", async () => {
    const runDir = tmp("studio-run-");
    const b = new LinuxWindowBuilder({ packageDir: pkgWithSource(), runDir, version: "0.1.40" }, fakeDeps({ compiles: false }).deps);
    b.ensure();
    await b.idle();
    expect(b.ensure().reason).toMatch(/building Studio's window failed: .*error: something/s);
    expect(fs.readdirSync(path.join(runDir, "0.1.40"))).toEqual([]);
  });

  it("has nothing to build from a package without the source", () => {
    const b = new LinuxWindowBuilder({ packageDir: tmp("studio-pkg-"), runDir: tmp("studio-run-"), version: "0.1.40" }, fakeDeps().deps);
    expect(b.ensure()).toEqual({ reason: "this Studio build has no studio-window" });
  });

  it("refuses a version that is not one", async () => {
    const b = new LinuxWindowBuilder({ packageDir: pkgWithSource(), runDir: tmp("studio-run-"), version: "1.0; rm -rf ~" }, fakeDeps().deps);
    b.ensure();
    await b.idle();
    expect(b.ensure().reason).toMatch(/unexpected Studio version/);
  });
});

describe("POST /window on Linux, with a package that ships no binary", () => {
  function host(over: Partial<WindowHost>) {
    const spawned: string[] = [];
    const opened: string[] = [];
    const project = tmp("studio-proj-");
    const h: WindowHost = {
      platform: "linux",
      packageDir: tmp("studio-pkg-"),
      runDir: tmp("studio-run-"),
      version: "0.1.40",
      projectDir: project,
      discoveryFile: path.join(tmp("studio-daemons-"), "0123456789abcdef.json"),
      stateFile: path.join(project, "window-placement.txt"),
      nodePath: "/usr/bin/node",
      ueMcpPackage: "ue-mcp@1.4.11",
      editors: () => [],
      uiUrl: () => "http://127.0.0.1:5555/ui/?token=ab",
      spawn: (file) => (spawned.push(file), 42),
      openUrl: (url) => opened.push(url),
      probe: () => null,
      ...over,
    };
    return { h, spawned, opened };
  }

  it("starts the window built on this machine", () => {
    const { h, spawned } = host({ buildWindow: () => ({ exe: "/home/u/.ue-mcp/studio/window/0.1.40/studio-window" }) });
    expect(openWindow(h, {})).toEqual({ opened: "window", pid: 42 });
    expect(spawned).toEqual(["/home/u/.ue-mcp/studio/window/0.1.40/studio-window"]);
  });

  it("opens the browser and says why while it is built or cannot be", () => {
    const { h, spawned, opened } = host({ buildWindow: () => ({ reason: BUILDING_REASON }) });
    expect(openWindow(h, {})).toEqual({ opened: "browser", reason: BUILDING_REASON });
    expect(spawned).toEqual([]);
    expect(opened).toHaveLength(1);
  });
});
