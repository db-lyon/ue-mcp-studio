/**
 * The updater's npx runs against a fake registry, with an .npmrc that holds
 * every release back seven days and excludes ue-mcp, as a user's might
 * (#45, ue-mcp#1510): a ue-mcp published today still installs, and when an
 * install cannot happen the error says what npm said.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Updater, failureText } from "../src/updates.js";

process.env.STUDIO_CHANNEL_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "studio-chan-")), "update-channel.json");

const TODAY = "1.9.0-beta.1";
const now = new Date(Date.now() - 60_000).toISOString();
const npmBin = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin");
/** The npx that applies min-release-age, found in beforeAll: the one beside Node, else the npm on PATH. */
let gated: string | null = null;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-registry-"));
const calls = path.join(root, "calls.log");
const saved: Record<string, string | undefined> = {};
let server: http.Server;
let tarball: Buffer;

/** A ue-mcp whose bin writes the arguments it got to calls.log. */
function packFake(): Buffer {
  const pkg = path.join(root, "pkg");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "ue-mcp", version: TODAY, bin: { "ue-mcp": "cli.js" } }));
  const cli = [
    "#!/usr/bin/env node",
    'const fs = require("fs");',
    'fs.appendFileSync(process.env.FAKE_UE_MCP_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");',
    // What npm's age gate is set to for the npm runs ue-mcp makes inside an update.
    'if (process.env.FAKE_UE_MCP_ENV) fs.appendFileSync(process.env.FAKE_UE_MCP_ENV, JSON.stringify({ minAge: process.env.npm_config_min_release_age ?? null }) + "\\n");',
    // The PATH npx ran it with, which a daemon it starts inherits.
    'if (process.env.FAKE_UE_MCP_PATH) fs.writeFileSync(process.env.FAKE_UE_MCP_PATH, process.env.PATH ?? process.env.Path ?? "");',
    // ue-mcp prints its errors on stdout, in colour, as fail() in its src/cli/ui/ansi.ts does.
    'if (process.env.FAKE_UE_MCP_FAIL) { console.log("  \\x1b[31mx\\x1b[0m " + process.env.FAKE_UE_MCP_FAIL); process.exit(1); }',
    "",
  ];
  fs.writeFileSync(path.join(pkg, "cli.js"), cli.join("\n"));
  const out = execFileSync(process.execPath, [path.join(npmBin, "npm-cli.js"), "pack", "--pack-destination", root, "--json"], { cwd: pkg, encoding: "utf-8" });
  return fs.readFileSync(path.join(root, (JSON.parse(out) as Array<{ filename: string }>)[0].filename));
}

function packument(base: string): unknown {
  // Published a minute ago: today, and older than any run here.
  return {
    name: "ue-mcp",
    "dist-tags": { latest: TODAY, beta: TODAY },
    versions: {
      [TODAY]: {
        name: "ue-mcp",
        version: TODAY,
        bin: { "ue-mcp": "cli.js" },
        dist: {
          tarball: `${base}/ue-mcp/-/ue-mcp-${TODAY}.tgz`,
          shasum: crypto.createHash("sha1").update(tarball).digest("hex"),
          integrity: `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`,
        },
      },
    },
    time: { created: now, modified: now, [TODAY]: now },
  };
}

function project(): string {
  const dir = fs.mkdtempSync(path.join(root, "proj-"));
  fs.writeFileSync(path.join(dir, "Game.uproject"), JSON.stringify({ EngineAssociation: "5.8" }));
  return dir;
}

/** A bridge plugin installed in `dir` the given way, with its install marker. */
function bridge(dir: string, kind: "source" | "binary"): string {
  const plugin = path.join(dir, "Plugins", "UE_MCP_Bridge");
  fs.mkdirSync(path.join(plugin, kind === "source" ? "Source" : "Binaries"), { recursive: true });
  fs.writeFileSync(path.join(plugin, "UE_MCP_Bridge.uplugin"), "{}");
  fs.writeFileSync(path.join(plugin, ".ue-mcp-install.json"), JSON.stringify({ kind }));
  return dir;
}

const host = (dir: string) => ({ projectDir: dir, dataDir: path.join(dir, "studio-data"), editors: () => [], editorOperation: async () => ({}) });
const manifestNaming = (pkg: string) => (async () => new Response(JSON.stringify({ version: "0.0.1", url: "x", sha256: "x", ueMcp: { package: pkg } }))) as unknown as typeof fetch;
const recorded = (): string[][] => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);

/** Run npx without the updater's arguments, as a client config would. */
function plainNpx(npx: string, spec: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    const c = spawn(process.execPath, [npx, "-y", spec, "--version"], { cwd: root, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    c.stderr.setEncoding("utf-8");
    c.stderr.on("data", (d: string) => void (stderr += d));
    c.on("exit", (code) => resolve({ code, stderr }));
  });
}

/** npm before 11 has no min-release-age; the npm on PATH may be newer than the one Node ships. */
function npxCandidates(): string[] {
  const found = [path.join(npmBin, "npx-cli.js")];
  try {
    const global = execFileSync("npm", ["root", "-g"], { encoding: "utf-8", shell: true, windowsHide: true }).trim();
    found.push(path.join(global, "npm", "bin", "npx-cli.js"));
  } catch {
    // No npm on PATH.
  }
  return [...new Set(found)].filter((f) => fs.existsSync(f));
}

async function until<T>(what: () => T | undefined, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = what();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  tarball = packFake();
  server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = decodeURIComponent(req.url ?? "");
    if (url === "/ue-mcp") {
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify(packument(base)));
    }
    if (url === `/ue-mcp/-/ue-mcp-${TODAY}.tgz`) return void res.end(tarball);
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const npmrc = path.join(root, ".npmrc");
  fs.writeFileSync(npmrc, [`registry=http://127.0.0.1:${port}/`, "min-release-age=7", "min-release-age-exclude[]=ue-mcp", "update-notifier=false", "audit=false", "fund=false", ""].join("\n"));
  const empty = path.join(root, "global-npmrc");
  fs.writeFileSync(empty, "");
  const env: Record<string, string> = {
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: empty,
    npm_config_cache: path.join(root, "cache"),
    FAKE_UE_MCP_CALLS: calls,
  };
  // npm reads every npm_config_* the shell set; only these reach the runs here. Windows keeps names in any case.
  for (const k of Object.keys(process.env)) if (/^npm_config_/i.test(k)) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
  for (const npx of npxCandidates()) {
    const r = await plainNpx(npx, `ue-mcp@${TODAY}`);
    if (r.code !== 0 && /with a date before/.test(r.stderr)) {
      gated = npx;
      break;
    }
  }
  saved.UE_MCP_STUDIO_NPX = process.env.UE_MCP_STUDIO_NPX;
  if (gated) process.env.UE_MCP_STUDIO_NPX = gated;
}, 180_000);

afterAll(() => {
  server?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("updates through an age-gated npm", () => {
  it("the gate is up: a plain npx refuses the release published today, though ue-mcp is excluded", async () => {
    // These cases prove nothing on an npm without the gate: npm 11 or later, beside Node or on PATH, is needed.
    expect(gated, `no npm here applies min-release-age (tried ${npxCandidates().join(", ")})`).not.toBeNull();
    const r = await plainNpx(gated!, `ue-mcp@${TODAY}`);
    expect(r.code).not.toBe(0);
    expect(failureText(r.stderr)).toMatch(new RegExp(`No matching version found for ue-mcp@${TODAY.replace(/\./g, "\\.")} with a date before`));
  }, 90_000);

  it("installs a binary bridge through the ue-mcp published today, which applies its own binaries", async () => {
    const dir = bridge(project(), "binary");
    const ops: string[] = [];
    const r = await new Updater({ ...host(dir), editorOperation: async (op: string) => (ops.push(op), {}) }, "0.0.1").updateUeMcp(TODAY);
    expect(r).toEqual({ ok: true });
    expect(recorded()).toContainEqual(["update", path.join(dir, "Game.uproject"), "--apply-only"]);
    expect(ops).toEqual([]);
  }, 90_000);

  it("deploys a source bridge through the ue-mcp published today, then rebuilds the editor on it", async () => {
    const dir = bridge(project(), "source");
    const ops: string[] = [];
    const r = await new Updater({ ...host(dir), editorOperation: async (op: string) => (ops.push(op), {}) }, "0.0.1").updateUeMcp(TODAY);
    expect(r).toEqual({ ok: true });
    expect(recorded()).toContainEqual(["update", path.join(dir, "Game.uproject"), "--no-build"]);
    // The editor never starts on source it has not built, whether or not it was up.
    expect(ops).toEqual(["rebuild"]);
  }, 90_000);

  it("says which rebuild step failed after a source deploy", async () => {
    const dir = bridge(project(), "source");
    const failing = { ...host(dir), editorOperation: async () => ({ steps: [{ step: "project.build", ok: false, result: "no toolchain" }] }) };
    expect(await new Updater(failing, "0.0.1").updateUeMcp(TODAY)).toEqual({
      ok: false, error: `The bridge source ${TODAY} is deployed, but project.build failed: no toolchain`,
    });
  }, 90_000);

  it("the refused screen's update: the release published today applies its own bridge, either kind, and the editor is left alone", async () => {
    for (const kind of ["binary", "source"] as const) {
      const dir = bridge(project(), kind);
      const ops: string[] = [];
      const r = await new Updater({ ...host(dir), editorOperation: async (op: string) => (ops.push(op), {}) }, "0.0.1").applyUeMcp(TODAY);
      expect(r).toEqual({ ok: true });
      expect(recorded()).toContainEqual(["update", path.join(dir, "Game.uproject"), "--apply-only"]);
      expect(ops).toEqual([]);
    }
  }, 120_000);

  it("says what npm said when the version cannot be installed", async () => {
    const r = await new Updater(host(project()), "0.0.1").updateUeMcp("9.9.9");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^npm could not find that version of the package\.\nCommand: npx -y --min-release-age=0 ue-mcp@9\.9\.9 update .*Game\.uproject --apply-only\n/);
    expect(r.error).toMatch(/ETARGET|No matching version found for ue-mcp@9\.9\.9/);
    expect(r.error).not.toMatch(/A complete log of this run/);
  }, 90_000);

  it("installs the Studio extension through the ue-mcp published today", async () => {
    const dir = project();
    const failures: string[] = [];
    const r = await new Updater(host(dir), "0.0.1", () => {}, manifestNaming(`ue-mcp@${TODAY}`), () => "stable", (_, e) => failures.push(e)).updateStudio();
    expect(r).toEqual({ started: true });
    const call = await until(() => recorded().find((c) => c[0] === "extension" && c[3] === path.join(dir, "Game.uproject")));
    expect(call.slice(0, 2)).toEqual(["extension", "install"]);
    expect(failures).toEqual([]);
  }, 90_000);

  it("moves the project to an installed Studio with extension use, then goes back to the channel (ue-mcp#1619)", async () => {
    const dir = project();
    const uproject = path.join(dir, "Game.uproject");
    const u = new Updater(host(dir), "0.0.1", () => {}, manifestNaming(`ue-mcp@${TODAY}`), () => "stable");
    u.targetInstalled("0.1.25");
    expect(await u.updateStudio()).toEqual({ started: true });
    const call = await until(() => recorded().find((c) => c[0] === "extension" && c[1] === "use" && c[4] === uproject));
    expect(call.slice(0, 5)).toEqual(["extension", "use", "studio", "0.1.25", uproject]);
    await u.updateStudio();
    await until(() => recorded().find((c) => c[0] === "extension" && c[1] === "install" && c[3] === uproject));
  }, 90_000);

  it("restarts the daemon on the ue-mcp published today", async () => {
    const dir = project();
    const uproject = path.join(dir, "Game.uproject");
    const r = await new Updater(host(dir), "0.0.1", () => {}, manifestNaming(`ue-mcp@${TODAY}`), () => "stable").restartDaemon();
    expect(r).toEqual({ started: true });
    await until(() => recorded().find((c) => c[0] === "daemon" && c[1] === "start" && c[2] === uproject));
    expect(recorded()).toContainEqual(["daemon", "stop", uproject]);
  }, 90_000);

  it("starts the new daemon only after the old one's process has exited", async () => {
    const dir = project();
    const uproject = path.join(dir, "Game.uproject");
    // Stands in for the daemon Studio runs in: it outlives the stop by several seconds.
    const old = spawn(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { stdio: "ignore", windowsHide: true });
    const exited = new Promise<number>((resolve) => old.on("exit", () => resolve(Date.now())));
    const r = await new Updater({ ...host(dir), daemonPid: old.pid }, "0.0.1", () => {}, manifestNaming(`ue-mcp@${TODAY}`), () => "stable").restartDaemon();
    expect(r).toEqual({ started: true });
    await until(() => recorded().find((c) => c[0] === "daemon" && c[1] === "start" && c[2] === uproject));
    const startedAt = Date.now();
    expect(startedAt).toBeGreaterThanOrEqual(await exited);
  }, 90_000);

  it("reports a background update that failed, with npm's error", async () => {
    const failures: Array<[string, string]> = [];
    const studio = new Updater(host(project()), "0.0.1", () => {}, manifestNaming("ue-mcp@9.9.9"), () => "stable", (step, e) => failures.push([step, e]));
    await studio.updateStudio();
    await studio.restartDaemon();
    await until(() => (failures.length === 2 ? true : undefined));
    expect(failures.map(([s]) => s).sort()).toEqual(["restart", "studio"]);
    for (const [, e] of failures) {
      expect(e).toMatch(/ETARGET|No matching version found for ue-mcp@9\.9\.9/);
      expect(e).not.toMatch(/A complete log of this run/);
    }
  }, 120_000);

  it("keeps what a failed Studio update printed on stdout, written by the chain itself", async () => {
    const dir = project();
    const failures: string[] = [];
    process.env.FAKE_UE_MCP_FAIL = "could not download studio-9.9.9.zip: HTTP 404";
    try {
      const u = new Updater(host(dir), "0.0.1", () => {}, manifestNaming(`ue-mcp@${TODAY}`), () => "stable", (_, e) => failures.push(e));
      expect(await u.updateStudio()).toEqual({ started: true });
      // Kept on disk, so it is there even when the step took the daemon that started it down.
      const kept = await until(() => u.lastFailure() ?? undefined);
      expect(kept.step).toBe("studio");
      expect(kept.error).toContain("could not download studio-9.9.9.zip: HTTP 404");
      expect(kept.error).not.toContain("\x1b");
      // What went wrong in plain words, then the command as the user could run it.
      const command = `npx -y --min-release-age=0 ue-mcp@${TODAY} extension install https://github.com/db-lyon/ue-mcp-studio/releases/latest/download/latest.json ${path.join(dir, "Game.uproject")}`;
      expect(kept.error.split("\n").slice(0, 2)).toEqual(["The command exited with code 1.", `Command: ${command}`]);
      await until(() => (failures.length ? true : undefined));
      expect(failures[0]).toContain("could not download studio-9.9.9.zip: HTTP 404");
    } finally {
      delete process.env.FAKE_UE_MCP_FAIL;
    }
  }, 90_000);

  it("a new attempt clears the last failure", async () => {
    const dir = project();
    const u = new Updater(host(dir), "0.0.1", () => {}, manifestNaming(`ue-mcp@${TODAY}`), () => "stable");
    process.env.FAKE_UE_MCP_FAIL = "first try failed";
    try {
      await u.updateStudio();
      await until(() => u.lastFailure() ?? undefined);
    } finally {
      delete process.env.FAKE_UE_MCP_FAIL;
    }
    await u.updateStudio();
    expect(u.lastFailure()).toBeNull();
  }, 90_000);

  it("lifts npm's age gate for the npm runs inside a Studio update and a bridge update", async () => {
    const dir = bridge(project(), "binary");
    const envLog = path.join(dir, "env.log");
    process.env.FAKE_UE_MCP_ENV = envLog;
    process.env.npm_config_min_release_age = "7";
    try {
      const u = new Updater(host(dir), "0.0.1", () => {}, manifestNaming(`ue-mcp@${TODAY}`), () => "stable");
      await u.updateStudio();
      await until(() => (fs.existsSync(envLog) ? true : undefined));
      expect(await u.updateUeMcp(TODAY)).toEqual({ ok: true });
      const seen = fs.readFileSync(envLog, "utf-8").trim().split("\n").map((l) => (JSON.parse(l) as { minAge: string | null }).minAge);
      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(new Set(seen)).toEqual(new Set(["0"]));
    } finally {
      delete process.env.FAKE_UE_MCP_ENV;
      delete process.env.npm_config_min_release_age;
    }
  }, 120_000);
});

describe("a daemon started by an update, updating again", () => {
  // npx puts its cache's .bin and every node_modules/.bin above the project on PATH, and the
  // daemon an update starts inherits it, so each update ran with a longer PATH. Past 8191
  // characters cmd.exe finds no command at all: "'ue-mcp' is not recognized".
  it("runs ue-mcp with the PATH the first update had, however many updates started the daemon", async () => {
    const dir = project();
    const seen = path.join(dir, "path.txt");
    const original = process.env.PATH ?? "";
    const failures: string[] = [];
    const update = async (): Promise<string> => {
      fs.rmSync(seen, { force: true });
      const u = new Updater(host(dir), "0.0.1", () => {}, manifestNaming(`ue-mcp@${TODAY}`), () => "stable", (_, e) => failures.push(e));
      expect(await u.updateStudio()).toEqual({ started: true });
      return until(() => (fs.existsSync(seen) ? fs.readFileSync(seen, "utf-8") : failures.length ? "" : undefined));
    };
    process.env.FAKE_UE_MCP_PATH = seen;
    try {
      const first = await update();
      expect(failures).toEqual([]);
      // What npx added for this run, as a daemon thirty updates deep would have it, each from its own npx cache folder.
      const added = first.split(path.delimiter).filter((d) => !original.split(path.delimiter).includes(d));
      expect(added.some((d) => /_npx/.test(d))).toBe(true);
      const layers = Array.from({ length: 30 }, (_, i) => added.map((d) => d.replace(/(_npx[\\/])([^\\/]+)/,`$1$2${i}`)).join(path.delimiter));
      process.env.PATH = [...layers, original].join(path.delimiter);
      expect(process.env.PATH.length).toBeGreaterThan(8191);
      const later = await update();
      expect(failures).toEqual([]);
      expect(later).toBe(first);
    } finally {
      process.env.PATH = original;
      delete process.env.FAKE_UE_MCP_PATH;
    }
  }, 120_000);
});

describe("failureText", () => {
  it("keeps npm's error lines without the log pointer", () => {
    const stderr = [
      "npm error code ETARGET",
      "npm error notarget No matching version found for ue-mcp@1.4.11-beta.3 with a date before 10/17/2026.",
      "npm error A complete log of this run can be found in: C:\\Users\\x\\AppData\\Local\\npm-cache\\_logs\\2026-10-24T10_00_00_000Z-debug-0.log",
      "",
    ].join("\r\n");
    expect(failureText(stderr)).toBe("code ETARGET\nnotarget No matching version found for ue-mcp@1.4.11-beta.3 with a date before 10/17/2026.");
  });

  it("falls back to the last lines written", () => {
    expect(failureText("one\ntwo\nthree\nfour\nfive\nsix\n")).toBe("two\nthree\nfour\nfive\nsix");
  });
});
