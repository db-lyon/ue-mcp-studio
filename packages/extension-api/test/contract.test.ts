/** The extension API package: publishable, MIT, and the constants Studio itself reports. */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as published from "@ue-mcp-studio/extension-api";
import * as source from "../src/index.js";
import { studioAbout } from "../../../apps/agent/src/about.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));

describe("@ue-mcp-studio/extension-api", () => {
  it("is publishable under MIT and ships only its build and license", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.license).toBe("MIT");
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.files).toEqual(["dist", "LICENSE"]);
    expect(fs.readFileSync(path.join(dir, "LICENSE"), "utf-8")).toMatch(/^MIT License/);
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("names the five slots, once each", () => {
    expect([...source.SLOT_NAMES]).toEqual(["settings.section", "chat.card", "toolbar.action", "composer.action", "session.panel"]);
    expect(new Set(source.SLOT_NAMES).size).toBe(source.SLOT_NAMES.length);
  });

  it("resolves by name to the same constants as its source", () => {
    expect(published.STUDIO_AGENT_API_VERSION).toBe(source.STUDIO_AGENT_API_VERSION);
    expect(published.STUDIO_UI_API_VERSION).toBe(source.STUDIO_UI_API_VERSION);
    expect(published.SLOT_NAMES).toEqual(source.SLOT_NAMES);
    for (const v of [source.STUDIO_AGENT_API_VERSION, source.STUDIO_UI_API_VERSION]) expect(Number.isInteger(v) && v >= 1).toBe(true);
  });

  it("is what the agent reports from /about", () => {
    const about = studioAbout("0.1.0", { version: "1.4.11", projectDir: "C:/P", ui: { active: () => null } as never });
    expect(about.extensionApi).toEqual({ agent: source.STUDIO_AGENT_API_VERSION, ui: source.STUDIO_UI_API_VERSION });
    expect(about).toMatchObject({ agentVersion: "0.1.0", daemonVersion: "1.4.11", uiVersion: null, projectDir: "C:/P" });
  });
});
