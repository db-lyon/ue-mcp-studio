// Sign the built UI with the dev key and install the agent plus that bundle
// into ~/.ue-mcp/extensions/studio, where the daemon loads it on start.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { signBundle } from "ue-mcp/daemon";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDist = path.join(root, "apps", "client-web", "dist");
const agentDir = path.join(root, "apps", "agent");
const keyFile = path.join(os.homedir(), ".ue-mcp-studio", "keys", "dev-ui-signing.key.pem");
const target = process.env.UE_MCP_EXTENSIONS_DIR
  ? path.join(process.env.UE_MCP_EXTENSIONS_DIR, "studio")
  : path.join(os.homedir(), ".ue-mcp", "extensions", "studio");

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
const staging = `${target}.staging`;
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
fs.cpSync(path.join(agentDir, "dist"), path.join(staging, "dist"), { recursive: true });
fs.copyFileSync(path.join(agentDir, "package.json"), path.join(staging, "package.json"));
// Runtime dependencies resolve from the workspace's node_modules.
fs.symlinkSync(path.join(root, "node_modules"), path.join(staging, "node_modules"), "junction");
fs.cpSync(webDist, path.join(staging, "ui"), { recursive: true });
// A dev build sorts after the release it builds on and after every earlier dev build.
const version = `${webPkg.version}-dev.${Date.now()}`;
const manifest = signBundle(path.join(staging, "ui"), { name: "studio", version, api: { min: 1, max: 1 } }, fs.readFileSync(keyFile, "utf-8"));
fs.rmSync(target, { recursive: true, force: true });
fs.renameSync(staging, target);
console.log(`installed agent and UI ${manifest.version} (${Object.keys(manifest.files).length} files) to ${target}`);
console.log("restart the project's daemon to load it: npx ue-mcp daemon stop, then any client or daemon start");
