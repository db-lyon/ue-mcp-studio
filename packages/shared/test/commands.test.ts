import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS, parseSlashCommand, slashPrefix, slashQuery } from "../src/commands.js";
import { slashMenuItems, slashQueries } from "../../client-core/src/composer-menus.js";

describe("slash commands at the start of a message", () => {
  it("runs a command with its text, and leaves other slashes alone", () => {
    expect(parseSlashCommand("/playtest the door")).toEqual({ name: "playtest", args: "the door" });
    expect(parseSlashCommand("/flow build_lighting quality=high")).toEqual({ name: "flow", args: "build_lighting quality=high" });
    expect(parseSlashCommand("/Game/Maps/L_Test is broken")).toBeNull();
    expect(slashQuery("/pla")).toBe("pla");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/playtest ")).toBeNull();
  });
});

describe("slash commands in the middle of a message", () => {
  it("runs /playtest and /compact from anywhere, the rest of the message as their text", () => {
    expect(parseSlashCommand("okay. time to /playtest")).toEqual({ name: "playtest", args: "okay. time to" });
    expect(parseSlashCommand("check the swing /playtest then the death")).toEqual({ name: "playtest", args: "check the swing then the death" });
    expect(parseSlashCommand("long chat, /compact keep the enemy notes")).toEqual({ name: "compact", args: "long chat, keep the enemy notes" });
  });

  it("leaves paths, unknown words and the structured commands as ordinary text", () => {
    expect(parseSlashCommand("open /Game/Combat/Tests/TS_Enemy")).toBeNull();
    expect(parseSlashCommand("and/or /playtesting")).toBeNull();
    expect(parseSlashCommand("then /flow build_lighting")).toBeNull();
    expect(parseSlashCommand("then /action level.place_actor")).toBeNull();
  });

  it("opens the menu for a name typed after a space, and a pick keeps the text before it", () => {
    expect(slashQuery("okay. time to /pla")).toBe("pla");
    expect(slashQuery("and/or")).toBeNull();
    expect(slashPrefix("okay. time to /pla")).toBe("okay. time to ");
    expect(slashPrefix("/pla")).toBe("");
    const q = slashQueries("okay. time to /", SLASH_COMMANDS, true, true);
    const items = slashMenuItems(q, SLASH_COMMANDS, [], []);
    expect(items.map((i) => i.label)).toEqual(["/playtest", "/compact"]);
    expect(items[0].insert).toBe("okay. time to /playtest ");
  });
});
