import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExtensionHandler, ExtensionRequest } from "ue-mcp/daemon";
import { BusyTracker } from "../src/busy.js";
import { registerWindowRoutes } from "../src/window-routes.js";
import { openWindow, parseWindowRequest, stagedExe, windowArgs, WINDOW_EXE, type WindowHost } from "../src/window.js";

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function fakeHost(over: Partial<WindowHost> = {}) {
  const pkg = tmp("studio-pkg-");
  const project = tmp("studio-proj-");
  fs.writeFileSync(path.join(project, "Vale.uproject"), "{}");
  const spawned: Array<{ file: string; args: string[] }> = [];
  const opened: string[] = [];
  const host: WindowHost = {
    platform: "win32",
    packageDir: pkg,
    runDir: tmp("studio-run-"),
    version: "0.1.0-beta.30",
    projectDir: project,
    discoveryFile: path.join(tmp("studio-daemons-"), "0123456789abcdef.json"),
    stateFile: path.join(pkg, "window-placement.txt"),
    nodePath: "C:/node/node.exe",
    ueMcpPackage: "ue-mcp@1.4.0-beta.1",
    editors: () => [{ connected: true, pid: 4242 }],
    uiUrl: () => "http://127.0.0.1:5555/ui/?token=ab",
    spawn: (file, args) => {
      spawned.push({ file, args });
      return 777;
    },
    openUrl: (url) => opened.push(url),
    ...over,
  };
  const ship = () => {
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "bin", WINDOW_EXE), "exe-v30");
  };
  return { host, spawned, opened, ship };
}

/** The routes as the daemon would hold them, called directly. */
function routes(host: WindowHost, busy = new BusyTracker(), stopSession: (id: string) => void = () => {}) {
  const table = new Map<string, ExtensionHandler>();
  registerWindowRoutes({ route: (method, p, handler) => void table.set(`${method} ${p}`, handler) }, { busy, stopSession, window: () => host });
  return async (method: string, p: string, body?: unknown) => {
    const req: ExtensionRequest = { method, path: p, params: {}, query: {}, headers: {}, body };
    return (await table.get(`${method} ${p}`)!(req))!;
  };
}

describe("POST /window", () => {
  it("starts this version's copy of the window for the project, following the editor that asked", async () => {
    const { host, spawned, ship } = fakeHost();
    ship();
    const res = await routes(host)("POST", "/window", { editorPid: 999, fromEditor: true });
    expect(res).toEqual({ status: 200, body: { opened: "window", pid: 777 } });
    const exe = path.join(host.runDir, "0.1.0-beta.30", WINDOW_EXE);
    expect(spawned[0].file).toBe(exe);
    expect(fs.readFileSync(exe, "utf-8")).toBe("exe-v30");
    const args = spawned[0].args;
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value("--key")).toBe("0123456789abcdef");
    expect(value("--project")).toBe(host.projectDir);
    expect(value("--discovery")).toBe(host.discoveryFile);
    expect(value("--title")).toBe("Vale");
    expect(value("--editor-pid")).toBe("999");
    expect(value("--ue-mcp")).toBe("ue-mcp@1.4.0-beta.1");
    expect(args).toContain("--close-with-editor");
    // The token stays off the command line; the window reads the discovery file.
    expect(args.join(" ")).not.toContain("token");
  });

  it("follows the connected editor when none is named, and does not close with it", () => {
    const { host } = fakeHost();
    const args = windowArgs(host, {});
    expect(args[args.indexOf("--editor-pid") + 1]).toBe("4242");
    expect(args).not.toContain("--close-with-editor");
    expect(windowArgs({ ...host, editors: () => [] }, {})).not.toContain("--editor-pid");
  });

  it("passes the mode the editor asks for, and none otherwise", async () => {
    const { host, spawned, ship } = fakeHost();
    ship();
    await routes(host)("POST", "/window", { editorPid: 999, fromEditor: true, mode: "docked" });
    const args = spawned[0].args;
    expect(args[args.indexOf("--mode") + 1]).toBe("docked");
    expect(windowArgs(host, { mode: "window" })).toEqual(expect.arrayContaining(["--mode", "window"]));
    expect(windowArgs(host, {})).not.toContain("--mode");
  });

  it("opens the system browser when the build has no window", async () => {
    const { host, spawned, opened } = fakeHost();
    const res = await routes(host)("POST", "/window", {});
    expect(res.body).toMatchObject({ opened: "browser" });
    expect(spawned).toEqual([]);
    expect(opened).toEqual(["http://127.0.0.1:5555/ui/?token=ab"]);
  });

  it("opens the system browser off Windows", async () => {
    const { host, spawned, opened, ship } = fakeHost({ platform: "darwin" });
    ship();
    expect(openWindow(host, {})).toMatchObject({ opened: "browser" });
    expect(spawned).toEqual([]);
    expect(opened).toHaveLength(1);
  });

  it("opens the system browser when the window does not start", () => {
    const { host, opened, ship } = fakeHost({ spawn: () => { throw new Error("ENOENT"); } });
    ship();
    expect(openWindow(host, {})).toMatchObject({ opened: "browser", reason: expect.stringContaining("ENOENT") });
    expect(opened).toHaveLength(1);
  });

  it("answers 503 when there is nothing to open", async () => {
    const { host } = fakeHost({ uiUrl: () => null });
    expect((await routes(host)("POST", "/window", {})).status).toBe(503);
  });

  it("refuses a malformed request", async () => {
    const { host } = fakeHost();
    expect((await routes(host)("POST", "/window", { editorPid: "1" })).status).toBe(400);
    expect(parseWindowRequest({ editorPid: -3 })).toMatch(/process id/);
    expect(parseWindowRequest({ fromEditor: "yes" })).toMatch(/boolean/);
    expect(parseWindowRequest({ mode: "floating" })).toMatch(/docked/);
    expect(parseWindowRequest({ mode: "docked" })).toEqual({ mode: "docked" });
    expect(parseWindowRequest(undefined)).toEqual({});
  });

  it("replaces an older version's copy and removes it once nothing runs it", () => {
    const { host, ship } = fakeHost();
    ship();
    fs.mkdirSync(path.join(host.runDir, "0.1.0-beta.29"), { recursive: true });
    fs.writeFileSync(path.join(host.runDir, "0.1.0-beta.29", WINDOW_EXE), "old");
    expect(stagedExe(host)).toBe(path.join(host.runDir, "0.1.0-beta.30", WINDOW_EXE));
    expect(fs.readdirSync(host.runDir)).toEqual(["0.1.0-beta.30"]);
  });
});

describe("GET /busy and POST /busy/stop", () => {
  it("report the calls in flight and stop the turns waiting on them", async () => {
    const busy = new BusyTracker(undefined, () => 10);
    const id = busy.start({ category: "pcg", action: "generate", source: "studio", sessionId: "s9" });
    const stopped: string[] = [];
    const call = routes(fakeHost().host, busy, (s) => stopped.push(s));
    expect((await call("GET", "/busy")).body).toEqual({ now: 10, calls: [{ id, category: "pcg", action: "generate", source: "studio", sessionId: "s9", startedAt: 10, stopped: false }] });
    expect((await call("POST", "/busy/stop")).body).toEqual({ stopped: ["s9"] });
    expect(stopped).toEqual(["s9"]);
    expect(((await call("GET", "/busy")).body as { calls: Array<{ stopped: boolean }> }).calls[0].stopped).toBe(true);
  });
});

// The single-instance protocol of the real exe, without its window: --instance-test runs only the hand-off.
const exe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "window", "dist", WINDOW_EXE);
const haveExe = process.platform === "win32" && fs.existsSync(exe);

describe.skipIf(!haveExe)("studio-window.exe, one window per project", () => {
  const waitFor = async (file: string, text: string) => {
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf-8").includes(text)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${file} never said ${text}`);
  };

  it("hands a second launch for the same project to the first, and keeps projects apart", async () => {
    const dir = tmp("studio-instance-");
    const key = `test${process.pid}${Date.now()}`;
    const first = spawn(exe, ["--key", key, "--project", dir, "--instance-test", path.join(dir, "first.txt")], { stdio: "ignore" });
    const other = spawn(exe, ["--key", `${key}b`, "--project", dir, "--instance-test", path.join(dir, "other.txt")], { stdio: "ignore" });
    try {
      await waitFor(path.join(dir, "first.txt"), "ready");
      await waitFor(path.join(dir, "other.txt"), "ready");

      const second = spawnSync(exe, ["--key", key, "--project", dir, "--editor-pid", "1234", "--instance-test", path.join(dir, "second.txt")], { timeout: 10_000 });
      expect(second.status).toBe(0);
      expect(fs.existsSync(path.join(dir, "second.txt"))).toBe(false);
      await waitFor(path.join(dir, "first.txt"), "--editor-pid 1234");
      expect(fs.readFileSync(path.join(dir, "other.txt"), "utf-8")).not.toContain("1234");

      spawnSync(exe, ["--key", key, "--project", dir, "--quit"], { timeout: 10_000 });
      await new Promise<void>((resolve) => (first.exitCode !== null ? resolve() : first.on("exit", () => resolve())));
      expect(first.exitCode).toBe(0);
    } finally {
      first.kill();
      other.kill();
    }
  });

  it("refuses a key that cannot name a window", () => {
    const r = spawnSync(exe, ["--key", "bad key/..", "--project", os.tmpdir(), "--instance-test", path.join(os.tmpdir(), "x.txt")], { timeout: 10_000 });
    expect(r.status).toBe(2);
  });
});
