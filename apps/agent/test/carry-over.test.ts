import { describe, expect, it } from "vitest";
import { carryOver } from "../src/runner.js";
import { modelName } from "../src/models.js";

describe("a conversation moving onto the Claude sign-in", () => {
  it("brings the whole conversation along as text, without Studio's own notes", () => {
    const text = carryOver([
      { role: "user", content: [{ type: "text", text: "[Studio] the editor restarted" }, { type: "text", text: "Rebuild Meadow." }] },
      { role: "assistant", content: [{ type: "text", text: "Rebuilding." }, { type: "tool_use", id: "t1", name: "ue_mcp", input: { action: "call", method: "regenerate" } }] },
    ]);
    expect(text).toContain("User: Rebuild Meadow.");
    expect(text).toContain("Assistant: Rebuilding.");
    expect(text).toContain('Assistant called ue_mcp {"action":"call","method":"regenerate"}');
    expect(text).not.toContain("the editor restarted");
    expect(text.startsWith("[Studio] This session continues")).toBe(true);
  });

  it("keeps the most recent part of a long conversation", () => {
    const text = carryOver([{ role: "user", content: "a".repeat(500) }, { role: "assistant", content: [{ type: "text", text: "latest" }] }], 100);
    expect(text).toContain("(earlier part left out)");
    expect(text).toContain("latest");
  });

  it("names models the way the picker does", () => {
    expect(modelName("gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(modelName("some-new-model")).toBe("some-new-model");
  });
});
