/**
 * The Playtest Hub's routes, under /v1/ext/studio, exactly as HUB_ROUTES in
 * packages/shared/src/hub.ts names them. A bad body answers 400, an unknown
 * id 404 and a request that cannot be met now 409, each with { error }.
 * Every change publishes studio.hub.changed (hub.ts).
 */
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { Hub, type HubOptions } from "./hub.js";
import { HubError } from "./util.js";

type Req = { params: Record<string, string>; query?: unknown; body?: unknown };
type Res = { status?: number; body?: unknown };

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
  route("DELETE", "/hub/goals/:id", (req) => void hub.goals.delete(req.params.id));
  route("POST", "/hub/goals/:id/checks", (req) => ({ body: { goal: hub.goals.addChecks(req.params.id, (req.body as { checks?: unknown } | undefined)?.checks) } }));
  // Before /checks/:checkId: a check id always has a colon, so "order" is never one.
  route("PUT", "/hub/goals/:id/checks/order", (req) => ({ body: { goal: hub.goals.orderChecks(req.params.id, req.body) } }));
  route("DELETE", "/hub/goals/:id/checks/:checkId", (req) => ({ body: { goal: hub.goals.removeCheck(req.params.id, req.params.checkId) } }));
  route("PUT", "/hub/goals/:id/checks/:checkId", (req) => ({ body: { goal: hub.goals.updateCheck(req.params.id, req.params.checkId, req.body) } }));
  route("POST", "/hub/goals/:id/requires", (req) => ({ body: { goal: hub.goals.addRequire(req.params.id, req.body) } }));
  route("PUT", "/hub/goals/:id/requires", (req) => ({ body: { goal: hub.goals.orderRequires(req.params.id, req.body) } }));
  route("DELETE", "/hub/goals/:id/requires/:goalId", (req) => ({ body: { goal: hub.goals.removeRequire(req.params.id, req.params.goalId) } }));
  route("POST", "/hub/goals/:id/sign-off", (req) => ({ body: { goal: hub.signOff(req.params.id, req.body) } }));
  route("DELETE", "/hub/goals/:id/sign-off", (req) => ({ body: { goal: hub.goals.clearSignOff(req.params.id) } }));
  route("POST", "/hub/goals/:id/write-playtests", (req) => ({ status: 202, body: hub.writePlaytests(req.params.id, req.body) }));

  route("GET", "/hub/checks/:checkId", async (req) => ({ body: await hub.check(req.params.checkId, q(req)) }));
  route("POST", "/hub/checks/:checkId/run", async (req) => ({ body: { plan: await hub.runCheck(req.params.checkId, req.body) } }));
  route("GET", "/hub/runs", (req) => ({ body: hub.runsPage(q(req)) }));
  route("GET", "/hub/runs/:runId", (req) => ({ body: hub.run(req.params.runId) }));
  route("POST", "/hub/runs/:runId/links", (req) => ({ body: { record: hub.addRunLink(req.params.runId, req.body) } }));
  route("DELETE", "/hub/runs/:runId/links", (req) => ({ body: { record: hub.removeRunLink(req.params.runId, q(req).url) } }));

  route("GET", "/hub/queue", () => ({ body: hub.queueView() }));
  route("PUT", "/hub/queue/paused", (req) => ({ body: hub.setPaused(req.body) }));
  route("POST", "/hub/plans", async (req) => ({ body: { plan: await hub.plan(req.body, "person") } }));
  route("POST", "/hub/plans/:id/cancel", async (req) => ({ body: { plan: await hub.cancelPlan(req.params.id) } }));
  route("POST", "/hub/plans/:id/move", (req) => ({ body: hub.movePlan(req.params.id, req.body) }));

  route("POST", "/hub/schedules", (req) => ({ body: { schedule: hub.createSchedule(req.body) } }));
  route("PUT", "/hub/schedules/:id", (req) => ({ body: { schedule: hub.updateSchedule(req.params.id, req.body) } }));
  route("DELETE", "/hub/schedules/:id", (req) => void hub.deleteSchedule(req.params.id));

  route("POST", "/hub/assign-failing", async (req) => ({ body: await hub.assignFailing(req.body) }));
  return hub;
}
