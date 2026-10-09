#!/usr/bin/env node
/**
 * Build, sign, package and publish a Studio release.
 *
 *   node scripts/release.mjs [--plugin] [--engines 5.7,5.8] [--publish] [--notes-file notes.md]
 *
 * Always: builds the UI and the bundled agent (trusting the release key only),
 * signs the UI with the release key from ~/.ue-mcp-studio/keys, and writes
 * release/studio-<version>.zip plus release/latest.json ({ version, url, sha256 }),
 * the manifest `ue-mcp extension install` follows.
 *
 * --plugin    also packages the UE_MCP_Studio editor plugin with RunUAT BuildPlugin
 *             for each engine, as UE_MCP_Studio-<version>-UE<engine>-Win64.zip.
 * --publish   creates release v<version> on the public db-lyon/ue-mcp-studio-releases
 *             (downloads, always marked latest so .../releases/latest/download/latest.json
 *             resolves) and on the private db-lyon/ue-mcp-studio (the release record).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { signBundle } from "ue-mcp/daemon";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "release");
const PUBLIC_REPO = "db-lyon/ue-mcp-studio-releases";
const PRIVATE_REPO = "db-lyon/ue-mcp-studio";
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
const agentPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "agent", "package.json"), "utf-8"));
for (const p of ["apps/agent/package.json", "apps/client-web/package.json"]) {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf-8")).version;
  if (v !== version) throw new Error(`${p} is ${v}, the root package.json is ${version}; keep them in step`);
}
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
};
fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
console.log(`\n${zipName} (${Object.keys(manifest.files).length} UI files) sha256 ${latest.sha256}`);

// 4. The editor plugin, per engine.
const pluginZips = [];
if (has("--plugin")) {
  const uplugin = path.join(ROOT, "apps", "client-plugin", "StudioHost", "Plugins", "UE_MCP_Studio", "UE_MCP_Studio.uplugin");
  const descriptor = JSON.parse(fs.readFileSync(uplugin, "utf-8"));
  if (descriptor.VersionName !== version) {
    descriptor.VersionName = version;
    fs.writeFileSync(uplugin, JSON.stringify(descriptor, null, "\t") + "\n");
  }
  // BuildPlugin writes a default Config/FilterPlugin.ini into the source plugin; keep the tree clean.
  const filterIni = path.join(path.dirname(uplugin), "Config", "FilterPlugin.ini");
  const hadFilterIni = fs.existsSync(filterIni);
  for (const engine of (arg("--engines", "5.7,5.8")).split(",")) {
    const engineRoot = path.join("C:/Program Files/Epic Games", `UE_${engine}`);
    const uat = path.join(engineRoot, "Engine", "Build", "BatchFiles", "RunUAT.bat");
    if (!fs.existsSync(uat)) {
      console.warn(`skip UE ${engine}: no ${uat}`);
      continue;
    }
    const pkgStage = path.join(os.tmpdir(), "uemcps", `UE${engine}`);
    const pkg = path.join(pkgStage, "UE_MCP_Studio");
    fs.rmSync(pkgStage, { recursive: true, force: true });
    const argsLine = [uat, "BuildPlugin", `-Plugin=${uplugin}`, `-Package=${pkg}`, "-TargetPlatforms=Win64", "-Rocket"].map((x) => `"${x}"`).join(" ");
    const r = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${argsLine}"`], { stdio: "inherit", windowsVerbatimArguments: true });
    if (r.status !== 0) throw new Error(`BuildPlugin UE_MCP_Studio failed for UE ${engine}`);
    for (const d of ["Intermediate", "HostProject"]) fs.rmSync(path.join(pkg, d), { recursive: true, force: true });
    const name = `UE_MCP_Studio-${version}-UE${engine}-Win64.zip`;
    zip(pkgStage, "UE_MCP_Studio", path.join(OUT, name));
    fs.rmSync(pkgStage, { recursive: true, force: true });
    if (!hadFilterIni) fs.rmSync(path.dirname(filterIni), { recursive: true, force: true });
    pluginZips.push(name);
    console.log(`${name} packaged`);
  }
}

// 5. Publish.
if (has("--publish")) {
  const tag = `v${version}`;
  const notes = arg("--notes-file", null);
  const notesArgs = notes ? ["--notes-file", notes] : ["--notes", `UE-MCP Studio ${version}.`];
  const files = [zipName, "latest.json", ...pluginZips].map((f) => path.join(OUT, f));
  run("gh", ["release", "create", tag, "--repo", PUBLIC_REPO, "--title", tag, "--latest", ...notesArgs, ...files]);
  const pre = version.includes("-") ? ["--prerelease"] : [];
  run("gh", ["release", "create", tag, "--repo", PRIVATE_REPO, "--title", tag, "--target", "main", ...pre, ...notesArgs, ...files]);
  console.log(`published ${tag} to ${PUBLIC_REPO} and ${PRIVATE_REPO}`);
}
