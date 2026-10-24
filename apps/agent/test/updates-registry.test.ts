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
  fs.writeFileSync(path.join(pkg, "cli.js"), '#!/usr/bin/env node\nrequire("fs").appendFileSync(process.env.FAKE_UE_MCP_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");\n');
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

const host = (dir: string) => ({ projectDir: dir, editors: () => [], editorOperation: async () => ({}) });
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

  it("installs the ue-mcp published today and runs its update", async () => {
    const dir = project();
    const r = await new Updater(host(dir), "0.0.1").updateUeMcpSource(TODAY);
    expect(r).toEqual({ ok: true });
    expect(recorded()).toContainEqual(["update", path.join(dir, "Game.uproject"), "--no-build"]);
  }, 90_000);

  it("says what npm said when the version cannot be installed", async () => {
    const r = await new Updater(host(project()), "0.0.1").updateUeMcpSource("9.9.9");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^ue-mcp 9\.9\.9 update exited with 1:\n/);
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

  it("restarts the daemon on the ue-mcp published today", async () => {
    const dir = project();
    const uproject = path.join(dir, "Game.uproject");
    const r = await new Updater(host(dir), "0.0.1", () => {}, manifestNaming(`ue-mcp@${TODAY}`), () => "stable").restartDaemon();
    expect(r).toEqual({ started: true });
    await until(() => recorded().find((c) => c[0] === "daemon" && c[1] === "start" && c[2] === uproject));
    expect(recorded()).toContainEqual(["daemon", "stop", uproject]);
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
