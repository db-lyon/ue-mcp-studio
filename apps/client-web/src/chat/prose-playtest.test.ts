import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { CONVERT_PREFIX, conversionMessage, offerConversion, proseSteps } from "./prose-playtest";

/** Replies the agent wrote instead of running a script, in the shapes models write them. */
const HITS: Record<string, { text: string; steps: Array<[string, "pass" | "fail" | null]> }> = {
  "dash markers": {
    text: "Here is the QA pass for the door:\n\n1. Walk up to the door - PASS\n2. Press E to open it - PASS\n3. The door opens without popping - FAIL (it snaps on the second frame)\n\nOverall the interaction works apart from the pop.",
    steps: [["Walk up to the door", "pass"], ["Press E to open it", "pass"], ["The door opens without popping (it snaps on the second frame)", "fail"]],
  },
  "emoji and bold": {
    text: "I tested movement in PIE:\n\n1. **Jump** ✅ works from standing and running\n2. **Double jump** ❌ the second press does nothing\n3. **Dash** ✅",
    steps: [["Jump works from standing and running", "pass"], ["Double jump the second press does nothing", "fail"], ["Dash", "pass"]],
  },
  "blank template": {
    text: "Test plan for the key and lock:\n\n1. Spawn in L_Dungeon. [PASS / FAIL]\n2. Pick up the brass key. [PASS / FAIL]\n3. Open the locked door with it. [PASS / FAIL]",
    steps: [["Spawn in L_Dungeon.", null], ["Pick up the brass key.", null], ["Open the locked door with it.", null]],
  },
  "bold verdicts after a colon": {
    text: "1. Character spawns at PlayerStart: **Pass**\n2. Camera follows the character: **Pass**\n3. Sprint speed: **Fail**, stays at walk speed\n4. Crouch: **Pass**",
    steps: [["Character spawns at PlayerStart", "pass"], ["Camera follows the character", "pass"], ["Sprint speed, stays at walk speed", "fail"], ["Crouch", "pass"]],
  },
  "result labels with wrapped lines": {
    text: "Checklist:\n1) Open the inventory with Tab.\n   Result: PASSED\n2) Drag the sword to the hotbar.\n   Result: FAILED, the slot stays empty\n3) Equip it with 1.\n   Result: PASSED",
    steps: [["Open the inventory with Tab.", "pass"], ["Drag the sword to the hotbar. the slot stays empty", "fail"], ["Equip it with 1.", "pass"]],
  },
  "a list with one unmarked step": {
    text: "1. Start PIE\n2. Fire the rifle - PASS\n3. Reload - FAIL",
    steps: [["Start PIE", null], ["Fire the rifle", "pass"], ["Reload", "fail"]],
  },
};

const MISSES: Record<string, string> = {
  "how-to steps": "To set this up:\n\n1. Open BP_Door\n2. Add a Timeline component\n3. Compile and save",
  "pass and fail in a sentence": "Before you ship:\n\n1. Make sure the build does not fail\n2. Check that the unit tests pass\n3. Tag the release",
  "one marked item": "What I did:\n1. Built the project\n2. Ran the server - FAIL\n3. Restarted it\n4. Ran it again",
  "bullets, not numbers": "- Jump: PASS\n- Dash: FAIL\n- Crouch: PASS",
  "a list inside a code block": "The test log:\n\n```\n1. door_opens PASS\n2. door_closes FAIL\n```\n\nI will look at door_closes next.",
  "a summary line before an ordinary list": "The suite ran: 12 PASS, 3 FAIL.\n\n1. Fix the flaky timer test\n2. Run the suite again",
  "a single numbered line": "1. Jump - PASS",
  "markers on too few of many items": "1. Open the map\n2. Place the actor\n3. Set its mesh\n4. Set its material - PASS\n5. Save - PASS\n6. Build lighting\n7. Package",
};

describe("finding a prose playtest in a reply", () => {
  for (const [name, x] of Object.entries(HITS)) {
    it(`finds ${name}`, () => {
      const steps = proseSteps(x.text);
      expect(steps?.map((s) => [s.instruction, s.mark])).toEqual(x.steps);
    });
  }
  for (const [name, text] of Object.entries(MISSES)) {
    it(`ignores ${name}`, () => {
      expect(proseSteps(text)).toBeNull();
    });
  }
});

const user = (text: string): TranscriptEntry => ({ kind: "user", text, at: "" });
const reply = (text: string, parent?: string): TranscriptEntry => ({ kind: "assistant", text, at: "", ...(parent ? { parent } : {}) });
const pie = (method: string, parent?: string): TranscriptEntry => ({
  kind: "tool", call: { id: method, name: "ue_mcp", input: { action: "call", category: "pie", method, args: {} }, outcome: "done", startedAt: "" }, ...(parent ? { parent } : {}),
});
const PROSE = HITS["dash markers"].text;

describe("offering to turn it into a Playtest", () => {
  it("offers it once the turn has ended without a script saved or run", () => {
    const t = [user("test the door"), pie("script_list"), reply(PROSE)];
    expect(offerConversion(t, 2, "idle")?.count).toBe(3);
    expect(offerConversion(t, 2, "running")).toBeNull();
    expect(offerConversion([...t, user("thanks")], 2, "running")?.count).toBe(3);
  });

  it("does not offer it when the turn ran a script, a subagent's included, or showed a Playtest card", () => {
    expect(offerConversion([user("test"), pie("script_run"), reply(PROSE)], 2, "idle")).toBeNull();
    expect(offerConversion([user("test"), pie("script_create"), reply(PROSE)], 2, "idle")).toBeNull();
    expect(offerConversion([user("test"), pie("script_update", "ag1"), reply(PROSE)], 2, "idle")).toBeNull();
    expect(offerConversion([user("test"), reply(PROSE), pie("script_replay", "ag1")], 1, "idle")).toBeNull();
    const qa = { kind: "qa", run: { runId: "r" } } as unknown as TranscriptEntry;
    expect(offerConversion([user("test"), qa, reply(PROSE)], 2, "idle")).toBeNull();
    // A script run in another turn does not count.
    expect(offerConversion([user("a"), pie("script_run"), reply("ran"), user("b"), reply(PROSE)], 4, "idle")?.count).toBe(3);
  });

  it("does not offer it on a subagent's reply, or after the user converted it", () => {
    expect(offerConversion([user("test"), reply(PROSE, "ag1")], 1, "idle")).toBeNull();
    expect(offerConversion([user("test"), reply(PROSE), user(`${CONVERT_PREFIX} and run it.`)], 1, "running")).toBeNull();
  });

  it("asks the agent for a draft script with each step's expect from an observation profile", () => {
    const text = conversionMessage(proseSteps(PROSE)!);
    expect(text.startsWith(CONVERT_PREFIX)).toBe(true);
    expect(text).toContain("pie.script_create");
    expect(text).toContain("1. Walk up to the door\n2. Press E to open it\n3. The door opens without popping");
    expect(text).toMatch(/observation profile/);
    expect(text).toMatch(/make the step auto with an expect on that value/);
    expect(text).toMatch(/make it manual/);
    expect(text).toMatch(/Save the script and stop there: the card shows it as a draft, and the user starts it/);
    expect(text).not.toMatch(/pie.script_run/);
  });
});
