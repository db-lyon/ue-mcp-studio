/**
 * How a conversation on each route reaches its model. Every route runs on
 * the durable runtime: the gateway, each key, the two sign-ins and custom
 * endpoints.
 *
 * GET /runtime answers the harness's state, and every route as on, in the
 * shape it had while each route had a setting. PUT /runtime is gone: there is
 * nothing left to switch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { GATEWAY_CLIENT_HEADER, GATEWAY_CLIENT_PREFIX, GATEWAY_SESSION_HEADER, endpointIdOf, type ModelRoute, type VendorId } from "@ue-mcp-studio/shared";
import type { RouteSpec } from "./protocol.js";

/** Every route a conversation runs on: the gateway, each key, the two sign-ins and custom endpoints. */
export const DURABLE_ROUTES = ["studio", "key:anthropic", "key:openai", "key:google", "chatgpt", "endpoint", "claude"] as const;
export type DurableRoute = (typeof DURABLE_ROUTES)[number];

/** The durable route a model runs on; null for a vendor no route reaches. */
export function durableRouteOf(route: ModelRoute, vendor: VendorId): DurableRoute | null {
  if (route === "key") return (["anthropic", "openai", "google"] as const).includes(vendor as never) ? (`key:${vendor}` as DurableRoute) : null;
  if (route === "studio" || route === "chatgpt" || route === "endpoint" || route === "claude") return route;
  return null;
}

/** The file the per-route setting was kept in before every route ran on the durable runtime. */
const OLD_SETTING_FILE = "durable-routes.json";

/** Forget the per-route setting a project kept before the cutover: nothing reads it any more. */
export function forgetRouteSetting(dataDir: string): void {
  try {
    fs.rmSync(path.join(dataDir, OLD_SETTING_FILE), { force: true });
  } catch {
    // A file left behind is never read.
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

export function registerDurableRoutes(api: DaemonExtensionApi, o: { harness: () => { available: boolean; connected: boolean; version: string | null; pid: number | null }; inspect?: () => Promise<unknown> }): void {
  const all = Object.fromEntries(DURABLE_ROUTES.map((r) => [r, true])) as Record<DurableRoute, true>;
  api.route("GET", "/runtime", () => ({ body: { durable: all, routes: DURABLE_ROUTES, defaults: [...DURABLE_ROUTES], harness: o.harness() } }));
  // What the background runtime is doing: live tasks (running, waiting, asleep or blocked), queued messages, recent reports.
  api.route("GET", "/runtime/inspect", async () => {
    if (!o.inspect) return { status: 404, body: { error: "This Studio cannot inspect its runtime." } };
    try {
      return { body: await o.inspect() };
    } catch (e) {
      return { status: 503, body: { error: e instanceof Error ? e.message : String(e) } };
    }
  });
}
