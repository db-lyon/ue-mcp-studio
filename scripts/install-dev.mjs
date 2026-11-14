// Sign the built UI with the dev key and install the agent plus that bundle
// into ~/.ue-mcp/extensions/studio@<version>, the copy the daemon loads on start.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { signBundle } from "ue-mcp/daemon";
import { copyWindowSource } from "./window-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDist = path.join(root, "apps", "client-web", "dist");
const agentDir = path.join(root, "apps", "agent");
const keyFile = path.join(os.homedir(), ".ue-mcp-studio", "keys", "dev-ui-signing.key.pem");
const extensions = process.env.UE_MCP_EXTENSIONS_DIR ?? path.join(os.homedir(), ".ue-mcp", "extensions");

for (const [what, p] of [["UI build", webDist], ["agent build", path.join(agentDir, "dist", "index.js")], ["dev key (npm run keys:dev)", keyFile]]) {
  if (!fs.existsSync(p)) throw new Error(`missing ${what}: ${p}`);
}

// A release build trusts only the release key; installed beside a dev-signed UI, the daemon
// rejects the UI and serves the last one it can verify, so the panel silently shows an old build.
const devPub = fs.readFileSync(path.join(root, "keys", "dev-ui-signing.pub.pem"), "utf-8").trim();
const trusted = JSON.parse(fs.readFileSync(path.join(agentDir, "dist", "keys.json"), "utf-8")).map((k) => k.trim());
if (!trusted.includes(devPub)) {
  throw new Error("the agent build trusts only the release key (left by scripts/release.mjs): run npm run build -w apps/agent first");
}

const webPkg = JSON.parse(fs.readFileSync(path.join(root, "apps", "client-web", "package.json"), "utf-8"));
// A dev build sorts after the release it builds on and after every earlier dev build. The agent
// carries the same version: the daemon serves a UI bundle only up to its extension's version, and
// loads studio@<version> over the unversioned folder.
const version = `${webPkg.version}-dev.${Date.now()}`;
const target = path.join(extensions, `studio@${version}`);
const staging = `${target}.staging`;
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
fs.cpSync(path.join(agentDir, "dist"), path.join(staging, "dist"), { recursive: true });
const agentPkg = JSON.parse(fs.readFileSync(path.join(agentDir, "package.json"), "utf-8"));
fs.writeFileSync(path.join(staging, "package.json"), JSON.stringify({ ...agentPkg, version }, null, 2) + "\n");
// Runtime dependencies resolve from the workspace's node_modules.
fs.symlinkSync(path.join(root, "node_modules"), path.join(staging, "node_modules"), "junction");
fs.cpSync(webDist, path.join(staging, "ui"), { recursive: true });
const windowName = process.platform === "win32" ? "studio-window.exe" : "studio-window";
const windowExe = path.join(root, "apps", "window", "dist", windowName);
if (fs.existsSync(windowExe)) {
  fs.mkdirSync(path.join(staging, "bin"), { recursive: true });
  fs.copyFileSync(windowExe, path.join(staging, "bin", windowName));
}
// The Linux window's source, which the agent builds from where the package has no binary for this platform.
copyWindowSource(root, staging);
const manifest = signBundle(path.join(staging, "ui"), { name: "studio", version, api: { min: 1, max: 1 } }, fs.readFileSync(keyFile, "utf-8"));
fs.renameSync(staging, target);
// Earlier dev installs only; releases stay.
for (const e of fs.readdirSync(extensions, { withFileTypes: true })) {
  if (e.isDirectory() && /^studio@.+-dev\.\d+$/.test(e.name) && e.name !== path.basename(target)) {
    fs.rmSync(path.join(extensions, e.name), { recursive: true, force: true });
  }
}
console.log(`installed agent and UI ${manifest.version} (${Object.keys(manifest.files).length} files) to ${target}`);
// A project that recorded a release keeps loading it until told otherwise.
console.log(`point a project at it: npx ue-mcp extension use studio ${version} <project>`);
console.log("then restart that project's daemon: npx ue-mcp daemon stop, then any client or daemon start");
