// Compare a session scenario's playtest cards, card by card, between the web client and the app.
//
//   node scripts/parity-cards-mobile.mjs [--out <dir>] [--only <scenario,prefix*,...>] [--themes ue-mcp,editor,editor-orange]
//
// In a session the chat screen draws the cards, so this draws them on their own
// (apps/mobile/visual-qa/cards.tsx, ?cards=1) and cuts the web client's cards out of its
// transcript (.thread-stage .qa-card), each after the scenario's clicks (web) and the presses
// apps/mobile/visual-qa/parity.ts gives it (app). Each pair is diffed with pixelmatch at
// threshold 0.1; <out>/<scenario>-<theme>-<n>.png puts web, app and the difference side by side.
// Both are shot 2600 pixels tall, so a long open card is drawn whole rather than scrolled.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "apps", "mobile");
const web = path.join(root, "apps", "client-web");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const out = path.resolve(arg("out") ?? path.join(os.tmpdir(), "studio-mobile-cards"));
const only = arg("only")?.split(",");
const THEMES = (arg("themes") ?? "ue-mcp,editor-orange,editor").split(",");
const WIDTH = 390;
const BROWSERS = [arg("browser"), process.env.STUDIO_QA_BROWSER, path.join(os.homedir(), "AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe"), "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
const browserPath = BROWSERS.find((p) => fs.existsSync(p));
if (!browserPath) throw new Error("no Chrome or Edge found: pass --browser <path> or set STUDIO_QA_BROWSER");

/** Scenarios whose session holds playtest cards. */
const CARDS = ["draft", "draft-asset-links", "armed", "running", "waiting", "waiting-open", "focus-step-bar", "focus-verdict", "finished-failures", "finished-failures-open", "stopped", "agent-captures", "loop-running", "loop-needs-you", "waiting-remote", "loop-needs-you-open", "strip-two-need-you", "strip-several"];

const { createServer } = await import("vite");
const { chromium } = await import("playwright-core");
const { PNG } = await import("pngjs");
const pixelmatch = (await import("pixelmatch")).default;
const { pictures } = await import("./visual-qa-pictures.mjs");

const mod = (name) => path.join(app, "node_modules", name);
const mock = (name) => path.join(app, "ui-test", "mocks", name);
const server = await createServer({
  root: path.join(app, "visual-qa"),
  configFile: false,
  logLevel: "warn",
  plugins: [pictures],
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
      { find: /^expo-font$/, replacement: mock("expo-font.ts") },
      { find: new RegExp("^@expo-google-fonts/.*$"), replacement: mock("google-fonts.ts") },
      { find: /^expo-status-bar$/, replacement: mock("status-bar.tsx") },
      { find: /^react-native-safe-area-context$/, replacement: mock("safe-area.tsx") },
      { find: /^@ue-mcp-studio\/(remote|client-core|shared|extension-api)$/, replacement: `${root}/packages/$1/src/index.ts` },
    ],
  },
  optimizeDeps: { include: [mod("react"), mod("react-dom"), "react-native-web", "marked"] },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const webServer = await createServer({ root: web, configFile: path.join(web, "vite.config.ts"), server: { port: 0, strictPort: false }, logLevel: "warn", plugins: [pictures] });
await webServer.listen();
const webBase = webServer.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: browserPath, headless: true });

const first = await browser.newPage();
await first.goto(`${base}/index.html?scenario=session-empty`);
await first.waitForFunction(() => window.__mobileQa, null, { timeout: 120_000 });
const { parity } = await first.evaluate(() => window.__mobileQa);
await first.close();

const picked = CARDS.filter((n) => !only || only.some((o) => (o.endsWith("*") ? n.startsWith(o.slice(0, -1)) : n === o)));
fs.mkdirSync(out, { recursive: true });
const still = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

async function press(page, what) {
  const byLabel = page.locator(`[aria-label="${what.replace(/"/g, '\\"')}"]`);
  for (const h of await byLabel.all()) if (await h.isVisible()) return h.click();
  const byText = page.getByText(what, { exact: true });
  for (const h of await byText.all()) if (await h.isVisible()) return h.click();
  throw new Error(`nothing visible to press: ${what}`);
}

async function webCards(name, theme) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 2600 }, hasTouch: true });
  await page.goto(`${webBase}/visual-qa.html?scenario=${encodeURIComponent(name)}&theme=${theme}&remote=1`);
  await page.waitForSelector(".app", { timeout: 120_000 });
  await page.waitForTimeout(1200);
  const q = await page.evaluate(() => ({ click: window.__visualQa.click, clicks: window.__visualQa.clicks ?? [], narrow: window.__visualQa.narrowClicks, focus: window.__visualQa.focus }));
  for (const sel of [q.click, ...(q.narrow ?? q.clicks)].filter(Boolean)) {
    let el = null;
    for (const h of await page.$$(sel)) if (await h.isVisible()) { el = h; break; }
    if (!el) continue;
    await el.click({ timeout: 5000 }).catch(() => el.click({ force: true }));
    await page.mouse.move(1, 1);
    await page.waitForTimeout(700);
  }
  if (q.focus) {
    await page.keyboard.press("Shift");
    await page.focus(q.focus).catch(() => undefined);
    await page.waitForTimeout(200);
  }
  await page.addStyleTag({ content: still });
  const shots = [];
  for (const el of await page.locator(".thread-stage .qa-card").all()) shots.push(PNG.sync.read(await el.screenshot()));
  await page.close();
  return shots;
}

async function appCards(name, theme, errors) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 2600 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/index.html?scenario=${encodeURIComponent(name)}&theme=${theme}&cards=1`);
  await page.waitForTimeout(1500);
  for (const c of parity[name]?.clicks ?? []) {
    try {
      await press(page, c);
      await page.waitForTimeout(700);
    } catch (e) {
      errors.push(String(e.message ?? e));
    }
  }
  await page.addStyleTag({ content: still });
  const shots = [];
  for (const el of await page.locator('[data-testid^="qa-card-"]').all()) shots.push(PNG.sync.read(await el.screenshot()));
  await page.close();
  return shots;
}

const rows = [];
for (const name of picked) {
  for (const theme of THEMES) {
    const errors = [];
    const a = await webCards(name, theme);
    const b = await appCards(name, theme, errors);
    if (a.length !== b.length) errors.push(`web has ${a.length} cards, app ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const w = Math.max(a[i].width, b[i].width);
      const h = Math.max(a[i].height, b[i].height);
      const pad = (img) => {
        const o = new PNG({ width: w, height: h });
        PNG.bitblt(img, o, 0, 0, img.width, img.height, 0, 0);
        return o;
      };
      const ca = pad(a[i]);
      const cb = pad(b[i]);
      const diff = new PNG({ width: w, height: h });
      const n = pixelmatch(ca.data, cb.data, diff.data, w, h, { threshold: 0.1 });
      const side = new PNG({ width: w * 3 + 16, height: h });
      side.data.fill(255);
      PNG.bitblt(ca, side, 0, 0, w, h, 0, 0);
      PNG.bitblt(cb, side, 0, 0, w, h, w + 8, 0);
      PNG.bitblt(diff, side, 0, 0, w, h, w * 2 + 16, 0);
      fs.writeFileSync(path.join(out, `${name}-${theme}-${i + 1}.png`), PNG.sync.write(side));
      const size = a[i].height === b[i].height && a[i].width === b[i].width ? "" : `web ${a[i].width}x${a[i].height}, app ${b[i].width}x${b[i].height}`;
      rows.push({ name, theme, card: i + 1, mismatch: n / (w * h), size, errors });
      console.log(`${name} ${theme} card ${i + 1}: ${((n / (w * h)) * 100).toFixed(2)}%${size ? ` (${size})` : ""}${errors.length ? `  errors: ${errors.join("; ")}` : ""}`);
    }
    if (!a.length || !b.length) {
      rows.push({ name, theme, card: 0, mismatch: null, size: "", errors });
      console.log(`${name} ${theme}: ${errors.join("; ") || "no cards"}`);
    }
  }
}
const lines = ["# Playtest cards: app against web", "", "Mismatch is the share of pixels pixelmatch finds different at threshold 0.1.", "", "| Scenario | Theme | Card | Mismatch | Size | Errors |", "|---|---|---|---|---|---|"];
for (const r of rows) lines.push(`| ${r.name} | ${r.theme} | ${r.card} | ${r.mismatch === null ? "" : `${(r.mismatch * 100).toFixed(2)}%`} | ${r.size} | ${r.errors.join("; ")} |`);
fs.writeFileSync(path.join(out, "index.md"), lines.join("\n") + "\n");
await browser.close();
await server.close();
await webServer.close();
console.log(`${rows.length} cards: ${path.join(out, "index.md")}`);
