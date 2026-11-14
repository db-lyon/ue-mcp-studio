#!/usr/bin/env node
/**
 * Build, sign, package and publish a Studio release.
 *
 *   node scripts/release.mjs [--publish] [--notes-file notes.md]
 *
 * Builds the UI, the bundled agent (trusting the release key only) and
 * studio-window.exe (scripts/build-window.mjs), signs
 * the UI with the release key from ~/.ue-mcp-studio/keys, adds the third-party
 * notices (scripts/notices.mjs), and writes release/studio-<version>.zip plus
 * release/latest.json, the manifest `ue-mcp install studio` follows and the
 * editor plugin fetches on first start, and release/UE-MCP-Setup.exe, the
 * UE-MCP app, which installs itself when run (apps/window/src/app.cpp).
 * latest.json names it under `app`, which is how an installed app updates.
 * The editor plugin is its own package, released from
 * db-lyon/ue-mcp-studio-plugin; latest.json names where its manifest is and
 * the oldest plugin this release works with.
 *
 * --publish   creates release v<version> on db-lyon/ue-mcp-studio. A stable version is marked
 *             latest, so .../releases/latest/download/latest.json resolves to it; a
 *             prerelease is published beside it for testers and never becomes latest.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { signBundle } from "ue-mcp/daemon";
import { renderNotices } from "./notices.mjs";
import { copyWindowSource } from "./window-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "release");
const REPO = "db-lyon/ue-mcp-studio";
const RELEASE_KEY = path.join(os.homedir(), ".ue-mcp-studio", "keys", "release-ui-signing.key.pem");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" && cmd === "npm", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
};
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
const zip = (parent, folder, out) => {
  fs.rmSync(out, { force: true });
  execFileSync(tar, ["-a", "-c", "-f", out, "-C", parent, folder], { stdio: "inherit" });
};

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).version;
const PLUGIN_CHANNEL = "https://github.com/db-lyon/ue-mcp-studio-plugin/releases/latest/download/plugin.json";
// The oldest editor plugin this release works with; the UI feature-detects anything newer.
const pluginMin = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).studioPlugin?.min;
if (!/^\d+\.\d+\.\d+/.test(pluginMin ?? "")) throw new Error("package.json names no studioPlugin.min");
const agentPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "agent", "package.json"), "utf-8"));
for (const p of ["apps/agent/package.json", "apps/client-web/package.json", "apps/window/package.json"]) {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf-8")).version;
  if (v !== version) throw new Error(`${p} is ${v}, the root package.json is ${version}; keep them in step`);
}
// The oldest ue-mcp this release runs on: the floor ue-mcp checks at load, and Update installs before Studio.
const ueMcpMin = String(agentPkg.ueMcpExtension?.ueMcp ?? "");
if (!/^\d+\.\d+\.\d+/.test(ueMcpMin)) throw new Error(`apps/agent/package.json names no ueMcpExtension.ueMcp (${ueMcpMin || "none"})`);
if (!fs.existsSync(RELEASE_KEY)) throw new Error(`no release signing key at ${RELEASE_KEY}`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1. Build, trusting only the release key.
run("npm", ["run", "build"], { cwd: ROOT, env: { ...process.env, STUDIO_RELEASE: "1" } });
const keys = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "agent", "dist", "keys.json"), "utf-8"));
if (keys.length !== 1) throw new Error(`a release agent must trust exactly the release key; it trusts ${keys.length}`);

// 2. Stage the extension: package.json, the bundled agent, the signed UI.
const stage = path.join(os.tmpdir(), `studio-release-${process.pid}`);
const ext = path.join(stage, "studio");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(ext, "dist"), { recursive: true });
fs.writeFileSync(path.join(ext, "package.json"), JSON.stringify({
  name: "ue-mcp-studio-agent",
  version,
  private: true,
  license: "UNLICENSED",
  type: "module",
  main: "dist/index.js",
  ueMcpExtension: agentPkg.ueMcpExtension,
}, null, 2) + "\n");
fs.copyFileSync(path.join(ROOT, "apps", "agent", "dist", "index.js"), path.join(ext, "dist", "index.js"));
// The process a Claude sign-in turn runs in, which the extension starts beside itself.
fs.copyFileSync(path.join(ROOT, "apps", "agent", "dist", "turn-host.js"), path.join(ext, "dist", "turn-host.js"));
fs.copyFileSync(path.join(ROOT, "apps", "agent", "dist", "keys.json"), path.join(ext, "dist", "keys.json"));
fs.copyFileSync(path.join(ROOT, "apps", "agent", "dist", "webp_dec.wasm"), path.join(ext, "dist", "webp_dec.wasm"));
fs.cpSync(path.join(ROOT, "apps", "client-web", "dist"), path.join(ext, "ui"), { recursive: true });
// Studio's own window on Windows; the extension opens the system browser without it, but a release always has it.
const windowExe = path.join(ROOT, "apps", "window", "dist", "studio-window.exe");
if (!fs.existsSync(windowExe)) throw new Error("no apps/window/dist/studio-window.exe: a release is built on Windows, with the C++ tools");
fs.mkdirSync(path.join(ext, "bin"), { recursive: true });
fs.copyFileSync(windowExe, path.join(ext, "bin", "studio-window.exe"));
// Studio's own window on Linux, as source: the agent builds it there for this version (scripts/window-source.mjs).
copyWindowSource(ROOT, ext);
fs.writeFileSync(path.join(ext, "THIRD_PARTY_NOTICES.txt"), renderNotices().text);
const manifest = signBundle(path.join(ext, "ui"), { name: "studio", version, api: { min: 1, max: 1 } }, fs.readFileSync(RELEASE_KEY, "utf-8"));

// 3. The UE-MCP app, built with the window, under one name so releases/latest/download/<name> always resolves.
const SETUP = "UE-MCP-Setup.exe";
const appExe = path.join(ROOT, "apps", "window", "dist", "UE-MCP.exe");
if (!fs.existsSync(appExe)) throw new Error("no apps/window/dist/UE-MCP.exe: a release is built on Windows, with the C++ tools");
fs.copyFileSync(appExe, path.join(OUT, SETUP));
// STUDIO_SIGNTOOL is a sign command with $f where the file goes; unset, the app ships unsigned.
const sign = process.env.STUDIO_SIGNTOOL;
if (sign) run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", sign.replace(/\$f/g, `"${path.join(OUT, SETUP)}"`)]);

// 4. Package with its manifest.
const zipName = `studio-${version}.zip`;
zip(stage, "studio", path.join(OUT, zipName));
fs.rmSync(stage, { recursive: true, force: true });
const latest = {
  version,
  url: zipName,
  sha256: sha256(path.join(OUT, zipName)),
  extensionApi: agentPkg.ueMcpExtension.api,
  uiApi: manifest.api,
  // The host plugin takes its ue-mcp pin from here, so following a ue-mcp release never needs a host update.
  ueMcp: { min: ueMcpMin, package: `ue-mcp@${ueMcpMin.includes("-") ? ueMcpMin.split("-")[1].split(".")[0] : "latest"}` },
  // The editor plugin is released on its own: where its manifest is, and the oldest one this release works with.
  pluginChannel: PLUGIN_CHANNEL,
  pluginMin,
  // The UE-MCP app: an installed app reads this to update itself.
  app: { version, url: SETUP, sha256: sha256(path.join(OUT, SETUP)) },
};
fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
console.log(`\n${zipName} (${Object.keys(manifest.files).length} UI files) sha256 ${latest.sha256}`);

if (has("--publish")) {
  const tag = `v${version}`;
  // Every release carries everything the install needs.
  const assets = [zipName, "latest.json", SETUP];
  for (const f of assets) if (!fs.existsSync(path.join(OUT, f))) throw new Error(`refusing to publish ${tag}: no ${f}`);
  const notes = arg("--notes-file", null);
  const notesArgs = notes ? ["--notes-file", notes] : ["--notes", `UE-MCP Studio ${version}.`];
  const files = assets.map((f) => path.join(OUT, f));
  // A prerelease is for testers: it never becomes latest, so the stable channel cannot pick it up.
  const channel = version.includes("-") ? ["--prerelease", "--latest=false"] : ["--latest"];
  run("gh", ["release", "create", tag, "--repo", REPO, "--title", tag, "--target", "main", ...channel, ...notesArgs, ...files]);
  console.log(`published ${tag} to ${REPO}`);
}
