/**
 * Android draws a bundled font by its file name (assets/fonts/<Name>.ttf, put
 * there by the expo-font config plugin in app.json). A style that also sets
 * fontWeight or fontStyle on such a family makes React Native look for
 * <Name>_bold.ttf or <Name>_italic.ttf, find none, and fall back to the system
 * font. These walk the rendered tree of representative screens as Android
 * would draw them and fail on any text that does that, and check that every
 * family name the theme can produce is one of the files app.json builds in.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Platform, StyleSheet, Text, View, type TextStyle } from "react-native";
import { FONT_FILES, fontName, labelFont, Markdown, DiffView, THEMES, ThemeProvider, type FontFamily, type Weight } from "../src/ui";
import { Harness } from "../visual-qa/harness";

const here = path.dirname(fileURLToPath(import.meta.url));
const appJson = JSON.parse(fs.readFileSync(path.join(here, "..", "app.json"), "utf8"));
const plugin = (appJson.expo.plugins as unknown[]).find((p): p is [string, { fonts: string[] }] => Array.isArray(p) && p[0] === "expo-font");
const built = (plugin?.[1].fonts ?? []).map((f) => path.basename(f, ".ttf"));
const BUNDLED = new Set<string>(FONT_FILES);

describe("the fonts app.json builds in", () => {
  it("lists the twelve files the app draws with, each present on disk", () => {
    expect(built).toHaveLength(12);
    expect(new Set(built)).toEqual(BUNDLED);
    for (const f of plugin![1].fonts) expect(fs.existsSync(path.resolve(here, "..", f)), f).toBe(true);
  });

  it("covers every family name the theme can produce", () => {
    const families: FontFamily[] = ["jakarta", "jetbrains", "instrument", "roboto"];
    const weights: Weight[] = [400, 500, 600, 700];
    for (const f of families) for (const w of weights) for (const i of [false, true]) expect(built, `${f} ${w}${i ? " italic" : ""}`).toContain(fontName(f, w, i));
    for (const theme of Object.values(THEMES)) {
      for (const role of [theme.sans, theme.mono, theme.serif]) if (role !== "system-mono") for (const w of weights) expect(built).toContain(fontName(role, w));
      const label = labelFont(theme).fontFamily!;
      if (theme.label.family !== "system-mono") expect(built).toContain(label);
    }
  });
});

type Fiber = { elementType: unknown; memoizedProps: { style?: unknown }; child: Fiber | null; sibling: Fiber | null; return: Fiber | null };

/** Every text whose own style sets a weight or a slant on a bundled family, its own or the one it inherits. */
function fallbacks(container: HTMLElement): string[] {
  const el = container.querySelector("*") as (HTMLElement & Record<string, Fiber>) | null;
  if (!el) return [];
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"))!;
  let root: Fiber = el[key];
  while (root.return) root = root.return;
  const bad: string[] = [];
  const walk = (f: Fiber | null, family: string | undefined) => {
    for (; f; f = f.sibling) {
      let inherited = family;
      if (f.elementType === Text) {
        const s = (StyleSheet.flatten(f.memoizedProps.style as never) ?? {}) as TextStyle;
        inherited = s.fontFamily ?? family;
        const weight = s.fontWeight !== undefined && !["normal", "400", 400].includes(s.fontWeight as never);
        const slant = s.fontStyle === "italic";
        if ((weight || slant) && inherited && BUNDLED.has(inherited)) bad.push(`${inherited} with ${weight ? `fontWeight ${String(s.fontWeight)}` : "fontStyle italic"}`);
      } else if (f.elementType === View) {
        // A view inside text starts a new text root: nothing is inherited past it.
        inherited = undefined;
      }
      walk(f.child, inherited);
    }
  };
  walk(root.child, undefined);
  return bad;
}

const wait = async (ms = 60) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

describe("no text falls back to the system font on Android", () => {
  const os = Platform.OS;
  beforeAll(() => void Object.defineProperty(Platform, "OS", { value: "android", configurable: true, writable: true }));
  afterAll(() => void Object.defineProperty(Platform, "OS", { value: os, configurable: true, writable: true }));

  const SCREENS: Array<[string, string[]]> = [
    ["checkpoints", ["Checkpoints"]],
    ["agents-sheet", ["Subagents (2)"]],
    ["approvals-waiting", []],
    ["compaction-expanded", []],
    ["review-card", []],
    ["running", []],
    ["settings-agents", []],
    ["settings-general-login-paid", []],
    ["plugins-remote-details", ["Details"]],
    ["diagnostics", []],
  ];
  for (const theme of ["ue-mcp", "editor"] as const) {
    for (const [name, clicks] of SCREENS) {
      it(`${name} in ${theme}`, async () => {
        const { container } = render(<Harness name={name} theme={theme} />);
        for (let i = 0; i < 10; i++) await wait();
        for (const label of clicks) {
          const target = screen.queryAllByLabelText(label)[0] ?? screen.queryAllByText(label)[0];
          if (target) fireEvent.click(target);
          await wait(300);
        }
        expect(container.textContent!.length).toBeGreaterThan(20);
        expect(fallbacks(container)).toEqual([]);
      });
    }
  }

  it("catches a weight or a slant on a bundled family, set on the text or inherited from its parent", () => {
    const t = THEMES["ue-mcp"];
    const { container } = render(
      <View>
        <Text style={{ fontFamily: fontName(t.sans, 400), fontWeight: "600" }}>own weight</Text>
        <Text style={{ fontFamily: fontName(t.sans, 400) }}>
          parent <Text style={{ fontStyle: "italic" }}>inherited slant</Text>
        </Text>
        <Text style={{ fontWeight: "700" }}>system font, fine</Text>
      </View>,
    );
    expect(fallbacks(container)).toEqual(["PlusJakartaSans_400Regular with fontWeight 600", "PlusJakartaSans_400Regular with fontStyle italic"]);
  });

  it("markdown emphasis and a diff's unchanged-lines note", async () => {
    for (const theme of ["ue-mcp", "editor"] as const) {
      const { container, unmount } = render(
        <ThemeProvider name={theme}>
          <Markdown text={"Some *emphasis*, **bold**, `code` and\n\n- [x] a done task"} />
          <DiffView lines={[{ op: " ", text: "a" }, { op: "gap", count: 4 }, { op: "+", text: "b" }]} />
        </ThemeProvider>,
      );
      await wait();
      expect(container.textContent).toContain("emphasis");
      expect(fallbacks(container)).toEqual([]);
      unmount();
    }
  });
});
