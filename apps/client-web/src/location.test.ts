// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { formatLocation, parseLocation, pushLocation, readLocation, writeLocation } from "./location";

beforeEach(() => window.history.replaceState(null, "", "/ui/"));

describe("the panel's location", () => {
  it("parses the hash", () => {
    expect(parseLocation("#/chat/614e0ba1-1942")).toEqual({ tab: "Chat", session: "614e0ba1-1942", section: null });
    expect(parseLocation("#/settings/diagnostics")).toEqual({ tab: "Settings", session: null, section: "diagnostics" });
    expect(parseLocation("#/plugins")).toEqual({ tab: "Settings", session: null, section: "plugins" });
    expect(parseLocation("#/playtests")).toEqual({ tab: "Playtests", session: null, section: null });
    expect(parseLocation("")).toEqual({ tab: "Chat", session: null, section: null });
  });

  it("refuses what is not a tab, a session id or a section", () => {
    expect(parseLocation("#/nowhere").tab).toBe("Chat");
    expect(parseLocation("#/chat/../../x").session).toBeNull();
    expect(parseLocation("#/chat/<script>").session).toBeNull();
  });

  it("formats what it parses", () => {
    for (const h of ["#/chat/abc-1", "#/chat", "#/settings/project", "#/settings/plugins", "#/playtests"]) expect(formatLocation(parseLocation(h))).toBe(h);
    expect(formatLocation({ tab: "Settings", session: null, section: "plugins" })).toBe("#/settings/plugins");
  });

  it("keeps the session while another tab is open, and writes without a history entry", () => {
    const before = window.history.length;
    writeLocation({ tab: "Chat", session: "s1" });
    expect(window.location.hash).toBe("#/chat/s1");
    writeLocation({ tab: "Settings", section: "general" });
    expect(window.location.hash).toBe("#/settings/general");
    expect(window.history.length).toBe(before);
    expect(window.location.pathname).toBe("/ui/");
  });

  it("carries the hub screen under #/playtests, ids encoded, and nothing else", () => {
    expect(parseLocation("#/playtests/runs")).toEqual({ tab: "Playtests", session: null, section: null, sub: "runs" });
    expect(parseLocation("#/playtests/arrangements/arena/runs/run-1%3A2").sub).toBe("arrangements/arena/runs/run-1%3A2");
    expect(parseLocation("#/playtests/clips/jump/in/arena").sub).toBe("clips/jump/in/arena");
    expect(parseLocation("#/playtests/goals/tutorial").sub).toBeUndefined();
    for (const h of ["#/playtests/runs", "#/playtests/arrangements", "#/playtests/arrangements/arena", "#/playtests/suites", "#/playtests/suites/smoke", "#/playtests/clips/jump"]) expect(formatLocation(parseLocation(h))).toBe(h);
    expect(parseLocation("#/playtests/elsewhere").sub).toBeUndefined();
    expect(parseLocation("#/playtests/suites/a/b").sub).toBeUndefined();
    expect(parseLocation("#/playtests/suites/<x>").sub).toBeUndefined();
    expect(formatLocation({ tab: "Chat", session: "s1", section: null, sub: "runs" })).toBe("#/chat/s1");
  });

  it("moves between hub screens as navigations Back can return from", () => {
    window.location.hash = "#/playtests";
    const before = window.history.length;
    pushLocation({ tab: "Playtests", sub: "runs" });
    expect(window.location.hash).toBe("#/playtests/runs");
    expect(window.history.length).toBe(before + 1);
  });

  it("reads back after a reload at a new address with the hash carried over", () => {
    window.history.replaceState(null, "", "/ui/?token=ab#/chat/s9");
    expect(readLocation()).toEqual({ tab: "Chat", session: "s9", section: null });
  });
});
