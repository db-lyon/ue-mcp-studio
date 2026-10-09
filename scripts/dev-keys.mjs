// Make the dev UI signing key pair. The private key never enters the repo.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateFile = path.join(os.homedir(), ".ue-mcp-studio", "keys", "dev-ui-signing.key.pem");
const publicFile = path.join(root, "keys", "dev-ui-signing.pub.pem");
if (fs.existsSync(privateFile) && fs.existsSync(publicFile)) {
  console.log(`dev keys exist: ${privateFile}`);
  process.exit(0);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
fs.mkdirSync(path.dirname(privateFile), { recursive: true });
fs.writeFileSync(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
fs.mkdirSync(path.dirname(publicFile), { recursive: true });
fs.writeFileSync(publicFile, publicKey.export({ type: "spki", format: "pem" }));
console.log(`wrote ${privateFile} and ${publicFile}`);
