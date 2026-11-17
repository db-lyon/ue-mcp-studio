// @vitest-environment jsdom
/**
 * The What's new dialog at a phone's size (390x600) and a short docked window:
 * the card stays inside the screen, the title and Close stay put, and the
 * parts scroll to the end of long notes. Runs in a real browser (Chrome or
 * Edge, through playwright-core) and is skipped on a machine without one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { render, waitFor, screen, cleanup } from "@testing-library/react";
import { WhatsNewDialog } from "./WhatsNew";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, "..", "styles.css"), "utf-8").replace(/@import[^;]+;/g, "");
const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const browserPath = BROWSERS.find((p) => fs.existsSync(p));

const body = Array.from({ length: 60 }, (_, i) => `- Change number ${i} with a [link](https://ue-mcp.com/${i})\n\n<details><summary>Fold ${i}</summary>\n\nInside ${i}\n\n</details>`).join("\n\n");
const studio = { part: "studio", name: "Studio", installed: "0.1.3", more: 0, releasesUrl: "https://github.com/db-lyon/ue-mcp-studio/releases", entries: [{ version: "0.1.5", available: true, publishedAt: "2026-11-15T00:00:00Z", url: "https://github.com/db-lyon/ue-mcp-studio/releases/tag/v0.1.5", body }] };

describe.skipIf(!browserPath)("the What's new dialog in a browser at small heights", () => {
  type Page = { setViewportSize(s: object): Promise<void>; setContent(h: string): Promise<void>; evaluate<T>(f: () => T): Promise<T> };
  let browser: { close(): Promise<void>; newPage(o: object): Promise<Page> };
  let page: Page;
  let html = "";

  beforeAll(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ channel: "stable", components: [studio] }), { status: 200 })));
    render(<WhatsNewDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Studio")).toBeTruthy());
    html = document.body.innerHTML;
    cleanup();
    vi.unstubAllGlobals();
    const { chromium } = await import("playwright-core");
    browser = (await chromium.launch({ executablePath: browserPath, headless: true })) as unknown as typeof browser;
    page = await browser.newPage({ viewport: { width: 390, height: 600 } });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  for (const [w, h] of [[390, 600], [390, 360], [320, 480]] as const) {
    it(`fits ${w}x${h}, keeps its head, and scrolls the notes to the end`, async () => {
      await page.setViewportSize({ width: w, height: h });
      await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body>${html}</body></html>`);
      const r = await page.evaluate(() => {
        const card = document.querySelector(".overlay-card.whats-new") as HTMLElement;
        const parts = document.querySelector(".whats-new-parts") as HTMLElement;
        const head = document.querySelector(".overlay-head") as HTMLElement;
        const cb = card.getBoundingClientRect();
        const scrollable = parts.scrollHeight > parts.clientHeight;
        parts.scrollTop = parts.scrollHeight;
        const hb = head.getBoundingClientRect();
        const last = Array.from(document.querySelectorAll(".whats-new-notes li")).at(-1)!.getBoundingClientRect();
        const pb = parts.getBoundingClientRect();
        return {
          cardTop: cb.top, cardBottom: cb.bottom, vh: window.innerHeight,
          cardScrolls: card.scrollHeight > card.clientHeight + 1,
          scrollable, headTop: hb.top, headVisible: hb.top >= cb.top && hb.bottom <= cb.bottom,
          lastReachable: last.bottom <= pb.bottom + 1,
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });
      expect(r.cardTop).toBeGreaterThanOrEqual(0);
      expect(r.cardBottom).toBeLessThanOrEqual(r.vh);
      expect(r.cardScrolls).toBe(false);
      expect(r.scrollable).toBe(true);
      expect(r.headVisible).toBe(true);
      expect(r.lastReachable).toBe(true);
      expect(r.sideways).toBe(false);
    });
  }
});
