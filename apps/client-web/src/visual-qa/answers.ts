/**
 * What the visual QA harness answers for a scenario, apart from the page: the
 * settings, health and every GET a section reads. main.tsx serves these to
 * client-web; the mobile app's harness serves the same answers to its screens,
 * so both are shot from one set of fixtures.
 */
import { DEFAULT_USAGE, type NativeOverview, type StudioSettings, type StudioTheme } from "@ue-mcp-studio/shared";
import { SCENARIOS as PLAYTESTS, type Scenario } from "./fixtures";
import { CONTEXT, INSTALL, SETTINGS_SCENARIOS } from "./settings-fixtures";
import { REVIEW_SCENARIOS } from "./review-fixtures";
import { REFUSED_SCENARIOS } from "./refused-fixtures";
import { CONTEXT_SCENARIOS } from "./context-fixtures";

export const SCENARIOS: Record<string, Scenario> = { ...PLAYTESTS, ...SETTINGS_SCENARIOS, ...REVIEW_SCENARIOS, ...REFUSED_SCENARIOS, ...CONTEXT_SCENARIOS };

export interface Answers {
  settings: StudioSettings;
  /** The body a request is answered with, or undefined for the harness's 404 (GET) or 409 (write). */
  answer(method: string, url: URL): unknown;
  /** The scenario's arriving line has been sent: the session is read with it from now on. */
  arrive(): void;
}

export function answersFor(scenario: Scenario, theme: StudioTheme): Answers {
  const SETTINGS: StudioSettings = {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    route: "claude",
    effort: "medium",
    gatewayUrl: "",
    theme,
    askBeforeChanges: true,
    approvals: { shell: "ask", files: "ask", editorRestart: "allow", destructive: "allow" },
    reviewTurns: true,
    composerHeight: null,
    dialogPolicy: { kind: "wait" },
    usage: { ...DEFAULT_USAGE, imageSize: "standard" },
    connected: { claude: true },
    routeOrder: "signins-first",
    endpoints: Array.isArray(scenario.endpoints) ? scenario.endpoints.length : 0,
    account: null,
    ...scenario.settings,
    ...(scenario.settings?.usage ? { usage: { ...DEFAULT_USAGE, ...scenario.settings.usage } } : {}),
  } as unknown as StudioSettings;

  const HEALTH = {
    ok: true, pid: 1, version: "1.4.11-beta.4", apiVersion: 1, projectRoot: "c:/projects/studioe2e", startedAt: new Date().toISOString(),
    editors: [{ name: "StudioE2E", connected: true, port: 1, pid: 1, lastDisconnect: null }],
    clients: 1, inflight: 0, lastEventId: 0, extensions: [{ name: "studio", version: "dev" }], ui: "dev", features: ["checkpoints"],
  };

  /** Settings > Agents: the project's own files as a Claude-only project reads them. */
  const NATIVE: NativeOverview = {
    enabled: true,
    main: "claude",
    worker: { model: null, effort: null, starts: "asked" },
    conventions: [
      { convention: "claude", routes: ["Claude sign-in"], instructionTokens: 420, notes: [], skipped: [], subagents: [], skills: [], instructions: [{ path: "CLAUDE.md", source: "project", tokens: 420, scope: { kind: "always" } }] },
      { convention: "codex", routes: [], instructionTokens: 0, notes: [], skipped: [], instructions: [], subagents: [], skills: [] },
      { convention: "gemini", routes: [], instructionTokens: 0, notes: [], skipped: [], instructions: [], subagents: [], skills: [] },
      { convention: "agents", routes: [], instructionTokens: 0, notes: [], skipped: [], instructions: [], subagents: [], skills: [] },
    ],
  };

  const PREVIEW = "# StudioE2E\n\nUse ue-mcp for every editor change.";

  let arrived = false;

  const answer = (method: string, url: URL): unknown => {
    const p = url.pathname;
    if (method !== "GET") return undefined;
    const s = scenario.session && arrived && scenario.arrives ? { ...scenario.session, transcript: [...scenario.session.transcript, scenario.arrives] } : scenario.session;
    if (scenario.missing?.includes(p)) return undefined;
    const own = scenario.get?.(p, url);
    if (own !== undefined) return own;
    const routes: Array<[RegExp, () => unknown]> = [
      [/^\/v1\/health$/, () => HEALTH],
      [/^\/v1\/ext\/studio\/settings$/, () => SETTINGS],
      [/^\/v1\/ext\/studio\/sessions$/, () => ({ sessions: s ? [s] : [] })],
      [/^\/v1\/ext\/studio\/sessions\/[^/]+$/, () => s],
      [/^\/v1\/ext\/studio\/qa\/playtests$/, () => scenario.index],
      [/^\/v1\/ext\/studio\/qa\/playtests\/script$/, () => {
        const e = scenario.index.playtests.find((x) => x.script === url.searchParams.get("script"));
        const r = e?.draft ?? e?.card ?? e?.last;
        return r ? { run: r } : undefined;
      }],
      [/^\/v1\/ext\/studio\/qa\/runs$/, () => ({ runs: [] })],
      [/^\/v1\/ext\/studio\/forms$/, () => ({ forms: [] })],
      [/^\/v1\/ext\/studio\/dialogs$/, () => ({ dialogs: [], now: Date.now() })],
      [/^\/v1\/ext\/studio\/busy$/, () => ({ now: Date.now(), calls: [] })],
      [/^\/v1\/ext\/studio\/vcs$/, () => ({ vcs: null })],
      [/^\/v1\/ext\/studio\/review\/status$/, () => ({ available: true, reason: null })],
      [/^\/v1\/ext\/studio\/models$/, () => ({
        signedIn: { claude: !!SETTINGS.connected.claude, chatgpt: !!SETTINGS.connected.chatgpt, studio: false },
        routeOrder: "signins-first",
        providers: [
          { id: "anthropic", name: "Anthropic", connected: false, source: "default", models: [{ id: "claude-sonnet-5-5", name: "Sonnet 5.5", signIns: ["claude"] }, ...(scenario.settings?.model === "claude-haiku-4-5" ? [{ id: "claude-haiku-4-5", name: "Haiku 4.5", signIns: ["claude"] }] : [])] },
          ...(Array.isArray(scenario.endpoints) ? scenario.endpoints : []).map((e) => ({ id: `endpoint:${e.id}`, name: e.name, connected: true, source: "live", endpoint: { id: e.id, ...(e.listError ? { listError: e.listError } : {}) }, models: e.models.map((m) => ({ id: m.id, name: m.id, signIns: [] })) })),
        ],
      })],
      [/^\/v1\/ext\/studio\/endpoints$/, () => (scenario.endpoints === "error" ? undefined : { endpoints: scenario.endpoints ?? [] })],
      [/^\/v1\/flows$/, () => ({ flows: [] })],
      [/^\/v1\/ext\/studio\/actions$/, () => ({ actions: [] })],
      [/^\/v1\/ext\/studio\/native$/, () => NATIVE],
      [/^\/v1\/ext\/studio\/native\/preview$/, () => ({ convention: url.searchParams.get("convention") ?? "claude", text: PREVIEW, tokens: 420, files: 1, loadedBy: "sdk", parts: [{ path: "CLAUDE.md", text: PREVIEW }] })],
      [/^\/v1\/ext\/studio\/agent-settings$/, () => ({ feedbackTool: true, feedbackMode: { mode: "interactive", project: true }, dialogMode: { mode: "interactive", project: true }, playtestRuns: "manual" })],
      [/^\/v1\/install$/, () => INSTALL],
      [/^\/v1\/ext\/studio\/context-strategy$/, () => CONTEXT],
      [/^\/v1\/ext\/studio\/config$/, () => ({ path: "C:/Projects/StudioE2E/ue-mcp.yml", exists: true, text: "context:\n  strategy: micro\n" })],
      [/^\/v1\/ext\/studio\/updates$/, () => ({ channel: "stable", studio: { installed: "0.1.24-beta.9", latest: "0.1.24-beta.9", available: false }, plugin: { installed: "0.1.4", latest: "0.1.4", available: false, location: "project", engine: "5.7" } })],
      [/^\/v1\/update$/, () => ({ installed: { version: "1.4.11-beta.4" }, server: "1.4.11-beta.4", latest: "1.4.11-beta.4", target: null, binaries: null })],
    ];
    for (const [re, f] of routes) if (re.test(p)) return f();
    return undefined;
  }
  return { settings: SETTINGS, answer, arrive: () => void (arrived = true) };
}
