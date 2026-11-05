/**
 * Gradients keep their alpha on Android. react-native-svg drops the alpha of
 * an rgba() stopColor there and draws the stop at stopOpacity, so build 7's
 * card tint (rgba(255,255,255,0.018)) painted near-opaque white. Every stop
 * carries a colour without alpha and an explicit opacity, and the faint web
 * colours stay faint. No style hands a CSS gradient to the native view.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Card, CardTint, PageGlow, stopOf, THEMES, ThemeProvider, type ThemeName } from "../src/ui";

const NAMES = Object.keys(THEMES) as ThemeName[];
const src = path.resolve(__dirname, "../src");

/** The alpha a CSS colour has on the web. */
function webAlpha(color: string): number {
  if (color === "transparent") return 0;
  const m = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(color);
  if (m) return Number(m[1]);
  const h = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(color);
  return h ? parseInt(h[1], 16) / 255 : 1;
}

function stops(container: HTMLElement) {
  return [...container.querySelectorAll("stop")].map((s) => ({ color: s.getAttribute("stop-color") ?? "", opacity: Number(s.getAttribute("stop-opacity") ?? "1") }));
}

describe("stopOf", () => {
  it("splits rgba, #rrggbbaa and transparent into a colour without alpha and an opacity", () => {
    expect(stopOf("rgba(255, 255, 255, 0.018)")).toEqual({ color: "rgb(255, 255, 255)", opacity: 0.018 });
    expect(stopOf("#e8720c14")).toEqual({ color: "#e8720c", opacity: 0.078 });
    expect(stopOf("transparent").opacity).toBe(0);
    expect(stopOf("#123456")).toEqual({ color: "#123456", opacity: 1 });
  });

  for (const name of NAMES) {
    it(`keeps every faint colour of the ${name} theme faint`, () => {
      const c = THEMES[name].c as unknown as Record<string, string>;
      for (const key of ["tint", "glow", "accentWash", "warnWash", "badWash", "okWash"]) {
        const v = c[key];
        if (typeof v !== "string") continue;
        const a = webAlpha(v);
        const s = stopOf(v);
        expect(s.opacity, `${name} ${key} ${v}`).toBeCloseTo(a, 2);
        expect(s.color, `${name} ${key}`).not.toMatch(/rgba|^#[0-9a-f]{8}$/i);
      }
    });
  }
});

describe("the gradients drawn", () => {
  for (const name of NAMES) {
    it(`a card's tint and the page glow stay under 0.1 opacity in ${name}`, () => {
      const { container } = render(
        <ThemeProvider name={name}>
          <PageGlow />
          <Card>
            <span>body</span>
          </Card>
          <CardTint color={THEMES[name].c.tint} radius={8} />
        </ThemeProvider>,
      );
      const all = stops(container);
      if (THEMES[name].c.tint === "transparent" && THEMES[name].c.glow === "transparent") expect(all).toEqual([]);
      for (const s of all) {
        expect(s.color, JSON.stringify(s)).not.toMatch(/rgba|^#[0-9a-f]{8}$/i);
        expect(s.opacity, JSON.stringify(s)).toBeLessThan(0.1);
      }
      if (THEMES[name].c.tint !== "transparent") expect(all.length).toBeGreaterThanOrEqual(4);
    });
  }
});

describe("the source", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(src);

  it("gives every svg Stop an explicit stopOpacity", () => {
    for (const f of files) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/<Stop\b[^>]*>/g)) expect(m[0], path.relative(src, f)).toMatch(/stopOpacity=/);
    }
  });

  // StepPath's failed-step hatch is the one CSS gradient on native: --bad, opaque in every theme, over transparent.
  const HATCH = path.join("screens", "playtests", "StepPath.tsx");
  it("keeps the step hatch's colour opaque in every theme", () => {
    for (const name of NAMES) expect(webAlpha(THEMES[name].c.bad), name).toBe(1);
  });

  it("hands no faint CSS gradient to a native view", () => {
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      if (path.relative(src, f) !== HATCH) expect(text, path.relative(src, f)).not.toMatch(/experimental_backgroundImage/);
      // A backgroundImage only behind a web check.
      for (const line of text.split("\n").filter((l) => /backgroundImage:/.test(l) && !/^\s*(\*|\/\/)/.test(l))) {
        expect(line, path.relative(src, f)).toMatch(/Platform\.OS === "web"|=> \(Platform\.OS === "web"/);
      }
    }
  });
});
