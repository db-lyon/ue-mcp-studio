/**
 * The agent's routes, under /v1/ext/studio:
 *
 *   GET  /settings                  provider, model, gateway URL, which secrets are set
 *   PUT  /settings                  change them; secrets are written, never returned
 *   GET  /sessions                  every session, newest first
 *   POST /sessions                  a new session
 *   GET  /sessions/:id              one session's transcript and state
 *   DELETE /sessions/:id            remove one (stops its turn first)
 *   PUT  /sessions/:id/draft        the unsent message, kept across reloads
 *   POST /sessions/:id/messages     send a message; the turn runs in the background
 *   POST /sessions/:id/stop         stop the turn
 *
 * Progress arrives on the daemon's event stream as studio.session.changed,
 * studio.transcript.added, studio.turn.delta and studio.tool.finished.
 */
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import type { StudioSettingsUpdate } from "@ue-mcp-studio/shared";
import { AgentRunner } from "./runner.js";
import { SessionStore } from "./sessions.js";
import { SettingsStore } from "./settings.js";
import { providerFor } from "./providers.js";

export function registerChat(api: DaemonExtensionApi): AgentRunner {
  const settings = new SettingsStore(api.dataDir);
  const store = new SessionStore(api.dataDir);
  const runner = new AgentRunner({
    host: api,
    store,
    provider: () => providerFor(settings),
    model: () => settings.model(),
  });

  const bad = (error: string) => ({ status: 400, body: { error } });
  const missing = (id: string) => ({ status: 404, body: { error: `no session ${id}` } });

  api.route("GET", "/settings", () => ({ body: settings.view() }));
  api.route("PUT", "/settings", (req) => {
    try {
      return { body: settings.update((req.body ?? {}) as StudioSettingsUpdate) };
    } catch (e) {
      return bad(e instanceof Error ? e.message : String(e));
    }
  });

  api.route("GET", "/sessions", () => ({ body: { sessions: store.all().map(SessionStore.summary) } }));
  api.route("POST", "/sessions", () => ({ status: 201, body: SessionStore.detail(store.create()) }));
  api.route("GET", "/sessions/:id", (req) => {
    const s = store.get(req.params.id);
    return s ? { body: SessionStore.detail(s) } : missing(req.params.id);
  });
  api.route("DELETE", "/sessions/:id", (req) => {
    if (!store.get(req.params.id)) return missing(req.params.id);
    runner.stop(req.params.id);
    store.delete(req.params.id);
    return { status: 204 };
  });
  api.route("PUT", "/sessions/:id/draft", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    const draft = (req.body as { draft?: unknown } | undefined)?.draft;
    if (typeof draft !== "string") return bad("body must be { draft: string }");
    s.draft = draft;
    store.save(s);
    return { status: 204 };
  });
  api.route("POST", "/sessions/:id/messages", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    const text = (req.body as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || !text.trim()) return bad("body must be { text: string }");
    if (s.status === "running" || s.status === "waiting") return { status: 409, body: { error: "a turn is already in progress" } };
    // The turn runs past this response; its progress is on the event stream.
    runner.send(s.id, text).catch((e) => api.log.warn(`turn in session ${s.id} failed`, e));
    return { status: 202, body: { sessionId: s.id } };
  });
  api.route("POST", "/sessions/:id/stop", (req) => {
    if (!store.get(req.params.id)) return missing(req.params.id);
    runner.stop(req.params.id);
    return { status: 204 };
  });

  runner.recover();
  return runner;
}
