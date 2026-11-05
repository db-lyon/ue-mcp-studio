/**
 * Every review fixture's asset diff drawn as Android would take it. The
 * react-native mock throws where a phone does (text outside <Text>, an
 * accessibilityRole Android rejects); build 10 closed on the owner's phone
 * opening WBP_GameHUD's diff (accessibilityRole="treegrid"). REVIEW_DIFF may
 * name a diff answer saved from a real computer ({ change }), which is drawn
 * too; it stays out of the repo.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { CheckpointChange } from "@ue-mcp-studio/shared";
import { CHANGES, EXTRA } from "../../client-web/src/visual-qa/review-fixtures";
import { THEMES, ThemeProvider, type ThemeName } from "../src/ui";
import { AssetDiffView } from "../src/screens/chat/items/AssetDiff";
import { ANDROID_ACCESSIBILITY_ROLES } from "./mocks/react-native";
import { renderInProject } from "./helpers";

const real = process.env.REVIEW_DIFF ? [(JSON.parse(fs.readFileSync(process.env.REVIEW_DIFF, "utf8")) as { change: CheckpointChange }).change] : [];
const changes = [...CHANGES, ...EXTRA, ...real].filter((c) => c.assetDiff);

function draw(c: CheckpointChange, theme: ThemeName) {
  return renderInProject(
    <ThemeProvider name={theme}>
      <AssetDiffView diff={c.assetDiff!} name={c.path.split("/").pop()!} status={(c.status as "added" | "modified" | "deleted") ?? "modified"} />
    </ThemeProvider>,
  );
}

describe("the source", () => {
  it("names only accessibilityRoles Android accepts, on screens no test draws too", () => {
    const src = path.resolve(__dirname, "../src");
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name))
          for (const m of fs.readFileSync(p, "utf8").matchAll(/accessibilityRole=\{?\s*["'`]([a-z]+)["'`]/g)) if (!ANDROID_ACCESSIBILITY_ROLES.has(m[1])) bad.push(`${path.relative(src, p)}: ${m[1]}`);
      }
    };
    walk(src);
    expect(bad, "use role= for ARIA roles Android's accessibilityRole does not take").toEqual([]);
  });
});

describe("asset diffs as Android draws them", () => {
  it("reads Android's accessibility roles from React Native's source", () => {
    expect(ANDROID_ACCESSIBILITY_ROLES.has("button")).toBe(true);
    expect(ANDROID_ACCESSIBILITY_ROLES.has("treegrid")).toBe(false);
  });

  it("has fixtures to draw", () => {
    expect(changes.length).toBeGreaterThan(5);
  });

  for (const theme of Object.keys(THEMES) as ThemeName[]) {
    it(`draws every fixture in ${theme}, every group closed and opened again`, () => {
      for (const c of changes) {
        const { unmount } = draw(c, theme);
        // Fold and unfold every group and open every long value: each state is drawn as well.
        for (const b of screen.queryAllByRole("button")) {
          fireEvent.click(b);
          fireEvent.click(b);
        }
        unmount();
      }
    });
  }
});
