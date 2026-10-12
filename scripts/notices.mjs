/**
 * Third-party notices for everything a Studio release bundles, each package
 * with its license text. The bundles drop license comments, so this file
 * carries them instead.
 *
 *   node scripts/notices.mjs    lists the packages after `npm run build`
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

/** The package directory `name` resolves to from `fromDir`, or null. */
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

/** Package directories esbuild bundled, read from its metafile. */
function bundledPackages(metafile) {
  const inputs = Object.keys(JSON.parse(fs.readFileSync(metafile, "utf-8")).inputs);
  const dirs = new Set();
  for (const input of inputs) {
    const m = input.replaceAll("\\", "/").match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (m) dirs.add(path.resolve(ROOT, m[1]));
  }
  return [...dirs];
}

/** Package directories in the runtime dependency closure of `appDir`. */
function dependencyClosure(appDir) {
  const dirs = new Set();
  const visit = (dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (dep.startsWith("@ue-mcp-studio/")) continue;
      const found = resolvePackage(dep, dir);
      if (found && !dirs.has(found)) {
        dirs.add(found);
        visit(found);
      }
    }
  };
  visit(appDir);
  return [...dirs];
}

const MIT = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** One package's entry. A package with no license file gets its declared MIT text. */
function entry(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
  const license = pkg.license ?? "UNKNOWN";
  const file = fs.readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  let text;
  if (file) text = fs.readFileSync(path.join(dir, file), "utf-8").trim();
  else if (license === "MIT") text = MIT(typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? pkg.name));
  else throw new Error(`${pkg.name}@${pkg.version} (${license}) ships no license file`);
  return { name: pkg.name, version: pkg.version, license, text };
}

/** The notices for the agent bundle and the UI, as text plus the package list. */
export function renderNotices() {
  const dirs = new Set([
    ...bundledPackages(path.join(ROOT, "apps", "agent", "dist", "meta.json")),
    ...dependencyClosure(path.join(ROOT, "apps", "client-web")),
  ]);
  const packages = [...dirs].map(entry).sort((a, b) => a.name.localeCompare(b.name));
  // studio-window.exe links the WebView2 SDK's static loader.
  const webview2 = path.join(ROOT, "apps", "window", "dist", "WebView2-LICENSE.txt");
  if (fs.existsSync(webview2)) {
    packages.push({ name: "Microsoft.Web.WebView2", version: "SDK (studio-window.exe)", license: "BSD-3-Clause", text: fs.readFileSync(webview2, "utf-8").trim() });
  }
  const bar = "=".repeat(78);
  const text = [
    "UE-MCP Studio includes the following third-party software.\n",
    ...packages.map((p) => `${bar}\n${p.name} ${p.version} (${p.license})\n${bar}\n\n${p.text}\n`),
  ].join("\n");
  return { text, packages };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  for (const p of renderNotices().packages) console.log(`${p.name}@${p.version} ${p.license}`);
}
