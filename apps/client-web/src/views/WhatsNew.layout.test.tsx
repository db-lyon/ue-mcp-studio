// @vitest-environment jsdom
/**
 * The What's new dialog at a phone's size (390x600) and a short docked window:
 * the card stays inside the screen with the title and Close fixed, each open
 * part's notes are a scroll box of their own about half the screen tall, a
 * real wheel over that box scrolls it (and not the page), and the list of
 * parts scrolls when several are open. Runs in a real browser (Chrome or
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
const part = (id: string, name: string) => ({ part: id, name, installed: "0.1.3", more: 0, releasesUrl: `https://github.com/db-lyon/${id}/releases`, entries: [{ version: "0.1.5", available: true, publishedAt: "2026-11-15T00:00:00Z", url: `https://github.com/db-lyon/${id}/releases/tag/v0.1.5`, body }] });
const components = [part("studio", "Studio"), part("bridge", "Bridge"), part("plugin", "Editor plugin"), part("server", "Server")];

describe.skipIf(!browserPath)("the What's new dialog in a browser at small heights", () => {
  type Page = {
    setViewportSize(s: object): Promise<void>;
    setContent(h: string): Promise<void>;
    evaluate<T, A = undefined>(f: (a: A) => T, a?: A): Promise<T>;
    mouse: { move(x: number, y: number): Promise<void>; wheel(dx: number, dy: number): Promise<void> };
    waitForTimeout(ms: number): Promise<void>;
  };
  let browser: { close(): Promise<void>; newPage(o: object): Promise<Page> };
  let page: Page;
  let html = "";

  beforeAll(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ channel: "stable", components }), { status: 200 })));
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
    it(`fits ${w}x${h} with its head fixed, and a wheel inside the open part scrolls that part's notes`, async () => {
      await page.setViewportSize({ width: w, height: h });
      await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body>${html}</body></html>`);
      const before = await page.evaluate(() => {
        const card = document.querySelector(".overlay-card.whats-new") as HTMLElement;
        const head = document.querySelector(".overlay-head") as HTMLElement;
        const open = document.querySelector(".whats-new-part[open] > .whats-new-body") as HTMLElement;
        const cb = card.getBoundingClientRect();
        const hb = head.getBoundingClientRect();
        const ob = open.getBoundingClientRect();
        return {
          cardTop: cb.top, cardBottom: cb.bottom, vh: window.innerHeight,
          cardScrolls: card.scrollHeight > card.clientHeight + 1,
          headTop: hb.top, headVisible: hb.top >= cb.top && hb.bottom <= cb.bottom,
          bodyHeight: open.clientHeight, bodyScrolls: open.scrollHeight > open.clientHeight, overflowY: getComputedStyle(open).overflowY,
          // The middle of the part's box that is on screen, for the wheel.
          x: ob.left + ob.width / 2, y: (Math.max(ob.top, cb.top) + Math.min(ob.bottom, cb.bottom)) / 2,
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });
      expect(before.cardTop).toBeGreaterThanOrEqual(0);
      expect(before.cardBottom).toBeLessThanOrEqual(before.vh);
      expect(before.cardScrolls).toBe(false);
      expect(before.headVisible).toBe(true);
      expect(before.sideways).toBe(false);
      // A bounded box of its own: at most 60% of the screen, scrolling inside itself.
      expect(before.overflowY).toBe("auto");
      expect(before.bodyHeight).toBeLessThanOrEqual(before.vh * 0.6);
      expect(before.bodyScrolls).toBe(true);

      await page.mouse.move(before.x, before.y);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(250);
      const after = await page.evaluate(() => {
        const open = document.querySelector(".whats-new-part[open] > .whats-new-body") as HTMLElement;
        const head = document.querySelector(".overlay-head") as HTMLElement;
        return { scrollTop: open.scrollTop, headTop: head.getBoundingClientRect().top };
      });
      expect(after.scrollTop).toBeGreaterThan(0);
      expect(after.headTop).toBe(before.headTop);

      // The end of the notes is reachable inside the part's box.
      const end = await page.evaluate(() => {
        const open = document.querySelector(".whats-new-part[open] > .whats-new-body") as HTMLElement;
        open.scrollTop = open.scrollHeight;
        const last = Array.from(open.querySelectorAll(".whats-new-notes li")).at(-1)!.getBoundingClientRect();
        return last.bottom <= open.getBoundingClientRect().bottom + 1;
      });
      expect(end).toBe(true);
    });
  }

  it("keeps every part's header reachable when several are open, by scrolling the list", async () => {
    await page.setViewportSize({ width: 390, height: 600 });
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body>${html}</body></html>`);
    const r = await page.evaluate(() => {
      for (const d of Array.from(document.querySelectorAll<HTMLDetailsElement>(".whats-new-part"))) d.open = true;
      const parts = document.querySelector(".whats-new-parts") as HTMLElement;
      const bodies = Array.from(document.querySelectorAll<HTMLElement>(".whats-new-part > .whats-new-body"));
      const listScrolls = parts.scrollHeight > parts.clientHeight;
      parts.scrollTop = parts.scrollHeight;
      const lastHead = Array.from(document.querySelectorAll(".whats-new-part > summary")).at(-1)!.getBoundingClientRect();
      const pb = parts.getBoundingClientRect();
      return { listScrolls, lastHeadVisible: lastHead.top >= pb.top - 1 && lastHead.bottom <= pb.bottom + 1, bounded: bodies.every((b) => b.clientHeight <= window.innerHeight * 0.6 && b.scrollHeight > b.clientHeight) };
    });
    expect(r.listScrolls).toBe(true);
    expect(r.lastHeadVisible).toBe(true);
    expect(r.bounded).toBe(true);
  });
});
