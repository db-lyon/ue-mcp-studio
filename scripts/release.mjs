#!/usr/bin/env node
/**
 * Build, sign, package and publish a Studio release.
 *
 *   node scripts/release.mjs [--publish] [--notes-file notes.md]
 *
 * Builds the UI and the bundled agent (trusting the release key only), signs
 * the UI with the release key from ~/.ue-mcp-studio/keys, adds the third-party
 * notices (scripts/notices.mjs), and writes release/studio-<version>.zip plus
 * release/latest.json, the manifest `ue-mcp extension install` follows and the
 * editor plugin fetches on first start. The editor plugin is its own package,
 * released from db-lyon/ue-mcp-studio-plugin; latest.json names where its
 * manifest is and the oldest plugin this release works with.
 *
 * --publish   creates release v<version> on db-lyon/ue-mcp-studio, always marked latest
 *             (betas too) so .../releases/latest/download/latest.json resolves.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { signBundle } from "ue-mcp/daemon";
import { renderNotices } from "./notices.mjs";

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
for (const p of ["apps/agent/package.json", "apps/client-web/package.json"]) {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf-8")).version;
  if (v !== version) throw new Error(`${p} is ${v}, the root package.json is ${version}; keep them in step`);
}
// The oldest ue-mcp this release works with: the version the agent is built against.
const ueMcpMin = String(agentPkg.dependencies?.["ue-mcp"] ?? agentPkg.devDependencies?.["ue-mcp"] ?? "").replace(/^[\^~]/, "");
if (!/^\d+\.\d+\.\d+/.test(ueMcpMin)) throw new Error(`apps/agent/package.json pins no ue-mcp version (${ueMcpMin || "none"})`);
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
fs.copyFileSync(path.join(ROOT, "apps", "agent", "dist", "keys.json"), path.join(ext, "dist", "keys.json"));
fs.cpSync(path.join(ROOT, "apps", "client-web", "dist"), path.join(ext, "ui"), { recursive: true });
fs.writeFileSync(path.join(ext, "THIRD_PARTY_NOTICES.txt"), renderNotices().text);
const manifest = signBundle(path.join(ext, "ui"), { name: "studio", version, api: { min: 1, max: 1 } }, fs.readFileSync(RELEASE_KEY, "utf-8"));

// 3. Package with its manifest.
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
};
fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
console.log(`\n${zipName} (${Object.keys(manifest.files).length} UI files) sha256 ${latest.sha256}`);

if (has("--publish")) {
  const tag = `v${version}`;
  // Every release carries everything the extension install needs.
  for (const f of [zipName, "latest.json"]) if (!fs.existsSync(path.join(OUT, f))) throw new Error(`refusing to publish ${tag}: no ${f}`);
  const notes = arg("--notes-file", null);
  const notesArgs = notes ? ["--notes-file", notes] : ["--notes", `UE-MCP Studio ${version}.`];
  const files = [zipName, "latest.json"].map((f) => path.join(OUT, f));
  run("gh", ["release", "create", tag, "--repo", REPO, "--title", tag, "--target", "main", "--latest", ...notesArgs, ...files]);
  console.log(`published ${tag} to ${REPO}`);
}
