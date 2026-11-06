import { describe, expect, it } from "vitest";
import { APPROVAL_KIND, approvalTitle, restartLine } from "../src/approvals.js";
import { checkFailure, pluginOutside, updateStatus, type StudioUpdates, type UeMcpUpdate } from "../src/updates.js";
import { waitingWho } from "../src/update-run.js";
import { stoppingWhy } from "../src/connection.js";

describe("the editor approval card", () => {
  it("titles each operation by what it does, and only a close mentions the save prompt", () => {
    expect(approvalTitle({ tool: "editor_restart", operation: "stop" })).toBe("Stop the editor?");
    expect(approvalTitle({ tool: "editor_restart", operation: "start" })).toBe("Start the editor?");
    expect(approvalTitle({ tool: "editor_restart", operation: "rebuild" })).toBe("Rebuild and restart the editor?");
    expect(approvalTitle({ tool: "editor_restart" })).toBe("Restart the editor?");
    expect(restartLine("start")).toBe("Start the editor.");
    expect(restartLine("stop")).toBe("Stop the editor. Unsaved work gets the editor's save prompt first.");
    expect(APPROVAL_KIND.editor_restart).toBe("editor starts, stops and restarts");
  });
});

describe("the updates card", () => {
  const studio = (plugin: Partial<StudioUpdates["plugin"]>, error?: string) => ({ studio: { installed: "1", latest: "1", available: false }, plugin, error }) as unknown as StudioUpdates;
  const ueMcp = { installed: { version: "1" }, available: false } as unknown as UeMcpUpdate;

  it("never says up to date when a check did not answer", () => {
    expect(checkFailure({ studio: null, ueMcp })).toBe("no answer");
    expect(checkFailure({ studio: studio({}, "offline"), ueMcp })).toBe("offline");
    expect(updateStatus({ steps: 0, unchecked: "offline", waiting: false, working: false, ready: "" })).toEqual({ pill: "Not checked", tone: "warn", line: "Could not check for updates." });
    expect(updateStatus({ steps: 0, unchecked: null, waiting: false, working: false, ready: "" })).toEqual({ pill: "Up to date", tone: "ok", line: "Up to date." });
    expect(updateStatus({ steps: 1, unchecked: null, waiting: true, working: false, ready: "r" }).line).toBe("Update ready. It runs once no turn is in progress.");
  });

  it("says a plugin outside the project is not replaced, only when one is installed", () => {
    expect(pluginOutside(studio({ location: "engine", installed: "1", latest: "2" } as never))).toBe(true);
    expect(pluginOutside(studio({ location: "engine", installed: null, latest: "2" } as never))).toBe(false);
  });

  it("names what restarts once no turn is in progress", () => {
    expect(waitingWho(["studio"])).toBe("Studio restarts");
    expect(waitingWho(["plugin"])).toBe("The editor restarts");
    expect(waitingWho(["plugin", "restart"])).toBe("The editor and Studio restart");
  });
});

describe("the connection", () => {
  it("does not call a shutdown request a restart", () => {
    expect(stoppingWhy("shutdown requested", false).why).toBe("ue-mcp was asked to stop");
  });
});
