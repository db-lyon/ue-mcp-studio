import { describe, expect, it } from "vitest";
import { firstRunnable, type RouteContext } from "../src/models.js";

const ctx = (o: Partial<RouteContext> & { keys?: string[] } = {}): RouteContext => ({
  signedIn: { chatgpt: false, claude: false, studio: false, ...o.signedIn },
  coverage: o.coverage ?? { planModels: [] },
  hasKey: (v) => (o.keys ?? []).includes(v),
  hasEndpoint: o.hasEndpoint ?? (() => false),
  order: "signins-first",
});
const placeholder = { provider: "anthropic" as const, model: "claude-opus-5-5" };

describe("the model a new install runs before the user picks one", () => {
  it("is the vendor the user connected, whichever it is", () => {
    expect(firstRunnable(placeholder, ctx({ keys: ["google"] }))).toEqual({ provider: "google", model: "gemini-3.1-pro-preview" });
    expect(firstRunnable(placeholder, ctx({ signedIn: { chatgpt: true, claude: false, studio: false }, coverage: { planModels: [], chatgptModels: [{ id: "gpt-6-sol", name: "6 Sol" }] } }))).toEqual({ provider: "openai", model: "gpt-6-sol" });
  });

  it("is a custom endpoint's first model when that is all there is", () => {
    expect(firstRunnable(placeholder, ctx({ hasEndpoint: (id) => id === "local" }), [{ id: "local", models: [{ id: "qwen", typed: true }] }])).toEqual({ provider: "endpoint:local", model: "qwen" });
  });

  it("keeps the placeholder when something runs it, and when nothing is connected at all", () => {
    expect(firstRunnable(placeholder, ctx({ signedIn: { chatgpt: false, claude: true, studio: false } }))).toBeNull();
    expect(firstRunnable(placeholder, ctx())).toBeNull();
  });
});
