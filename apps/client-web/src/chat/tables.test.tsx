/**
 * Markdown tables in a reply at the chat's narrowest width: no plain word in a
 * cell breaks across lines, inline code breaks only after a dot or an
 * underscore, and a table wider than the chat scrolls in its wrapper. The
 * layout half runs in a real browser (Chrome or Edge, through playwright-core)
 * and is skipped on a machine without one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Reply } from "./Transcript";

/** The table a playtest draft came back as in Vale, at full length. */
export const PLAYTEST_TABLE = [
  "| # | Player | Do | Pass when | Judged |",
  "|---|---|---|---|---|",
  "| 1 | Host | Pick up the sigil on the altar | The sigil counter fills | auto: `PlayerState.SigilAttributes.Sigil.CurrentValue` eq 100, within 5 s |",
  "| 2 | Client | Watch the host pick it up | The pickup plays on the client too | manual |",
  "| 3 | Host | Walk through the shrine gate | The gate opens for the sigil holder | auto: `BP_ShrineGate_C.bIsOpen` eq 1, within 5 s |",
  "| 4 | Client | Try the gate without a sigil | The gate stays shut and shows the locked prompt | manual |",
].join("\n");

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, "..", "styles.css"), "utf-8").replace(/@import[^;]+;/g, "");
const markup = renderToStaticMarkup(<Reply text={PLAYTEST_TABLE} />);

describe("a reply's table, as markup", () => {
  it("sits in a wrapper of its own", () => {
    expect(markup).toMatch(/<div class="md-table"><table>/);
  });

  it("lets inline code break only after a dot or an underscore", () => {
    expect(markup).toContain("<code>PlayerState.<wbr/>SigilAttributes.<wbr/>Sigil.<wbr/>CurrentValue</code>");
    expect(markup).toContain("<code>BP_<wbr/>ShrineGate_<wbr/>C.<wbr/>bIsOpen</code>");
  });
});

const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const browserPath = BROWSERS.find((p) => fs.existsSync(p));

/** The chat's narrowest: the editor's dock tab, about as wide as a phone. */
const NARROWEST = 320;

describe.skipIf(!browserPath)("a reply's table, laid out at the chat's narrowest width", () => {
  type Browser = { close(): Promise<void>; newPage(o: object): Promise<{ setContent(h: string): Promise<void>; evaluate<T>(f: () => T): Promise<T> }> };
  let browser: Browser;
  let page: Awaited<ReturnType<Browser["newPage"]>>;

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = (await chromium.launch({ executablePath: browserPath, headless: true })) as unknown as Browser;
    page = await browser.newPage({ viewport: { width: NARROWEST, height: 800 } });
    // The chat's own frame around a reply, as the narrow layout draws it.
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
      <div class="chat" style="width:${NARROWEST}px"><section class="card conversation"><div class="transcript">${markup}</div></section></div></body></html>`);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("never breaks a plain word in a cell across lines", async () => {
    const broken = await page.evaluate(() => {
      const out: string[] = [];
      for (const cell of Array.from(document.querySelectorAll(".md th, .md td"))) {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.parentElement?.closest("code")) continue;
          const text = n.textContent ?? "";
          for (const m of text.matchAll(/\S+/g)) {
            const r = document.createRange();
            r.setStart(n, m.index!);
            r.setEnd(n, m.index! + m[0].length);
            const lines = new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top)));
            if (lines.size > 1) out.push(m[0]);
          }
        }
      }
      return out;
    });
    expect(broken).toEqual([]);
  });

  it("breaks inline code only after a dot or an underscore", async () => {
    const broken = await page.evaluate(() => {
      const out: string[] = [];
      for (const code of Array.from(document.querySelectorAll(".md td code"))) {
        for (const n of Array.from(code.childNodes)) {
          if (n.nodeType !== Node.TEXT_NODE || !n.textContent) continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          const lines = new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top)));
          if (lines.size > 1) out.push(n.textContent);
        }
      }
      return out;
    });
    expect(broken).toEqual([]);
  });

  it("gives every column at least its longest word, and scrolls the table instead of the chat", async () => {
    const m = await page.evaluate(() => {
      const wrap = document.querySelector(".md-table") as HTMLElement;
      const page = document.scrollingElement!;
      return { scrolls: getComputedStyle(wrap).overflowX, wider: wrap.scrollWidth > wrap.clientWidth, pageOverflow: page.scrollWidth > page.clientWidth };
    });
    expect(m.scrolls).toBe("auto");
    expect(m.pageOverflow).toBe(false);
    // Host, Client and the code parts need more than 320 px across five columns: the wrapper scrolls.
    expect(m.wider).toBe(true);
  });
});
