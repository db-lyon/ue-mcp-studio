/**
 * Every route runs on the durable runtime: GET /runtime answers each as on, in
 * the shape it had while each route had a setting, PUT /runtime is gone, and
 * the per-route setting file a project kept before the cutover is forgotten.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DURABLE_ROUTES, durableRouteOf, forgetRouteSetting, registerDurableRoutes } from "../../src/durable/routes.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-durable-routes-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("durableRouteOf", () => {
  it("names the route of every model Studio runs", () => {
    expect(durableRouteOf("claude", "anthropic")).toBe("claude");
    expect(durableRouteOf("studio", "anthropic")).toBe("studio");
    expect(durableRouteOf("chatgpt", "openai")).toBe("chatgpt");
    expect(durableRouteOf("key", "anthropic")).toBe("key:anthropic");
    expect(durableRouteOf("key", "openai")).toBe("key:openai");
    expect(durableRouteOf("key", "google")).toBe("key:google");
  });
});

describe("forgetRouteSetting", () => {
  it("removes the setting file a project kept before the cutover", () => {
    const file = path.join(dir, "durable-routes.json");
    fs.writeFileSync(file, JSON.stringify({ claude: false }));
    forgetRouteSetting(dir);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("does nothing where there is no file", () => {
    expect(() => forgetRouteSetting(path.join(dir, "missing"))).not.toThrow();
  });
});

describe("GET and PUT /runtime", () => {
  type Handler = (req: { body?: unknown }) => { status?: number; body: Record<string, unknown> };
  const mount = () => {
    const routes = new Map<string, Handler>();
    const api = { route: (method: string, p: string, h: Handler) => void routes.set(`${method} ${p}`, h) };
    registerDurableRoutes(api as never, { harness: () => ({ available: true, connected: true, version: "1.0.0", pid: 7 }) });
    return routes;
  };

  it("answers every route as on, and the harness's state", () => {
    const r = mount().get("GET /runtime")!({});
    expect(r.body.durable).toEqual(Object.fromEntries(DURABLE_ROUTES.map((x) => [x, true])));
    expect(r.body.routes).toEqual(DURABLE_ROUTES);
    expect(r.body.defaults).toEqual([...DURABLE_ROUTES]);
    expect(r.body.harness).toEqual({ available: true, connected: true, version: "1.0.0", pid: 7 });
  });

  it("has no PUT: nothing is left to switch", () => {
    expect(mount().has("PUT /runtime")).toBe(false);
  });
});
