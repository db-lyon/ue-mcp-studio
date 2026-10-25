// Bundle the agent into one ESM file, so an installed extension needs no node_modules.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { CLAUDE_SIGN_IN_AVAILABLE } from "@ue-mcp-studio/shared";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The Claude runtime the subscription route fetches must match the bundled SDK.
const sdkVersion = JSON.parse(fs.readFileSync(path.join(root, "apps", "agent", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf-8")).version;
fs.rmSync(path.join(root, "apps", "agent", "dist"), { recursive: true, force: true });
const result = await build({
  entryPoints: [path.join(root, "apps", "agent", "src", "index.ts")],
  outfile: path.join(root, "apps", "agent", "dist", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  // Some dependencies still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  // With the Claude sign-in off, the Agent SDK is left out of the bundle.
  define: { __CLAUDE_SDK_VERSION__: JSON.stringify(sdkVersion), __CLAUDE_SIGN_IN__: JSON.stringify(CLAUDE_SIGN_IN_AVAILABLE) },
  logLevel: "warning",
  metafile: true,
  // Metafile paths are relative to this, and scripts/notices.mjs resolves them from the root.
  absWorkingDir: root,
});
// The WebP decoder's code, which the agent loads from beside the bundle.
fs.copyFileSync(path.join(root, "node_modules", "@jsquash", "webp", "codec", "dec", "webp_dec.wasm"), path.join(root, "apps", "agent", "dist", "webp_dec.wasm"));
// The context measurement Auto reads, once one is recorded; without it Auto stays hidden.
const costs = path.join(root, "apps", "agent", "src", "context-costs.json");
if (fs.existsSync(costs)) fs.copyFileSync(costs, path.join(root, "apps", "agent", "dist", "context-costs.json"));
// Which packages went into the bundle, for the third-party notices.
fs.writeFileSync(path.join(root, "apps", "agent", "dist", "meta.json"), JSON.stringify(result.metafile));
console.log("bundled the agent into apps/agent/dist/index.js");
