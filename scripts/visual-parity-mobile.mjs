// Compare the mobile app's ports with the web client, pixel by pixel, state by state.
//
//   node scripts/visual-parity-mobile.mjs [--out <dir>] [--only <pair,prefix*,...>] [--browser <chrome.exe>]
//
// Each pair names a client-web visual-qa scenario (apps/client-web/src/visual-qa/fixtures.ts)
// and the mobile scene that draws the same state (apps/mobile/visual-qa/parity.tsx). Both are
// shot at 390 pixels wide, scale 1, with a touch screen, in the ue-mcp theme. Each shot is cut to
// the part being compared (`web` selector, `mobile` testID) and the two are diffed: a pixel
// differs when a channel differs by more than 24 of 255. <out>/<pair>.png is web, mobile and the
// differing pixels in red side by side; <out>/index.md lists the share that differs, and any size
// difference, for every pair.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PAIRS } from "./visual-parity-pairs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps", "client-web");
const app = path.join(root, "apps", "mobile");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const out = path.resolve(arg("out") ?? path.join(os.tmpdir(), "studio-mobile-parity"));
const only = arg("only")?.split(",");
const BROWSERS = [arg("browser"), process.env.STUDIO_QA_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
const browserPath = BROWSERS.find((p) => fs.existsSync(p));
if (!browserPath) throw new Error("no Chrome or Edge found: pass --browser <path> or set STUDIO_QA_BROWSER");

const { createServer } = await import("vite");
const { chromium } = await import("playwright-core");
const { PNG } = await import("pngjs");

const pictures = (await import("./visual-qa-pictures.mjs")).pictures;
const webServer = await createServer({ root: web, configFile: path.join(web, "vite.config.ts"), server: { port: 0, strictPort: false }, logLevel: "warn", plugins: [pictures] });
await webServer.listen();
const webBase = webServer.resolvedUrls.local[0].replace(/\/$/, "");

const mod = (name) => path.join(app, "node_modules", name);
const mock = (name) => path.join(app, "ui-test", "mocks", name);
const appServer = await createServer({
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
      { find: /^expo-status-bar$/, replacement: mock("status-bar.tsx") },
      { find: /^react-native-safe-area-context$/, replacement: mock("safe-area.tsx") },
      { find: /^@ue-mcp-studio\/(remote|client-core|shared|extension-api)$/, replacement: `${root}/packages/$1/src/index.ts` },
    ],
  },
  optimizeDeps: { include: [mod("react"), mod("react-dom"), "react-native-web", "marked"] },
});
await appServer.listen();
const appBase = appServer.resolvedUrls.local[0].replace(/\/$/, "");

const browser = await chromium.launch({ executablePath: browserPath, headless: true });
fs.mkdirSync(out, { recursive: true });
const WIDTH = 390;

/** A shot of the element `clip` matches (a CSS selector), or of the whole window. */
async function shoot(page, clip) {
  if (!clip) return PNG.sync.read(await page.screenshot());
  const el = page.locator(clip).first();
  if (!(await el.count())) throw new Error(`nothing matched ${clip}`);
  return PNG.sync.read(await el.screenshot({ animations: "disabled" }));
}

async function webShot(pair) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: pair.height ?? 860 }, hasTouch: true });
  await page.goto(`${webBase}/visual-qa.html?scenario=${encodeURIComponent(pair.web.scenario)}&theme=ue-mcp`);
  await page.waitForSelector(".app");
  await page.waitForTimeout(1200);
  const q = await page.evaluate(() => ({ click: window.__visualQa.click, clicks: window.__visualQa.clicks ?? [], narrow: window.__visualQa.narrowClicks, scroll: window.__visualQa.scroll }));
  const clicks = pair.web.clicks ?? [q.click, ...(q.narrow ?? q.clicks)].filter(Boolean);
  for (const sel of clicks) {
    let el = null;
    for (const h of await page.$$(sel)) if (await h.isVisible()) { el = h; break; }
    if (!el) throw new Error(`web ${pair.name}: nothing visible matched ${sel}`);
    await el.click({ timeout: 5000 }).catch(() => el.click({ force: true }));
    await page.mouse.move(1, 1);
    await page.waitForTimeout(700);
  }
  if (pair.web.focus) {
    await page.keyboard.press("Shift");
    await page.focus(pair.web.focus);
    await page.waitForTimeout(200);
  }
  await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" });
  await page.waitForTimeout(100);
  const png = await shoot(page, pair.web.clip);
  await page.close();
  return png;
}

async function appShot(pair) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: pair.height ?? 860 }, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${appBase}/parity.html?scene=${encodeURIComponent(pair.mobile.scene ?? pair.name)}`);
  await page.waitForTimeout(1200);
  for (const text of pair.mobile.presses ?? []) {
    const target = text.startsWith("label=") ? page.getByLabel(text.slice(6), { exact: true }).first() : page.getByText(text, { exact: true }).first();
    await target.click();
    await page.mouse.move(1, 1);
    await page.waitForTimeout(500);
  }
  await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" });
  await page.waitForTimeout(100);
  if (errors.length) throw new Error(`mobile ${pair.name}: ${errors.join("; ")}`);
  const png = await shoot(page, pair.mobile.clip ? `[data-testid="${pair.mobile.clip}"]` : null);
  await page.close();
  return png;
}

/** Web, mobile and their differing pixels side by side, and the share that differs over the overlap. */
function compare(a, b) {
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  const gap = 8;
  const sheet = new PNG({ width: w * 3 + gap * 2, height: h });
  sheet.data.fill(0x40);
  const put = (img, x0) => {
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      const d = (y * sheet.width + x0 + x) * 4;
      img.data.copy(sheet.data, d, s, s + 4);
    }
  };
  put(a, 0);
  put(b, w + gap);
  let differ = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inA = x < a.width && y < a.height;
    const inB = x < b.width && y < b.height;
    const d = (y * sheet.width + 2 * (w + gap) + x) * 4;
    let off = !(inA && inB);
    if (!off) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      off = Math.abs(a.data[i] - b.data[j]) > 24 || Math.abs(a.data[i + 1] - b.data[j + 1]) > 24 || Math.abs(a.data[i + 2] - b.data[j + 2]) > 24;
    }
    if (off) differ++;
    const g = inA ? Math.round((a.data[(y * a.width + x) * 4] + a.data[(y * a.width + x) * 4 + 1] + a.data[(y * a.width + x) * 4 + 2]) / 9) : 0;
    sheet.data[d] = off ? 255 : g;
    sheet.data[d + 1] = off ? 40 : g;
    sheet.data[d + 2] = off ? 40 : g;
    sheet.data[d + 3] = 255;
  }
  return { sheet, share: differ / (w * h) };
}

const picked = PAIRS.filter((p) => !only || only.some((o) => (o.endsWith("*") ? p.name.startsWith(o.slice(0, -1)) : p.name === o)));
const lines = ["# Mobile parity with the web client", "", `Rendered ${new Date().toISOString()} at ${WIDTH} px, scale 1, touch, ue-mcp theme.`, "", "| Pair | Web | Mobile | Differs |", "|---|---|---|---|"];
let worst = 0;
for (const pair of picked) {
  try {
    const [a, b] = [await webShot(pair), await appShot(pair)];
    const { sheet, share } = compare(a, b);
    fs.writeFileSync(path.join(out, `${pair.name}.png`), PNG.sync.write(sheet));
    worst = Math.max(worst, share);
    lines.push(`| [${pair.name}](${pair.name}.png) | ${a.width}x${a.height} | ${b.width}x${b.height} | ${(share * 100).toFixed(2)}% |`);
    console.log(`${pair.name}: ${(share * 100).toFixed(2)}% (${a.width}x${a.height} / ${b.width}x${b.height})`);
  } catch (e) {
    lines.push(`| ${pair.name} | | | failed: ${String(e.message).replace(/\|/g, "/")} |`);
    console.log(`${pair.name}: failed: ${e.message}`);
  }
}
fs.writeFileSync(path.join(out, "index.md"), lines.join("\n") + "\n");
await browser.close();
await webServer.close();
await appServer.close();
console.log(`${picked.length} pairs, worst ${(worst * 100).toFixed(2)}%: ${path.join(out, "index.md")}`);
