import { describe, expect, it } from "vitest";
import { actionsOf, appUpdateLine, channelLabel, chipsOf, daemonRows, filterProjects, parseReport, running, studioOf, uptime, type MachineProject, type MachineReport } from "./model";

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

  it("says each project's state in chips", () => {
    expect(chipsOf(project({ ueMcp: { setUp: false, bridge: null, config: false } }), {}).map((c) => c.label)).toEqual(["ue-mcp not set up", "No Studio"]);
    const open = project({ extensions: { studio: "0.1.35" }, editor: { running: true, pids: [1] } });
    expect(chipsOf(open, { "0e9f3c9aae1e89bb": { pid: 1, port: 2, version: "1.4.13" } }).map((c) => c.label)).toEqual(["ue-mcp 1.4.13", "Studio 0.1.35", "Running", "Editor open"]);
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

  it("lists running daemons by project name, and names an unlisted one by its .uproject", () => {
    const r: MachineReport = {
      version: 1, ueMcp: "1.4.13", daemonDir: "D", projects: [project()],
      daemons: [
        { key: "0e9f3c9aae1e89bb", projectRoot: "c:/p/vale", uproject: "C:\\P\\Vale\\Vale.uproject", pid: 1, port: 2, version: "1", startedAt: "", discovery: "", log: "" },
        { key: "1111111111111111", projectRoot: "c:/x/tests/.shards/h1/ue_mcp", uproject: "C:\\x\\tests\\.shards\\h1\\ue_mcp\\ue_mcp.uproject", pid: 3, port: 4, version: "1", startedAt: "", discovery: "", log: "" },
        { key: "2222222222222222", projectRoot: "c:/gone", uproject: null, pid: 5, port: 6, version: "1", startedAt: "", discovery: "", log: "" },
      ],
    };
    expect(daemonRows(r, null).map((d) => [d.name, d.listed])).toEqual([["Vale", true], ["ue_mcp", false], ["gone", false]]);
    expect(daemonRows(r, { "1111111111111111": { pid: 3, port: 4, version: "1" } }).map((d) => d.name)).toEqual(["ue_mcp"]);
  });

  it("lists a listed project's daemon that started after the report was read", () => {
    const r: MachineReport = { version: 1, ueMcp: "1.4.13", daemonDir: "D", projects: [project()], daemons: [] };
    expect(daemonRows(r, { "0e9f3c9aae1e89bb": { pid: 12, port: 34, version: "1.4.13" } })).toMatchObject([{ name: "Vale", pid: 12, port: 34, listed: true, startedAt: "" }]);
    expect(daemonRows(r, {})).toEqual([]);
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

describe("the UE-MCP row on Updates", () => {
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
