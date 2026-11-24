// Write the UI public keys (keys/*.pub.pem plus this machine's dev public key) into the agent's dist/keys.json.
// STUDIO_RELEASE=1 keeps only the release key, so a shipped agent never trusts the dev key.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keysDir = path.join(root, "keys");
const pems = fs.existsSync(keysDir)
  ? fs.readdirSync(keysDir).filter((f) => f.endsWith(".pub.pem") && (process.env.STUDIO_RELEASE !== "1" || f.startsWith("release-"))).sort().map((f) => fs.readFileSync(path.join(keysDir, f), "utf-8"))
  : [];
// The dev public key lives beside the private key, per machine. Absent, the dev key is not trusted.
const devPub = path.join(os.homedir(), ".ue-mcp-studio", "keys", "dev-ui-signing.pub.pem");
if (process.env.STUDIO_RELEASE !== "1" && fs.existsSync(devPub)) pems.push(fs.readFileSync(devPub, "utf-8"));
const out = path.join(root, "apps", "agent", "dist", "keys.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(pems, null, 2));
console.log(`agent trusts ${pems.length} UI key(s)`);
