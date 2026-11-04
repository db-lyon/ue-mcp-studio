// Compare the mobile app with client-web, pixel by pixel, state by state.
//
//   node scripts/visual-qa-parity.mjs --web <dir> [--out <dir>] [--only <scenario,prefix*,...>] [--themes a,b] [--browser <chrome.exe>]
//
// <dir> holds client-web's shots of its visual QA scenarios as a paired browser
// sees them at 390 pixels (node scripts/visual-qa.mjs --widths 390 --remote --grayscale-text).
// Each scenario the app maps (apps/mobile/visual-qa/parity-scenes.tsx) is drawn
// with react-native-web from the same answers, shot at the same size, and
// compared below the 50 pixel top bar the app's shell draws. <out>/index.md
// lists every scenario with the share of pixels that differ and a diff image;
// a scenario in <dir> the app does not map is listed as missing.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "apps", "mobile");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const webDir = path.resolve(arg("web") ?? path.join(os.tmpdir(), "studio-visual-qa"));
const out = path.resolve(arg("out") ?? path.join(os.tmpdir(), "studio-mobile-parity"));
const only = arg("only")?.split(",");
const THEMES = (arg("themes") ?? "ue-mcp,editor-orange,editor").split(",");
const BAR = 50;
const BROWSERS = [
  arg("browser"),
  process.env.STUDIO_QA_BROWSER,
  path.join(os.homedir(), "AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe"),
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const browserPath = BROWSERS.find((p) => fs.existsSync(p));
if (!browserPath) throw new Error("no Chrome or Edge found: pass --browser <path> or set STUDIO_QA_BROWSER");

const { createServer } = await import("vite");
const { chromium } = await import("playwright-core");

const mod = (name) => path.join(app, "node_modules", name);
const mock = (name) => path.join(app, "ui-test", "mocks", name);
const server = await createServer({
  root: path.join(app, "visual-qa"),
  configFile: false,
  logLevel: "warn",
  server: { port: 0, strictPort: false, fs: { allow: [root] } },
  define: { __DEV__: "false", "process.env.NODE_ENV": JSON.stringify("development"), "process.env.EXPO_OS": JSON.stringify("android") },
  esbuild: { jsx: "automatic" },
  resolve: {
    extensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".mjs", ".js", ".json"],
    alias: [
      { find: /^react-native$/, replacement: path.join(root, "node_modules/react-native-web/dist/index.js") },
      { find: /^react$/, replacement: mod("react") },
      { find: /^react\/(.*)$/, replacement: `${mod("react")}/$1` },
      { find: /^react-dom$/, replacement: mod("react-dom") },
      { find: /^react-dom\/(.*)$/, replacement: `${mod("react-dom")}/$1` },
      { find: /^expo-secure-store$/, replacement: mock("secure-store.ts") },
      { find: /^expo-camera$/, replacement: mock("camera.tsx") },
      { find: /^expo-crypto$/, replacement: mock("crypto.ts") },
      { find: /^expo-status-bar$/, replacement: mock("status-bar.tsx") },
      { find: /^react-native-safe-area-context$/, replacement: mock("safe-area.tsx") },
      { find: /^@ue-mcp-studio\/(remote|client-core|shared|extension-api)$/, replacement: `${root}/packages/$1/src/index.ts` },
    ],
  },
  optimizeDeps: { include: [mod("react"), mod("react-dom"), "react-native-web", "marked"] },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
fs.mkdirSync(out, { recursive: true });
// Grayscale text antialiasing, as the web shots are taken with --grayscale-text.
const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--disable-lcd-text"] });

const listing = await browser.newPage();
await listing.goto(`${base}/parity.html?scenario=plugins-remote`);
await listing.waitForFunction(() => window.__parity, null, { timeout: 60_000 });
const SCENES = await listing.evaluate(() => window.__parity.scenes);
await listing.close();

const match = (n) => !only || only.some((o) => (o.endsWith("*") ? n.startsWith(o.slice(0, -1)) : n === o));
const webShots = fs.readdirSync(webDir).filter((f) => f.endsWith("-390-remote.png"));
const webScenarios = [...new Set(webShots.map((f) => f.replace(/-(ue-mcp|editor-orange|editor)-390-remote\.png$/, "")))].filter(match).sort();
const index = ["# Mobile parity with client-web", "", `Web shots: ${webDir}`, "", "| Scenario | Theme | Differing pixels | Shots |", "|---|---|---|---|"];
const missing = webScenarios.filter((s) => !SCENES[s]);
let worst = 0;

/** Share of pixels below the bar that differ by more than a small per-channel tolerance, and a picture of where. */
function diff(a, b, file) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const d = new PNG({ width: w, height: h });
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      const k = (y * w + x) * 4;
      // Brightness, not colour fringes: client-web's text is drawn with subpixel (LCD) antialiasing and
      // react-native-web's in grayscale, so the same glyph differs only in its coloured edges.
      const la = 0.299 * a.data[i] + 0.587 * a.data[i + 1] + 0.114 * a.data[i + 2];
      const lb = 0.299 * b.data[j] + 0.587 * b.data[j + 1] + 0.114 * b.data[j + 2];
      const off = y >= BAR && Math.abs(la - lb) > 32;
      if (off) n++;
      const g = (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 9;
      d.data[k] = off ? 255 : g;
      d.data[k + 1] = off ? 0 : g;
      d.data[k + 2] = off ? 60 : g;
      d.data[k + 3] = 255;
    }
  }
  fs.writeFileSync(file, PNG.sync.write(d));
  return { share: n / (w * (h - BAR)), sizeDiffers: a.width !== b.width || a.height !== b.height };
}

for (const name of webScenarios.filter((s) => SCENES[s])) {
  for (const theme of THEMES) {
    const webFile = path.join(webDir, `${name}-${theme}-390-remote.png`);
    if (!fs.existsSync(webFile)) continue;
    const web = PNG.sync.read(fs.readFileSync(webFile));
    const page = await browser.newPage({ viewport: { width: 390, height: web.height }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/parity.html?scenario=${encodeURIComponent(name)}&theme=${theme}`);
    await page.waitForTimeout(1500);
    const scene = SCENES[name];
    for (const id of scene.clicks) {
      const el = page.locator(`[data-testid="${id}"]`).first();
      if (!(await el.count())) errors.push(`nothing has testID ${id}`);
      else {
        await el.click();
        await page.mouse.move(1, 1);
        await page.waitForTimeout(700);
      }
    }
    if (scene.type) {
      const el = page.locator(`[data-testid="${scene.type.into}"]`).first();
      await el.focus();
      await page.keyboard.type(scene.type.text, { delay: 20 });
      await page.waitForTimeout(500);
    }
    if (scene.scroll) {
      const found = await page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        el?.scrollIntoView({ block: "start" });
        return !!el;
      }, scene.scroll);
      if (!found) errors.push(`nothing has testID ${scene.scroll}`);
      await page.waitForTimeout(300);
    }
    const file = `${name}-${theme}`;
    await page.screenshot({ path: path.join(out, `${file}-app.png`) });
    await page.close();
    fs.copyFileSync(webFile, path.join(out, `${file}-web.png`));
    const shot = PNG.sync.read(fs.readFileSync(path.join(out, `${file}-app.png`)));
    const r = diff(web, shot, path.join(out, `${file}-diff.png`));
    worst = Math.max(worst, r.share);
    const pct = `${(r.share * 100).toFixed(2)}%${r.sizeDiffers ? " (sizes differ)" : ""}${errors.length ? ` errors: ${errors.join("; ")}` : ""}`;
    index.push(`| ${name} | ${theme} | ${pct} | [web](${file}-web.png) [app](${file}-app.png) [diff](${file}-diff.png) |`);
    console.log(`${file}: ${pct}`);
  }
}
index.push("", missing.length ? `## Not mapped in the app (${missing.length})\n\n${missing.map((m) => `- ${m}`).join("\n")}` : "Every web scenario in range is mapped.");
fs.writeFileSync(path.join(out, "index.md"), index.join("\n"));
await browser.close();
await server.close();
console.log(`worst ${(worst * 100).toFixed(2)}%, ${missing.length} not mapped: ${path.join(out, "index.md")}`);
