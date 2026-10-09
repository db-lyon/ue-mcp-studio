// Write the UI public keys from keys/*.pub.pem into the agent's dist/keys.json.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keysDir = path.join(root, "keys");
const pems = fs.existsSync(keysDir)
  ? fs.readdirSync(keysDir).filter((f) => f.endsWith(".pub.pem")).sort().map((f) => fs.readFileSync(path.join(keysDir, f), "utf-8"))
  : [];
const out = path.join(root, "apps", "agent", "dist", "keys.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(pems, null, 2));
console.log(`agent trusts ${pems.length} UI key(s)`);
