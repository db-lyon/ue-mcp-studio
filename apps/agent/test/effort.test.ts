import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { geminiEffort, openaiEffort } from "../src/effort.js";
import { toChatRequest } from "../src/openai-compat.js";
import { AnthropicProvider, requestBody, type ModelRequest } from "../src/providers.js";
import { toResponsesRequest } from "../src/responses.js";
import { SettingsStore } from "../src/settings.js";

const req = (model: string, effort?: ModelRequest["effort"]): ModelRequest => ({
  sessionId: "s",
  model,
  effort,
  system: [{ type: "text", text: "sys" }],
  tools: [],
  messages: [{ role: "user", content: "hi" }],
});

describe("the effort setting", () => {
  const store = () => ((d) => new SettingsStore(d, path.join(d, "keys")))(fs.mkdtempSync(path.join(os.tmpdir(), "studio-effort-")));

  it("starts at high and keeps a chosen level", () => {
    const s = store();
    expect(s.effort()).toBe("high");
    s.update({ effort: "max" });
    expect(s.view().effort).toBe("max");
  });

  it("refuses an unknown level", () => {
    expect(() => store().update({ effort: "huge" as never })).toThrow(/effort must be one of/);
  });
});

describe("each vendor gets its nearest level", () => {
  it("sends Claude every level as it is, high when none is chosen", () => {
    expect(requestBody(req("claude-opus-5-5", "low")).output_config).toEqual({ effort: "low" });
    expect(requestBody(req("claude-opus-5-5", "max")).output_config).toEqual({ effort: "max" });
    expect(requestBody(req("claude-opus-5-5")).output_config).toEqual({ effort: "high" });
  });

  it("sends OpenAI's reasoning models up to xhigh, and models that do not reason nothing", () => {
    expect(openaiEffort("gpt-6-sol", "max")).toBe("xhigh");
    expect(openaiEffort("o4-mini", "low")).toBe("low");
    expect(openaiEffort("gpt-4.1", "high")).toBeNull();
    expect(toResponsesRequest(req("gpt-6-sol", "medium"))).toMatchObject({ reasoning: { effort: "medium" } });
    expect(toResponsesRequest(req("gpt-4.1", "medium"))).not.toHaveProperty("reasoning");
    expect(toChatRequest(req("gpt-6-luna", "xhigh"))).toMatchObject({ reasoning_effort: "xhigh" });
  });

  it("sends Gemini's thinking models up to high", () => {
    expect(geminiEffort("gemini-3.1-pro-preview", "max")).toBe("high");
    expect(geminiEffort("gemini-2.0-flash", "low")).toBeNull();
    expect(toChatRequest(req("gemini-3.8-flash", "low"))).toMatchObject({ reasoning_effort: "low" });
  });
});

describe("a Claude model without the chosen level", () => {
  it("runs the turn again at high", async () => {
    const sent: unknown[] = [];
    const message = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
    const client = {
      beta: {
        messages: {
          stream: vi.fn((body: { output_config: { effort: string } }) => {
            sent.push(body.output_config.effort);
            const refuse = body.output_config.effort !== "high";
            return {
              on: () => {},
              finalMessage: () => (refuse ? Promise.reject(Object.assign(new Error("400 effort 'max' is not supported by this model"), { status: 400 })) : Promise.resolve(message)),
            };
          }),
        },
      },
    };
    const turn = await new AnthropicProvider("k", client as never).run(req("claude-haiku-5-5", "max"), () => {}, new AbortController().signal);
    expect(sent).toEqual(["max", "high"]);
    expect(turn.stopReason).toBe("end_turn");
  });
});
