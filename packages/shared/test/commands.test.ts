import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS, parseSlashCommand, slashPrefix, slashQuery } from "../src/commands.js";
import { slashMenuItems, slashQueries } from "../../client-core/src/composer-menus.js";

describe("slash commands at the start of a message", () => {
  it("runs a command with its text, and leaves other slashes alone", () => {
    expect(parseSlashCommand("/compact the door notes")).toEqual({ name: "compact", args: "the door notes" });
    expect(parseSlashCommand("/flow build_lighting quality=high")).toEqual({ name: "flow", args: "build_lighting quality=high" });
    expect(parseSlashCommand("/Game/Maps/L_Test is broken")).toBeNull();
    expect(parseSlashCommand("/playtest the door")).toBeNull();
    expect(slashQuery("/com")).toBe("com");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/compact ")).toBeNull();
  });
});

describe("slash commands in the middle of a message", () => {
  it("runs /compact from anywhere, the rest of the message as its text", () => {
    expect(parseSlashCommand("okay. time to /compact")).toEqual({ name: "compact", args: "okay. time to" });
    expect(parseSlashCommand("long chat, /compact keep the enemy notes")).toEqual({ name: "compact", args: "long chat, keep the enemy notes" });
  });

  it("leaves paths, unknown words and the structured commands as ordinary text", () => {
    expect(parseSlashCommand("open /Game/Combat/Tests/TS_Enemy")).toBeNull();
    expect(parseSlashCommand("and/or /compacting")).toBeNull();
    expect(parseSlashCommand("then /flow build_lighting")).toBeNull();
    expect(parseSlashCommand("then /action level.place_actor")).toBeNull();
  });

  it("opens the menu for a name typed after a space, and a pick keeps the text before it", () => {
    expect(slashQuery("okay. time to /com")).toBe("com");
    expect(slashQuery("and/or")).toBeNull();
    expect(slashPrefix("okay. time to /com")).toBe("okay. time to ");
    expect(slashPrefix("/com")).toBe("");
    const q = slashQueries("okay. time to /", SLASH_COMMANDS, true, true);
    const items = slashMenuItems(q, SLASH_COMMANDS, [], []);
    expect(items.map((i) => i.label)).toEqual(["/compact"]);
    expect(items[0].insert).toBe("okay. time to /compact ");
  });
});
