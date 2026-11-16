/**
 * Which routes run on the durable runtime, and how a conversation on each
 * reaches its model. One setting per route: the routes in DURABLE_DEFAULT_ON
 * are on unless the project turns them off, every other route is off unless
 * it turns them on. A route turned off runs on Studio's loop or its turn
 * hosts as before. The setting is the project's, kept beside its sessions,
 * and read at each reply, so a change applies from the next one.
 *
 * GET /runtime answers the setting, the defaults and the harness's state;
 * PUT /runtime { route, durable } changes one route.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { GATEWAY_CLIENT_HEADER, GATEWAY_CLIENT_PREFIX, GATEWAY_SESSION_HEADER, endpointIdOf, type ModelRoute, type VendorId } from "@ue-mcp-studio/shared";
import { writeFileAtomic } from "../atomic-write.js";
import type { RouteSpec } from "./protocol.js";

/** The routes the setting names: the gateway, each key, the two sign-ins and custom endpoints. */
export const DURABLE_ROUTES = ["studio", "key:anthropic", "key:openai", "key:google", "chatgpt", "endpoint", "claude"] as const;
export type DurableRoute = (typeof DURABLE_ROUTES)[number];

/** The setting's key for the route a model runs on. */
export function durableRouteOf(route: ModelRoute, vendor: VendorId): DurableRoute | null {
  if (route === "key") return (["anthropic", "openai", "google"] as const).includes(vendor as never) ? (`key:${vendor}` as DurableRoute) : null;
  if (route === "studio" || route === "chatgpt" || route === "endpoint" || route === "claude") return route;
  return null;
}

/**
 * Routes on the durable runtime unless the project's setting turns them off.
 * Each route is switched on by default on its own, as its kill tests and
 * live check pass; a route that fails them comes out of this list alone.
 */
// The OpenAI key, Google key, ChatGPT sign-in, custom endpoints and the UE-MCP gateway stay off by default
// until each has passed the kill tests and a live turn on its own credential.
export const DURABLE_DEFAULT_ON: readonly DurableRoute[] = ["claude", "key:anthropic"];

export class DurableSetting {
  constructor(private readonly dir: string, private readonly defaults: readonly DurableRoute[] = DURABLE_DEFAULT_ON) {}

  private get file(): string {
    return path.join(this.dir, "durable-routes.json");
  }

  /** What the project's file says, route by route: true or false where it says, nothing where the default holds. */
  private stored(): Partial<Record<DurableRoute, boolean>> {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Record<string, unknown>;
      return Object.fromEntries(DURABLE_ROUTES.filter((r) => typeof v[r] === "boolean").map((r) => [r, v[r] as boolean]));
    } catch {
      return {};
    }
  }

  /** Routes switched on, by the project's file or by default; every other route is off. */
  read(): Partial<Record<DurableRoute, boolean>> {
    const v = this.stored();
    return Object.fromEntries(DURABLE_ROUTES.filter((r) => v[r] ?? this.defaults.includes(r)).map((r) => [r, true]));
  }

  /** The routes on when the project's file says nothing about them. */
  defaultsOn(): DurableRoute[] {
    return DURABLE_ROUTES.filter((r) => this.defaults.includes(r));
  }

  on(route: DurableRoute | null): boolean {
    return !!route && this.read()[route] === true;
  }

  /** Switch a route on or off for the project. Back to its default, the file forgets it, so a later default applies. */
  set(route: DurableRoute, on: boolean): void {
    const v = this.stored();
    if (on === this.defaults.includes(route)) delete v[route];
    else v[route] = on;
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(v, null, 2));
  }
}

/**
 * Where each route is reached, and how its credential is sent. `search`: the
 * provider runs web search on its own side. The gateway and custom endpoints
 * have none, and get Studio's own web_search tool instead.
 */
export function routeSpec(o: {
  route: DurableRoute;
  model: string;
  vendor: VendorId;
  gatewayUrl: string;
  agentVersion: string;
  endpoint: (id: string) => { baseUrl: string; key: string | null } | null;
}): RouteSpec {
  switch (o.route) {
    case "studio":
      return {
        route: o.route, provider: "studio", api: "anthropic-messages", model: o.model, baseUrl: o.gatewayUrl.replace(/\/+$/, ""), auth: "bearer", maxTokens: 64_000,
        headers: { [GATEWAY_CLIENT_HEADER]: `${GATEWAY_CLIENT_PREFIX}${o.agentVersion}` }, sessionHeader: GATEWAY_SESSION_HEADER,
      };
    case "key:anthropic":
      return { route: o.route, provider: "anthropic", api: "anthropic-messages", model: o.model, baseUrl: "https://api.anthropic.com", auth: "apiKey", search: true };
    case "key:openai":
      return { route: o.route, provider: "openai", api: "openai-responses", model: o.model, baseUrl: "https://api.openai.com/v1", auth: "apiKey", search: true };
    case "key:google":
      return { route: o.route, provider: "google", api: "google-generative-ai", model: o.model, baseUrl: "https://generativelanguage.googleapis.com/v1beta", auth: "apiKey", search: true };
    case "chatgpt":
      return { route: o.route, provider: "chatgpt", api: "openai-responses", model: o.model, baseUrl: "https://api.openai.com/v1", auth: "bearer", search: true };
    case "endpoint": {
      const id = endpointIdOf(o.vendor);
      const e = id !== null ? o.endpoint(id) : null;
      if (!e) throw new Error(`The endpoint for ${o.model} was removed: pick another model.`);
      // Its credential is asked for by the endpoint's own id: a helper can run on another endpoint than the main agent's.
      return { route: `endpoint:${id}`, provider: `endpoint-${id}`, api: "openai-completions", model: o.model, baseUrl: e.baseUrl, auth: e.key ? "apiKey" : "none" };
    }
    case "claude":
      // Claude Code as a model sends the Messages API's own web search with the request, on the user's subscription.
      return { route: o.route, provider: "claude-code", api: "claude-code", model: o.model, auth: "none", search: true };
  }
}

export function registerDurableRoutes(api: DaemonExtensionApi, o: { setting: DurableSetting; harness: () => { available: boolean; connected: boolean; version: string | null; pid: number | null } }): void {
  api.route("GET", "/runtime", () => ({ body: { durable: o.setting.read(), routes: DURABLE_ROUTES, defaults: o.setting.defaultsOn(), harness: o.harness() } }));
  api.route("PUT", "/runtime", (req) => {
    const b = (req.body ?? {}) as { route?: unknown; durable?: unknown };
    if (!DURABLE_ROUTES.includes(b.route as DurableRoute)) return { status: 400, body: { error: `route is one of ${DURABLE_ROUTES.join(", ")}` } };
    if (typeof b.durable !== "boolean") return { status: 400, body: { error: "durable is true or false" } };
    o.setting.set(b.route as DurableRoute, b.durable);
    return { body: { durable: o.setting.read() } };
  });
}
