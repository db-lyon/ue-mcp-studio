import { describe, expect, it } from "vitest";
import { FormBroker } from "../src/forms.js";
import { feedbackToolOn, withFeedbackTool } from "../src/agent-settings.js";

const params = {
  message: "File this report?\n\npcg has no wait for a generation to finish",
  requestedSchema: { type: "object" as const, properties: { revisions: { type: "string", title: "Changes" } }, required: [] },
};

describe("forms ue-mcp raises during a turn", () => {
  it("waits for the user's answer, and drops the form once answered", async () => {
    const seen: string[] = [];
    const b = new FormBroker((type, data) => seen.push(`${type}:${data.sessionId}`));
    const answer = b.ask("s1", "feedback(submit)", params);
    const [form] = b.list("s1");
    expect(form).toMatchObject({ sessionId: "s1", call: "feedback(submit)", message: params.message });
    expect(b.list("other")).toEqual([]);
    expect(b.answer(form.id, { action: "accept", content: { revisions: "clearer title" } })).toBeNull();
    expect(await answer).toEqual({ action: "accept", content: { revisions: "clearer title" } });
    expect(b.list()).toEqual([]);
    expect(seen).toEqual(["form.changed:s1", "form.changed:s1"]);
  });

  it("asks for required fields, and refuses an answer that is not one", () => {
    const b = new FormBroker(() => {});
    void b.ask("s1", "x(y)", { ...params, requestedSchema: { ...params.requestedSchema, required: ["revisions"] } });
    const [form] = b.list();
    expect(b.answer(form.id, { action: "accept", content: {} })).toMatch(/revisions/);
    expect(b.answer(form.id, { action: "maybe" })).toMatch(/body must be/);
    expect(b.answer("gone", { action: "decline" })).toMatch(/no longer waiting/);
  });

  it("cancels a stopped session's forms so their calls return", async () => {
    const b = new FormBroker(() => {});
    const answer = b.ask("s1", "feedback(submit)", params);
    b.cancelSession("s1");
    expect(await answer).toEqual({ action: "cancel" });
  });
});

describe("the feedback tool in ue-mcp.yml", () => {
  const yml = "# keep this comment\nue-mcp:\n  version: 1\n";
  it("is on unless disabled, and turns off and on without losing the file's comments", () => {
    expect(feedbackToolOn(yml)).toBe(true);
    const off = withFeedbackTool(yml, false);
    expect(feedbackToolOn(off)).toBe(false);
    expect(off).toContain("# keep this comment");
    const on = withFeedbackTool(off, true);
    expect(feedbackToolOn(on)).toBe(true);
    expect(on).not.toContain("disable");
    expect(feedbackToolOn(withFeedbackTool("ue-mcp:\n  disable:\n    - niagara\n", false))).toBe(false);
    expect(withFeedbackTool("ue-mcp:\n  disable:\n    - niagara\n", true)).toContain("niagara");
  });

  it("reads and writes the list where ue-mcp reads it, under the ue-mcp block", () => {
    // What `ue-mcp init` writes for a project set up without the feedback tool.
    const init = "ue-mcp:\n  version: 1\n  disable:\n    - feedback\n";
    expect(feedbackToolOn(init)).toBe(false);
    const on = withFeedbackTool(init, true);
    expect(feedbackToolOn(on)).toBe(true);
    expect(on).toBe("ue-mcp:\n  version: 1\n");
    expect(withFeedbackTool(yml, false)).toContain("ue-mcp:\n  version: 1\n  disable:\n    - feedback");
  });

  it("moves a top-level list an earlier Studio wrote into the block", () => {
    const stray = "ue-mcp:\n  version: 1\ndisable:\n  - feedback\n  - niagara\n";
    expect(withFeedbackTool(stray, true)).toBe("ue-mcp:\n  version: 1\n  disable:\n    - niagara\n");
  });
});
