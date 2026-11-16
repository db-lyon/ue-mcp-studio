// The durable runtime's kill tests (#445): bundle the stand-in daemon and the
// runner, then run every scenario on every runtime. Needs `npm run build` first
// (the harness, its extension and the turn host come from apps/agent/dist).
//
// node scripts/kill-tests.mjs [--out results.json] [--runtimes loop,hosts,durable] [--scenarios stream,...]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const out = path.resolve(arg("out") ?? path.join(os.tmpdir(), "studio-kill-results.json"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-kill-build-"));
await build({
  entryPoints: {
    daemon: path.join(root, "apps", "agent", "test", "kill", "daemon-main.ts"),
    run: path.join(root, "apps", "agent", "test", "kill", "run.ts"),
    "live-claude": path.join(root, "apps", "agent", "test", "kill", "live-claude.ts"),
  },
  outdir: dir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: { __CLAUDE_SIGN_IN__: "true" },
  logLevel: "warning",
  absWorkingDir: root,
});
// --live-claude <runtime exe> <model>: the durable runtime on the real Claude sign-in instead of the matrix.
const live = process.argv.indexOf("--live-claude");
const args = live > 0
  ? [path.join(dir, "live-claude.mjs"), process.argv[live + 1], process.argv[live + 2]]
  : [path.join(dir, "run.mjs"), out, arg("runtimes") ?? "loop,hosts,durable", arg("scenarios") ?? ""];
const r = spawnSync(process.execPath, args, {
  stdio: "inherit",
  env: { ...process.env, STUDIO_AGENT_DIST: path.join(root, "apps", "agent", "dist") },
});
fs.rmSync(dir, { recursive: true, force: true });
console.log(`results: ${out}`);
process.exit(r.status ?? 1);
