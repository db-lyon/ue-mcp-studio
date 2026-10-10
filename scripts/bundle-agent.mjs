// Bundle the agent into one ESM file, so an installed extension needs no node_modules.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  logLevel: "warning",
  metafile: true,
});
// Which packages went into the bundle, for the third-party notices.
fs.writeFileSync(path.join(root, "apps", "agent", "dist", "meta.json"), JSON.stringify(result.metafile));
console.log("bundled the agent into apps/agent/dist/index.js");
