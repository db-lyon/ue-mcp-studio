/** Custom OpenAI-compatible endpoints: the store, its routes, the route they run on, the catalog and their prices. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { conventionOf, endpointVendor, type CustomEndpoint, type SignInId } from "@ue-mcp-studio/shared";
import { EndpointStore, baseUrlOf, endpointPrices, idFor, listEndpointModels, mergeListed, registerEndpointRoutes } from "../src/endpoints.js";
import { ModelCatalogSource, endpointCatalog, pickRoute, type RouteContext } from "../src/models.js";
import { OpenAICompatibleProvider } from "../src/openai-compat.js";
import { providerFor } from "../src/providers.js";
import { SettingsStore } from "../src/settings.js";
import { PriceStore, costOf, priceFor } from "../src/prices.js";
import { splitModelKey } from "../src/usage-routes.js";

let dir: string;
let keysDir: string;
let store: EndpointStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-endpoints-"));
  keysDir = path.join(dir, "studio", "keys");
  store = new EndpointStore(keysDir);
});

const listing = (ids: string[], status = 200) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }), { status }));

describe("the endpoint store", () => {
  it("keeps the list beside the keys folder and each key inside it, never in the list", () => {
    const e = store.create({ name: "Local Ollama", baseUrl: "http://localhost:11434/v1/", key: " sk-local " });
    expect(e).toMatchObject({ id: "local-ollama", name: "Local Ollama", baseUrl: "http://localhost:11434/v1", hasKey: true, models: [] });
    expect(fs.existsSync(path.join(dir, "studio", "endpoints.json"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "studio", "endpoints.json"), "utf-8")).not.toContain("sk-local");
    expect(fs.readFileSync(path.join(keysDir, "endpoint-local-ollama.key"), "utf-8")).toBe("sk-local");
    expect(store.key("local-ollama")).toBe("sk-local");
    expect(JSON.stringify(store.list())).not.toContain("sk-local");
  });

  it("refuses a missing name, a duplicate name and an address that is not http", () => {
    store.create({ name: "Box", baseUrl: "http://box:8000/v1" });
    expect(() => store.create({ name: "", baseUrl: "http://x" })).toThrow(/name/);
    expect(() => store.create({ name: "box", baseUrl: "http://y" })).toThrow(/already named/);
    expect(() => store.create({ name: "Other", baseUrl: "ftp://y" })).toThrow(/http/);
    expect(() => baseUrlOf("not a url")).toThrow(/http/);
  });

  it("makes ids from names that never hold a colon, unique among those taken", () => {
    expect(idFor("My: Server!", () => false)).toBe("my-server");
    expect(idFor("Box", (id) => id === "box")).toBe("box-2");
    expect(idFor("???", () => false)).toBe("endpoint");
  });

  it("changes the name, typed models, prices and key, and clears the key with an empty one", () => {
    store.create({ name: "Box", baseUrl: "http://box/v1", key: "k" });
    const e = store.update("box", { name: "Big box", models: [{ id: "qwen-coder", perMTok: { input: 0.5, cacheRead: null, cacheWrite: null, output: 1 } }], key: "" });
    expect(e.name).toBe("Big box");
    expect(e.hasKey).toBe(false);
    expect(e.models).toEqual([{ id: "qwen-coder", typed: true, perMTok: { input: 0.5, cacheRead: null, cacheWrite: null, output: 1 } }]);
    expect(() => store.update("box", { models: [{ id: "m", perMTok: { input: -1, cacheRead: null, cacheWrite: null, output: null } }] })).toThrow(/zero or more/);
    expect(() => store.update("nope", { name: "x" })).toThrow(/no endpoint/);
  });

  it("removes an endpoint and its key", () => {
    store.create({ name: "Box", baseUrl: "http://box/v1", key: "k" });
    expect(store.remove("box")).toBe(true);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(path.join(keysDir, "endpoint-box.key"))).toBe(false);
    expect(store.remove("box")).toBe(false);
  });
});

describe("reading an endpoint's models", () => {
  it("asks its /models with the key, keeping chat models only", async () => {
    const f = listing(["text-embedding-3", "llama-3.3-70b", "qwen-coder"]);
    expect(await listEndpointModels("http://box/v1", "k", f as unknown as typeof fetch)).toEqual(["llama-3.3-70b", "qwen-coder"]);
    expect(f.mock.calls[0][0]).toBe("http://box/v1/models");
    expect((f.mock.calls[0][1]!.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("sends no authorization to an endpoint without a key", async () => {
    const f = listing(["m"]);
    await listEndpointModels("http://box/v1", null, f as unknown as typeof fetch);
    expect(f.mock.calls[0][1]!.headers).toEqual({});
  });

  it("keeps typed models and every price when the list is read again", () => {
    const merged = mergeListed(
      [{ id: "a", perMTok: { input: 1, cacheRead: null, cacheWrite: null, output: 2 } }, { id: "gone" }, { id: "mine", typed: true }],
      ["a", "b"],
    );
    expect(merged).toEqual([{ id: "a", perMTok: { input: 1, cacheRead: null, cacheWrite: null, output: 2 } }, { id: "b" }, { id: "mine", typed: true }]);
  });

  it("keeps the error to show when the endpoint cannot list, and the models it had", async () => {
    store.create({ name: "Box", baseUrl: "http://box/v1", models: [{ id: "typed-one" }] });
    const e = await store.refresh("box", listing([], 401) as unknown as typeof fetch);
    expect(e.listError).toMatch(/401/);
    expect(e.listedAt).not.toBeNull();
    expect(e.models.map((m) => m.id)).toEqual(["typed-one"]);
    const ok = await store.refresh("box", listing(["served"]) as unknown as typeof fetch);
    expect(ok.listError).toBeNull();
    expect(ok.models.map((m) => m.id)).toEqual(["served", "typed-one"]);
  });
});

type Handler = (req: { params: Record<string, string>; body?: unknown; query?: Record<string, string> }) => Promise<{ status?: number; body?: unknown }> | { status?: number; body?: unknown };

describe("the endpoint routes", () => {
  let routes: Map<string, Handler>;
  let changed: number;
  let removed: string[];
  beforeEach(() => {
    routes = new Map();
    changed = 0;
    removed = [];
    const api = { route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h) } as unknown as DaemonExtensionApi;
    registerEndpointRoutes(api, { store, changed: () => void changed++, removed: (id) => void removed.push(id), fetch: listing(["llama", "qwen"]) as unknown as typeof fetch });
  });
  const call = (key: string, params: Record<string, string> = {}, body?: unknown) => Promise.resolve(routes.get(key)!({ params, body }));

  it("adds an endpoint, reads its models, and lists it without its key", async () => {
    const r = await call("POST /endpoints", {}, { name: "Box", baseUrl: "http://box/v1", key: "secret" });
    expect(r.status).toBe(201);
    expect((r.body as CustomEndpoint).models.map((m) => m.id)).toEqual(["llama", "qwen"]);
    const list = (await call("GET /endpoints")).body as { endpoints: CustomEndpoint[] };
    expect(list.endpoints).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("secret");
    expect(changed).toBe(1);
  });

  it("answers 400 for a bad endpoint and 404 for an unknown one", async () => {
    expect((await call("POST /endpoints", {}, { name: "Box", baseUrl: "box" })).status).toBe(400);
    expect((await call("PUT /endpoints/:id", { id: "nope" }, { name: "x" })).status).toBe(404);
    expect((await call("DELETE /endpoints/:id", { id: "nope" })).status).toBe(404);
    expect((await call("POST /endpoints/:id/models", { id: "nope" })).status).toBe(404);
  });

  it("changes, reads again and removes one, saying which was removed", async () => {
    await call("POST /endpoints", {}, { name: "Box", baseUrl: "http://box/v1" });
    const put = await call("PUT /endpoints/:id", { id: "box" }, { models: [{ id: "llama", perMTok: { input: 1, cacheRead: null, cacheWrite: null, output: 3 } }, { id: "extra" }] });
    expect((put.body as CustomEndpoint).models).toEqual([{ id: "llama", perMTok: { input: 1, cacheRead: null, cacheWrite: null, output: 3 } }, { id: "extra", typed: true }]);
    expect((await call("POST /endpoints/:id/models", { id: "box" })).status ?? 200).toBe(200);
    const del = await call("DELETE /endpoints/:id", { id: "box" });
    expect(del.status).toBe(204);
    expect(removed).toEqual(["box"]);
  });
});

describe("routing a model", () => {
  const ctx = (o: Partial<RouteContext> = {}): RouteContext => ({
    signedIn: { claude: true, chatgpt: false, studio: false } as Record<SignInId, boolean>,
    coverage: { planModels: [] },
    hasKey: () => true,
    hasEndpoint: (id) => id === "box",
    order: "signins-first",
    ...o,
  });

  it("runs an endpoint's model on that endpoint, and on nothing once it is gone", () => {
    expect(pickRoute("endpoint:box", "llama", ctx())).toBe("endpoint");
    expect(pickRoute("endpoint:gone", "llama", ctx())).toBeNull();
  });

  it("uses a sign-in before a key by default, and the key first when the order says so", () => {
    expect(pickRoute("anthropic", "claude-opus-5-5", ctx())).toBe("claude");
    expect(pickRoute("anthropic", "claude-opus-5-5", ctx({ order: "keys-first" }))).toBe("key");
    expect(pickRoute("anthropic", "claude-opus-5-5", ctx({ order: "keys-first", hasKey: () => false }))).toBe("claude");
    expect(pickRoute("google", "gemini-3.8-flash", ctx({ hasKey: () => false }))).toBeNull();
  });

  it("gives an endpoint's model the vendor-neutral files: AGENTS.md and .agents/skills", () => {
    expect(conventionOf(endpointVendor("box"))).toBe("agents");
  });
});

describe("the model catalog", () => {
  it("lists each endpoint after the named vendors, with no sign-ins, and the route order", async () => {
    const e = store.create({ name: "Box", baseUrl: "http://box/v1", models: [{ id: "llama" }] });
    const c = await new ModelCatalogSource(() => null).catalog({ claude: false, chatgpt: false, studio: false }, { planModels: [] }, { endpoints: [e], routeOrder: "keys-first" });
    expect(c.routeOrder).toBe("keys-first");
    const last = c.providers[c.providers.length - 1];
    expect(last).toEqual({ id: "endpoint:box", name: "Box", connected: true, source: "typed", endpoint: { id: "box" }, models: [{ id: "llama", name: "llama", signIns: [] }] });
    expect(endpointCatalog({ ...e, models: [{ id: "x" }] }).source).toBe("live");
  });
});

describe("running on an endpoint", () => {
  it("sends Chat Completions to the endpoint's address, with its key when it has one", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("data: [DONE]\n", { status: 200 }));
    await new OpenAICompatibleProvider("http://box/v1", "", fetchImpl as unknown as typeof fetch).run({ sessionId: "s", model: "llama", system: [{ type: "text", text: "sys" }], tools: [], messages: [{ role: "user", content: "hi" }] }, () => {}, new AbortController().signal);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://box/v1/chat/completions");
    expect((fetchImpl.mock.calls[0][1]!.headers as Record<string, string>).authorization).toBeUndefined();
    await new OpenAICompatibleProvider("http://box/v1", "k", fetchImpl as unknown as typeof fetch).run({ sessionId: "s", model: "llama", system: [], tools: [], messages: [{ role: "user", content: "hi" }] }, () => {}, new AbortController().signal);
    expect((fetchImpl.mock.calls[1][1]!.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("makes the endpoint's provider, and says so when the endpoint was removed", () => {
    const settings = new SettingsStore(path.join(dir, "project"), keysDir);
    settings.update({ provider: "endpoint:box", model: "llama" });
    expect(settings.provider()).toBe("endpoint:box");
    const p = providerFor(settings, "endpoint", { endpoint: (id) => (id === "box" ? { baseUrl: "http://box/v1", key: null } : null) });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(() => providerFor(settings, "endpoint", { endpoint: () => null })).toThrow(/removed/);
  });
});

describe("settings", () => {
  it("keeps an endpoint vendor and the route order, refusing ones that are not", () => {
    const settings = new SettingsStore(path.join(dir, "project"), keysDir);
    expect(settings.routeOrder()).toBe("signins-first");
    settings.update({ routeOrder: "keys-first" });
    expect(settings.routeOrder()).toBe("keys-first");
    expect(() => settings.update({ routeOrder: "random" as never })).toThrow(/routeOrder/);
    expect(() => settings.update({ provider: "endpoint:Bad:Id" as never })).toThrow(/provider/);
    expect(() => settings.update({ provider: "endpoint:" as never })).toThrow(/provider/);
  });
});

describe("pricing an endpoint's usage", () => {
  it("prices a model from the user's price on the endpoint, and leaves an unpriced one without a cost", () => {
    const e = store.create({ name: "Box", baseUrl: "http://box/v1", models: [{ id: "llama", perMTok: { input: 1, cacheRead: null, cacheWrite: null, output: 4 } }, { id: "free-for-all" }] });
    const prices = new PriceStore(dir, () => endpointPrices([e]));
    const p = priceFor(prices.all(), "endpoint:box", "llama");
    expect(p).toMatchObject({ vendor: "endpoint:box", model: "llama", user: true });
    expect(costOf(p, { input: 1_000_000, cacheRead: null, cacheWrite: null, output: 500_000 })).toBe(3);
    expect(priceFor(prices.all(), "endpoint:box", "free-for-all")).toBeNull();
    // The Usage price table shows only the prices set there.
    expect(prices.table().prices.some((x) => x.vendor === "endpoint:box")).toBe(false);
  });

  it("splits an endpoint model's group key at the colon after the endpoint's id", () => {
    expect(splitModelKey("endpoint:box:llama3:8b")).toEqual({ vendor: "endpoint:box", model: "llama3:8b" });
    expect(splitModelKey("anthropic:claude-opus-5-5")).toEqual({ vendor: "anthropic", model: "claude-opus-5-5" });
  });
});
