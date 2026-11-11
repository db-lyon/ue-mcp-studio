import { describe, expect, it } from "vitest";
import { actionsOf, appUpdateLine, channelLabel, filterProjects, nameHint, parseReport, running, studioOf, updateHow, updatesOf, uptime, versionsOf, type MachineProject } from "./model";

const project = (o: Partial<MachineProject> = {}): MachineProject => ({
  name: "Vale",
  uproject: "C:\\P\\Vale\\Vale.uproject",
  dir: "C:\\P\\Vale",
  key: "0e9f3c9aae1e89bb",
  source: "recent",
  lastOpened: null,
  engine: { association: "5.8", version: "5.8" },
  editor: { running: false, pids: [] },
  ueMcp: { setUp: true, bridge: { version: "1.4.13", kind: "binary" }, config: true },
  extensions: {},
  plugins: [],
  daemon: { discovery: "d.json", log: "d.log", running: null },
  ...o,
});

describe("the UE-MCP app's model", () => {
  it("finds Studio by the version a project records, or by its editor plugin", () => {
    expect(studioOf(project())).toEqual({ installed: false, version: null, plugin: null });
    expect(studioOf(project({ extensions: { studio: "0.1.35" } }))).toMatchObject({ installed: true, version: "0.1.35" });
    expect(studioOf(project({ plugins: [{ name: "UE_MCP_Studio", version: "0.1.8" }] }))).toMatchObject({ installed: true, plugin: "0.1.8" });
  });

  it("takes the host's live read of a daemon over the report's snapshot", () => {
    const d = { key: "k", projectRoot: "", uproject: null, pid: 7, port: 8, version: "1.4.13", startedAt: "", discovery: "", log: "" };
    const p = project({ daemon: { discovery: "", log: "", running: d } });
    expect(running(p, null)).toEqual({ pid: 7, port: 8, version: "1.4.13" });
    expect(running(p, {})).toBeNull();
    expect(running(project(), { "0e9f3c9aae1e89bb": { pid: 9, port: 1, version: "x" } })).toEqual({ pid: 9, port: 1, version: "x" });
  });

  it("lists a project's versions: the daemon's ue-mcp over the app's, the bridge, Studio and its editor plugin", () => {
    const p = project({ extensions: { studio: "0.1.35" }, plugins: [{ name: "UE_MCP_Studio", version: "0.1.8" }] });
    expect(versionsOf(p, {}, "1.4.14")).toEqual([
      { label: "ue-mcp", version: "1.4.14" }, { label: "Bridge", version: "1.4.13" }, { label: "Studio", version: "0.1.35" }, { label: "Editor plugin", version: "0.1.8" },
    ]);
    expect(versionsOf(p, { "0e9f3c9aae1e89bb": { pid: 1, port: 2, version: "1.4.12" } }, "1.4.14")[0]).toEqual({ label: "ue-mcp", version: "1.4.12" });
    expect(versionsOf(project({ ueMcp: { setUp: false, bridge: null, config: false } }), {}, "1.4.14")).toEqual([]);
  });

  it("tells same-named projects apart by the fewest parent folders that differ", () => {
    const a = project({ name: "ue_mcp", key: "a", dir: "C:\\work\\ue-mcp\\tests\\ue_mcp" });
    const b = project({ name: "ue_mcp", key: "b", dir: "C:\\work\\ue-mcp-release\\tests\\ue_mcp" });
    const c = project({ name: "Vale", key: "c", dir: "C:\\P\\Vale" });
    expect(nameHint(a, [a, b, c])).toBe("ue-mcp\\tests");
    expect(nameHint(b, [a, b, c])).toBe("ue-mcp-release\\tests");
    expect(nameHint(c, [a, b, c])).toBe("");
    const d = project({ name: "UE_MCP", key: "d", dir: "D:\\games\\ue_mcp" });
    expect(nameHint(d, [a, d])).toBe("games");
  });

  it("waits to add Studio while the editor has the project open or another install runs, and to launch while its own install runs", () => {
    expect(actionsOf(project(), false, false)).toEqual({ openStudio: false, addStudio: true, addBlocked: null, launchBlocked: null });
    expect(actionsOf(project({ editor: { running: true, pids: [1] } }), false, false)).toMatchObject({ addBlocked: "Close Vale in Unreal first.", launchBlocked: "Vale is open in Unreal." });
    expect(actionsOf(project(), false, true)).toMatchObject({ addBlocked: "Another install is running.", launchBlocked: null });
    expect(actionsOf(project(), true, false).launchBlocked).toMatch(/install/);
    expect(actionsOf(project({ extensions: { studio: "0.1.35" } }), false, false)).toMatchObject({ openStudio: true, addStudio: false });
  });

  it("filters by name, folder or engine", () => {
    const list = [project(), project({ name: "Harbor", dir: "D:\\Games\\Harbor", key: "b", engine: { association: "5.6", version: "5.6" } })];
    expect(filterProjects(list, "harb").map((p) => p.name)).toEqual(["Harbor"]);
    expect(filterProjects(list, "5.8").map((p) => p.name)).toEqual(["Vale"]);
    expect(filterProjects(list, " ")).toHaveLength(2);
  });

  it("finds updates from installed versions against the channel's newest, with no daemon", () => {
    expect(updatesOf(project(), null)).toBeNull();
    const studio = project({ extensions: { studio: "0.1.34" }, plugins: [{ name: "UE_MCP_Studio", version: "0.1.8" }] });
    const u = updatesOf(studio, { channel: "beta", ueMcp: "1.4.14", studio: "0.1.35", plugin: "0.1.8" })!;
    expect(u.parts.map((x) => [x.name, x.installed, x.latest, x.available])).toEqual([
      ["Bridge plugin", "1.4.13", "1.4.14", true], ["Studio", "0.1.34", "0.1.35", true], ["Editor plugin", "0.1.8", "0.1.8", false],
    ]);
    expect(u).toMatchObject({ via: "studio", pill: "Update available", tone: "warn", line: "Ready to install: the bridge plugin 1.4.14 and Studio 0.1.35." });
    expect(u.waiting[1].installs).toMatch(/^Studio 0\.1\.35/);
    expect(updateHow(u, studio)).toMatch(/Studio on its Updates card/);
  });

  it("updates a project without Studio by ue-mcp update, and waits while its editor is open", () => {
    const u = updatesOf(project(), { channel: "stable", ueMcp: "1.4.14", studio: "0.1.35", plugin: "0.1.8" })!;
    expect(u.parts.map((x) => x.name)).toEqual(["Bridge plugin"]);
    expect(u.via).toBe("ue-mcp");
    expect(updateHow(u, project())).toBe("Runs ue-mcp update --apply-only for Vale.");
    expect(updateHow(u, project({ editor: { running: true, pids: [1] } }))).toMatch(/^Close Vale in Unreal first/);
  });

  it("says up to date on the channel, why a part was not checked, and nothing for a project not set up", () => {
    expect(updatesOf(project(), { channel: "beta", ueMcp: "1.4.13" })).toMatchObject({ via: null, pill: "Up to date", line: "Up to date on Beta." });
    const s = project({ extensions: { studio: "0.1.35" } });
    expect(updatesOf(s, { channel: "beta", ueMcp: "1.4.13", errors: { studio: "GitHub's rate limit for release checks was reached." } })).toMatchObject({
      pill: "Not checked", line: "Could not check: GitHub's rate limit for release checks was reached.",
    });
    expect(updatesOf(project({ ueMcp: { setUp: false, bridge: null, config: false } }), { ueMcp: "1.4.14" })).toMatchObject({ parts: [], pill: "", via: null });
  });

  it("reads uptime in minutes, hours and days", () => {
    const now = Date.parse("2026-11-08T12:00:00Z");
    expect(uptime("2026-11-08T11:56:00Z", now)).toBe("4m");
    expect(uptime("2026-11-08T09:55:00Z", now)).toBe("2h 05m");
    expect(uptime("2026-11-05T08:00:00Z", now)).toBe("3d 4h");
    expect(uptime("", now)).toBe("");
  });

  it("reads only report version 1", () => {
    expect(parseReport(JSON.stringify({ version: 1, projects: [], daemons: [] }))).not.toBeNull();
    expect(parseReport(JSON.stringify({ version: 2, projects: [], daemons: [] }))).toBeNull();
    expect(parseReport("not json")).toBeNull();
    expect(parseReport(undefined)).toBeNull();
  });
});

describe("the UE-MCP row in Settings", () => {
  it("names the channel the way Studio's Updates card does", () => {
    expect(channelLabel("stable")).toBe("Stable");
    expect(channelLabel("beta")).toBe("Beta");
  });

  it("shows the version here, the channel and the channel's newest", () => {
    expect(appUpdateLine("0.1.35-beta.5", null, "beta", false)).toBe("UE-MCP 0.1.35-beta.5, on Beta.");
    expect(appUpdateLine("0.1.35-beta.5", { ok: true, channel: "beta", version: "0.1.35-beta.6", newer: true }, "beta", false)).toBe("UE-MCP 0.1.35-beta.6 is ready to install from Beta. You have 0.1.35-beta.5.");
    expect(appUpdateLine("0.1.35-beta.6", { ok: true, channel: "beta", version: "0.1.35-beta.6", newer: false }, "beta", false)).toBe("UE-MCP 0.1.35-beta.6, the newest on Beta.");
    expect(appUpdateLine("0.1.35-beta.6", { ok: true, channel: "stable", version: "0.1.34", newer: false }, "stable", false)).toBe("UE-MCP 0.1.35-beta.6. The newest on Stable is 0.1.34.");
  });

  it("names the channel the check read over the one picked, and says why a check failed", () => {
    expect(appUpdateLine("0.1.35", { ok: true, channel: "stable", version: "0.1.35", newer: false }, "beta", false)).toBe("UE-MCP 0.1.35, the newest on Stable.");
    expect(appUpdateLine("0.1.35", { ok: false, channel: "beta", error: "GitHub's rate limit for release checks was reached." }, "beta", false)).toBe("Could not check Beta: GitHub's rate limit for release checks was reached.");
    expect(appUpdateLine("0.1.35", { ok: true, version: "0.1.36", newer: true }, "beta", true)).toBe("Installing. UE-MCP restarts when it is done.");
  });
});
