// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { formatLocation, parseLocation, readLocation, writeLocation } from "./location";

beforeEach(() => window.history.replaceState(null, "", "/ui/"));

describe("the panel's location", () => {
  it("parses the hash", () => {
    expect(parseLocation("#/chat/614e0ba1-1942")).toEqual({ tab: "Chat", session: "614e0ba1-1942", section: null });
    expect(parseLocation("#/settings/diagnostics")).toEqual({ tab: "Settings", session: null, section: "diagnostics" });
    expect(parseLocation("#/flows")).toEqual({ tab: "Flows", session: null, section: null });
    expect(parseLocation("")).toEqual({ tab: "Chat", session: null, section: null });
  });

  it("refuses what is not a tab, a session id or a section", () => {
    expect(parseLocation("#/nowhere").tab).toBe("Chat");
    expect(parseLocation("#/chat/../../x").session).toBeNull();
    expect(parseLocation("#/chat/<script>").session).toBeNull();
  });

  it("formats what it parses", () => {
    for (const h of ["#/chat/abc-1", "#/chat", "#/settings/project", "#/plugins"]) expect(formatLocation(parseLocation(h))).toBe(h);
    expect(formatLocation({ tab: "Flows", session: "abc", section: "x" })).toBe("#/flows");
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

  it("reads back after a reload at a new address with the hash carried over", () => {
    window.history.replaceState(null, "", "/ui/?token=ab#/chat/s9");
    expect(readLocation()).toEqual({ tab: "Chat", session: "s9", section: null });
  });
});
