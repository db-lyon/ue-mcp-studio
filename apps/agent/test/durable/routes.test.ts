/**
 * The per-route durable setting: the routes in DURABLE_DEFAULT_ON are on
 * unless the project turns them off, every other route is off unless it
 * turns them on, and a route set back to its default leaves the file, so a
 * later release's default applies to it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DURABLE_DEFAULT_ON, DURABLE_ROUTES, DurableSetting, durableRouteOf, registerDurableRoutes } from "../../src/durable/routes.js";

let dir: string;
const file = () => path.join(dir, "durable-routes.json");
const stored = () => JSON.parse(fs.readFileSync(file(), "utf-8")) as Record<string, unknown>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-durable-routes-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("DurableSetting defaults", () => {
  it("has the Claude sign-in on by default", () => {
    expect(DURABLE_DEFAULT_ON).toContain("claude");
    expect(new DurableSetting(dir).on("claude")).toBe(true);
  });

  it("names only routes the setting knows", () => {
    for (const r of DURABLE_DEFAULT_ON) expect(DURABLE_ROUTES).toContain(r);
  });

  it("with no file, has exactly the default routes on", () => {
    const s = new DurableSetting(dir);
    expect(Object.keys(s.read()).sort()).toEqual([...DURABLE_DEFAULT_ON].sort());
    for (const r of DURABLE_ROUTES) expect(s.on(r)).toBe(DURABLE_DEFAULT_ON.includes(r));
    expect(s.defaultsOn().sort()).toEqual([...DURABLE_DEFAULT_ON].sort());
  });

  it("answers off for a model no route reaches", () => {
    expect(new DurableSetting(dir).on(null)).toBe(false);
  });

  it("treats an unreadable file as saying nothing, so the defaults hold", () => {
    fs.writeFileSync(file(), "{ not json");
    const s = new DurableSetting(dir, ["claude"]);
    expect(s.read()).toEqual({ claude: true });
  });

  it("ignores values that are not true or false", () => {
    fs.writeFileSync(file(), JSON.stringify({ claude: "no", studio: 1, "key:openai": true, bogus: true }));
    const s = new DurableSetting(dir, ["claude"]);
    expect(s.read()).toEqual({ claude: true, "key:openai": true });
  });
});

describe("DurableSetting with explicit defaults", () => {
  it("turns a default route off and keeps the old path selected", () => {
    const s = new DurableSetting(dir, ["claude"]);
    s.set("claude", false);
    expect(s.on("claude")).toBe(false);
    expect(stored()).toEqual({ claude: false });
    // A new instance reads the same file: the choice survives a daemon restart.
    expect(new DurableSetting(dir, ["claude"]).on("claude")).toBe(false);
  });

  it("forgets a route set back to its default", () => {
    const s = new DurableSetting(dir, ["claude"]);
    s.set("claude", false);
    s.set("claude", true);
    expect(s.on("claude")).toBe(true);
    expect(stored()).toEqual({});
  });

  it("turns a route that is off by default on, and forgets it when turned off again", () => {
    const s = new DurableSetting(dir, ["claude"]);
    s.set("studio", true);
    expect(s.on("studio")).toBe(true);
    expect(stored()).toEqual({ studio: true });
    s.set("studio", false);
    expect(s.on("studio")).toBe(false);
    expect(stored()).toEqual({});
  });

  it("reads a file written before any route was on by default", () => {
    // The file then held only routes switched on; every other route was off.
    fs.writeFileSync(file(), JSON.stringify({ "key:anthropic": true }));
    const s = new DurableSetting(dir, ["claude"]);
    expect(s.read()).toEqual({ "key:anthropic": true, claude: true });
  });

  it("lets a later default apply to a route the project never chose", () => {
    new DurableSetting(dir, []).set("claude", true);
    new DurableSetting(dir, []).set("claude", false);
    // Off was the default then, so the file forgot it, and a release that turns it on by default applies.
    expect(new DurableSetting(dir, ["claude"]).on("claude")).toBe(true);
  });

  it("keeps a project's explicit off when a later release turns the route on by default", () => {
    new DurableSetting(dir, ["claude"]).set("claude", false);
    expect(new DurableSetting(dir, ["claude", "studio"]).on("claude")).toBe(false);
    expect(new DurableSetting(dir, ["claude", "studio"]).on("studio")).toBe(true);
  });
});

describe("durableRouteOf", () => {
  it("names each route's setting key", () => {
    expect(durableRouteOf("claude", "anthropic")).toBe("claude");
    expect(durableRouteOf("studio", "anthropic")).toBe("studio");
    expect(durableRouteOf("chatgpt", "openai")).toBe("chatgpt");
    expect(durableRouteOf("key", "anthropic")).toBe("key:anthropic");
    expect(durableRouteOf("key", "openai")).toBe("key:openai");
    expect(durableRouteOf("key", "google")).toBe("key:google");
  });
});

describe("GET and PUT /runtime", () => {
  type Handler = (req: { body?: unknown }) => { status?: number; body: Record<string, unknown> };
  const mount = (setting: DurableSetting) => {
    const routes = new Map<string, Handler>();
    const api = { route: (method: string, p: string, h: Handler) => void routes.set(`${method} ${p}`, h) };
    registerDurableRoutes(api as never, { setting, harness: () => ({ available: true, connected: false, version: null, pid: null }) });
    return (method: string, body?: unknown) => routes.get(`${method} /runtime`)!({ body });
  };

  it("answers the setting and the defaults", () => {
    const call = mount(new DurableSetting(dir, ["claude"]));
    const r = call("GET");
    expect(r.body.durable).toEqual({ claude: true });
    expect(r.body.defaults).toEqual(["claude"]);
    expect(r.body.routes).toEqual(DURABLE_ROUTES);
  });

  it("turns the default route off through PUT", () => {
    const call = mount(new DurableSetting(dir, ["claude"]));
    expect(call("PUT", { route: "claude", durable: false }).body.durable).toEqual({});
    expect(call("GET").body.durable).toEqual({});
  });

  it("refuses an unknown route or a value that is not true or false", () => {
    const call = mount(new DurableSetting(dir, ["claude"]));
    expect(call("PUT", { route: "nope", durable: true }).status).toBe(400);
    expect(call("PUT", { route: "claude", durable: "off" }).status).toBe(400);
  });
});
