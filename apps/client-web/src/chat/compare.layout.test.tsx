/**
 * The asset diff's tree grid laid out at every card width from 320 to 1280
 * pixels (db-lyon/ue-mcp-studio#112): every cell inside the card, Before and
 * After under their column headers on a wide card and on one line under the
 * property's name on a narrow one. The tier logic is unit tested here too; the
 * layout half runs in a real browser (Chrome or Edge, through playwright-core)
 * and is skipped on a machine without one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssetDiff } from "@ue-mcp-studio/shared";
import { AssetDiffView } from "./AssetDiff";
import { COMPARE_TIERS, colorOf, compareTier } from "./compare";

describe("the card's tier", () => {
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
  /** Rows with both values: whether Before and After share a line, Before first. */
  oneLine: boolean[];
  /** Rows with values: whether the values sit under the name. */
  underName: boolean[];
  hiddenBlank: number;
  headerShown: boolean;
  /** The tallest row with no opened cell, in pixels. */
  tallest: number;
};

describe.skipIf(!browserPath)("the tree grid, laid out in a browser at every card width", () => {
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
      const oneLine: boolean[] = [];
      const underName: boolean[] = [];
      let hiddenBlank = 0;
      let tallest = 0;
      const visible = (e: Element) => getComputedStyle(e).display !== "none";
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth) overflow.push("the page scrolls sideways");
      const grid = document.querySelector(".dtree") as HTMLElement;
      if (grid.scrollWidth > grid.clientWidth + 1) overflow.push(`the grid scrolls sideways: ${grid.scrollWidth} > ${grid.clientWidth}`);
      const head = Array.from(document.querySelectorAll(".dt-head > span")).map((h) => h.getBoundingClientRect());
      const headerShown = visible(document.querySelector(".dt-head")!);
      for (const row of Array.from(document.querySelectorAll(".dtree > .dt-row:not(.dt-head)"))) {
        const [name, before, after] = Array.from(row.children) as HTMLElement[];
        tallest = Math.max(tallest, row.getBoundingClientRect().height);
        for (const cell of [name, before, after]) {
          if (!visible(cell)) {
            hiddenBlank++;
            continue;
          }
          const b = cell.getBoundingClientRect();
          if (b.right > card.right + 1 || b.left < card.left - 1) overflow.push(`a cell runs past the card: ${cell.textContent}`);
        }
        // On a narrow card a name wraps inside its cell; with columns it and the values are cut to their cells.
        const nb = name.getBoundingClientRect();
        const walker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if ((n.parentElement as HTMLElement).closest(".dt-note, .sr-only")) continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          if (!headerShown) for (const rect of Array.from(r.getClientRects())) if (rect.width > 0 && rect.right > nb.right + 1) overflow.push(`a name leaves its cell: ${n.textContent}`);
        }
        if (headerShown) {
          [before, after].forEach((c, i) => {
            const b = c.getBoundingClientRect();
            if (Math.abs(b.left - head[i + 1].left) > 1 || Math.abs(b.right - head[i + 1].right) > 1) outOfColumn.push(`${c.textContent} is not under ${i ? "After" : "Before"}`);
          });
        }
        const shown = [before, after].filter((c) => visible(c) && !c.classList.contains("dt-blank"));
        if (shown.length) underName.push(shown.every((c) => c.getBoundingClientRect().top >= nb.bottom - 1));
        if (row.classList.contains("dt-both")) {
          const b = before.getBoundingClientRect();
          const a = after.getBoundingClientRect();
          oneLine.push(Math.abs(b.top - a.top) < 1 && b.right <= a.left + 1);
        }
      }
      return { tier, overflow, outOfColumn, oneLine, underName, hiddenBlank, headerShown, tallest };
    }, COMPARE_TIERS);
  };

  for (const width of WIDTHS) {
    it(`keeps every cell inside the card and the values in their columns or under the name at ${width} px`, async () => {
      const l = await layoutAt(width);
      expect(l.overflow).toEqual([]);
      expect(l.outOfColumn).toEqual([]);
      expect(l.oneLine.length).toBeGreaterThan(0);
      // Before and After share a line in every tier: side by side in columns, or "False → True" under the name.
      expect(l.oneLine.every(Boolean)).toBe(true);
      if (l.tier === "wide" || l.tier === "medium") {
        expect(l.headerShown).toBe(true);
        expect(l.underName.some(Boolean)).toBe(false);
        expect(l.hiddenBlank).toBe(0);
      } else {
        expect(l.headerShown).toBe(false);
        expect(l.underName.every(Boolean)).toBe(true);
        // An added row's empty Before, and a group's empty cells, are left out.
        expect(l.hiddenBlank).toBeGreaterThan(0);
      }
      // Compact: no row with no cell opened is taller than five lines.
      expect(l.tallest).toBeLessThan(96);
    });
  }

  it("uses all four tiers across the range", async () => {
    const tiers = new Set<string>();
    for (const width of [250, ...WIDTHS]) tiers.add((await layoutAt(width)).tier);
    expect([...tiers].sort()).toEqual(["medium", "narrow", "tiny", "wide"]);
  });
});
