// Screenshot every screen of the mobile app in every state worth reviewing, with no relay, computer or editor.
//
//   node scripts/visual-qa-mobile.mjs [--out <dir>] [--browser <chrome.exe>] [--only <scene,prefix*,...>] [--sizes 390x844,360x740]
//
// Serves apps/mobile/visual-qa with Vite, the app's own screens rendered through
// react-native-web against fixture answers (apps/mobile/visual-qa/scenes.tsx),
// and shoots each scene at phone sizes. <out>/index.md names every file and lists
// layout problems found on the page: anything past the screen's edge, a page
// that scrolls sideways, and controls smaller than a finger.
//
// react-native-web is close to the phone, not the phone: fonts and native
// controls (Switch, the keyboard) differ. The owner's phone stays the final check.
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
const out = path.resolve(arg("out") ?? path.join(os.tmpdir(), "studio-mobile-visual-qa"));
const only = arg("only")?.split(",");
const SIZES = (arg("sizes") ?? "390x844,360x740").split(",").map((s) => s.split("x").map(Number));
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

fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
// The page lists its own scenes, so this script never has to load React Native itself.
const listing = await browser.newPage();
await listing.goto(`${base}/index.html?scene=welcome`);
await listing.waitForFunction(() => window.__scenes);
const SCENES = await listing.evaluate(() => window.__scenes);
await listing.close();
const picked = Object.keys(SCENES).filter((n) => !only || only.some((o) => (o.endsWith("*") ? n.startsWith(o.slice(0, -1)) : n === o)));
const index = ["# Mobile visual QA", "", `Rendered with react-native-web at ${SIZES.map(([w, h]) => `${w}x${h}`).join(" and ")}.`, ""];
let problems = 0;
for (const name of picked) {
  for (const [width, height] of SIZES) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/index.html?scene=${encodeURIComponent(name)}`);
    await page.waitForTimeout(700);
    const click = SCENES?.[name]?.click;
    if (click) {
      await page.getByText(click, { exact: false }).first().click();
      await page.waitForTimeout(500);
    }
    const found = await page.evaluate(() => {
      const vw = window.innerWidth;
      const out = [];
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
      };
      const label = (el) => (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 50);
      const inScroller = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const st = getComputedStyle(p);
          if ((st.overflowX === "auto" || st.overflowX === "scroll") && p.scrollWidth > p.clientWidth) return true;
        }
        return false;
      };
      if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways by ${document.documentElement.scrollWidth - vw}px`);
      for (const el of document.querySelectorAll("#root *")) {
        if (!visible(el) || inScroller(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.right > vw + 1 && r.width < vw * 3) out.push(`past the right edge by ${Math.round(r.right - vw)}px: ${label(el)}`);
      }
      // Switches are left out: react-native-web draws a small one, the phone's own is a full-size target.
      for (const el of document.querySelectorAll("[role=button], [role=tab], [role=link], input:not([type=checkbox]), textarea")) {
        if (!visible(el) || getComputedStyle(el).display === "inline") continue;
        if (el.closest("[role=button]") !== el && el.closest("[role=button]")) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 32 || r.width < 32) out.push(`small target ${Math.round(r.width)}x${Math.round(r.height)}: ${label(el)}`);
      }
      return [...new Set(out)];
    });
    const file = `${name}-${width}.png`;
    await page.screenshot({ path: path.join(out, file), fullPage: false });
    await page.close();
    const all = [...errors.map((e) => `page error: ${e}`), ...found];
    problems += all.length;
    index.push(`## ${name} (${width}x${height})`, "", `![${name}](${file})`, "", ...(all.length ? all.map((p) => `- ${p}`) : ["No layout problems found."]), "");
  }
}
fs.writeFileSync(path.join(out, "index.md"), index.join("\n"));
await browser.close();
await server.close();
console.log(`${picked.length} scenes, ${picked.length * SIZES.length} shots, ${problems} problems: ${path.join(out, "index.md")}`);
