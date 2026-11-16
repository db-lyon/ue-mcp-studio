import { describe, expect, it } from "vitest";
import { componentRange, entryDate, moreLine, readWhatsNewWith, shownComponents, whatsNewError, whatsNewOf, whatsNewPath } from "../src/index.js";

const component = (o: Record<string, unknown>) => ({ part: "studio", name: "Studio", installed: "0.1.3", previous: null, entries: [], more: 0, releasesUrl: "https://github.com/o/r/releases", ...o });

describe("what's new model", () => {
  it("reads the agent's answer and refuses one from an agent without the route", () => {
    expect(whatsNewOf(null)).toBeNull();
    expect(whatsNewOf({ error: "not found" })).toBeNull();
    const w = whatsNewOf({ channel: "beta", components: [component({ entries: [{ version: "0.1.3", body: "x", available: "yes" }, { body: "no version" }] }), { part: "other" }] });
    expect(w).toEqual({ channel: "beta", components: [{ ...component({}), entries: [{ version: "0.1.3", body: "x", url: "", publishedAt: null, available: false }] }] });
  });

  it("asks the cache, or GitHub again on refresh", async () => {
    const asked: string[] = [];
    await readWhatsNewWith(async (p) => (asked.push(p), null));
    await readWhatsNewWith(async (p) => (asked.push(p), null), true);
    expect(asked).toEqual([whatsNewPath(), "/v1/ext/studio/whats-new?refresh=1"]);
  });

  it("shows a part with notes or an error, and hides an empty one", () => {
    const w = whatsNewOf({ channel: "stable", components: [component({ entries: [{ version: "0.1.3", body: "" }] }), component({ part: "plugin", error: "GitHub answered 500" }), component({ part: "bridge" })] });
    expect(shownComponents(w).map((c) => c.part)).toEqual(["studio", "plugin"]);
    expect(shownComponents(null)).toEqual([]);
  });

  it("words the range, the error, the older releases and the date", () => {
    const w = whatsNewOf({ channel: "stable", components: [component({ previous: "0.1.1", entries: [{ version: "0.1.4", available: true }, { version: "0.1.3" }] })] })!;
    expect(componentRange(w.components[0])).toBe("0.1.1 to 0.1.3, 0.1.4 available");
    expect(componentRange(whatsNewOf({ channel: "stable", components: [component({})] })!.components[0])).toBe("0.1.3");
    expect(whatsNewError(whatsNewOf({ channel: "stable", components: [component({ error: "GitHub answered 500" })] })!.components[0])).toBe("Could not load the release notes: GitHub answered 500.");
    expect(moreLine(1)).toBe("1 older release on the release page.");
    expect(moreLine(3)).toBe("3 older releases on the release page.");
    expect(entryDate("2026-11-14T10:00:00Z")).toBe("2026-11-14");
    expect(entryDate(null)).toBe("");
  });
});
