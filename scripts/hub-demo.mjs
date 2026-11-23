// Serve the Playtest Hub demo: the real Studio UI against a simulated daemon in the page, with no
// daemon and no editor (apps/client-web/src/hub-demo).
//
//   node scripts/hub-demo.mjs [--port <n>] [--seed full|empty|fresh]
//
// Prints the address to open, and serves until stopped with Ctrl+C.
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps", "client-web");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const seed = arg("seed");

// The page answers /v1 itself: no proxy to a project's daemon.
delete process.env.STUDIO_PROJECT;
const { createServer } = await import("vite");
const server = await createServer({ root: web, configFile: path.join(web, "vite.config.ts"), server: { port: Number(arg("port") ?? 5180), strictPort: false }, logLevel: "warn" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const url = `${base}/hub-demo.html${seed ? `?seed=${seed}` : ""}#/playtests`;
console.log(`Playtest Hub demo: ${url}`);
console.log("Projects: ?seed=full (default), ?seed=empty, ?seed=fresh. Add &reset=1 to start one over. Ctrl+C stops the server.");
