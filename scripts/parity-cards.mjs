// Compare one card of a scenario between the web client and the app, pixel by pixel.
//
//   node scripts/parity-cards.mjs [--out <dir>] [--only <scenario,prefix*,...>] [--themes ue-mcp,editor-orange,editor]
//
// scripts/parity-mobile.mjs diffs whole screens, so a header a pixel taller moves
// every card under it and the diff no longer says anything about the cards. This
// draws both sides in a window tall enough that nothing scrolls, finds the card
// the scenario is about on each (CARDS below: a CSS selector on the web client, a
// testID in the app), shoots that element alone and diffs the two. The web side is
// the web client's own visual QA page as a paired browser draws it, with the
// scenario's clicks; the app side is apps/mobile/visual-qa with the clicks in
// apps/mobile/visual-qa/parity.ts. <out>/cards.md lists every card's mismatch,
// and <out>/<scenario>-<theme>-card.png puts web, app and the difference side by side.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps", "client-web");
const app = path.join(root, "apps", "mobile");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const out = path.resolve(arg("out") ?? path.join(os.tmpdir(), "studio-card-parity"));
const only = arg("only")?.split(",");
const THEMES = (arg("themes") ?? "ue-mcp,editor-orange,editor").split(",");
const WIDTH = 390;
const TALL = 3200;

/** The card each scenario is about: on the web client by selector, in the app by testID. */
const CARDS = [
  [/^approvals-waiting$/, ".approvals", "approvals"],
  [/^review-/, ".review-card", "review-card"],
  [/^checkpoints$/, ".review-panel", "review-panel"],
  [/^compaction-/, ".compaction", "compaction"],
];

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
const { PNG } = await import("pngjs");
const pixelmatch = (await import("pixelmatch")).default;

// The web client's harness, its pictures drawn as scripts/visual-qa.mjs draws them.
const pictures = {
  name: "visual-qa-pictures",
  configureServer(s) {
    s.middlewares.use((req, res, next) => {
      if (!/^\/v1\/ext\/studio\/review\/(?:thumbnails|images)\/[^/?]+/.test(req.url ?? "")) return next();
      if (/unreadable/.test(req.url)) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader("content-type", "image/svg+xml");
      if (/blank/.test(req.url)) return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#000"/></svg>`);
      const hue = [...req.url].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><radialGradient id="g" cx="0.38" cy="0.34" r="0.7"><stop offset="0" stop-color="hsl(${hue},55%,78%)"/><stop offset="0.55" stop-color="hsl(${hue},45%,42%)"/><stop offset="1" stop-color="hsl(${hue},40%,14%)"/></radialGradient></defs><rect width="256" height="256" fill="#1d1f24"/><ellipse cx="128" cy="214" rx="78" ry="12" fill="#000" opacity="0.45"/><circle cx="128" cy="124" r="86" fill="url(#g)"/></svg>`);
    });
  },
};
delete process.env.STUDIO_PROJECT;
const webServer = await createServer({ root: web, configFile: path.join(web, "vite.config.ts"), server: { port: 0, strictPort: false }, logLevel: "warn", plugins: [pictures] });
await webServer.listen();
const webBase = webServer.resolvedUrls.local[0].replace(/\/$/, "");

const mod = (name) => path.join(app, "node_modules", name);
const mock = (name) => path.join(app, "ui-test", "mocks", name);
const appServer = await createServer({
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
      { find: /^react-native-svg$/, replacement: path.join(app, "node_modules/react-native-svg/lib/module/elements.web.js") },
      { find: "@react-native/assets-registry/registry", replacement: mock("assets-registry.ts") },
      { find: /fabric\/NativeSvgSoundModule(\.js)?$/, replacement: mock("svg-sound.ts") },
      { find: /^expo-secure-store$/, replacement: mock("secure-store.ts") },
      { find: /^expo-camera$/, replacement: mock("camera.tsx") },
      { find: /^expo-crypto$/, replacement: mock("crypto.ts") },
      { find: /^expo-(constants|application)$/, replacement: mock("expo-modules.ts") },
      { find: /^expo-clipboard$/, replacement: mock("clipboard.ts") },
      { find: /^expo-font$/, replacement: mock("expo-font.ts") },
      { find: new RegExp("^@expo-google-fonts/.*$"), replacement: mock("google-fonts.ts") },
      { find: /^expo-status-bar$/, replacement: mock("status-bar.tsx") },
      { find: /^react-native-safe-area-context$/, replacement: mock("safe-area.tsx") },
      { find: /^expo-image-picker$/, replacement: mock("image-picker.ts") },
      { find: /^expo-document-picker$/, replacement: mock("document-picker.ts") },
      { find: /^@ue-mcp-studio\/(remote|client-core|shared|extension-api)$/, replacement: `${root}/packages/$1/src/index.ts` },
    ],
  },
  optimizeDeps: {
    include: [mod("react"), mod("react-dom"), "react-native-web", "marked"],
    esbuildOptions: { plugins: [{ name: "svg-sound", setup: (b) => b.onResolve({ filter: /NativeSvgSoundModule$/ }, () => ({ path: mock("svg-sound.ts") })) }] },
  },
});
await appServer.listen();
const appBase = appServer.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: browserPath, headless: true });

const first = await browser.newPage();
await first.goto(`${appBase}/index.html?scenario=session-empty`);
await first.waitForFunction(() => window.__mobileQa, null, { timeout: 60_000 });
const { scenarios, parity } = await first.evaluate(() => window.__mobileQa);
await first.close();

fs.mkdirSync(out, { recursive: true });
const cardOf = (n) => CARDS.find(([re]) => re.test(n));
const picked = Object.keys(scenarios).filter((n) => cardOf(n) && (!only || only.some((o) => (o.endsWith("*") ? n.startsWith(o.slice(0, -1)) : n === o))));

async function press(page, what) {
  const prefix = what.endsWith("*");
  const label = (prefix ? what.slice(0, -1) : what).replace(/"/g, '\\"');
  for (const h of await page.locator(prefix ? `[aria-label^="${label}"]` : `[aria-label="${label}"]`).all()) if (await h.isVisible()) return h.click();
  for (const h of await page.getByText(what, { exact: true }).all()) if (await h.isVisible()) return h.click();
  throw new Error(`nothing visible to press: ${what}`);
}

/** The web client's card, after the scenario's narrow clicks. */
async function webCard(name, theme, selector, file) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: TALL }, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${webBase}/visual-qa.html?scenario=${encodeURIComponent(name)}&theme=${theme}&remote=1`);
  await page.waitForSelector(".app");
  await page.waitForTimeout(1200);
  const q = await page.evaluate(() => ({ click: window.__visualQa.click, clicks: window.__visualQa.clicks ?? [], narrow: window.__visualQa.narrowClicks }));
  for (const sel of [q.click, ...(q.narrow ?? q.clicks)].filter(Boolean)) {
    let el = null;
    for (const h of await page.$$(sel)) if (await h.isVisible()) { el = h; break; }
    if (!el) errors.push(`web: nothing visible matched ${sel}`);
    else {
      await el.click({ timeout: 5000 }).catch(() => el.click({ force: true }));
      await page.mouse.move(1, 1);
      await page.waitForTimeout(700);
    }
  }
  const el = page.locator(selector).first();
  if (!(await el.count())) errors.push(`web: no ${selector}`);
  else await el.screenshot({ path: file, animations: "disabled" });
  await page.close();
  return errors;
}

/** The app's card, after the parity inventory's clicks. */
async function appCard(name, theme, testId, file) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: TALL }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${appBase}/index.html?scenario=${encodeURIComponent(name)}&theme=${theme}`);
  await page.waitForTimeout(1500);
  for (const c of parity[name]?.clicks ?? []) {
    try {
      await press(page, c);
      await page.waitForTimeout(700);
    } catch (e) {
      errors.push(`app: ${e.message ?? e}`);
    }
  }
  await page.waitForTimeout(500);
  const el = page.locator(`[data-testid="${testId}"]`).first();
  if (!(await el.count())) errors.push(`app: no testID ${testId}`);
  else await el.screenshot({ path: file });
  await page.close();
  return errors;
}

const rows = [];
for (const name of picked) {
  const [, selector, testId] = cardOf(name);
  for (const theme of THEMES) {
    const webPng = path.join(out, `${name}-${theme}-web-card.png`);
    const appPng = path.join(out, `${name}-${theme}-app-card.png`);
    for (const f of [webPng, appPng]) fs.rmSync(f, { force: true });
    const errors = [...(await webCard(name, theme, selector, webPng)), ...(await appCard(name, theme, testId, appPng))];
    let mismatch = null;
    let size = "";
    if (fs.existsSync(webPng) && fs.existsSync(appPng)) {
      const a = PNG.sync.read(fs.readFileSync(webPng));
      const b = PNG.sync.read(fs.readFileSync(appPng));
      size = `${a.width}x${a.height} / ${b.width}x${b.height}`;
      // The larger of the two, each drawn on the page's background, so a card that is taller or shorter counts every row it adds or loses.
      const w = Math.max(a.width, b.width);
      const h = Math.max(a.height, b.height);
      const pad = (img) => {
        const o = new PNG({ width: w, height: h });
        for (let i = 0; i < o.data.length; i += 4) o.data.set([255, 0, 255, 255], i);
        PNG.bitblt(img, o, 0, 0, img.width, img.height, 0, 0);
        return o;
      };
      const ca = pad(a);
      const cb = pad(b);
      const diff = new PNG({ width: w, height: h });
      mismatch = pixelmatch(ca.data, cb.data, diff.data, w, h, { threshold: 0.1 }) / (w * h);
      const side = new PNG({ width: w * 3 + 16, height: h });
      side.data.fill(255);
      PNG.bitblt(ca, side, 0, 0, w, h, 0, 0);
      PNG.bitblt(cb, side, 0, 0, w, h, w + 8, 0);
      PNG.bitblt(diff, side, 0, 0, w, h, w * 2 + 16, 0);
      fs.writeFileSync(path.join(out, `${name}-${theme}-card.png`), PNG.sync.write(side));
    }
    rows.push({ name, theme, mismatch, size, errors });
    console.log(`${name} ${theme}: ${mismatch === null ? "no shot" : `${(mismatch * 100).toFixed(2)}%`} ${size}${errors.length ? `  errors: ${errors.join("; ")}` : ""}`);
  }
}

const lines = ["# Card parity", "", "Each scenario's card alone, web client (paired browser) against the app, in a window tall enough that nothing scrolls. Mismatch is the share of pixels pixelmatch finds different at threshold 0.1, over the larger of the two cards.", "", "| Scenario | Theme | Mismatch | Size (web / app) | Errors |", "|---|---|---|---|---|"];
for (const r of rows) lines.push(`| ${r.name} | ${r.theme} | ${r.mismatch === null ? "no shot" : `${(r.mismatch * 100).toFixed(2)}%`} | ${r.size} | ${r.errors.join("; ")} |`);
fs.writeFileSync(path.join(out, "cards.md"), lines.join("\n") + "\n");
await browser.close();
await webServer.close();
await appServer.close();
console.log(`${rows.length} cards: ${path.join(out, "cards.md")}`);
