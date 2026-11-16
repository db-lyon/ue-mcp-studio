/**
 * Studio's model behind flow agent steps: registered with the daemon's
 * models hook, answered by the durable harness on the route the user picked,
 * with no tools and the JSON Schema in the system prompt, and the JSON parsed
 * out of the answer. The harness side is in test/durable/complete.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { parseJsonAnswer, promptOf, registerFlowModel, schemaInstruction, studioFlowModel, systemOf, type FlowModelOptions } from "../src/flow-model.js";

const SCHEMA = { type: "object", required: ["steps"], properties: { steps: { type: "array" } } };

type Call = { system: string; prompt: string; effort: string };
const recorder = (answer: string | Error) => {
  const calls: Call[] = [];
  const complete: FlowModelOptions["complete"] = async (system, prompt, effort) => {
    calls.push({ system, prompt, effort });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, complete };
};

const options = (over: Partial<FlowModelOptions> = {}): FlowModelOptions => ({
  model: () => "claude-opus-5-5",
  effort: () => "medium",
  complete: recorder("{}").complete,
  ...over,
});

describe("registering Studio's model for flow agent steps", () => {
  it("registers one provider with the daemon's models hook and takes it back on dispose", () => {
    const unregister = vi.fn();
    const register = vi.fn(() => unregister);
    const off = registerFlowModel({ models: { register } }, options());
    expect(register).toHaveBeenCalledTimes(1);
    const provider = (register.mock.calls[0] as unknown as [{ complete: unknown }])[0];
    expect(typeof provider.complete).toBe("function");
    off();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("fails loudly on a daemon without the hook", () => {
    expect(() => registerFlowModel({}, options())).toThrow(/ue-mcp has no models/);
  });
});

describe("a completion", () => {
  it("asks the harness with the schema in the system prompt and the chosen effort, and parses the answer", async () => {
    const rec = recorder("```json\n{\"steps\":[{\"instruction\":\"Jump\"}]}\n```");
    const model = studioFlowModel(options({ complete: rec.complete, model: () => "gpt-6-sol" }));
    const r = await model.complete({ system: "You write scripts.", prompt: "Write one.", schema: SCHEMA });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].system).toContain("You write scripts.");
    expect(rec.calls[0].system).toContain(schemaInstruction(SCHEMA));
    expect(rec.calls[0].prompt).toBe("Write one.");
    expect(rec.calls[0].effort).toBe("medium");
    expect(r.parsed).toEqual({ steps: [{ instruction: "Jump" }] });
    expect(r.model).toBe("gpt-6-sol");
  });

  it("sends a conversation as one prompt, its system messages in the system prompt", async () => {
    const req = {
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "a" },
        { role: "tool", content: "b" },
        { role: "assistant", content: "c" },
      ],
    };
    expect(systemOf(req)).toBe("Be terse.");
    expect(promptOf(req)).toBe("User: a\n\nUser: b\n\nAssistant: c");
    expect(promptOf({ prompt: "only" })).toBe("only");
  });

  it("says why when the harness cannot answer", async () => {
    const model = studioFlowModel(options({ complete: recorder(new Error("Nothing on this computer runs claude-opus-5-5.")).complete }));
    await expect(model.complete({ prompt: "x" })).rejects.toThrow(/Nothing on this computer runs/);
  });
});

describe("parseJsonAnswer", () => {
  it("reads a bare answer, a fenced one, or the object inside prose, and nothing from prose alone", () => {
    expect(parseJsonAnswer("{\"a\":1}")).toEqual({ a: 1 });
    expect(parseJsonAnswer("```\n[1,2]\n```")).toEqual([1, 2]);
    expect(parseJsonAnswer("Sure. {\"a\":{\"b\":2}} Done.")).toEqual({ a: { b: 2 } });
    expect(parseJsonAnswer("no json here")).toBeUndefined();
  });
});
