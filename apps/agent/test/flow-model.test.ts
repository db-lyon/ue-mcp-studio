/**
 * Studio's model behind flow agent steps: registered with the daemon's
 * models hook, run on the route the user picked, with no tools and the JSON
 * Schema in the system prompt, and the JSON parsed out of the answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider, ModelRequest, ModelTurn } from "../src/providers.js";

const sdk = vi.hoisted(() => ({
  calls: [] as Array<{ prompt: unknown; options: Record<string, unknown> }>,
  answer: "" as string,
}));
vi.mock("../src/runtime.js", () => ({ ensureRuntime: async () => "claude.exe", installedRuntime: () => "claude.exe" }));
vi.mock("../src/claude-auth.js", async (actual) => {
  const login = { method: "claude.ai", subscription: "max", keySource: null };
  return { ...(await actual<typeof import("../src/claude-auth.js")>()), claudeLogin: () => login, refreshClaudeLogin: async () => login };
});
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: () => ({}),
  createSdkMcpServer: () => ({}),
  query: ({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    sdk.calls.push({ prompt, options });
    return (async function* () {
      yield { type: "assistant", message: { id: "m1", content: [{ type: "text", text: sdk.answer }] }, parent_tool_use_id: null };
      yield { type: "result", subtype: "success", is_error: false, result: sdk.answer, session_id: "x" };
    })();
  },
}));

import { parseJsonAnswer, registerFlowModel, schemaInstruction, studioFlowModel, type FlowModelOptions } from "../src/flow-model.js";

const SCHEMA = { type: "object", required: ["steps"], properties: { steps: { type: "array" } } };

class Recorder implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(private readonly answer: string) {}
  async run(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(req);
    return { content: [{ type: "text", text: this.answer, citations: null } as never], stopReason: "end_turn" };
  }
}

const options = (over: Partial<FlowModelOptions> = {}): FlowModelOptions => ({
  projectDir: "C:/P",
  model: () => "claude-opus-5-5",
  effort: () => "medium",
  subscription: () => false,
  provider: () => new Recorder("{}"),
  ...over,
});

beforeEach(() => {
  sdk.calls = [];
  sdk.answer = "";
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

  it("leaves a daemon without the hook alone", () => {
    expect(() => registerFlowModel({}, options())()).not.toThrow();
  });
});

describe("a completion on an API route", () => {
  it("runs the model the user picked, with no tools or search and the schema in the system prompt", async () => {
    const rec = new Recorder("```json\n{\"steps\":[{\"instruction\":\"Jump\"}]}\n```");
    const model = studioFlowModel(options({ provider: () => rec, model: () => "gpt-6-sol" }));
    const r = await model.complete({ system: "You write scripts.", prompt: "Write one.", schema: SCHEMA, model: "claude-opus-5-5" } as never);
    const sent = rec.requests[0];
    expect(sent.model).toBe("gpt-6-sol");
    expect(sent.tools).toEqual([]);
    expect(sent.search).toBe(false);
    expect(sent.system[0].text).toContain("You write scripts.");
    expect(sent.system[0].text).toContain(JSON.stringify(SCHEMA));
    expect(sent.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Write one." }] }]);
    expect(r.parsed).toEqual({ steps: [{ instruction: "Jump" }] });
    expect(r.model).toBe("gpt-6-sol");
  });

  it("sends a conversation with alternating roles, and its system messages in the system prompt", async () => {
    const rec = new Recorder("ok");
    await studioFlowModel(options({ provider: () => rec })).complete({
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "a" },
        { role: "tool", content: "b" },
        { role: "assistant", content: "c" },
      ],
    });
    const sent = rec.requests[0];
    expect(sent.system[0].text).toBe("Be terse.");
    expect(sent.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect((sent.messages[0].content as Array<{ text: string }>).map((b) => b.text)).toEqual(["a", "b"]);
  });

  it("says when no route can run the model", async () => {
    const model = studioFlowModel(options({ provider: () => { throw new Error("Sign in to run claude-opus-5-5: open the model picker."); } }));
    await expect(model.complete({ prompt: "x" })).rejects.toThrow(/Sign in to run/);
  });
});

describe("a completion on the Claude sign-in", () => {
  it("goes through the Agent SDK with no tools, one turn and no session, and returns the parsed JSON", async () => {
    sdk.answer = "Here it is: {\"steps\":[{\"instruction\":\"Open the door\"}]}";
    const model = studioFlowModel(options({ subscription: () => true, model: () => "claude-sonnet-5-5" }));
    const r = await model.complete({ system: "You write scripts.", prompt: "Write one.", schema: SCHEMA });
    expect(sdk.calls).toHaveLength(1);
    const o = sdk.calls[0].options;
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual([]);
    expect(o.mcpServers).toBeUndefined();
    expect(o.maxTurns).toBe(1);
    expect(o.persistSession).toBe(false);
    expect(o.model).toBe("claude-sonnet-5-5");
    expect(o.systemPrompt).toContain(schemaInstruction(SCHEMA));
    expect(sdk.calls[0].prompt).toBe("Write one.");
    expect(r.parsed).toEqual({ steps: [{ instruction: "Open the door" }] });
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
