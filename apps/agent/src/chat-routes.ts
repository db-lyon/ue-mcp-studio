/**
 * The agent's routes, under /v1/ext/studio:
 *
 *   GET  /settings                  the selected model, theme, which providers are connected
 *   PUT  /settings                  change them; keys are written, never returned
 *   GET  /models                    every provider and its models, for the picker
 *   GET  /signin/:id                a sign-in's progress
 *   POST /signin/:id                start it
 *   DELETE /signin/:id              cancel it
 *   GET  /sessions                  every session, newest first
 *   POST /sessions                  a new session
 *   GET  /sessions/:id              one session's transcript and state
 *   DELETE /sessions/:id            remove one (stops its turn first)
 *   PUT  /sessions/:id/draft        the unsent message, kept across reloads
 *   POST /sessions/:id/seen         a subagent thread the user opened, so it is no longer new
 *   POST /sessions/:id/messages     send a message; the turn runs in the background
 *   POST /sessions/:id/stop         stop the turn
 *   POST /sessions/:id/approvals/:approvalId   allow or deny a command or file change
 *   POST /quick                     the editor's quick ask: a new session with its first message (quick.ts)
 *   PUT  /updates/channel           stable or beta, for every project
 *   POST /updates/{plugin,studio,restart}       run an update step, or keep it until no turn is in progress
 *   POST /updates/deferred/now      Restart now: end the turns in progress and run the waiting steps
 *
 * Editor dialogs (/dialogs) are in dialog-routes.ts, PIE test script runs (/qa) in qa.ts. Studio's window and the editor's busy state are in window-routes.ts; resolving
 * and opening the assets the chat names (/assets/resolve, /assets/open) in asset-links.ts.
 *
 * Progress arrives on the daemon's event stream as studio.session.changed,
 * studio.transcript.added, studio.turn.delta, studio.tool.finished,
 * studio.approval.requested and studio.approval.resolved.
 */
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { CLAUDE_SIGN_IN_AVAILABLE, PROVIDERS } from "@ue-mcp-studio/shared";
import type { ApprovalDecision, FeedbackReport, VcsStatus, AttachmentUpload, ModelRoute, SessionUpdate, SignInId, StudioSettings, StudioSettingsUpdate, AccountUsage, StudioAccountResponse } from "@ue-mcp-studio/shared";
import { AgentRunner, RESTART_CAUSE_FILE } from "./runner.js";
import { SessionStore } from "./sessions.js";
import { SettingsStore } from "./settings.js";
import { providerFor } from "./providers.js";
import { DEFAULT_PLAN_MODELS, ModelCatalogSource, signInsFor, type SignInCoverage } from "./models.js";
import { StudioSignInFlow } from "./signin.js";
import { AttachmentStore } from "./attachments.js";
import { detectVcs, diffOf, listChanges } from "./vcs.js";
import { Updater, writeChannel } from "./updates.js";
import { DEFERRED_STEPS, UpdateQueue, type DeferredStep } from "./update-queue.js";
import { issueBody, submitFeedback, validate, type Environment } from "./feedback.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { ClaudeLoginCheck, claudeHome, claudeLogin, refreshClaudeLogin, studioClaudeHome } from "./claude-auth.js";
import { deleteTranscripts, restoreTranscripts } from "./claude-sessions.js";
import { ChatGptAuth, ChatGptSignInFlow, chatgptModels } from "./chatgpt.js";
import { BusyTracker } from "./busy.js";
import { registerDialogs } from "./dialog-routes.js";
import { registerForms } from "./forms.js";
import { registerQa } from "./qa.js";
import { registerAgentSettings } from "./agent-settings.js";
import { daemonWindowHost, registerWindowRoutes } from "./window-routes.js";
import { registerQuickRoute } from "./quick.js";
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
  const signedIn = (): Record<SignInId, boolean> => ({ chatgpt: chatgpt.signedIn() !== null, claude: CLAUDE_SIGN_IN_AVAILABLE && claudeLogin() !== null, studio: accountToken() !== null });

  /** A sign-in that runs the model comes first; the vendor key is the fallback. */
  const route = (): ModelRoute => {
    const vendor = settings.provider();
    const done = signedIn();
    const via = signInsFor(vendor, settings.model(), coverage()).find((s) => done[s]);
    if (via) return via;
    return settings.key(vendor) ? "key" : null;
  };
  // Who is signed in to Claude comes from the runtime's own `auth status`.
  const refreshClaude = async (): Promise<void> => {
    if (!CLAUDE_SIGN_IN_AVAILABLE) return;
    const before = claudeLogin()?.method ?? null;
    if (((await refreshClaudeLogin())?.method ?? null) !== before) api.events.publish("settings.changed", {});
  };
  void refreshAccount();
  void refreshClaude();
  const accountTimer = setInterval(() => {
    void refreshAccount();
    void refreshClaude();
  }, 60_000);
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

  const signins: Record<SignInId, { view(): unknown; start(): Promise<unknown>; cancel(): void }> = {
    claude: new ClaudeLoginCheck(() => api.events.publish("settings.changed", {})),
    chatgpt: new ChatGptSignInFlow(chatgpt, () => {
      chatgptList = null;
      void refreshChatgptModels().then(() => api.events.publish("settings.changed", {}));
    }),
    studio: new StudioSignInFlow((token, login) => {
      settings.signIn(token, login);
      void refreshAccount().then(() => api.events.publish("settings.changed", {}));
    }),
  };
  const signinOf = (id: string) => (id === "studio" || (id === "claude" && CLAUDE_SIGN_IN_AVAILABLE) || id === "chatgpt" ? signins[id] : null);

  const busy = new BusyTracker((type, data) => api.events.publish(type, data), Date.now, () => api.editors().some((e) => e.connected));
  const unobserve = api.events.subscribe((e) => busy.observe(e));
  const forms = registerForms(api);
  const dialogs = registerDialogs(api, store, settings, forms);
  const qa = registerQa(api, store, forms);
  const runner = new AgentRunner({
    host: api,
    busy,
    dialogs,
    qa,
    store,
    provider: () => providerFor(settings, route(), { accountToken: accountToken(), agentVersion, chatgptToken: () => chatgpt.accessToken() }),
    model: () => settings.model(),
    effort: () => settings.effort(),
    subscription: () => route() === "claude",
    // A key names its vendor, since model names no longer do.
    route: () => ({ claude: "Claude Code login", chatgpt: "ChatGPT sign-in", studio: "UE-MCP account", key: `${PROVIDERS[settings.provider()].name} key` } as Record<string, string>)[route() ?? ""] ?? null,
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
  // Stable or beta, for every project: Update follows it for Studio and the editor plugin.
  api.route("PUT", "/updates/channel", (req) => {
    const channel = (req.body as { channel?: unknown } | undefined)?.channel;
    if (channel !== "stable" && channel !== "beta") return { status: 400, body: { error: "channel is stable or beta" } };
    writeChannel(channel);
    return { body: { channel } };
  });
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
    await Promise.all([refreshChatgptModels(), refreshClaude()]);
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
      if (u.signOut === "chatgpt") {
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

  // Sessions from 0.1.3 to 0.1.22, which kept their Claude conversations in Studio's own home, continue from Claude Code's.
  try {
    const ids = store.all().flatMap((x) => [x.sdkSession ?? "", ...(x.sdkPast ?? [])]);
    const copied = restoreTranscripts(ids, studioClaudeHome(), claudeHome(), api.projectDir);
    if (copied) api.log.info(`copied ${copied} Claude conversation(s) into Claude Code's home`);
  } catch (e) {
    api.log.warn("could not copy Claude conversations into Claude Code's home", e);
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
  api.route("POST", "/sessions/:id/seen", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    const id = (req.body as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !id) return bad("body must be { id: string }");
    if (!(s.seen ?? []).includes(id)) {
      s.seen = [...(s.seen ?? []), id];
      store.save(s);
    }
    return { status: 204 };
  });
  // Finished subagents the user takes off the thread list; kept with the session, so a reload keeps them off.
  api.route("POST", "/sessions/:id/dismissed", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    const ids = (req.body as { ids?: unknown } | undefined)?.ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) return bad("body must be { ids: string[] }");
    if (SessionStore.dismiss(s, ids as string[]).length) {
      store.save(s);
      api.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    }
    return { body: { dismissed: s.dismissed ?? [] } };
  });
  /** A message's text and the session files it carries, or why the body is not one. */
  const messageBody = (sessionId: string, body: unknown): { text: string; files: Array<NonNullable<ReturnType<typeof attachments.get>>> } | { error: string } => {
    const b = body as { text?: unknown; attachments?: unknown } | undefined;
    const text = typeof b?.text === "string" ? b.text : "";
    const ids = Array.isArray(b?.attachments) ? b.attachments.filter((x): x is string => typeof x === "string") : [];
    if (!text.trim() && ids.length === 0) return { error: "body must be { text: string, attachments?: string[] } with text or a file" };
    const files = ids.map((a) => attachments.get(sessionId, a));
    if (files.some((f) => !f)) return { error: "an attachment is missing; add the file again" };
    return { text, files: files as Array<NonNullable<(typeof files)[number]>> };
  };
  /** A Stop's side effects beside the runner's: open forms close, and nothing waits on the editor for this session. */
  const stopSide = (id: string) => {
    forms.cancelSession(id);
    busy.endWait();
  };
  // now: true stops a running turn, as Stop does, and sends this message in its place, ahead of the queue.
  api.route("POST", "/sessions/:id/messages", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    const m = messageBody(s.id, req.body);
    if ("error" in m) return bad(m.error);
    const now = (req.body as { now?: unknown } | undefined)?.now === true;
    const running = s.status === "running" || s.status === "waiting";
    if (running && !now) return { status: 409, body: { error: "a turn is already in progress; queue the message or send it with now: true" } };
    if (running) stopSide(s.id);
    // The turn runs past this response; its progress is on the event stream.
    runner.sendNow(s.id, m.text, m.files).catch((e) => api.log.warn(`turn in session ${s.id} failed`, e));
    return { status: 202, body: { sessionId: s.id } };
  });
  // A message written while a turn runs: it waits, and goes when the turns before it have ended.
  api.route("POST", "/sessions/:id/queue", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    const m = messageBody(s.id, req.body);
    if ("error" in m) return bad(m.error);
    const q = runner.enqueue(s.id, m.text, m.files.map(({ path: _p, ...a }) => a));
    return { status: 201, body: q };
  });
  api.route("PUT", "/sessions/:id/queue/:qid", (req) => {
    if (!store.get(req.params.id)) return missing(req.params.id);
    const text = (req.body as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || !text.trim()) return bad("body must be { text: string } with text");
    return runner.editQueued(req.params.id, req.params.qid, text) ? { status: 204 } : { status: 404, body: { error: "that message is not queued any more" } };
  });
  api.route("DELETE", "/sessions/:id/queue/:qid", (req) => {
    if (!store.get(req.params.id)) return missing(req.params.id);
    return runner.editQueued(req.params.id, req.params.qid, null) ? { status: 204 } : { status: 404, body: { error: "that message is not queued any more" } };
  });
  // Send the next queued message now, when a stopped or failed turn left the queue waiting.
  api.route("POST", "/sessions/:id/queue/next", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    if (s.status === "running" || s.status === "waiting") return { status: 409, body: { error: "a turn is already in progress" } };
    void runner.sendQueued(s.id);
    return { status: 202, body: { sessionId: s.id } };
  });
  // Edit one of the user's messages. "rewind" (the default) cuts this conversation back to it and sends the
  // new text as a new turn; "fork" leaves this session as it is and continues from the new text in a copy.
  api.route("POST", "/sessions/:id/transcript/:index/edit", async (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    const index = Number(req.params.index);
    const body = (req.body ?? {}) as { text?: unknown; mode?: unknown };
    const text = body.text;
    if (typeof text !== "string" || !text.trim()) return bad("body must be { text: string, mode?: \"rewind\" | \"fork\" } with text");
    if (body.mode !== undefined && body.mode !== "rewind" && body.mode !== "fork") return bad('mode is "rewind" or "fork"');
    const entry = Number.isInteger(index) ? s.transcript[index] : undefined;
    if (!entry || entry.kind !== "user" || entry.parent) return bad(`entry ${req.params.index} is not one of your messages`);
    if (body.mode === "fork") {
      const forked = await runner.forkAt(s.id, index, text);
      return forked ? { status: 201, body: { sessionId: forked } } : bad(`entry ${req.params.index} is not one of your messages`);
    }
    if (s.status === "running" || s.status === "waiting") stopSide(s.id);
    runner.editMessage(s.id, index, text).catch((e) => api.log.warn(`edit in session ${s.id} failed`, e));
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
    // Nothing waits on the editor attaching after a Stop, so the banner stops saying it does.
    busy.endWait();
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

  registerQuickRoute(api, {
    connected: () => route() !== null,
    create: (title) => store.create(title),
    send: (id, text) => runner.send(id, text),
    detail: (id) => {
      const s = store.get(id);
      return s ? SessionStore.detail(s) : undefined;
    },
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
      qa.dispose();
      runner.dispose();
    },
  };
}
