import { describe, expect, it } from "vitest";
import { componentRange, entryDate, moreLine, offersWhatsNew, readWhatsNewWith, shownComponents, whatsNewError, whatsNewOf, whatsNewPath, type Updates } from "../src/index.js";

const component = (o: Record<string, unknown>) => ({ part: "studio", name: "Studio", installed: "0.1.3", entries: [], more: 0, releasesUrl: "https://github.com/o/r/releases", ...o });
const newer = (version: string, body = "x") => ({ version, body, available: true });

describe("what's new model", () => {
  it("reads the agent's answer and refuses one from an agent without the route", () => {
    expect(whatsNewOf(null)).toBeNull();
    expect(whatsNewOf({ error: "not found" })).toBeNull();
    const w = whatsNewOf({ channel: "beta", components: [component({ entries: [newer("0.1.4"), { body: "no version" }] }), { part: "other" }] });
    expect(w).toEqual({ channel: "beta", components: [{ ...component({}), entries: [{ version: "0.1.4", body: "x", url: "", publishedAt: null, available: true }] }] });
  });

  it("keeps only what is newer, even from an agent that also sent the installed release", () => {
    const w = whatsNewOf({ channel: "beta", components: [component({ previous: "0.1.1", entries: [newer("0.1.4"), { version: "0.1.3", body: "installed", available: false }] })] })!;
    expect(w.components[0].entries.map((e) => e.version)).toEqual(["0.1.4"]);
    // The installed release alone leaves nothing to show.
    expect(shownComponents(whatsNewOf({ channel: "beta", components: [component({ entries: [{ version: "0.1.3", body: "installed", available: false }] })] }))).toEqual([]);
  });

  it("drops a leading heading that only restates the version", () => {
    const w = whatsNewOf({ channel: "beta", components: [component({ entries: [newer("1.4.14-beta.5", "## v1.4.14-beta.5\n\nUnreal Engine 5.4 to 5.9.\n\n## Features"), newer("1.4.13", "## 1.4.13 is here\n\nText")] })] })!;
    expect(w.components[0].entries[0].body).toBe("Unreal Engine 5.4 to 5.9.\n\n## Features");
    expect(w.components[0].entries[1].body).toBe("## 1.4.13 is here\n\nText");
  });

  it("asks the cache, or GitHub again on refresh", async () => {
    const asked: string[] = [];
    await readWhatsNewWith(async (p) => (asked.push(p), null));
    await readWhatsNewWith(async (p) => (asked.push(p), null), true);
    expect(asked).toEqual([whatsNewPath(), "/v1/ext/studio/whats-new?refresh=1"]);
  });

  it("shows a part with something newer or an error, and hides one with nothing newer", () => {
    const w = whatsNewOf({ channel: "stable", components: [component({ entries: [newer("0.1.4", "")] }), component({ part: "plugin", error: "GitHub answered 500" }), component({ part: "bridge" })] });
    expect(shownComponents(w).map((c) => c.part)).toEqual(["studio", "plugin"]);
    expect(shownComponents(null)).toEqual([]);
  });

  it("offers What's new on the card only when the check found something newer", () => {
    const base: Updates = {
      studio: { channel: "beta", studio: { installed: "0.1.3", latest: "0.1.3", available: false }, plugin: { installed: "0.1.9", latest: "0.1.9", available: false, location: "project", engine: "5.7" } as never },
      ueMcp: { installed: { version: "1.4.2" }, server: "1.4.2", latest: "1.4.2", target: null, binaries: null },
    };
    expect(offersWhatsNew(null)).toBe(false);
    expect(offersWhatsNew(base)).toBe(false);
    expect(offersWhatsNew({ ...base, studio: { ...base.studio!, studio: { installed: "0.1.3", latest: "0.1.4", available: true } } })).toBe(true);
    expect(offersWhatsNew({ ...base, ueMcp: { ...base.ueMcp!, target: "1.4.3" } })).toBe(true);
  });

  it("words the range, the error, the longer list and the date", () => {
    const w = whatsNewOf({ channel: "stable", components: [component({ entries: [newer("0.1.5"), newer("0.1.4")] })] })!;
    expect(componentRange(w.components[0])).toBe("0.1.3 to 0.1.5");
    expect(whatsNewError(whatsNewOf({ channel: "stable", components: [component({ error: "GitHub answered 500" })] })!.components[0])).toBe("Could not load the release notes: GitHub answered 500.");
    expect(moreLine(1)).toBe("1 more release on the release page.");
    expect(moreLine(3)).toBe("3 more releases on the release page.");
    expect(entryDate("2026-11-14T10:00:00Z")).toBe("2026-11-14");
    expect(entryDate(null)).toBe("");
  });
});
