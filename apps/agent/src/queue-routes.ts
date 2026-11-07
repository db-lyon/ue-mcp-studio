/**
 * The queue's routes: messages written while a turn runs wait, and go when the turns before
 * them have ended. A queue request that fails answers with the error; it never reaches the
 * daemon as an exception (#165).
 */
import type { DaemonExtensionApi, ExtensionHandler } from "ue-mcp/daemon";
import type { Attachment } from "@ue-mcp-studio/shared";
import { guardedRoute } from "./guarded-route.js";
import type { AgentRunner } from "./runner.js";
import type { SessionStore } from "./sessions.js";

export interface QueueRouteDeps {
  store: SessionStore;
  runner: Pick<AgentRunner, "enqueue" | "editQueued" | "sendQueued" | "sendQueuedNow">;
  /** A message's text and the session files it carries, or why the body is not one. */
  messageBody: (sessionId: string, body: unknown) => { text: string; files: Array<Attachment & { path: string }> } | { error: string };
  /** A Stop's side effects beside the runner's. */
  stopSide: (sessionId: string) => void;
}

export function registerQueueRoutes(api: Pick<DaemonExtensionApi, "route" | "log">, { store, runner, messageBody, stopSide }: QueueRouteDeps): void {
  const bad = (error: string) => ({ status: 400, body: { error } });
  const missing = (id: string) => ({ status: 404, body: { error: `no session ${id}` } });
  const gone = { status: 404, body: { error: "that message is not queued any more" } };
  const queueRoute = (what: string, fn: ExtensionHandler) => guardedRoute(api.log, what, fn);
  const running = (status: string) => status === "running" || status === "waiting";

  api.route("POST", "/sessions/:id/queue", queueRoute("queueing a message", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    const m = messageBody(s.id, req.body);
    if ("error" in m) return bad(m.error);
    const q = runner.enqueue(s.id, m.text, m.files.map(({ path: _p, ...a }) => a));
    return { status: 201, body: q };
  }));
  api.route("PUT", "/sessions/:id/queue/:qid", queueRoute("changing a queued message", (req) => {
    if (!store.get(req.params.id)) return missing(req.params.id);
    const text = (req.body as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || !text.trim()) return bad("body must be { text: string } with text");
    return runner.editQueued(req.params.id, req.params.qid, text) ? { status: 204 } : gone;
  }));
  api.route("DELETE", "/sessions/:id/queue/:qid", queueRoute("removing a queued message", (req) => {
    if (!store.get(req.params.id)) return missing(req.params.id);
    return runner.editQueued(req.params.id, req.params.qid, null) ? { status: 204 } : gone;
  }));
  // Send the next queued message now, when a stopped or failed turn left the queue waiting.
  api.route("POST", "/sessions/:id/queue/next", queueRoute("sending the next queued message", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    if (running(s.status)) return { status: 409, body: { error: "a turn is already in progress" } };
    void runner.sendQueued(s.id);
    return { status: 202, body: { sessionId: s.id } };
  }));
  // Send one queued message now: a running turn stops, as Stop does, and the rest of the queue keeps its order.
  api.route("POST", "/sessions/:id/queue/:qid/now", queueRoute("sending a queued message now", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    if (!s.queue?.some((q) => q.id === req.params.qid)) return gone;
    if (running(s.status)) stopSide(s.id);
    return runner.sendQueuedNow(s.id, req.params.qid) ? { status: 202, body: { sessionId: s.id } } : gone;
  }));
}
