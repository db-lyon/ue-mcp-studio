// Screenshot the playtest UI, the review card and Settings in every state, theme and width, with no daemon and no editor.
//
//   node scripts/visual-qa.mjs [--out <dir>] [--browser <chrome.exe>] [--only <scenario,prefix*,...>] [--widths <px,px,...>] [--remote]
//
// --remote draws every scenario as a paired browser sees it through the relay: the
// reference scripts/parity-mobile.mjs compares the mobile app against.
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

const THEMES = arg("themes") ? arg("themes").split(",") : ["ue-mcp", "editor-orange", "editor"];
// --widths 320,590,1280 shoots those widths instead, each file named by its width.
const WIDTHS = arg("widths") ? arg("widths").split(",").map((w) => [`${Number(w)}`, Number(w)]) : [["wide", 1280], ["narrow", 380]];

const { createServer } = await import("vite");
const { chromium } = await import("playwright-core");

delete process.env.STUDIO_PROJECT;
const { pictures } = await import("./visual-qa-pictures.mjs");
const server = await createServer({ root: web, configFile: path.join(web, "vite.config.ts"), server: { port: 0, strictPort: false }, logLevel: "warn", plugins: [pictures] });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
fs.mkdirSync(out, { recursive: true });

// --audit also measures each shot for what breaks on a phone, into <out>/audit.json:
// the page scrolling sideways, an element past the window's right edge, and, at
// 760 pixels and below, a control smaller than 44 pixels in either direction.
const audit = process.argv.includes("--audit");
const findings = [];
const auditPage = (page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    const label = (el) => {
      const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
      const text = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${text ? ` "${text}"` : ""}`;
    };
    // Inside a box that scrolls sideways on purpose (code, diffs, tables) nothing counts as overflow.
    const inScroller = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if ((s.overflowX === "auto" || s.overflowX === "scroll") && p.scrollWidth > p.clientWidth) return true;
        if (s.overflowX === "hidden" || s.overflowX === "clip") return true;
      }
      return false;
    };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const scrollers = [document.documentElement, ...document.querySelectorAll(".app, main, [class*=pane], [class*=scroll]")];
    for (const s of scrollers) {
      const st = getComputedStyle(s);
      if (s.scrollWidth > s.clientWidth + 1 && st.overflowX !== "hidden" && st.overflowX !== "clip" && (s === document.documentElement || st.overflowX !== "visible"))
        out.push({ kind: "page-scrolls-sideways", el: label(s), by: s.scrollWidth - s.clientWidth });
    }
    for (const el of document.querySelectorAll("body *")) {
      if (!visible(el) || inScroller(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width < vw * 3) out.push({ kind: "past-right-edge", el: label(el), by: Math.round(r.right - vw) });
      if (r.left < -1 && r.width < vw * 3) out.push({ kind: "past-left-edge", el: label(el), by: Math.round(-r.left) });
    }
    // Text cut off at a box's edge with no ellipsis to say so: a line too long for a narrow panel.
    for (const el of document.querySelectorAll("body *")) {
      // Screen-reader-only text is clipped on purpose.
      if (!visible(el) || !el.childNodes.length || el.children.length > 2 || el.classList.contains("sr-only")) continue;
      const st = getComputedStyle(el);
      if (st.overflowX !== "hidden" && st.overflowX !== "clip") continue;
      if (el.scrollWidth > el.clientWidth + 2 && st.textOverflow !== "ellipsis" && st.whiteSpace.startsWith("nowrap") && el.textContent.trim())
        out.push({ kind: "clipped-text", el: label(el), by: el.scrollWidth - el.clientWidth });
    }
    // Text squeezed so narrow it breaks after nearly every word: a column too thin to read. Only an
    // element's own text counts, and its lines are the rendered ones, so a tall button is not three lines.
    for (const el of document.querySelectorAll("body *")) {
      if (!visible(el) || ["PRE", "TEXTAREA", "CODE", "SCRIPT", "STYLE"].includes(el.tagName) || el.closest("pre")) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own.length) continue;
      const words = own.map((n) => n.textContent).join(" ").trim().split(/\s+/).filter(Boolean).length;
      if (words < 3) continue;
      const tops = new Set();
      for (const n of own) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top));
      }
      if (tops.size >= 3 && tops.size >= words * 0.75) out.push({ kind: "one-word-per-line", el: label(el), by: `${tops.size} lines, ${words} words` });
    }
    // A child that spills out of a box with a border: the box no longer holds what it draws around.
    for (const el of document.querySelectorAll("body *")) {
      if (!visible(el)) continue;
      const st = getComputedStyle(el);
      if (!(parseFloat(st.borderTopWidth) > 0 && parseFloat(st.borderBottomWidth) > 0) || st.overflowY !== "visible" || st.display === "inline") continue;
      const r = el.getBoundingClientRect();
      for (const c of el.children) {
        if (!visible(c) || getComputedStyle(c).position === "absolute" || getComputedStyle(c).position === "fixed") continue;
        const cr = c.getBoundingClientRect();
        if (cr.bottom > r.bottom + 1 || cr.top < r.top - 1) { out.push({ kind: "spills-out-of-border", el: label(el), by: `${label(c)} ${Math.round(cr.bottom - r.bottom)}px` }); break; }
      }
    }
    // The message box must stay on screen: a card above it that grows must not push it away.
    const composer = document.querySelector(".composer");
    if (composer && visible(composer)) {
      const r = composer.getBoundingClientRect();
      if (r.bottom > window.innerHeight + 1 || r.top < 0) out.push({ kind: "composer-off-screen", el: label(composer), by: Math.round(r.bottom - window.innerHeight) });
    }
    // A flex row whose content runs past the panel's right edge inside a clipping ancestor.
    for (const el of document.querySelectorAll("summary, .row, [class*=-row], [class*=-head]")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      for (const c of el.children) {
        const cr = c.getBoundingClientRect();
        if (cr.width > 0 && cr.left >= vw - 1) { out.push({ kind: "child-off-screen", el: label(c), by: Math.round(cr.left - vw) }); break; }
      }
      if (r.right > vw + 1 && el.scrollWidth > el.clientWidth + 2) out.push({ kind: "row-overflows", el: label(el), by: Math.round(r.right - vw) });
    }
    if (vw <= 760) {
      const controls = document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, summary, label:has(> input[type=checkbox]), label:has(> input[type=radio]), [role=button], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=menuitem]");
      for (const el of controls) {
        if (!visible(el) || el.closest("[aria-hidden=true]")) continue;
        // A link inside a sentence is exempt, as WCAG exempts inline targets; a box of its own is not.
        if (getComputedStyle(el).display === "inline") continue;
        if ([...(el.parentElement?.childNodes ?? [])].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        // A checkbox or radio inside its label is reached through the label, which is measured instead.
        if ((el.type === "checkbox" || el.type === "radio") && el.closest("label")) continue;
        const r = el.getBoundingClientRect();
        // The hit area counts, not the drawn box: a ::before that pads it out is measured by elementFromPoint at the edges.
        const reach = (dx, dy) => {
          const hit = document.elementFromPoint(r.left + r.width / 2 + dx, r.top + r.height / 2 + dy);
          return !!hit && (hit === el || el.contains(hit));
        };
        const w = r.width >= 44 || (reach(-22 + 1, 0) && reach(22 - 1, 0));
        const h = r.height >= 44 || (reach(0, -22 + 1) && reach(0, 22 - 1));
        if (!w || !h) out.push({ kind: "small-target", el: label(el), size: `${Math.round(r.width)}x${Math.round(r.height)}` });
      }
    }
    // One finding per distinct element and kind.
    const seen = new Set();
    return out.filter((f) => {
      const k = `${f.kind}|${f.el}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });

const open = async (scenario, theme, width, height = 860) => {
  // Phone widths are shot as a touch screen, so styles for a finger (pointer: coarse) apply as they would on a phone.
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width <= 760 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/visual-qa.html?scenario=${encodeURIComponent(scenario)}&theme=${theme}${process.argv.includes("--remote") ? "&remote=1" : ""}`);
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
      const { click, clicks: wide, narrowClicks } = await page.evaluate(() => ({ click: window.__visualQa.click, clicks: window.__visualQa.clicks ?? [], narrowClicks: window.__visualQa.narrowClicks }));
      const clicks = width <= 760 && narrowClicks ? narrowClicks : wide;
      for (const sel of [click, ...clicks].filter(Boolean)) {
        // The first visible match: a narrow layout keeps some controls in a drawer, hidden until opened.
        let el = null;
        for (const h of await page.$$(sel)) if (await h.isVisible()) { el = h; break; }
        if (!el) errors.push(`nothing visible matched ${sel}`);
        else {
          // A drawer still sliding in can sit over its own controls for a moment; then the click goes in regardless.
          await el.click({ timeout: 5000 }).catch(() => el.click({ force: true }));
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
      const after = await page.evaluate(() => window.__visualQa.afterType);
      if (after) {
        for (const sel of after.clicks) {
          const el = await page.waitForSelector(sel, { timeout: 3000 }).catch(() => null);
          if (!el) errors.push(`nothing matched ${sel}`);
          else await el.click();
        }
        await page.mouse.move(1, 1);
        await page.waitForTimeout(after.wait);
      }
      const waitFor = await page.evaluate(() => window.__visualQa.waitFor);
      if (waitFor) {
        const el = await page.waitForSelector(waitFor.selector, { timeout: waitFor.timeout }).catch(() => null);
        if (!el) errors.push(`nothing matched ${waitFor.selector} within ${waitFor.timeout} ms`);
        await page.waitForTimeout(300);
      }
      if (audit) findings.push(...(await auditPage(page)).map((f) => ({ scenario, theme, width, ...f })));
      const file = `${scenario}-${theme}-${label}.png`;
      await page.screenshot({ path: path.join(out, file), animations: "disabled" });
      lines.push(`- [${theme}, ${label} (${width}px)](${file})${errors.length ? ` errors: ${errors.join("; ")}` : ""}`);
      console.log(`${file}${errors.length ? `  errors: ${errors.join("; ")}` : ""}`);
      await page.close();
    }
    lines.push("");
  }
  fs.writeFileSync(path.join(out, "index.md"), lines.join("\n"));
  if (audit) {
    fs.writeFileSync(path.join(out, "audit.json"), JSON.stringify(findings, null, 2));
    console.log(`audit: ${findings.length} finding(s) in ${path.join(out, "audit.json")}`);
  }
  console.log(`wrote ${path.join(out, "index.md")}`);
} finally {
  await browser.close();
  await server.close();
}
