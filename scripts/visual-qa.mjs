// Screenshot the playtest UI, the review card and Settings in every state, theme and width, with no daemon and no editor.
//
//   node scripts/visual-qa.mjs [--out <dir>] [--browser <chrome.exe>] [--only <scenario,prefix*,...>] [--widths <px,px,...>]
//
// Serves apps/client-web with Vite (no proxy) and opens visual-qa.html, the real app
// with the daemon answered from apps/client-web/src/visual-qa/fixtures.ts. Each
// scenario is shot in the ue-mcp, editor-orange and editor themes at 1280 and 380
// pixels wide, and <out>/index.md names every file. Infinite animations are frozen
// for the shot, so a pulsing bar is drawn at full strength.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps", "client-web");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const out = path.resolve(arg("out") ?? path.join(os.tmpdir(), "studio-visual-qa"));
const only = arg("only")?.split(",");
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

const THEMES = ["ue-mcp", "editor-orange", "editor"];
// --widths 320,590,1280 shoots those widths instead, each file named by its width.
const WIDTHS = arg("widths") ? arg("widths").split(",").map((w) => [`${Number(w)}`, Number(w)]) : [["wide", 1280], ["narrow", 380]];

const { createServer } = await import("vite");
const { chromium } = await import("playwright-core");

delete process.env.STUDIO_PROJECT;
/**
 * Pictures the fixtures name: a review thumbnail, a captured review image or a
 * playtest capture, drawn as a shaded sphere whose hue comes from the id. An id
 * with "unreadable" in it answers 404, as a file the agent lost would.
 */
const pictures = {
  name: "visual-qa-pictures",
  configureServer(s) {
    s.middlewares.use((req, res, next) => {
      const m = /^\/v1\/ext\/studio\/(?:review\/(?:thumbnails|images)\/[^/?]+|qa\/runs\/[^?]+\/captures\/\d+)/.exec(req.url ?? "");
      if (!m) return next();
      // A run id with "unreadable-<n>" in it loses only its capture n.
      const lost = /unreadable(?:-(\d+))?/.exec(req.url);
      if (lost && (lost[1] === undefined || req.url.endsWith(`/captures/${lost[1]}`))) {
        res.statusCode = 404;
        return res.end();
      }
      const hue = [...req.url].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
      res.setHeader("content-type", "image/svg+xml");
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><radialGradient id="g" cx="0.38" cy="0.34" r="0.7"><stop offset="0" stop-color="hsl(${hue},55%,78%)"/><stop offset="0.55" stop-color="hsl(${hue},45%,42%)"/><stop offset="1" stop-color="hsl(${hue},40%,14%)"/></radialGradient></defs><rect width="256" height="256" fill="#1d1f24"/><ellipse cx="128" cy="214" rx="78" ry="12" fill="#000" opacity="0.45"/><circle cx="128" cy="124" r="86" fill="url(#g)"/></svg>`);
    });
  },
};
const server = await createServer({ root: web, configFile: path.join(web, "vite.config.ts"), server: { port: 0, strictPort: false }, logLevel: "warn", plugins: [pictures] });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
fs.mkdirSync(out, { recursive: true });

const open = async (scenario, theme, width, height = 860) => {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/visual-qa.html?scenario=${encodeURIComponent(scenario)}&theme=${theme}`);
  await page.waitForSelector(".app");
  await page.waitForTimeout(1200);
  return { page, errors };
};

try {
  const first = await open("session-empty", "ue-mcp", 1280);
  const scenarios = await first.page.evaluate(() => window.__visualQa.scenarios);
  const heights = await first.page.evaluate(() => window.__visualQa.heights);
  await first.page.close();
  const lines = ["# Studio visual QA", "", `Rendered ${new Date().toISOString()} from apps/client-web/src/visual-qa/fixtures.ts, no daemon and no editor.`, ""];
  for (const [scenario, title] of Object.entries(scenarios)) {
    if (only && !only.some((o) => (o.endsWith("*") ? scenario.startsWith(o.slice(0, -1)) : o === scenario))) continue;
    lines.push(`## ${scenario}`, "", title, "");
    for (const theme of THEMES) for (const [label, width] of WIDTHS) {
      const { page, errors } = await open(scenario, theme, width, heights[scenario] ?? 860);
      // The app scrolls inside its own panel, so a tall section is shot in a tall window instead.
      if (await page.evaluate(() => window.__visualQa.fullPage)) {
        await page.setViewportSize({ width, height: 2600 });
        await page.waitForTimeout(400);
      }
      const { click, clicks } = await page.evaluate(() => ({ click: window.__visualQa.click, clicks: window.__visualQa.clicks ?? [] }));
      for (const sel of [click, ...clicks].filter(Boolean)) {
        const el = await page.$(sel);
        if (!el) errors.push(`nothing matched ${sel}`);
        else {
          await el.click();
          await page.mouse.move(1, 1);
          await page.waitForTimeout(700);
        }
      }
      const scroll = await page.evaluate(() => window.__visualQa.scroll);
      if (scroll) {
        const found = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          el?.scrollIntoView({ block: "start" });
          return !!el;
        }, scroll);
        if (!found) errors.push(`nothing matched ${scroll}`);
        await page.waitForTimeout(200);
      }
      const focus = await page.evaluate(() => window.__visualQa.focus);
      if (focus) {
        // A key press first, so the browser draws focus as it does for the keyboard.
        await page.keyboard.press("Shift");
        if (!(await page.$(focus))) errors.push(`nothing matched ${focus}`);
        else await page.focus(focus);
        await page.waitForTimeout(200);
      }
      const typed = await page.evaluate(() => window.__visualQa.type);
      if (typed) {
        // Typed key by key at the end of what the box holds, as a person would, then left to settle.
        if (!(await page.$(typed.into))) errors.push(`nothing matched ${typed.into}`);
        else {
          await page.focus(typed.into);
          await page.keyboard.press("End");
          await page.keyboard.type(typed.text, { delay: 20 });
          await page.mouse.move(1, 1);
          await page.waitForTimeout(700);
        }
      }
      const file = `${scenario}-${theme}-${label}.png`;
      await page.screenshot({ path: path.join(out, file), animations: "disabled" });
      lines.push(`- [${theme}, ${label} (${width}px)](${file})${errors.length ? ` errors: ${errors.join("; ")}` : ""}`);
      console.log(`${file}${errors.length ? `  errors: ${errors.join("; ")}` : ""}`);
      await page.close();
    }
    lines.push("");
  }
  fs.writeFileSync(path.join(out, "index.md"), lines.join("\n"));
  console.log(`wrote ${path.join(out, "index.md")}`);
} finally {
  await browser.close();
  await server.close();
}
