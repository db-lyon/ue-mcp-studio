// The composer bar laid out by a real browser: jsdom has no layout, so this serves the
// visual QA page (src/visual-qa) with Vite and measures it in headless Chrome or Edge.
// At every width, Send or Stop sits wholly inside the bar, the bar is one row that does
// not overflow, and the page does not scroll sideways.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import type { ViteDevServer } from "vite";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BROWSERS = [
  process.env.STUDIO_QA_BROWSER,
  path.join(os.homedir(), "AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe"),
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((p): p is string => !!p);

const THEMES = ["ue-mcp", "editor-orange", "editor"];
/** Window widths: below 760 the conversation takes the whole window, above it shares it with the session list. */
const WIDTHS = [320, 380, 480, 590, 760, 800, 1000, 1280];

let server: ViteDevServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("the composer layout test needs Chrome or Edge: install one or set STUDIO_QA_BROWSER");
  const { createServer } = await import("vite");
  const { chromium } = await import("playwright-core");
  delete process.env.STUDIO_PROJECT;
  server = await createServer({ root: web, configFile: path.join(web, "vite.config.ts"), server: { port: 0, strictPort: false }, logLevel: "warn" });
  await server.listen();
  base = server.resolvedUrls!.local[0].replace(/\/$/, "");
  browser = await chromium.launch({ executablePath: exe, headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

interface Measure {
  tier: string | undefined;
  folded: boolean;
  words: string;
  overlaps: string[];
  utilities: string[];
  bar: { left: number; right: number; top: number; bottom: number };
  send: { left: number; right: number; top: number; bottom: number; text: string } | null;
  scrollWidth: number;
  clientWidth: number;
  pageOverflow: number;
  wrapped: string[];
}

describe("the composer bar in a browser", () => {
  for (const [scenario, label] of [["composer-idle", "Send"], ["composer-running", "Stop"], ["agents-tokens", "Stop"]] as const) {
    for (const theme of THEMES) {
      it(`keeps ${label} inside the bar at every width, ${scenario}, ${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
        try {
          await page.goto(`${base}/visual-qa.html?scenario=${scenario}&theme=${theme}`);
          await page.waitForSelector(".composer-bar .composer-send", { timeout: 30_000 });
          await page.evaluate(() => document.fonts.ready);
          const failures: string[] = [];
          const folds: string[] = [];
          for (const width of WIDTHS) {
            await page.setViewportSize({ width, height: 860 });
            // Two frames: the bar's ResizeObserver sets its tier, then the new tier lays out.
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            const m: Measure = await page.evaluate(() => {
              const bar = document.querySelector<HTMLElement>(".composer-bar")!;
              const b = bar.getBoundingClientRect();
              const send = bar.querySelector<HTMLElement>(".composer-send");
              const s = send?.getBoundingClientRect();
              return {
                tier: bar.dataset.tier,
                bar: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
                send: s && s.width > 0 ? { left: s.left, right: s.right, top: s.top, bottom: s.bottom, text: send!.getAttribute("aria-label") ?? "" } : null,
                folded: bar.dataset.folded !== undefined,
                words: bar.querySelector(".composer-utilities")!.textContent!.replace(/\d+/g, "").trim(),
                // Every shown control, the utilities one by one: none may overlap the next.
                overlaps: (() => {
                  const shown = [...bar.children].flatMap((c) => (c.classList.contains("composer-utilities") ? [...c.children] : [c]))
                    .map((c) => ({ name: c.className || c.tagName, r: c.getBoundingClientRect() }))
                    .filter((c) => c.r.width > 0);
                  const out: string[] = [];
                  for (let i = 1; i < shown.length; i++) if (shown[i].r.left < shown[i - 1].r.right - 0.5) out.push(`${shown[i - 1].name} / ${shown[i].name}`);
                  return out;
                })(),
                utilities: [...bar.querySelectorAll<HTMLElement>(".composer-utilities > button, .composer-utilities .composer-more-button")].map((b) => b.getAttribute("aria-label") ?? ""),
                scrollWidth: bar.scrollWidth,
                clientWidth: bar.clientWidth,
                pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                // One row: every shown child is centred on the bar's middle. A wrapped child is not.
                wrapped: [...bar.children].filter((c) => {
                  const r = c.getBoundingClientRect();
                  return r.width > 0 && Math.abs(r.top + r.height / 2 - (b.top + b.height / 2)) > 4;
                }).map((c) => c.className || c.tagName),
              };
            });
            const at = `${width}px (${m.tier})`;
            if (!m.send) failures.push(`${at}: ${label} is not shown`);
            else {
              if (m.send.text !== label) failures.push(`${at}: the last button says ${m.send.text}`);
              if (m.send.right > m.bar.right + 0.5) failures.push(`${at}: ${label}'s right edge ${m.send.right} is past the bar's ${m.bar.right}`);
              if (m.send.left < m.bar.left - 0.5) failures.push(`${at}: ${label} starts before the bar`);
              if (m.send.top < m.bar.top - 0.5 || m.send.bottom > m.bar.bottom + 0.5) failures.push(`${at}: ${label} is outside the bar's row`);
            }
            if (m.scrollWidth > m.clientWidth) failures.push(`${at}: the bar overflows, ${m.scrollWidth} in ${m.clientWidth}`);
            if (m.pageOverflow > 0) failures.push(`${at}: the page scrolls sideways by ${m.pageOverflow}`);
            if (m.wrapped.length) failures.push(`${at}: wrapped onto another row: ${m.wrapped.join(", ")}`);
            if (m.overlaps.length) failures.push(`${at}: controls overlap: ${m.overlaps.join(", ")}`);
            // Icons only: no words on the utilities, folded or not.
            if (m.words) failures.push(`${at}: the utilities show words: ${m.words}`);
            const agents = scenario === "agents-tokens";
            const all = ["Checkpoints", ...(agents ? ["Subagents (2)"] : []), "Attach"];
            const expected = m.folded ? [agents ? "More controls, 2 subagents" : "More controls"] : all;
            if (JSON.stringify(m.utilities) !== JSON.stringify(expected)) failures.push(`${at}: the utilities are ${JSON.stringify(m.utilities)}, not ${JSON.stringify(expected)}`);
            // A wide bar has the room for the whole row; a narrow one shows it when it fits, measured, not by width.
            if (width >= 1000 && m.folded) failures.push(`${at}: folded with room for the row`);
            folds.push(`${width}:${m.folded ? "folded" : "row"}`);
          }
          expect(failures).toEqual([]);
          // Below 760 the conversation takes the window: a narrower window never shows the row where a wider one folded it.
          const phone = folds.filter((f) => Number(f.split(":")[0]) < 760).map((f) => f.endsWith("folded"));
          expect(phone.some((f, i) => !f && phone.slice(i + 1).some(Boolean))).toBe(false);
        } finally {
          await page.close();
        }
      }, 90_000);
    }
  }
});

describe("a subagent's card in the conversation, in a browser", () => {
  for (const theme of THEMES) {
    it(`keeps Open thread and Stop inside the card's row at phone widths, ${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 860 } });
      try {
        await page.goto(`${base}/visual-qa.html?scenario=agents-tokens&theme=${theme}`);
        await page.waitForSelector(".transcript .agent-link .agent-open", { timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);
        const failures: string[] = [];
        for (const width of [320, 360, 390, 590]) {
          await page.setViewportSize({ width, height: 860 });
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          const out: string[] = await page.evaluate(() => {
            const bad: string[] = [];
            for (const link of document.querySelectorAll<HTMLElement>(".transcript .agent-link")) {
              const c = link.getBoundingClientRect();
              const row = (link.closest(".agent-link-row") ?? link).getBoundingClientRect();
              const open = link.querySelector<HTMLElement>(".agent-open")!.getBoundingClientRect();
              if (open.right > c.right + 0.5 || open.left < c.left - 0.5) bad.push(`Open thread ${open.left}-${open.right} outside the card ${c.left}-${c.right}`);
              const stop = link.closest(".agent-link-row")?.querySelector<HTMLElement>(".agent-stop")?.getBoundingClientRect();
              if (stop && stop.right > row.right + 0.5) bad.push(`Stop ends at ${stop.right}, past the row's ${row.right}`);
              const scroller = link.closest<HTMLElement>(".transcript")!;
              if (row.right > scroller.getBoundingClientRect().right + 0.5) bad.push(`the row ends at ${row.right}, past the conversation`);
            }
            return bad;
          });
          for (const o of out) failures.push(`${width}px: ${o}`);
        }
        expect(failures).toEqual([]);
      } finally {
        await page.close();
      }
    }, 90_000);
  }
});
