import { describe, expect, it, vi } from "vitest";

vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.2.0" } } }));
const { compareVersions, studioTooOld, versionsOf, MIN_STUDIO } = await import("../src/native/compat");

describe("Studio version check", () => {
  it("orders versions the semver way, prereleases before their release", () => {
    expect(compareVersions("0.1.25-beta.9", "0.1.25-beta.30")).toBeLessThan(0);
    expect(compareVersions("0.1.25-beta.30", "0.1.25")).toBeLessThan(0);
    expect(compareVersions("0.1.26", "0.1.25")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("reads Studio and ue-mcp from the daemon's health", () => {
    expect(versionsOf({ version: "1.4.13", extensions: [{ name: "studio", version: "0.1.25-beta.31" }] })).toEqual({ ueMcp: "1.4.13", studio: "0.1.25-beta.31" });
    expect(versionsOf({})).toEqual({ ueMcp: null, studio: null });
  });

  it("asks for an update only when Studio is known and older", () => {
    expect(studioTooOld("0.1.25-beta.29")).toContain(MIN_STUDIO);
    expect(studioTooOld(MIN_STUDIO)).toBeNull();
    expect(studioTooOld("dev")).toBeNull();
    expect(studioTooOld(null)).toBeNull();
  });
});
