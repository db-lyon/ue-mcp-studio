import { describe, expect, it } from "vitest";
import { judgeOf, playerOf, scriptName, tablePlaytest, tableScriptSteps } from "./table-playtest";
import { writtenPlaytest } from "./prose-playtest";

/** The draft the agent wrote in Vale instead of creating the script, in its exact shape. */
export const SIGIL_TABLE = [
  "### Sigil pickup playtest",
  "",
  "| # | Player | Do | Pass when | Judged |",
  "|---|---|---|---|---|",
  "| 1 | Host | Pick up the sigil on the altar | The sigil counter reads 100 | auto: PlayerState.SigilAttributes.Sigil.CurrentValue eq 100, within 5 s |",
  "| 2 | Client | Watch the host pick it up | The pickup effect plays on the client too | manual |",
  "| 3 | Host | Walk through the shrine gate | The gate opens for the sigil holder | auto: `BP_ShrineGate_C.bIsOpen` eq 1, within 5 s |",
  "| 4 | Client | Try the gate without a sigil | The gate stays shut and the locked prompt shows | manual |",
].join("\n");

describe("a playtest written as a table", () => {
  it("reads the five-column draft: steps, players, auto checks and manual rows", () => {
    const t = tablePlaytest(SIGIL_TABLE)!;
    expect(t.name).toBe("Sigil pickup playtest");
    expect(t.steps).toEqual([
      { instruction: "Pick up the sigil on the altar. Pass when: The sigil counter reads 100", judge: "auto", expect: { value: "PlayerState.SigilAttributes.Sigil.CurrentValue", op: "eq", target: 100, within_ms: 5000 }, player: "host" },
      { instruction: "Watch the host pick it up. Pass when: The pickup effect plays on the client too", judge: "manual", player: "client 1" },
      { instruction: "Walk through the shrine gate. Pass when: The gate opens for the sigil holder", judge: "auto", expect: { value: "BP_ShrineGate_C.bIsOpen", op: "eq", target: 1, within_ms: 5000 }, player: "host" },
      { instruction: "Try the gate without a sigil. Pass when: The gate stays shut and the locked prompt shows", judge: "manual", player: "client 1" },
    ]);
  });

  it("becomes the script directly when every row says how it is judged", () => {
    const c = writtenPlaytest(SIGIL_TABLE)!;
    expect(c.count).toBe(4);
    expect(c.script?.name).toBe("PT_SigilPickup");
    expect(c.script?.steps.map((s) => [s.judge, s.player, s.expect?.value ?? null])).toEqual([
      ["auto", "host", "PlayerState.SigilAttributes.Sigil.CurrentValue"],
      ["manual", "client 1", null],
      ["auto", "host", "BP_ShrineGate_C.bIsOpen"],
      ["manual", "client 1", null],
    ]);
  });

  it("goes to the agent when a row has no check Studio can read", () => {
    const t = tablePlaytest("| Step | Expected |\n|---|---|\n| Open the door | It swings open |\n| Walk through | No hitch |")!;
    expect(t.steps.map((s) => s.judge)).toEqual([undefined, undefined]);
    expect(tableScriptSteps(t)).toBeNull();
    const c = writtenPlaytest("| Step | Expected |\n|---|---|\n| Open the door | It swings open |\n| Walk through | No hitch |")!;
    expect(c.script).toBeNull();
    expect(c.message).toContain("1. Open the door. Pass when: It swings open");
  });

  it("reads the usual ways of writing a check", () => {
    expect(judgeOf("auto: Door.OpenAngle > 80, within 3000 ms")).toEqual({ judge: "auto", expect: { value: "Door.OpenAngle", op: "gt", target: 80, within_ms: 3000 } });
    expect(judgeOf("**auto** `Door.Distance` decreasing within 2 s")).toEqual({ judge: "auto", expect: { value: "Door.Distance", op: "decreasing", within_ms: 2000 } });
    expect(judgeOf("auto: BP_Key_C exists")).toEqual({ judge: "auto", expect: { value: "BP_Key_C", op: "exists" } });
    expect(judgeOf("Manual (look)")).toEqual({ judge: "manual" });
    expect(judgeOf("auto, by eye")).toEqual({ judge: "auto" });
    expect(playerOf("Host")).toBe("host");
    expect(playerOf("Client 2")).toBe("client 2");
    expect(playerOf("Both")).toBeUndefined();
  });

  it("names a script without a heading by the time", () => {
    expect(scriptName(null, new Date(2026, 9, 24, 9, 5, 7))).toBe("PT_Playtest_090507");
  });
});

describe("tables that are not playtests", () => {
  const MISSES: Record<string, string> = {
    "settings and values": "| Setting | Value |\n|---|---|\n| Max FPS | 60 |\n| VSync | Off |",
    "assets and sizes": "| Asset | Size | Used by |\n|---|---|---|\n| T_Rock | 4 MB | M_Rock |\n| T_Sand | 2 MB | M_Sand |",
    "a single row": "| Do | Pass when |\n|---|---|\n| Jump | The pawn leaves the ground |",
    "a table in a code block": "```\n| Do | Pass when |\n|---|---|\n| Jump | Up |\n| Land | Down |\n```",
    "a comparison": "| Option | Pros | Cons |\n|---|---|---|\n| Timeline | Simple | One curve |\n| Sequencer | Rich | Heavy |",
  };
  for (const [name, text] of Object.entries(MISSES)) {
    it(`ignores ${name}`, () => {
      expect(tablePlaytest(text)).toBeNull();
      expect(writtenPlaytest(text)).toBeNull();
    });
  }
});
