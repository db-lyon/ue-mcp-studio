// Compare the mobile app with the web client, scenario by scenario, pixel by pixel.
//
//   node scripts/visual-qa.mjs --remote --widths 390 --out <web>     (the reference, once per change to client-web)
//   node scripts/parity-mobile.mjs --web <web> [--web-computer <computer shots>] [--out <dir>] [--only <scenario,prefix*,...>] [--themes ue-mcp,editor,editor-orange] [--owner chat,shell]
//   node scripts/parity-mobile.mjs --list                                (the scenarios and who owns each)
//
// Serves apps/mobile/visual-qa with Vite: the app's own screens, drawn by
// react-native-web against the same fixture daemon the web harness answers from
// (apps/client-web/src/visual-qa/daemon.ts), at 390 pixels wide and the
// scenario's height. Each shot is diffed against <web>/<scenario>-<theme>-390.png
// with pixelmatch. <out>/index.md lists every scenario with its mismatch, and
// <out>/<scenario>-<theme>.png puts web, app and the difference side by side.
// A scenario missing from apps/mobile/visual-qa/parity.ts fails the run.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "apps", "mobile");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const list = process.argv.includes("--list");
const webDir = arg("web") ? path.resolve(arg("web")) : null;
// Scenarios whose reference is the computer's own capture (parity.ts reference: "computer"): node scripts/visual-qa.mjs --widths 390 without --remote.
const computerDir = arg("web-computer") ? path.resolve(arg("web-computer")) : webDir;
const out = path.resolve(arg("out") ?? path.join(os.tmpdir(), "studio-mobile-parity"));
const only = arg("only")?.split(",");
const THEMES = (arg("themes") ?? "ue-mcp,editor-orange,editor").split(",");
const owners = arg("owner")?.split(",");
const WIDTH = 390;
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
if (!list && !webDir) throw new Error("pass --web <dir> with the web client's shots (node scripts/visual-qa.mjs --remote --widths 390 --out <dir>)");

const { createServer } = await import("vite");
const { chromium } = await import("playwright-core");
const { PNG } = await import("pngjs");
const pixelmatch = (await import("pixelmatch")).default;

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
      // The library's web build: its elements drawn as DOM svg, as the web client draws its glyphs.
      { find: /^react-native-svg$/, replacement: path.join(app, "node_modules/react-native-svg/lib/module/elements.web.js") },
      { find: "@react-native/assets-registry/registry", replacement: mock("assets-registry.ts") },
      // Android only: the touch sound the web build never plays.
      { find: /fabric\/NativeSvgSoundModule(\.js)?$/, replacement: mock("svg-sound.ts") },
      { find: /^expo-secure-store$/, replacement: mock("secure-store.ts") },
      { find: /^expo-camera$/, replacement: mock("camera.tsx") },
      { find: /^expo-crypto$/, replacement: mock("crypto.ts") },
      { find: /^expo-(constants|application)$/, replacement: mock("expo-modules.ts") },
      { find: /^expo-font$/, replacement: mock("expo-font.ts") },
      { find: new RegExp("^@expo-google-fonts/.*$"), replacement: mock("google-fonts.ts") },
      { find: /^expo-status-bar$/, replacement: mock("status-bar.tsx") },
      { find: /^react-native-safe-area-context$/, replacement: mock("safe-area.tsx") },
      { find: /^react-native-svg$/, replacement: mock("svg-web.tsx") },
      { find: /^expo-image-picker$/, replacement: mock("image-picker.ts") },
      { find: /^expo-document-picker$/, replacement: mock("document-picker.ts") },
      { find: /^expo-clipboard$/, replacement: mock("clipboard.ts") },
      { find: /^@ue-mcp-studio\/(remote|client-core|shared|extension-api)$/, replacement: `${root}/packages/$1/src/index.ts` },
    ],
  },
  optimizeDeps: {
    include: [mod("react"), mod("react-dom"), "react-native-web", "marked"],
    // Prebundling skips the aliases for a dependency's own relative requires: react-native-svg's Android touch sound.
    esbuildOptions: { plugins: [{ name: "svg-sound", setup: (b) => b.onResolve({ filter: /NativeSvgSoundModule$/ }, () => ({ path: mock("svg-sound.ts") })) }] },
  },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: browserPath, headless: true });

const first = await browser.newPage();
await first.goto(`${base}/index.html?scenario=session-empty`);
await first.waitForFunction(() => window.__mobileQa, null, { timeout: 60_000 });
const { scenarios, parity } = await first.evaluate(() => window.__mobileQa);
await first.close();

const missing = Object.keys(scenarios).filter((n) => !parity[n]);
if (list) {
  for (const [n, s] of Object.entries(scenarios)) console.log(`${n}\t${parity[n]?.owner ?? (parity[n]?.notOnPhone ? "not on phone" : "MISSING")}\t${s.title}`);
  await browser.close();
  await server.close();
  process.exit(missing.length ? 1 : 0);
}

fs.mkdirSync(out, { recursive: true });
const picked = Object.keys(scenarios).filter((n) => parity[n]?.owner && (!owners || owners.includes(parity[n].owner)) && (!only || only.some((o) => (o.endsWith("*") ? n.startsWith(o.slice(0, -1)) : n === o))));

/** The app's form of a click: an element whose accessibility label or text is `what`, the first visible. A `what` ending in * matches a label by its start. */
async function press(page, what) {
  const prefix = what.endsWith("*");
  const label = (prefix ? what.slice(0, -1) : what).replace(/"/g, '\\"');
  const byLabel = page.locator(prefix ? `[aria-label^="${label}"]` : `[aria-label="${label}"]`);
  for (const h of await byLabel.all()) if (await h.isVisible()) return h.click();
  const byText = page.getByText(what, { exact: true });
  for (const h of await byText.all()) if (await h.isVisible()) return h.click();
  throw new Error(`nothing visible to press: ${what}`);
}

const rows = [];
for (const name of picked) {
  for (const theme of THEMES) {
    const height = scenarios[name].height ?? 860;
    const page = await browser.newPage({ viewport: { width: WIDTH, height }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/index.html?scenario=${encodeURIComponent(name)}&theme=${theme}`);
    await page.waitForTimeout(1500);
    for (const c of parity[name].clicks ?? []) {
      try {
        await press(page, c);
        await page.waitForTimeout(700);
      } catch (e) {
        errors.push(String(e.message ?? e));
      }
    }
    const { focus, type: typed, afterType } = parity[name];
    if (focus) {
      // A key press first, so the page treats the focus as the keyboard's.
      await page.keyboard.press("Shift");
      const el = page.locator(`[aria-label="${focus.replace(/"/g, '\\"')}"]`).first();
      if (!(await el.count())) errors.push(`nothing to focus: ${focus}`);
      else await el.focus();
      await page.waitForTimeout(200);
    }
    if (typed) {
      // Typed key by key at the end of what the element holds, as the web harness types, then left to settle.
      const el = page.locator(typed.into).first();
      if (!(await el.count())) errors.push(`nothing matched ${typed.into}`);
      else {
        await el.focus();
        await page.keyboard.press("End");
        await page.keyboard.type(typed.text, { delay: 20 });
        await page.mouse.move(1, 1);
        await page.waitForTimeout(700);
      }
    }
    for (const c of afterType?.clicks ?? []) {
      try {
        await press(page, c);
      } catch (e) {
        errors.push(String(e.message ?? e));
      }
    }
    if (afterType) {
      await page.mouse.move(1, 1);
      await page.waitForTimeout(afterType.wait);
    }
    // The web scenario's scroll: the element with this label at the top of its scroller.
    if (parity[name].scroll) {
      const target = page.locator(`[aria-label="${parity[name].scroll.replace(/"/g, '\\"')}"]`).first();
      if (await target.count()) {
        await target.evaluate((el) => el.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(300);
      } else errors.push(`nothing to scroll to: ${parity[name].scroll}`);
    }
    const appPng = path.join(out, `${name}-${theme}-app.png`);
    await page.screenshot({ path: appPng });
    await page.close();

    const webPng = path.join(parity[name].reference === "computer" ? computerDir : webDir, `${name}-${theme}-390.png`);
    let mismatch = null;
    if (fs.existsSync(webPng)) {
      const a = PNG.sync.read(fs.readFileSync(webPng));
      const b = PNG.sync.read(fs.readFileSync(appPng));
      const w = Math.min(a.width, b.width);
      const h = Math.min(a.height, b.height);
      const crop = (img) => {
        const o = new PNG({ width: w, height: h });
        PNG.bitblt(img, o, 0, 0, w, h, 0, 0);
        return o;
      };
      const ca = crop(a);
      const cb = crop(b);
      const diff = new PNG({ width: w, height: h });
      const n = pixelmatch(ca.data, cb.data, diff.data, w, h, { threshold: 0.1 });
      mismatch = n / (w * h);
      const side = new PNG({ width: w * 3 + 16, height: h });
      side.data.fill(255);
      PNG.bitblt(ca, side, 0, 0, w, h, 0, 0);
      PNG.bitblt(cb, side, 0, 0, w, h, w + 8, 0);
      PNG.bitblt(diff, side, 0, 0, w, h, w * 2 + 16, 0);
      fs.writeFileSync(path.join(out, `${name}-${theme}.png`), PNG.sync.write(side));
    }
    rows.push({ name, theme, mismatch, errors });
    console.log(`${name} ${theme}: ${mismatch === null ? "no web shot" : `${(mismatch * 100).toFixed(2)}%`}${errors.length ? `  errors: ${errors.join("; ")}` : ""}`);
  }
}

const lines = ["# Mobile parity", "", `App (react-native-web, ${WIDTH}px) against the web client as a paired browser draws it. Mismatch is the share of pixels pixelmatch finds different at threshold 0.1.`, ""];
if (missing.length) lines.push(`**Scenarios missing from apps/mobile/visual-qa/parity.ts:** ${missing.join(", ")}`, "");
lines.push("| Scenario | Theme | Mismatch | Errors |", "|---|---|---|---|");
for (const r of rows) lines.push(`| ${r.name} | ${r.theme} | ${r.mismatch === null ? "no web shot" : `${(r.mismatch * 100).toFixed(2)}%`} | ${r.errors.join("; ")} |`);
lines.push("");
for (const r of rows) if (r.mismatch !== null) lines.push(`## ${r.name} (${r.theme})`, "", `![web, app, difference](${r.name}-${r.theme}.png)`, "");
fs.writeFileSync(path.join(out, "index.md"), lines.join("\n"));
await browser.close();
await server.close();
console.log(`${rows.length} shots: ${path.join(out, "index.md")}`);
if (missing.length) {
  console.error(`missing from parity.ts: ${missing.join(", ")}`);
  process.exit(1);
}
