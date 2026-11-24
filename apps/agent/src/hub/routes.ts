/**
 * The Playtest Hub's routes, under /v1/ext/studio, exactly as HUB_ROUTES in
 * packages/shared/src/hub.ts names them. A bad body answers 400, an unknown
 * id 404 and a request that cannot be met now 409, each with { error }.
 * Every change publishes studio.hub.changed (hub.ts).
 */
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { PAIRED_DEVICE_HEADER } from "@ue-mcp-studio/remote";
import { Hub, type HubOptions } from "./hub.js";
import { HubError } from "./util.js";

type Req = { params: Record<string, string>; query?: unknown; body?: unknown; headers?: Record<string, string | string[] | undefined> };
type Res = { status?: number; body?: unknown };

/** The paired browser a request came through remote control from, by the name it paired with; undefined at this computer. */
function pairedDevice(req: Req): string | undefined {
  const v = req.headers?.[PAIRED_DEVICE_HEADER];
  if (typeof v !== "string" || !v) return undefined;
  try {
    return decodeURIComponent(v).slice(0, 120);
  } catch {
    return undefined;
  }
}

/** A route's answer from its work: thrown HubErrors become their status, anything else a 500. */
async function answer(api: DaemonExtensionApi, work: () => unknown): Promise<Res> {
  try {
    const out = await work();
    return out === undefined ? { status: 204 } : (out as Res);
  } catch (e) {
    if (e instanceof HubError) return { status: e.status, body: { error: e.message } };
    api.log.warn("hub: a route failed", e);
    return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
  }
}

export function registerHub(api: DaemonExtensionApi, o: Omit<HubOptions, "host">): Hub {
  const hub = new Hub({ ...o, host: api as unknown as HubOptions["host"] });
  const route = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, work: (req: Req) => unknown) =>
    api.route(method, path, (req) => answer(api, () => work(req as unknown as Req)));
  const q = (req: Req) => (req.query ?? {}) as Record<string, unknown>;

  route("GET", "/hub", async () => ({ body: await hub.overview() }));

  route("GET", "/hub/goals/:id", async (req) => ({ body: await hub.goal(req.params.id) }));
  route("POST", "/hub/goals", (req) => ({ body: { goal: hub.goals.create(req.body) } }));
  route("PUT", "/hub/goals/:id", (req) => ({ body: { goal: hub.goals.update(req.params.id, req.body) } }));
  route("DELETE", "/hub/goals/:id", (req) => hub.goals.delete(req.params.id));
  route("POST", "/hub/goals/:id/checks", (req) => ({ body: { goal: hub.goals.addChecks(req.params.id, (req.body as { checks?: unknown } | undefined)?.checks) } }));
  // Before /checks/:checkId: a check id always has a colon, so "order" is never one.
  route("PUT", "/hub/goals/:id/checks/order", (req) => ({ body: { goal: hub.goals.orderChecks(req.params.id, req.body) } }));
  route("DELETE", "/hub/goals/:id/checks/:checkId", async (req) => ({ body: { goal: hub.goals.removeCheck(req.params.id, await hub.goalCheckId(req.params.id, req.params.checkId)) } }));
  route("PUT", "/hub/goals/:id/checks/:checkId", async (req) => ({ body: { goal: hub.goals.updateGoalCheck(req.params.id, await hub.goalCheckId(req.params.id, req.params.checkId), req.body) } }));
  route("POST", "/hub/goals/:id/requires", (req) => ({ body: { goal: hub.goals.addRequire(req.params.id, req.body) } }));
  route("PUT", "/hub/goals/:id/requires", (req) => ({ body: { goal: hub.goals.orderRequires(req.params.id, req.body) } }));
  route("DELETE", "/hub/goals/:id/requires/:goalId", (req) => ({ body: { goal: hub.goals.removeRequire(req.params.id, req.params.goalId) } }));
  route("POST", "/hub/goals/:id/sign-off", async (req) => ({ body: { signOff: await hub.signOff(req.params.id, req.body, pairedDevice(req)) } }));
  route("DELETE", "/hub/goals/:id/sign-off", (req) => hub.clearSignOff(req.params.id));
  route("POST", "/hub/goals/:id/write-playtests", (req) => ({ status: 202, body: hub.writePlaytests(req.params.id, req.body) }));

  route("GET", "/hub/checks/:checkId", async (req) => ({ body: await hub.check(req.params.checkId, q(req)) }));
  route("PUT", "/hub/checks/:checkId", (req) => ({ body: { meta: hub.updateCheckMeta(req.params.checkId, req.body) } }));
  route("PUT", "/hub/rules", (req) => ({ body: { rules: hub.goals.setRules(req.body) } }));
  route("GET", "/hub/store", () => ({ body: hub.goals.exportAll() }));
  route("POST", "/hub/store", (req) => ({ body: hub.goals.importAll(req.body) }));
  route("POST", "/hub/checks/:checkId/run", async (req) => ({ body: { plan: await hub.runCheck(req.params.checkId, req.body) } }));
  route("GET", "/hub/runs", (req) => ({ body: hub.runsPage(q(req)) }));
  route("GET", "/hub/runs/:runId", (req) => ({ body: hub.run(req.params.runId) }));
  route("POST", "/hub/runs/:runId/links", (req) => ({ body: { record: hub.addRunLink(req.params.runId, req.body) } }));
  route("DELETE", "/hub/runs/:runId/links", (req) => ({ body: { record: hub.removeRunLink(req.params.runId, q(req).url) } }));

  route("GET", "/hub/queue", () => ({ body: hub.queueView() }));
  route("PUT", "/hub/queue/paused", (req) => ({ body: hub.setPaused(req.body) }));
  route("GET", "/hub/lease", () => ({ body: hub.leaseView() }));
  route("POST", "/hub/release", async () => ({ body: await hub.release() }));
  route("POST", "/hub/plans", async (req) => ({ body: { plan: await hub.plan(req.body, "person") } }));
  route("POST", "/hub/plans/:id/cancel", async (req) => ({ body: { plan: await hub.cancelPlan(req.params.id) } }));
  route("POST", "/hub/fix", async (req) => ({ body: await hub.fix(req.body) }));
  return hub;
}
