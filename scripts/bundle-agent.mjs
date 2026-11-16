// Bundle the agent into one ESM file, so an installed extension needs no node_modules.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { CLAUDE_SIGN_IN_AVAILABLE } from "@ue-mcp-studio/shared";
import { patchClaudeCodeStream } from "./pi-claude-code-patch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The Claude runtime the Claude sign-in fetches, as the agent's package.json pins it.
const sdkVersion = JSON.parse(fs.readFileSync(path.join(root, "apps", "agent", "package.json"), "utf-8")).claudeRuntime;
if (!/^\d+\.\d+\.\d+/.test(sdkVersion ?? "")) throw new Error("apps/agent/package.json pins no claudeRuntime");
fs.rmSync(path.join(root, "apps", "agent", "dist"), { recursive: true, force: true });
const result = await build({
  entryPoints: {
    // The extension.
    index: path.join(root, "apps", "agent", "src", "index.ts"),
    // The durable harness: one long-lived process per project that owns its Pi Durable storage.
    "durable-harness": path.join(root, "apps", "agent", "src", "durable", "harness-main.ts"),
    // Studio's extension alone, which a harness an older Studio started installs over its own.
    "durable-extension": path.join(root, "apps", "agent", "src", "durable", "extension.ts"),
  },
  // pi-claude-code ships as TypeScript source from its pinned commit: only the durable harness imports it, by this name.
  plugins: [{
    name: "pi-claude-code",
    setup(b) {
      b.onResolve({ filter: /^studio-pi-claude-code$/ }, () => ({ path: path.join(root, "node_modules", "@earendil-works", "pi-claude-code", "src", "provider.ts") }));
      // Its request body goes through onPayload, as every pi-ai API's does (scripts/pi-claude-code-patch.mjs).
      b.onLoad({ filter: /pi-claude-code[\\/]src[\\/]stream\.ts$/ }, (args) => ({ contents: patchClaudeCodeStream(fs.readFileSync(args.path, "utf-8")), loader: "ts" }));
    },
  }],
  outdir: path.join(root, "apps", "agent", "dist"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  // Some dependencies still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  // The Claude runtime's version, and whether this build offers the Claude sign-in.
  define: { __CLAUDE_SDK_VERSION__: JSON.stringify(sdkVersion), __CLAUDE_SIGN_IN__: JSON.stringify(CLAUDE_SIGN_IN_AVAILABLE) },
  logLevel: "warning",
  metafile: true,
  // Metafile paths are relative to this, and scripts/notices.mjs resolves them from the root.
  absWorkingDir: root,
});
// The WebP decoder's code, which the agent loads from beside the bundle.
fs.copyFileSync(path.join(root, "node_modules", "@jsquash", "webp", "codec", "dec", "webp_dec.wasm"), path.join(root, "apps", "agent", "dist", "webp_dec.wasm"));
// pi-claude-code starts this script beside its own module, which in the bundle is dist/durable-harness.js.
fs.copyFileSync(path.join(root, "node_modules", "@earendil-works", "pi-claude-code", "src", "inert-mcp.mjs"), path.join(root, "apps", "agent", "dist", "inert-mcp.mjs"));
// Which packages went into the bundle, for the third-party notices.
fs.writeFileSync(path.join(root, "apps", "agent", "dist", "meta.json"), JSON.stringify(result.metafile));
console.log("bundled the agent into apps/agent/dist/index.js, dist/durable-harness.js and dist/durable-extension.js");
