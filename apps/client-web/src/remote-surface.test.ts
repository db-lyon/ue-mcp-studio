/** What remote control shows each account, and how /remote and /rc are recognised. */
import { describe, expect, it } from "vitest";
import { REMOTE_COMMAND, SLASH_COMMANDS, isLocalCommand, matchCommands, parseSlashCommand, remoteSurface } from "@ue-mcp-studio/shared";

describe("remoteSurface", () => {
  it("is the working section on a paid plan, whatever STUDIO_PLAN_AVAILABLE says", () => {
    expect(remoteSurface(false, true)).toBe("working");
    expect(remoteSurface(true, true)).toBe("working");
  });

  it("is the plan note for a free account only while the plan is offered", () => {
    expect(remoteSurface(true, false)).toBe("upsell");
    expect(remoteSurface(false, false)).toBe("hidden");
  });

  it("waits for the answer: listed while the plan is offered, hidden otherwise", () => {
    expect(remoteSurface(true, null)).toBe("pending");
    expect(remoteSurface(false, null)).toBe("hidden");
  });
});

describe("/remote and /rc", () => {
  it("recognises the name and the alias alone, with surrounding space", () => {
    for (const t of ["/remote", "/rc", " /rc ", "/remote\n"]) expect(isLocalCommand(t, REMOTE_COMMAND), t).toBe(true);
    for (const t of ["/remote now", "remote", "/rcx", "/re", "say /rc"]) expect(isLocalCommand(t, REMOTE_COMMAND), t).toBe(false);
  });

  it("is matched in the menu by the alias too, and never by the agent's parser", () => {
    expect(matchCommands("rc", [...SLASH_COMMANDS, REMOTE_COMMAND]).map((c) => c.name)).toEqual(["remote"]);
    expect(matchCommands("rc").map((c) => c.name)).toEqual([]);
    expect(parseSlashCommand("/remote")).toBeNull();
    expect(parseSlashCommand("/rc")).toBeNull();
  });
});
