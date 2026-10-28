/**
 * The agent's routes, under /v1/ext/studio:
 *
 *   GET  /settings                  the selected model, theme, which providers are connected
 *   PUT  /settings                  change them; keys are written, never returned
 *   GET  /models                    every provider and its models, for the picker
 *   /endpoints                      custom OpenAI-compatible endpoints (endpoints.ts)
 *   GET  /signin/:id                a sign-in's progress
 *   POST /signin/:id                start it
 *   DELETE /signin/:id              cancel it
 *   GET  /sessions                  every session, newest first
 *   POST /sessions                  a new session
 *   GET  /sessions/:id              one session's transcript and state
 *   DELETE /sessions/:id            remove one (stops its turn first)
 *   PUT  /sessions/:id/draft        the unsent message, kept across reloads
 *   POST /sessions/:id/seen         a subagent thread the user opened, so it is no longer new
 *   POST /sessions/:id/messages     send a message; the turn runs in the background. "/playtest <text>" runs the playtest flow
 *   POST /sessions/:id/playtest     a /playtest: { text?, source?, turn? }, source an agent message's transcript index, turn the latest turn's (the Make playtest pill)
 *   POST /sessions/:id/flow         a /flow: { name, params?, text? }, run through the daemon's /v1/flows/<name>/run
 *   GET  /actions                   every ue-mcp action as category.method, with its line and effect, for /action's menu
 *   GET  /actions/:name             one action's parameters (project(describe_action)), for /action's form
 *   POST /sessions/:id/action       a /action: { category, method, args?, text? }, run as a ue_mcp call under the approval rules
 *   POST /sessions/:id/stop         stop the turn
 *   POST /sessions/:id/approvals/:approvalId   allow or deny a command or file change
 *   POST /quick                     the editor's quick ask: a new session with its first message (quick.ts)
 *   PUT  /updates/channel           stable or beta, for every project
 *   POST /updates/{plugin,studio,restart}       run an update step, or keep it until no turn is in progress
 *   POST /updates/deferred/now      Restart now: end the turns in progress and run the waiting steps
 *
 * Per-turn review (/review, /sessions/:id/review, /sessions/:id/reviews, /sessions/:id/timeline) is in review.ts.
 * Editor dialogs (/dialogs) are in dialog-routes.ts, playtests, PIE test script runs (/qa), in qa.ts. Studio's window and the editor's busy state are in window-routes.ts; resolving
 * and opening the assets the chat names (/assets/resolve, /assets/open) in asset-links.ts; the composer's @-mention search
 * (/mentions/search) in mentions.ts.
 *
 * Progress arrives on the daemon's event stream as studio.session.changed,
 * studio.transcript.added, studio.turn.delta, studio.tool.finished,
 * studio.approval.requested and studio.approval.resolved.
 */
import { readDiscovery, type DaemonExtensionApi } from "ue-mcp/daemon";
import { PlaytestFlow } from "./playtest-flow.js";
import { FlowCaller } from "./flow-run.js";
import { ActionCatalog } from "./action-catalog.js";
import { registerFlowModel, type ModelHost } from "./flow-model.js";
import { CLAUDE_SIGN_IN_AVAILABLE, IMAGE_EDGES, PROVIDERS } from "@ue-mcp-studio/shared";
import { setImageEdge } from "./images.js";
import type { ActionRunRequest, ApprovalDecision, FlowRunRequest, PlaytestRequest, FeedbackReport, VcsStatus, AttachmentUpload, ModelRoute, SessionUpdate, SignInId, StudioSettings, StudioSettingsUpdate, AccountUsage, StudioAccountResponse } from "@ue-mcp-studio/shared";
import { MENTION_KINDS, splitActionName, type MentionKind } from "@ue-mcp-studio/shared";
import { AgentRunner, RESTART_CAUSE_FILE } from "./runner.js";
import { SessionStore } from "./sessions.js";
import { DEFAULT_MODEL, SettingsStore } from "./settings.js";
import { EndpointStore, registerEndpointRoutes } from "./endpoints.js";
import { providerFor } from "./providers.js";
import { DEFAULT_PLAN_MODELS, ModelCatalogSource, pickRoute, type SignInCoverage } from "./models.js";
import { StudioSignInFlow } from "./signin.js";
import { AttachmentStore } from "./attachments.js";
import { detectVcs, diffOf, listChanges } from "./vcs.js";
import { Updater, readChannel, writeChannel } from "./updates.js";
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
import { PlaytestIndex, registerPlaytestIndex, type PlaytestIndexHost } from "./playtest-index.js";
import { registerReview } from "./review.js";
import { PlaytestStore } from "./playtest-store.js";
import { registerAgentSettings } from "./agent-settings.js";
import { daemonWindowHost, registerWindowRoutes } from "./window-routes.js";
import { registerQuickRoute } from "./quick.js";
import { AssetResolver, editorBusy, missLine, openAsset, traceName } from "./asset-links.js";
import { MentionSearch, SUPERSEDED } from "./mentions.js";
import type { AssetRef } from "@ue-mcp-studio/shared";
import { DaemonActionEffects } from "./approval-kind.js";
import { required } from "./backend.js";
import { projectStrategy, registerComposerRoutes } from "./composer-routes.js";
import { registerNativeRoutes } from "./native-routes.js";
import { ContextSurfaces, contextApiOf } from "./context-surface.js";
import { fullModelName, modelName } from "./models.js";
import { userHome } from "./instructions.js";
import { loadout } from "./native.js";
import { composeNative, modelOf, toolsFor, type NativeHelper, type NativeRun } from "./native-runtime.js";
import { KEY_PROVIDER_IDS, STUDIO_PLAN_AVAILABLE, conventionOf, endpointIdOf, endpointVendor, type KeyProviderId, type VendorId } from "@ue-mcp-studio/shared";

export function registerChat(api: DaemonExtensionApi, agentVersion = "0.0.0", packageDir?: string): { runner: AgentRunner; dispose(): void } {
  const settings = new SettingsStore(api.dataDir);
  // Every image the model is shown, from a tool or the user, goes at the project's Image size.
  setImageEdge(() => IMAGE_EDGES[settings.usage().imageSize]);
  const store = new SessionStore(api.dataDir);
  const playtests = new PlaytestStore(api.dataDir);
  const attachments = new AttachmentStore(api.dataDir);
  // Custom OpenAI-compatible endpoints, for every project like the vendor keys.
  const endpoints = new EndpointStore();
  // ue-mcp's own word on which actions delete or overwrite, for that approval row.
  const actionsApi = required((api as unknown as { actions?: { effects(): Array<{ category: string; action: string; effect: string; destructive?: boolean }> } }).actions, "actions.effects");
  const effects = new DaemonActionEffects(() => actionsApi.effects());
  // How ue-mcp's tools are put to Studio's own agent, projected by the daemon.
  const surfaces = new ContextSurfaces(contextApiOf(api), () => projectStrategy(api.projectDir));
  // /action's catalog and forms, read from ue-mcp's own surface.
  const actionCatalog = new ActionCatalog({ effects: () => actionsApi.effects(), callAction: (c, a, args) => api.callAction(c, a, args) });
  const unwatchPlugins = api.events.subscribe((e) => {
    if (e.type === "plugins.changed") {
      actionCatalog.invalidate();
      effects.refresh();
      surfaces.invalidate();
    }
  });

  // The `ue-mcp login` account, kept fresh so a sign-in is picked up without a restart.
  let registry: Awaited<ReturnType<DaemonExtensionApi["registryAccount"]>> = null;
  // The signed-in plan's models, once the gateway has said; the default plan's until then.
  let planModels: readonly string[] = DEFAULT_PLAN_MODELS;
  const refreshAccount = async (): Promise<void> => {
    registry = await api.registryAccount().catch(() => null);
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

  /** How a model runs now: its endpoint, or the first connected sign-in or key by the route order, else nothing. */
  const routeOf = (vendor: VendorId, model: string): ModelRoute =>
    pickRoute(vendor, model, {
      signedIn: signedIn(),
      coverage: coverage(),
      hasKey: (v) => settings.key(v) !== null,
      hasEndpoint: (id) => endpoints.get(id) !== null,
      order: settings.routeOrder(),
    });
  const route = (): ModelRoute => routeOf(settings.provider(), settings.model());
  const endpointName = (vendor: string): string | null => {
    const id = endpointIdOf(vendor);
    return id === null ? null : endpoints.get(id)?.name ?? id;
  };
  /** What every provider is made with: the sign-ins' tokens and each endpoint's address and key. */
  const providerContext = () => ({
    accountToken: accountToken(),
    agentVersion,
    chatgptToken: () => chatgpt.accessToken(),
    endpoint: (id: string) => {
      const e = endpoints.get(id);
      return e ? { baseUrl: e.baseUrl, key: endpoints.key(id) } : null;
    },
  });
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
      endpoints: endpoints.list().length,
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
  const qa = registerQa(api, store, forms, playtests);
  registerPlaytestIndex(api, new PlaytestIndex({ host: api as unknown as PlaytestIndexHost, broker: qa, store }));
  const review = registerReview(api, store, () => settings.reviewTurns());
  /** The daemon's own address, for the flow routes. */
  const endpoint = () => {
    const d = readDiscovery(api.projectDir);
    return d ? { port: d.port, token: d.token } : null;
  };
  // The main agent's vendor's own files: instructions, subagents and skills (native.ts), read again at most every few seconds.
  const skillOwners = (): Map<string, string> => {
    const skills = required((api as unknown as { skills?: { list(): Array<{ dir: string; owner: { kind: string; package?: string } }> } }).skills, "skills");
    try {
      return new Map(skills.list().filter((s) => s.owner.kind === "plugin" && s.owner.package).map((s) => [path.resolve(s.dir), s.owner.package!]));
    } catch {
      return new Map();
    }
  };
  let nativeCache: { at: number; key: string; run: NativeRun | null } | null = null;
  const nativeRun = (): NativeRun | null => {
    if (!settings.usage().projectInstructions) return null;
    const vendor = settings.provider();
    const key = `${vendor}:${settings.model()}:${route()}`;
    if (nativeCache && nativeCache.key === key && Date.now() - nativeCache.at < 3000) return nativeCache.run;
    const convention = conventionOf(vendor);
    const l = loadout(convention, api.projectDir, userHome(), skillOwners());
    const helpers: NativeHelper[] = l.subagents.filter((a) => !a.problems.some((p) => p.endsWith("is required"))).map((a) => {
      const { allowed } = toolsFor(a);
      const wants = modelOf(convention, a.model);
      const base = { name: a.name, description: a.description, prompt: a.prompt, allowed, maxTurns: a.maxTurns, effort: a.effort };
      if (!wants || (wants.vendor === vendor && wants.model === settings.model())) return base;
      const r = KEY_PROVIDER_IDS.includes(wants.vendor as KeyProviderId) ? routeOf(wants.vendor as KeyProviderId, wants.model) : null;
      // Studio's loop runs a model over the API; the Claude sign-in runs whole conversations, so it needs a key here.
      const viaKey = r === "claude" && settings.key(wants.vendor as KeyProviderId) ? "key" : r;
      if (!viaKey || viaKey === "claude") return { ...base, note: `Its file names ${a.model}, which nothing on this machine runs over the API; it runs on the main agent's model.` };
      return { ...base, run: { model: wants.model, vendor: wants.vendor, route: viaKey, provider: () => providerFor(settings, viaKey, providerContext(), wants.vendor as KeyProviderId) } };
    });
    const run: NativeRun = { convention, loadout: l, composed: composeNative(l), helpers, skills: l.skills, sdkLoads: route() === "claude" };
    nativeCache = { at: Date.now(), key, run };
    return run;
  };
  const runner = new AgentRunner({
    host: api,
    review,
    busy,
    dialogs,
    qa,
    store,
    provider: () => providerFor(settings, route(), providerContext()),
    model: () => settings.model(),
    effort: () => settings.effort(),
    usage: () => settings.usage(),
    surfaces,
    subagentModel: () => settings.subagentModel(),
    subscription: () => route() === "claude",
    // A key names its vendor, since model names no longer do.
    route: () => {
      const r = route();
      if (r === "endpoint") return endpointName(settings.provider());
      if (r === "key") return `${PROVIDERS[settings.provider() as KeyProviderId].name} key`;
      return ({ claude: "Claude Code login", chatgpt: "ChatGPT sign-in", studio: "UE-MCP account" } as Record<string, string>)[r ?? ""] ?? null;
    },
    askBeforeChanges: () => settings.askBeforeChanges(),
    approvals: () => settings.approvals(),
    effects,
    native: nativeRun,
    playtestRuns: () => playtests.runs(),
    playtestFlow: new PlaytestFlow({ endpoint, subscribe: (listener) => api.events.subscribe((e) => listener(e)) }),
    flows: new FlowCaller({ endpoint, subscribe: (listener) => api.events.subscribe((e) => listener(e)) }),
  });
  // Flow agent steps, such as the playtest flow's draft, run on the model picked here, on its route.
  const unregisterModel = registerFlowModel(api as ModelHost, {
    projectDir: api.projectDir,
    model: () => settings.model(),
    effort: () => settings.effort(),
    subscription: () => route() === "claude",
    provider: () => providerFor(settings, route(), providerContext()),
  });
  // A playtest's card hands it to a subagent the runner starts beside the session's turns.
  qa.setAssigner({ assign: (sid, description, prompt) => runner.assignSubagent(sid, description, prompt), stop: (sid, callId) => runner.stopSubagent(sid, callId) });
  // It loops until the playtest passes, each attempt between checkpoints.
  qa.setLoopSupport({
    checkpoints: {
      checkpoint: (label) => review.checkpoint(label),
      changes: (from, to) => review.changes(from, to),
      restore: (checkpoint, paths, force) => review.restore(checkpoint, paths, force),
      mark: (sid, m) => {
        const s = store.get(sid);
        if (s) review.mark(s, m);
      },
    },
    blocked: (sid) => {
      const s = store.get(sid);
      return s && !review.on(s) ? "Review is off in this session, so no checkpoints would let you undo its changes. Turn it on in the session's Checkpoints panel." : null;
    },
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
  // A Studio update or restart that fails in the background stops the panel's run with what npm said.
  const updater = new Updater(api, agentVersion, (type, data) => api.events.publish(type, data), fetch, () => readChannel(), (step, error) => updates.fail(step, error));
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
  registerAgentSettings(api, () => updates.request("restart", {}), playtests);
  registerEndpointRoutes(api, {
    store: endpoints,
    changed: () => {
      nativeCache = null;
      api.events.publish("settings.changed", {});
    },
    // A model selected on a removed endpoint has nothing to run it: go back to the default model.
    removed: (id) => {
      if (settings.provider() === endpointVendor(id)) settings.update({ provider: "anthropic", model: DEFAULT_MODEL });
    },
  });
  registerNativeRoutes(api, {
    enabled: () => settings.usage().projectInstructions,
    main: () => ({ vendor: settings.provider(), model: settings.model(), route: route() }),
    routesFor: (vendor) => {
      // AGENTS.md is what every custom endpoint reads.
      if (vendor === "endpoint") return endpoints.list().map((e) => e.name);
      if (!KEY_PROVIDER_IDS.includes(vendor as KeyProviderId)) return [];
      const done = signedIn();
      const names: string[] = [];
      if (vendor === "anthropic" && done.claude) names.push("Claude sign-in");
      if (vendor === "anthropic" && done.studio && STUDIO_PLAN_AVAILABLE) names.push("Studio plan");
      if (vendor === "openai" && done.chatgpt) names.push("ChatGPT sign-in");
      if (settings.key(vendor as KeyProviderId)) names.push(`${PROVIDERS[vendor as KeyProviderId].name} key`);
      return names;
    },
    runsOverApi: (vendor, model) => {
      if (endpointIdOf(vendor) !== null) return routeOf(vendor as VendorId, model) !== null;
      if (!KEY_PROVIDER_IDS.includes(vendor as KeyProviderId)) return false;
      const r = routeOf(vendor as KeyProviderId, model);
      return r !== null && (r !== "claude" || !!settings.key(vendor as KeyProviderId));
    },
    modelName: fullModelName,
    worker: () => {
      const u = settings.usage();
      // Unset, the worker follows the main agent, whichever model that is.
      return {
        // A model of another vendor than the main agent's is not used: the worker then runs on the main agent's.
        model: u.subagentModel && u.subagentModel.provider === settings.provider() ? fullModelName(u.subagentModel.model) : null,
        effort: u.subagentEffort,
        starts: u.subagents === "automatic" ? "automatic" : "asked",
      };
    },
    home: userHome,
    owners: skillOwners,
  });
  registerComposerRoutes(api, {
    settings,
    restartUeMcp: () => updates.request("restart", {}),
  });
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
    const r = await updater.updateUeMcp(version);
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
    return { body: await catalog.catalog(signedIn(), coverage(), { endpoints: endpoints.list(), routeOrder: settings.routeOrder() }) };
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
  // A /playtest from a button: Make playtest on an agent message (source), or Retry on a failed one.
  api.route("POST", "/sessions/:id/playtest", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    const b = (req.body ?? {}) as { text?: unknown; source?: unknown; turn?: unknown };
    if (b.text !== undefined && typeof b.text !== "string") return bad("body must be { text?: string, source?: integer, turn?: integer }");
    if (b.turn !== undefined && (!Number.isInteger(b.turn) || s.turn?.start !== b.turn)) return bad("turn is the transcript index that began the latest turn");
    if (b.source !== undefined && !Number.isInteger(b.source)) return bad("source is the transcript index of an agent message");
    const source = b.source as number | undefined;
    if (source !== undefined && (s.transcript[source]?.kind !== "assistant" || s.transcript[source].parent)) return bad(`entry ${source} is not one of the agent's messages`);
    if (s.status === "running" || s.status === "waiting") return { status: 409, body: { error: "a turn is already in progress; wait for it to finish or stop it" } };
    const request: PlaytestRequest = { text: (b.text as string | undefined) ?? "", ...(source !== undefined ? { source } : {}), ...(b.turn !== undefined ? { turn: b.turn as number } : {}) };
    runner.playtest(s.id, request).catch((e) => api.log.warn(`playtest in session ${s.id} failed`, e));
    return { status: 202, body: { sessionId: s.id } };
  });
  // A /flow from its form: the flow and the params the form gave.
  api.route("POST", "/sessions/:id/flow", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    const b = (req.body ?? {}) as { name?: unknown; params?: unknown; text?: unknown };
    if (typeof b.name !== "string" || !b.name.trim()) return bad("body must be { name: string, params?: object, text?: string }");
    if (b.params !== undefined && (typeof b.params !== "object" || b.params === null || Array.isArray(b.params))) return bad("params is an object of the flow's inputs");
    if (b.text !== undefined && typeof b.text !== "string") return bad("text is the message the chat shows");
    if (s.status === "running" || s.status === "waiting") return { status: 409, body: { error: "a turn is already in progress; wait for it to finish or stop it" } };
    const request: FlowRunRequest = { name: b.name.trim(), params: (b.params as Record<string, unknown> | undefined) ?? {}, ...(b.text ? { text: b.text as string } : {}) };
    runner.flow(s.id, request).catch((e) => api.log.warn(`flow in session ${s.id} failed`, e));
    return { status: 202, body: { sessionId: s.id } };
  });
  api.route("GET", "/actions", async () => {
    try {
      return { body: { actions: await actionCatalog.list() } };
    } catch (e) {
      return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
    }
  });
  api.route("GET", "/actions/:name", async (req) => {
    const parts = splitActionName(req.params.name);
    if (!parts) return bad("name an action as category.method");
    try {
      return { body: await actionCatalog.describe(parts.category, parts.method) };
    } catch (e) {
      return { status: 404, body: { error: e instanceof Error ? e.message : String(e) } };
    }
  });
  // A /action from its form: the action and the args the form gave.
  api.route("POST", "/sessions/:id/action", (req) => {
    const s = store.get(req.params.id);
    if (!s) return missing(req.params.id);
    const b = (req.body ?? {}) as { category?: unknown; method?: unknown; args?: unknown; text?: unknown };
    if (typeof b.category !== "string" || typeof b.method !== "string" || !splitActionName(`${b.category}.${b.method}`)) return bad("body must be { category: string, method: string, args?: object, text?: string }");
    if (b.args !== undefined && (typeof b.args !== "object" || b.args === null || Array.isArray(b.args))) return bad("args is an object of the action's parameters");
    if (b.text !== undefined && typeof b.text !== "string") return bad("text is the message the chat shows");
    if (s.status === "running" || s.status === "waiting") return { status: 409, body: { error: "a turn is already in progress; wait for it to finish or stop it" } };
    const request: ActionRunRequest = { category: b.category, method: b.method, args: (b.args as Record<string, unknown> | undefined) ?? {}, ...(b.text ? { text: b.text as string } : {}) };
    runner.action(s.id, request).catch((e) => api.log.warn(`action in session ${s.id} failed`, e));
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
  // @-mentions in the composer: assets, actors and files by name (mentions.ts).
  const mentions = new MentionSearch({ host: api, connected: () => api.editors().some((e) => e.connected), busy: () => editorBusy(busy.state()) });
  // A finished call may have created an asset that was missing a moment ago.
  const unwatchAssets = api.events.subscribe((e) => {
    if (/tool\.finished$/.test(e.type)) {
      assets.forgetMissing();
      mentions.forget();
    }
  });
  api.route("POST", "/mentions/search", async (req) => {
    const b = (req.body ?? {}) as { query?: unknown; kinds?: unknown };
    const kinds = b.kinds === undefined ? undefined : Array.isArray(b.kinds) && b.kinds.every((k) => (MENTION_KINDS as readonly unknown[]).includes(k)) ? (b.kinds as MentionKind[]) : null;
    if (typeof b.query !== "string" || kinds === null) return bad(`body must be { query: string, kinds?: (${MENTION_KINDS.join(" | ")})[] }`);
    const answer = await mentions.search(b.query, kinds);
    // A newer search took this one's place: the UI has dropped it already.
    return answer === SUPERSEDED ? { status: 409, body: { error: "superseded by a newer search" } } : { body: answer };
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
      unwatchPlugins();
      updates.stop();
      unregisterModel();
      dialogs.dispose();
      qa.dispose();
      runner.dispose();
    },
  };
}
