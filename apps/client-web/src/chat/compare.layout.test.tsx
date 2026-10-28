/**
 * The change card's Change | Before | After comparison laid out at every card
 * width from 320 to 1280 pixels (db-lyon/ue-mcp-studio#112): every cell inside
 * its column, nothing past the card, Before and After side by side or stacked
 * by the card's own tier. The tier logic is unit tested here too; the layout
 * half runs in a real browser (Chrome or Edge, through playwright-core) and is
 * skipped on a machine without one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssetDiff } from "@ue-mcp-studio/shared";
import { AssetDiffView } from "./AssetDiff";
import { COMPARE_TIERS, colorOf, compareTier } from "./compare";

describe("the comparison's tier", () => {
  it("steps down by the card's width in ems of its font", () => {
    expect(compareTier(700, 13.5)).toBe("wide");
    expect(compareTier(520, 13.5)).toBe("medium");
    expect(compareTier(330, 13.5)).toBe("narrow");
    expect(compareTier(250, 13.5)).toBe("tiny");
    // A larger font moves the same width to the next tier.
    expect(compareTier(700, 16)).toBe("medium");
    expect(compareTier(0, 13.5)).toBe("wide");
  });

  it("reads colours as the engine writes them", () => {
    expect(colorOf("(R=1.000000,G=0.000000,B=0.000000,A=1.000000)")).toBe("rgba(255, 0, 0, 1)");
    expect(colorOf("(B=0,G=128,R=255,A=255)")).toBe("rgba(255, 128, 0, 1)");
    expect(colorOf("(X=1.0,Y=2.0,Z=3.0)")).toBeNull();
    expect(colorOf("Print String")).toBeNull();
  });
});

const scalar = (name: string, v: string) => `(ParameterInfo=(Name="${name}",Association=GlobalParameter,Index=-1),ParameterValue=${v},ExpressionGUID=5A1F0C2E4B7D9E3F8A6B1C0D2E4F6A8B)`;

/** One edit as Unreal reports it, the issue's example and its neighbours: every kind of row the card draws. */
const DIFF: AssetDiff = {
  state: "ready",
  status: "modified",
  assetClass: "Blueprint",
  summary: "6 differences",
  nativeDiff: { available: true },
  before: { class: "Blueprint", facts: [{ name: "Parent class", value: "Actor" }] },
  after: { class: "Blueprint", facts: [{ name: "Parent class", value: "Actor" }] },
  sections: [
    { category: "Graph: EventGraph", kind: "graph", engineSource: "FGraphDiffControl::DiffGraphs", entries: [
      { displayString: "Added Node 'PrintString'", diffType: "NODE_ADDED", category: "ADDITION", node1: { guid: "1", name: "K2Node_CallFunction_0", class: "K2Node_CallFunction", title: "PrintString", fullTitle: "Print String", pins: [
        { name: "InString", displayName: "In String", defaultValue: "Overlapped the trigger volume by the bridge's far end", linked: false },
        { name: "bPrintToScreen", displayName: "Print to Screen", defaultValue: "true", linked: false },
        { name: "bPrintToLog", displayName: "Print to Log", defaultValue: "true", linked: false },
        { name: "TextColor", displayName: "Text Color", defaultValue: "(R=0.000000,G=0.660000,B=1.000000,A=1.000000)", linked: false },
        { name: "Duration", displayName: "Duration", defaultValue: "2.000000", linked: false },
        { name: "Key", displayName: "Key", defaultValue: "None", linked: false },
      ] } },
      { displayString: "Pin 'then' has more links (was 0 now 1)", diffType: "PIN_LINKEDTO_NUM_INC", category: "MODIFICATION", node1: { guid: "2", name: "K2Node_Event_0", class: "K2Node_Event", title: "Event ActorBeginOverlap" } },
      { displayString: "Removed Node 'Delay'", diffType: "NODE_REMOVED", category: "SUBTRACTION", node1: { guid: "3", name: "K2Node_CallFunction_1", class: "K2Node_CallFunction", title: "Delay", pins: [{ name: "Duration", displayName: "Duration", defaultValue: "0.200000", linked: false }] } },
      { displayString: "Node moved", diffType: "NODE_MOVED", category: "MINOR", node1: { guid: "4", name: "K2Node_IfThenElse_0", class: "K2Node_IfThenElse", title: "Branch" } },
    ] },
    { category: "Components", kind: "components", engineSource: "DiffUtils::CompareUnrelatedSCS", entries: [
      { group: "BridgeTriggerVolumeAtTheFarEndOfTheBrokenBridge", path: "Relative Location", diffType: "PropertyValueChanged", displayString: "Relative Location", before: "(X=1200.000000,Y=-280.000000,Z=0.000000)", after: "(X=1180.000000,Y=-280.000000,Z=35.500000)" },
      { group: "BridgeTriggerVolumeAtTheFarEndOfTheBrokenBridge", path: "Shape Color", diffType: "PropertyValueChanged", displayString: "Shape Color", before: "(B=0,G=0,R=255,A=255)", after: "(B=255,G=128,R=0,A=255)" },
      { path: "Collision Profile Name", diffType: "PropertyAddedToB", displayString: "Collision Profile Name", before: null, after: "OverlapAllDynamicExceptPawnsAndPhysicsBodies" },
      { path: "Scalar Parameter Values", diffType: "PropertyValueChanged", displayString: "Scalar Parameter Values", before: `(${scalar("Roughness", "0.550000")},${scalar("MossCoverage", "0.300000")})`, after: `(${scalar("Roughness", "0.800000")},${scalar("MossCoverage", "0.650000")})` },
    ] },
  ],
};

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, "..", "styles.css"), "utf-8").replace(/@import[^;]+;/g, "");
const markup = renderToStaticMarkup(<AssetDiffView diff={DIFF} name="BP_BrokenBridge.uasset" status="modified" />);

const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const browserPath = BROWSERS.find((p) => fs.existsSync(p));

/** Card widths from the editor's dock tab to a wide window. */
const WIDTHS = [320, 360, 420, 480, 590, 640, 720, 800, 960, 1024, 1280];

type Layout = {
  tier: string;
  overflow: string[];
  outOfColumn: string[];
  sideBySide: boolean[];
  stacked: boolean[];
  hiddenEmpty: number;
  /** Parameter lists whose parts share a line. */
  partsInline: number;
  headerShown: boolean;
};

describe.skipIf(!browserPath)("the comparison, laid out in a browser at every card width", () => {
  type Page = { setViewportSize(s: object): Promise<void>; setContent(h: string): Promise<void>; evaluate<T, A>(f: (a: A) => T, a: A): Promise<T> };
  let browser: { close(): Promise<void>; newPage(o: object): Promise<Page> };
  let page: Page;

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = (await chromium.launch({ executablePath: browserPath, headless: true })) as unknown as typeof browser;
    page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  const layoutAt = async (width: number): Promise<Layout> => {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div id="card" style="width:${width}px">${markup}</div></body></html>`);
    return page.evaluate((tiers: readonly [string, number][]) => {
      const diff = document.querySelector(".asset-diff") as HTMLElement;
      // As useCompareTier sets it.
      const ems = diff.clientWidth / parseFloat(getComputedStyle(diff).fontSize);
      const tier = tiers.find(([, min]) => ems >= min)?.[0] ?? "tiny";
      diff.dataset.tier = tier;
      const card = diff.getBoundingClientRect();
      const overflow: string[] = [];
      const outOfColumn: string[] = [];
      const sideBySide: boolean[] = [];
      const stacked: boolean[] = [];
      let hiddenEmpty = 0;
      const visible = (e: Element) => getComputedStyle(e).display !== "none" && (e as HTMLElement).offsetParent !== null;
      for (const wrap of Array.from(document.querySelectorAll(".diff-table-wrap"))) {
        if (wrap.scrollWidth > wrap.clientWidth + 1) overflow.push(`a table scrolls sideways: ${wrap.scrollWidth} > ${wrap.clientWidth}`);
      }
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth) overflow.push("the page scrolls sideways");
      for (const td of Array.from(document.querySelectorAll(".diff-table td"))) {
        if (!visible(td)) {
          hiddenEmpty++;
          continue;
        }
        const box = td.getBoundingClientRect();
        if (box.right > card.right + 1 || box.left < card.left - 1) overflow.push(`a cell runs past the card: ${td.textContent}`);
        // Every line of text inside its own cell.
        const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const r = document.createRange();
          r.selectNodeContents(n);
          for (const rect of Array.from(r.getClientRects())) {
            if (rect.width > 0 && (rect.right > box.right + 1 || rect.left < box.left - 1)) overflow.push(`text leaves its cell: ${n.textContent}`);
          }
        }
      }
      const header = document.querySelector(".diff-table thead") as HTMLElement;
      const headerShown = visible(header);
      for (const table of Array.from(document.querySelectorAll(".diff-table"))) {
        const ths = Array.from(table.querySelectorAll("thead th")).map((th) => th.getBoundingClientRect());
        for (const tr of Array.from(table.querySelectorAll("tbody tr.diff-row"))) {
          const cells = Array.from(tr.children) as HTMLElement[];
          if (tier === "wide") {
            cells.forEach((td, i) => {
              const b = td.getBoundingClientRect();
              const col = ths[i];
              if (Math.abs(b.left - col.left) > 1 || Math.abs(b.right - col.right) > 1) outOfColumn.push(`${td.textContent} is not under ${table.querySelectorAll("thead th")[i].textContent}`);
            });
          }
          const [, before, after] = cells;
          if (before && after && visible(before) && visible(after)) {
            const b = before.getBoundingClientRect();
            const a = after.getBoundingClientRect();
            sideBySide.push(Math.abs(b.top - a.top) < 1 && b.right <= a.left + 1);
            stacked.push(b.bottom <= a.top + 1);
          }
        }
      }
      // A parameter list keeps one parameter per line.
      const partsInline = Array.from(document.querySelectorAll(".diff-parts")).filter((p) => {
        const tops = Array.from(p.children).map((c) => Math.round(c.getBoundingClientRect().top));
        return new Set(tops).size !== tops.length;
      }).length;
      return { tier, overflow, outOfColumn, sideBySide, stacked, hiddenEmpty, headerShown, partsInline };
    }, COMPARE_TIERS);
  };

  for (const width of WIDTHS) {
    it(`keeps every cell in its column and inside the card at ${width} px`, async () => {
      const l = await layoutAt(width);
      expect(l.overflow).toEqual([]);
      expect(l.outOfColumn).toEqual([]);
      expect(l.partsInline).toBe(0);
      expect(l.sideBySide.length).toBeGreaterThan(0);
      if (l.tier === "wide") {
        expect(l.headerShown).toBe(true);
        expect(l.sideBySide.every(Boolean)).toBe(true);
        expect(l.hiddenEmpty).toBe(0);
      } else if (l.tier === "medium") {
        expect(l.headerShown).toBe(false);
        expect(l.sideBySide.every(Boolean)).toBe(true);
      } else {
        expect(l.headerShown).toBe(false);
        expect(l.stacked.every(Boolean)).toBe(true);
        // An empty side, and Before on an added row, are left out.
        expect(l.hiddenEmpty).toBeGreaterThan(0);
      }
    });
  }

  it("uses all four tiers across the range", async () => {
    const tiers = new Set<string>();
    for (const width of [250, ...WIDTHS]) tiers.add((await layoutAt(width)).tier);
    expect([...tiers].sort()).toEqual(["medium", "narrow", "tiny", "wide"]);
  });
});
