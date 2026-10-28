/**
 * The visual QA harness: the real app, with the daemon answered from a
 * scenario in fixtures.ts instead of a live daemon or editor. Opened as
 * /ui/visual-qa.html?scenario=<name>&theme=<theme> by scripts/visual-qa.mjs,
 * which screenshots every scenario in every theme at a wide and a narrow width.
 * Writes are answered with an error, so nothing a click does goes anywhere.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-700.css";
import "../styles.css";
import "../settings.css";
import { DEFAULT_USAGE, type NativeOverview, type StudioSettings, type StudioTheme } from "@ue-mcp-studio/shared";
import { SCENARIOS as PLAYTESTS } from "./fixtures";
import { CONTEXT, INSTALL, SETTINGS_SCENARIOS } from "./settings-fixtures";
import { REVIEW_SCENARIOS } from "./review-fixtures";
import { REFUSED_SCENARIOS } from "./refused-fixtures";

const SCENARIOS = { ...PLAYTESTS, ...SETTINGS_SCENARIOS, ...REVIEW_SCENARIOS, ...REFUSED_SCENARIOS };

const params = new URLSearchParams(location.search);
const scenario = SCENARIOS[params.get("scenario") ?? ""] ?? SCENARIOS["session-empty"];
const theme = (params.get("theme") ?? "ue-mcp") as StudioTheme;

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

/** What each GET answers; anything else is a 404, and every write a 409. */
/** Set once a scenario's arriving line has been sent: the session is then read with it. */
let arrived = false;

function answer(method: string, url: URL): unknown {
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
        { id: "anthropic", name: "Anthropic", connected: false, source: "default", models: [{ id: "claude-sonnet-5-5", name: "Sonnet 5.5", signIns: ["claude"] }] },
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

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.startsWith("/v1/")) return realFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  // The event stream stays open and quiet: the page is streaming, and nothing changes under it.
  if (url.pathname === "/v1/events") {
    return new Response(new ReadableStream({
      start(controller) {
        if (!scenario.arrives || !scenario.session) return;
        // The reader scrolls up, then a line arrives below them.
        setTimeout(() => {
          document.querySelector(".thread-stage .transcript")?.scrollTo({ top: 0 });
          setTimeout(() => {
            arrived = true;
            const data = JSON.stringify({ sessionId: scenario.session!.id, at: new Date().toISOString() });
            controller.enqueue(new TextEncoder().encode(`id: 1
event: studio.transcript.added
data: ${data}

`));
          }, 150);
        }, 700);
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  let sent: unknown;
  try {
    sent = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  } catch {
    sent = undefined;
  }
  const written = method === "GET" ? undefined : scenario.post?.(url.pathname, sent);
  if (written) return new Response(JSON.stringify(written.body), { status: written.status, headers: { "content-type": "application/json" } });
  const body = answer(method, url);
  if (body === undefined) {
    // The endpoints scenario that fails says what a broken agent would.
    if (url.pathname === "/v1/ext/studio/endpoints" && scenario.endpoints === "error") return new Response(JSON.stringify({ error: "could not read ~/.ue-mcp/studio/endpoints.json: permission denied" }), { status: 500, headers: { "content-type": "application/json" } });
    const status = method === "GET" ? 404 : 409;
    return new Response(JSON.stringify({ error: `visual QA harness: ${method} ${url.pathname} is not answered` }), { status, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

try {
  if (scenario.filter) window.localStorage.setItem("studio.playtests.filter", scenario.filter);
  else window.localStorage.removeItem("studio.playtests.filter");
} catch {
  // Storage blocked: the page picks its own filter.
}
history.replaceState(null, "", `${location.pathname}${location.search}${scenario.hash}`);
// The runner reads the scenarios and what each shows from here, and what to click once the page settles.
(window as unknown as { __visualQa: unknown }).__visualQa = {
  scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([name, s]) => [name, s.title])),
  click: scenario.click ?? null,
  clicks: scenario.clicks ?? [],
  scroll: scenario.scroll ?? null,
  heights: Object.fromEntries(Object.entries(SCENARIOS).flatMap(([name, s]) => (s.height ? [[name, s.height]] : []))),
  focus: scenario.focus ?? null,
  type: scenario.type ?? null,
  fullPage: scenario.fullPage ?? false,
};

void import("../App").then(({ App }) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
