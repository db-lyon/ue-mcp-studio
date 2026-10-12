#!/usr/bin/env node
/**
 * Build apps/window/dist/studio-window.exe, Studio's own window on Windows,
 * with MSVC and the WebView2 SDK. The SDK comes from nuget.org, pinned by
 * version and SHA-256, and is kept in apps/window/.deps. The CRT links
 * statically, so the exe needs nothing installed but the WebView2 Runtime
 * Windows ships with.
 *
 * On other platforms there is nothing to build: Studio opens in the system
 * browser there.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "apps", "window");
const DEPS = path.join(APP, ".deps");
const OUT = path.join(APP, "dist");
const WEBVIEW2 = {
  version: "1.0.4191.47",
  sha256: "f492bbf547d0da329553b6727435b677579b1e9f91cc9e4a1ad029366d5f23d0",
};

if (process.platform !== "win32") {
  console.log("studio-window.exe is Windows only; skipped");
  process.exit(0);
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).version;
if (!/^[0-9A-Za-z.-]+$/.test(version)) throw new Error(`unexpected version ${version}`);

/** The WebView2 SDK's headers and static loader, downloaded once and checked. */
async function webview2() {
  const dir = path.join(DEPS, `webview2-${WEBVIEW2.version}`);
  if (fs.existsSync(path.join(dir, "build", "native", "include", "WebView2.h"))) return dir;
  const url = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2.version}/microsoft.web.webview2.${WEBVIEW2.version}.nupkg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`downloading the WebView2 SDK answered ${res.status}`);
  const pkg = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash("sha256").update(pkg).digest("hex");
  if (got !== WEBVIEW2.sha256) throw new Error(`the WebView2 SDK download does not match its pinned SHA-256 (${got})`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const nupkg = path.join(DEPS, `webview2-${WEBVIEW2.version}.nupkg`);
  fs.writeFileSync(nupkg, pkg);
  const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-xf", nupkg, "-C", dir, "build/native/include", "build/native/x64", "LICENSE.txt"], { stdio: "inherit" });
  fs.rmSync(nupkg, { force: true });
  return dir;
}

/** vcvars64.bat of the newest Visual Studio with the C++ tools. */
function vcvars() {
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!fs.existsSync(vswhere)) throw new Error("Visual Studio was not found (no vswhere.exe); the C++ build tools are needed for studio-window.exe");
  const install = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf-8" }).trim();
  const bat = path.join(install, "VC", "Auxiliary", "Build", "vcvars64.bat");
  if (!install || !fs.existsSync(bat)) throw new Error("no Visual Studio with the C++ x64 tools was found");
  return bat;
}

const sdk = await webview2();
const obj = path.join(APP, "build");
fs.mkdirSync(obj, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const exe = path.join(OUT, "studio-window.exe");
const cl = [
  "cl", "/nologo", "/O2", "/MT", "/EHsc", "/std:c++17", "/W4", "/WX", "/permissive-", "/utf-8",
  "/DUNICODE", "/D_UNICODE", `/DSTUDIO_WINDOW_VERSION=\\"${version}\\"`,
  `/I"${path.join(sdk, "build", "native", "include")}"`,
  `/Fo"${obj}\\\\"`, `/Fe"${exe}"`,
  `"${path.join(APP, "src", "main.cpp")}"`,
  "/link", "/SUBSYSTEM:WINDOWS", "/INCREMENTAL:NO",
  `"${path.join(sdk, "build", "native", "x64", "WebView2LoaderStatic.lib")}"`,
  "user32.lib", "gdi32.lib", "ole32.lib", "shell32.lib", "advapi32.lib", "dwmapi.lib", "shlwapi.lib", "version.lib",
].join(" ");
const line = `"${vcvars()}" >nul 2>&1 && ${cl}`;
const r = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { stdio: "inherit", windowsVerbatimArguments: true });
if (r.status !== 0) throw new Error(`building studio-window.exe failed (${r.status})`);
fs.copyFileSync(path.join(sdk, "LICENSE.txt"), path.join(OUT, "WebView2-LICENSE.txt"));
console.log(`built ${path.relative(ROOT, exe)} ${version}`);

// The docked-mode protocol's unit tests, run by apps/window/test/dock.test.ts. Not shipped.
const testExe = path.join(APP, "build", "dock-test.exe");
const testCl = [
  "cl", "/nologo", "/O2", "/MT", "/EHsc", "/std:c++17", "/W4", "/WX", "/permissive-", "/utf-8",
  `/Fo"${obj}\\\\"`, `/Fe"${testExe}"`, `"${path.join(APP, "test", "dock-test.cpp")}"`,
].join(" ");
const t = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${vcvars()}" >nul 2>&1 && ${testCl}"`], { stdio: "inherit", windowsVerbatimArguments: true });
if (t.status !== 0) throw new Error(`building dock-test.exe failed (${t.status})`);
