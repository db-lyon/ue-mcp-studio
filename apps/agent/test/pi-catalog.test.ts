/**
 * packages/shared/src/pi-catalog.ts is pi-ai's built-in catalog at the version
 * the agent pins: windows and prices the shared package, the agent and both
 * clients use where a vendor's model list says nothing.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { contextWindowOf, requestCost } from "@ue-mcp-studio/shared";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("pi-ai's catalog in the shared package", () => {
  it("matches the pinned pi-ai (run node scripts/pi-catalog.mjs after bumping it)", async () => {
    const gen = (await import(path.join(root, "scripts", "pi-catalog.mjs").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"))) as {
      catalog(): Promise<Record<string, unknown>>;
      render(entries: Record<string, unknown>, version: string): string;
      piAiVersion(): string;
    };
    const want = gen.render(await gen.catalog(), gen.piAiVersion());
    expect(fs.readFileSync(path.join(root, "packages", "shared", "src", "pi-catalog.ts"), "utf-8")).toBe(want);
  });

  it("gives a window to a model Studio's own rules do not know", () => {
    expect(contextWindowOf("gpt-4")).toEqual({ tokens: 8192, known: true });
    expect(contextWindowOf("some-local-model").known).toBe(false);
  });

  it("keeps a window tag's variant and the vendor's own list first", () => {
    expect(contextWindowOf("claude-haiku-4-5[1m]").tokens).toBe(1_000_000);
    expect(contextWindowOf("gpt-4", 32_000).tokens).toBe(32_000);
  });

  it("prices a model Studio's own table does not, and keeps Studio's prices where it does", () => {
    // gpt-4: $30 in and $60 out per million in the catalog.
    expect(requestCost("gpt-4", { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(90, 6);
    // claude-fable-5: Studio's table reads cache at $0.25, the catalog at $1.
    expect(requestCost("claude-fable-5", { input: 0, output: 0, cacheRead: 1_000_000 })).toBeCloseTo(0.25, 6);
    expect(requestCost("some-local-model", { input: 1, output: 1 })).toBeNull();
  });
});
