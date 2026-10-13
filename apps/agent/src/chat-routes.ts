/**
 * The agent's routes, under /v1/ext/studio:
 *
 *   GET  /settings                  the selected model, theme, which providers are connected
 *   PUT  /settings                  change them; keys are written, never returned
 *   GET  /models                    every provider and its models, for the picker
 *   GET  /signin/:id                a sign-in's progress (studio)
 *   POST /signin/:id                start it: the page to approve on, and a code for Studio
 *   DELETE /signin/:id              cancel it
 *   GET  /sessions                  every session, newest first
 *   POST /sessions                  a new session
 *   GET  /sessions/:id              one session's transcript and state
 *   DELETE /sessions/:id            remove one (stops its turn first)
 *   PUT  /sessions/:id/draft        the unsent message, kept across reloads
 *   POST /sessions/:id/messages     send a message; the turn runs in the background
 *   POST /sessions/:id/stop         stop the turn
 *   POST /sessions/:id/approvals/:approvalId   allow or deny a command or file change
 *   POST /updates/{plugin,studio,restart}       run an update step, or keep it until no turn is in progress
 *   POST /updates/deferred/now      Restart now: end the turns in progress and run the waiting steps
 *
 * Editor dialogs (/dialogs) are in dialog-routes.ts. Studio's window and the editor's busy state are in window-routes.ts; resolving
 * and opening the assets the chat names (/assets/resolve, /assets/open) in asset-links.ts.
 *
 * Progress arrives on the daemon's event stream as studio.session.changed,
 * studio.transcript.added, studio.turn.delta, studio.tool.finished,
 * studio.approval.requested and studio.approval.resolved.
 */
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import type { ApprovalDecision, FeedbackReport, VcsStatus, AttachmentUpload, ModelRoute, SessionUpdate, SignInId, StudioSettings, StudioSettingsUpdate, AccountUsage, StudioAccountResponse } from "@ue-mcp-studio/shared";
import { AgentRunner, RESTART_CAUSE_FILE } from "./runner.js";
import { SessionStore } from "./sessions.js";
import { SettingsStore } from "./settings.js";
import { providerFor } from "./providers.js";
import { DEFAULT_PLAN_MODELS, ModelCatalogSource, signInsFor, type SignInCoverage } from "./models.js";
import { StudioSignInFlow } from "./signin.js";
import { AttachmentStore } from "./attachments.js";
import { detectVcs, diffOf, listChanges } from "./vcs.js";
import { Updater } from "./updates.js";
import { DEFERRED_STEPS, UpdateQueue, type DeferredStep } from "./update-queue.js";
import { issueBody, submitFeedback, validate, type Environment } from "./feedback.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { ClaudeSignInFlow, claudeHome, claudeLogin, sharedClaudeHome } from "./subscription.js";
import { deleteTranscripts, restoreTranscripts } from "./claude-sessions.js";
import { ChatGptAuth, ChatGptSignInFlow, chatgptModels } from "./chatgpt.js";
import { BusyTracker } from "./busy.js";
import { registerDialogs } from "./dialog-routes.js";
import { registerForms } from "./forms.js";
import { registerAgentSettings } from "./agent-settings.js";
import { daemonWindowHost, registerWindowRoutes } from "./window-routes.js";
import { AssetResolver, missLine, openAsset, traceName } from "./asset-links.js";
import type { AssetRef } from "@ue-mcp-studio/shared";

export function registerChat(api: DaemonExtensionApi, agentVersion = "0.0.0", packageDir?: string): { runner: AgentRunner; dispose(): void } {
  const settings = new SettingsStore(api.dataDir);
  const store = new SessionStore(api.dataDir);
  const attachments = new AttachmentStore(api.dataDir);

  // The `ue-mcp login` account, kept fresh so a sign-in is picked up without a restart.
  // Older daemons have no registryAccount; the Settings token is the only source then.
  let registry: Awaited<ReturnType<DaemonExtensionApi["registryAccount"]>> = null;
  // The signed-in plan's models, once the gateway has said; the default plan's until then.
  let planModels: readonly string[] = DEFAULT_PLAN_MODELS;
  const refreshAccount = async (): Promise<void> => {
    registry = typeof api.registryAccount === "function" ? await api.registryAccount().catch(() => null) : null;
    const token = accountToken();
    if (!token) return;
    const res = await fetchUsage(token).catch(() => null);
    if (res?.ok) planModels = ((await res.json()) as AccountUsage).plan.models;
  };
  // A sign-in from the panel wins; otherwise the account from `ue-mcp login`.
  const accountToken = (): string | null => settings.accountToken() ?? registry?.token ?? null;
  const fetchUsage = async (token: string): Promise<Response> =>
    fetch(`${settings.gatewayUrl()}/v1/account/usage`, { headers: { authorization: `Bearer ${token}` } });

  const coverage = (): SignInCoverage => ({ planModels, chatgptModels: chatgpt.signedIn() ? chatgptList?.models ?? null : null });
  const chatgpt = new ChatGptAuth();
  // The signed-in ChatGPT account's models, read once per sign-in.
  let chatgptList: { email: string | null; models: Array<{ id: string; name: string }> } | null = null;
  const refreshChatgptModels = async (): Promise<void> => {
    const who = chatgpt.signedIn();
    if (!who) return void (chatgptList = null);
    if (chatgptList && chatgptList.email === who.email) return;
    const models = await chatgpt.accessToken().then((t) => chatgptModels(t)).catch(() => null);
    chatgptList = models ? { email: who.email, models } : null;
  };
  const signedIn = (): Record<SignInId, boolean> => ({ chatgpt: chatgpt.signedIn() !== null, claude: claudeLogin() !== null, studio: accountToken() !== null });

  /** A sign-in that runs the model comes first; the vendor key is the fallback. */
  const route = (): ModelRoute => {
    const vendor = settings.provider();
    const done = signedIn();
    const via = signInsFor(vendor, settings.model(), coverage()).find((s) => done[s]);
    if (via) return via;
    return settings.key(vendor) ? "key" : null;
  };
  void refreshAccount();
  const accountTimer = setInterval(() => void refreshAccount(), 60_000);
  accountTimer.unref();


  const view = (): StudioSettings => {
    const { keys, ...rest } = settings.view();
    const login = settings.accountToken() ? settings.accountLogin() ?? "your account" : null;
    return {
      ...rest,
      route: route(),
      connected: { ...signedIn(), ...keys },
      account: login ? { login, via: "studio" } : registry ? { login: registry.login, via: "ue-mcp-login" } : null,
    };
  };

  const catalog = new ModelCatalogSource((p) => settings.key(p));

  const claudeSignIn = new ClaudeSignInFlow(() => api.events.publish("settings.changed", {}));
  const signins: Record<SignInId, { view(): unknown; start(): Promise<unknown>; cancel(): void }> = {
    claude: claudeSignIn,
    chatgpt: new ChatGptSignInFlow(chatgpt, () => {
      chatgptList = null;
      void refreshChatgptModels().then(() => api.events.publish("settings.changed", {}));
    }),
    studio: new StudioSignInFlow((token, login) => {
      settings.signIn(token, login);
      void refreshAccount().then(() => api.events.publish("settings.changed", {}));
    }),
  };
  const signinOf = (id: string) => (id === "studio" || id === "claude" || id === "chatgpt" ? signins[id] : null);

  const busy = new BusyTracker((type, data) => api.events.publish(type, data), Date.now, () => api.editors().some((e) => e.connected));
  const unobserve = api.events.subscribe((e) => busy.observe(e));
  const forms = registerForms(api);
  const dialogs = registerDialogs(api, store, settings, forms);
  const runner = new AgentRunner({
    host: api,
    busy,
    dialogs,
    store,
    provider: () => providerFor(settings, route(), { accountToken: accountToken(), agentVersion, chatgptToken: () => chatgpt.accessToken() }),
    model: () => settings.model(),
    effort: () => settings.effort(),
    subscription: () => route() === "claude",
    route: () => ({ claude: "Claude sign-in", chatgpt: "ChatGPT sign-in", studio: "UE-MCP account", key: "API key" } as Record<string, string>)[route() ?? ""] ?? null,
    askBeforeChanges: () => settings.askBeforeChanges(),
  });

  const bad = (error: string) => ({ status: 400, body: { error } });
  const missing = (id: string) => ({ status: 404, body: { error: `no session ${id}` } });

  api.route("GET", "/settings", () => ({ body: view() }));

  // The project's source control, read at most every few seconds however often the panel asks.
  let vcs: { at: number; value: Promise<VcsStatus | null> } | null = null;
  api.route("GET", "/vcs", async () => {
    if (!vcs || Date.now() - vcs.at > 5000) vcs = { at: Date.now(), value: detectVcs(api.projectDir).catch(() => null) };
    return { body: { vcs: await vcs.value } };
  });

  // Studio's own updates: the extension and the editor plugin, against the release channel.
  const updater = new Updater(api, agentVersion, (type, data) => api.events.publish(type, data));
  // A step that restarts the daemon or closes the editor waits while any turn is in progress.
  const writeRestartCause = (cause: string) => {
    fs.mkdirSync(api.dataDir, { recursive: true });
    fs.writeFileSync(path.join(api.dataDir, RESTART_CAUSE_FILE), JSON.stringify({ cause, at: Date.now() }));
  };
  const updates = new UpdateQueue({
    dataDir: api.dataDir,
    busy: () => runner.activeSessions().length > 0,
    interruptTurns: () => {
      for (const id of runner.activeSessions()) runner.interrupt(id, { by: "studio", why: "the user chose Restart now to install an update" });
    },
    run: async (step) => {
      if (step === "plugin") return updater.updatePlugin();
      writeRestartCause(step === "studio" ? "Studio's daemon restarted to install a Studio update" : "Studio's daemon restarted to load the updated ue-mcp");
      const r = step === "studio" ? await updater.updateStudio() : await updater.restartDaemon();
      if (!r.started) fs.rmSync(path.join(api.dataDir, RESTART_CAUSE_FILE), { force: true });
      return { ok: r.started, started: r.started, error: r.error };
    },
    publish: (type, data) => api.events.publish(type, data),
  });
  const stepBody = (body: unknown): { now?: boolean; then?: DeferredStep[] } => {
    const b = (body ?? {}) as { now?: unknown; then?: unknown };
    return { now: b.now === true, then: Array.isArray(b.then) ? b.then.filter((s): s is DeferredStep => (DEFERRED_STEPS as readonly unknown[]).includes(s)) : [] };
  };
  registerAgentSettings(api, () => updates.request("restart", {}));
  const stepRoute = async (step: DeferredStep, body: unknown) => {
    const r = await updates.request(step, stepBody(body));
    if (r.deferred) return { status: 202, body: { ok: true, deferred: r.deferred } };
    if (!r.ok) return { status: 500, body: { error: r.error } };
    return { status: r.started ? 202 : 200, body: r };
  };
  api.route("GET", "/updates", async () => ({ body: { ...(await updater.check()), deferred: updates.steps() } }));
  // Reports for Studio's tracker, with what is installed when the user includes it.
  const environment = (): Environment => ({
    studio: agentVersion,
    plugin: updater.pluginVersion(),
    ueMcp: api.version,
    engine: updater.engine(),
    model: settings.model(),
    route: route(),
  });
  api.route("GET", "/feedback/environment", () => ({ body: { environment: environment(), body: issueBody({ kind: "problem", title: "", description: "", includeEnvironment: true }, environment()).trim() } }));
  api.route("POST", "/feedback", async (req) => {
    const r = (req.body ?? {}) as FeedbackReport;
    const invalid = validate(r);
    if (invalid) return { status: 400, body: { error: invalid } };
    return { body: await submitFeedback(r, environment()) };
  });

  // The panel's update run, kept here because the page that resumes it is served on the next daemon's port.
  const runFile = path.join(api.dataDir, "update-run.json");
  api.route("GET", "/updates/run", () => {
    try {
      return { body: { run: JSON.parse(fs.readFileSync(runFile, "utf-8")) as unknown } };
    } catch {
      return { body: { run: null } };
    }
  });
  api.route("PUT", "/updates/run", (req) => {
    const run = (req.body as { run?: unknown } | undefined)?.run ?? null;
    if (run === null) fs.rmSync(runFile, { force: true });
    else fs.writeFileSync(runFile, JSON.stringify(run));
    return { body: { ok: true } };
  });
  api.route("POST", "/updates/restart", (req) => stepRoute("restart", req.body));
  api.route("POST", "/updates/studio", (req) => stepRoute("studio", req.body));
  api.route("POST", "/updates/plugin", (req) => stepRoute("plugin", req.body));
  api.route("POST", "/updates/ueMcp", async (req) => {
    const version = String((req.body as { version?: unknown } | undefined)?.version ?? "");
    const r = await updater.updateUeMcpSource(version);
    return r.ok ? { body: { ok: true } } : { status: 500, body: { ok: false, error: r.error } };
  });
  // Restart now: end the turns in progress and run the waiting steps.
  api.route("POST", "/updates/deferred/now", async () => {
    if (updates.steps().length === 0) return { status: 404, body: { error: "no update is waiting" } };
    const r = await updates.runNow();
    return r.ok ? { status: 202, body: r } : { status: 500, body: { error: r.error } };
  });

  api.route("GET", "/vcs/changes", async () => ({ body: await listChanges(api.projectDir) }));
  api.route("GET", "/vcs/diff", async (req) => {
    const file = req.query.path;
    if (typeof file !== "string" || !file) return bad("query must name ?path=");
    return { body: await diffOf(api.projectDir, file) };
  });

  api.route("GET", "/models", async () => {
    await refreshChatgptModels();
    return { body: await catalog.catalog(signedIn(), coverage()) };
  });

  const noSignIn = (id: string) => ({ status: 404, body: { error: `no sign-in ${id}` } });
  api.route("GET", "/signin/:id", (req) => {
    const f = signinOf(req.params.id);
    return f ? { body: f.view() } : noSignIn(req.params.id);
  });
  api.route("POST", "/signin/:id", async (req) => {
    const f = signinOf(req.params.id);
    return f ? { body: await f.start() } : noSignIn(req.params.id);
  });
  // The code Claude's approval page shows, for a sign-in that asks for one.
  api.route("POST", "/signin/:id/code", (req) => {
    if (req.params.id !== "claude") return noSignIn(req.params.id);
    const code = (req.body as { code?: unknown } | undefined)?.code;
    if (typeof code !== "string" || !code.trim()) return bad("code must be a non-empty string");
    return { body: claudeSignIn.submit(code) };
  });
  api.route("DELETE", "/signin/:id", (req) => {
    const f = signinOf(req.params.id);
    if (!f) return noSignIn(req.params.id);
    f.cancel();
    return { status: 204 };
  });

  // Plan and usage from the gateway, for the Account tab.
  api.route("GET", "/account", async () => {
    await refreshAccount();
    const token = accountToken();
    if (!token) {
      const out: StudioAccountResponse = { signedIn: false, reason: "Not signed in." };
      return { body: out };
    }
    try {
      const res = await fetchUsage(token);
      if (res.status === 401) return { body: { signedIn: false, reason: "The sign-in has expired. Sign in again." } satisfies StudioAccountResponse };
      if (!res.ok) return { status: 502, body: { error: `gateway ${res.status}` } };
      const usage = (await res.json()) as AccountUsage;
      const out: StudioAccountResponse = { signedIn: true, usage, manageUrl: process.env.UE_MCP_STUDIO_MANAGE_URL ?? null };
      return { body: out };
    } catch (e) {
      return { status: 502, body: { error: `gateway unreachable: ${e instanceof Error ? e.message : String(e)}` } };
    }
  });
  api.route("PUT", "/settings", async (req) => {
    try {
      const u = (req.body ?? {}) as StudioSettingsUpdate;
      if (u.signOut === "claude") {
        await claudeSignIn.signOut();
        delete u.signOut;
      } else if (u.signOut === "chatgpt") {
        await chatgpt.signOut();
        chatgptList = null;
        delete u.signOut;
      }
      settings.update(u);
      return { body: view() };
    } catch (e) {
      return bad(e instanceof Error ? e.message : String(e));
    }
  });

  // Sessions from the 0.1.2 betas, which kept their Claude conversations in Claude Code's home, continue from Studio's.
  try {
    const ids = store.all().flatMap((x) => [x.sdkSession ?? "", ...(x.sdkPast ?? [])]);
    const copied = restoreTranscripts(ids, sharedClaudeHome(), claudeHome(), api.projectDir);
    if (copied) api.log.info(`copied ${copied} Claude conversation(s) back into Studio's home`);
  } catch (e) {
    api.log.warn("could not copy Claude conversations back into Studio's home", e);
  }
  api.route("GET", "/sessions", () => ({ body: { sessions: store.all().map(SessionStore.summary) } }));
  api.route("POST", "/sessions", () => ({ status: 201, body: SessionStore.detail(store.create()) }));
  api.route("GET", "/sessions/:id", (req) => {
    const s = store.get(req.params.id);
    return s ? { body: SessionStore.detail(s) } : missing(req.params.id);
  });
  api.route("DELETE", "/sessions/:id", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    forms.cancelSession(s.id);
    runner.stop(s.id);
    deleteTranscripts([s.sdkSession ?? "", ...(s.sdkPast ?? [])], claudeHome(), api.projectDir);
    store.delete(s.id);
    attachments.removeSession(s.id);
    return { status: 204 };
  });
  api.route("PUT", "/sessions/:id", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    const u = (req.body ?? {}) as SessionUpdate;
    if (u.title !== undefined && (typeof u.title !== "string" || !u.title.trim())) return bad("title must be a non-empty string");
    if (u.archived !== undefined && typeof u.archived !== "boolean") return bad("archived must be a boolean");
    if (u.title !== undefined) s.title = u.title.trim().slice(0, 120);
    if (u.archived !== undefined) s.archived = u.archived;
    store.save(s);
    api.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    return { body: SessionStore.summary(s) };
  });
  // A dropped or pasted file, saved before the message that carries it is sent.
  api.route("POST", "/sessions/:id/attachments", (req) => {
    if (!store.get(req.params.id)) return missing(req.params.id);
    try {
      const { path: _path, ...a } = attachments.save(req.params.id, req.body as AttachmentUpload);
      return { status: 201, body: a };
    } catch (e) {
      return bad(e instanceof Error ? e.message : String(e));
    }
  });
  // The file itself, for the panel's thumbnails and downloads.
  api.route("GET", "/sessions/:id/attachments/:aid", (req) => {
    const a = attachments.get(req.params.id, req.params.aid);
    if (!a) return { status: 404, body: { error: "no such attachment" } };
    return { headers: { "content-type": a.type, "content-disposition": `inline; filename="${a.name.replace(/"/g, "")}"` }, body: fs.readFileSync(a.path) };
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
    const body = req.body as { text?: unknown; attachments?: unknown } | undefined;
    const text = typeof body?.text === "string" ? body.text : "";
    const ids = Array.isArray(body?.attachments) ? body.attachments.filter((x): x is string => typeof x === "string") : [];
    if (!text.trim() && ids.length === 0) return bad("body must be { text: string, attachments?: string[] } with text or a file");
    const files = ids.map((a) => attachments.get(s.id, a));
    if (files.some((f) => !f)) return bad("an attachment is missing; add the file again");
    if (s.status === "running" || s.status === "waiting") return { status: 409, body: { error: "a turn is already in progress" } };
    // The turn runs past this response; its progress is on the event stream.
    runner.send(s.id, text, files as Array<NonNullable<(typeof files)[number]>>).catch((e) => api.log.warn(`turn in session ${s.id} failed`, e));
    return { status: 202, body: { sessionId: s.id } };
  });
  // Stop one subagent; the turn goes on without it.
  api.route("POST", "/sessions/:id/agents/:callId/stop", (req) => {
    if (!store.get(req.params.id)) return missing(req.params.id);
    return runner.stopSubagent(req.params.id, req.params.callId) ? { status: 204 } : { status: 404, body: { error: `no running subagent ${req.params.callId}` } };
  });
  // The user's answer to a command or file change the agent asked to make.
  api.route("POST", "/sessions/:id/approvals/:approvalId", (req) => {
    if (!store.get(req.params.id)) return missing(req.params.id);
    const decision = (req.body as { decision?: unknown } | undefined)?.decision;
    if (decision !== "allow" && decision !== "session" && decision !== "deny") return bad("body must be { decision: allow | session | deny }");
    return runner.answerApproval(req.params.id, req.params.approvalId, decision as ApprovalDecision)
      ? { status: 204 }
      : { status: 404, body: { error: `no approval ${req.params.approvalId} is waiting` } };
  });
  api.route("POST", "/sessions/:id/stop", (req) => {
    if (!store.get(req.params.id)) return missing(req.params.id);
    forms.cancelSession(req.params.id);
    runner.stop(req.params.id);
    return { status: 204 };
  });

  // Asset names in the chat: resolved from disk, opened in the editor on a click.
  const assets = new AssetResolver(api);
  // A finished call may have created an asset that was missing a moment ago.
  const unwatchAssets = api.events.subscribe((e) => {
    if (/tool\.finished$/.test(e.type)) assets.forgetMissing();
  });
  api.route("POST", "/assets/resolve", async (req) => {
    const b = (req.body ?? {}) as { refs?: unknown; sessionId?: unknown };
    const refs = Array.isArray(b.refs) ? (b.refs as Array<{ token?: unknown; at?: unknown }>) : null;
    if (!refs || !refs.every((r) => r && typeof r.token === "string" && (r.at === undefined || Number.isInteger(r.at)))) {
      return bad("body must be { refs: [{ token: string, at?: integer }], sessionId?: string }");
    }
    const own = typeof b.sessionId === "string" ? store.get(b.sessionId) : null;
    const running = own?.status === "running" || own?.status === "waiting";
    const trace = (name: string, at?: number) => (own ? traceName(own.transcript, name, at, running) : ({ status: "none" } as const));
    return { body: { results: await assets.resolve(refs as AssetRef[], trace) } };
  });
  api.route("POST", "/assets/missed", async (req) => {
    const line = missLine(req.body);
    if (!line) return bad("body must be { name: string, candidates: integer }");
    api.log.warn(line);
    return { status: 204 };
  });
  api.route("POST", "/assets/open", async (req) => {
    const r = await openAsset({
      host: api,
      connected: () => api.editors().some((e) => e.connected),
      busy: () => busy.state(),
      track: async (f) => {
        const id = busy.start({ category: "editor", action: "open_asset", source: "studio" });
        try {
          return await f();
        } finally {
          busy.finish(id);
        }
      },
      resolver: assets,
    }, (req.body as { path?: unknown } | undefined)?.path);
    return r;
  });

  if (packageDir) registerWindowRoutes(api, { busy, stopSession: (id) => runner.stop(id), window: () => daemonWindowHost(api, packageDir, agentVersion) });

  runner.recover();
  return {
    runner,
    dispose: () => {
      unobserve();
      unwatchAssets();
      updates.stop();
      dialogs.dispose();
      runner.dispose();
    },
  };
}
