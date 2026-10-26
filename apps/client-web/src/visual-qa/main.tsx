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
import type { NativeOverview, StudioSettings, StudioTheme } from "@ue-mcp-studio/shared";
import { SCENARIOS } from "./fixtures";

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
  reviewTurns: true,
  composerHeight: null,
  dialogPolicy: "ask",
  usage: { turnTokens: null, sessionTokens: null, warnAt: null, imageSize: "standard" },
  connected: { claude: true },
  routeOrder: "signins-first",
  endpoints: Array.isArray(scenario.endpoints) ? scenario.endpoints.length : 0,
  account: null,
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
  worker: { model: null, effort: null, starts: "asked", fromSettings: false },
  conventions: [
    { convention: "claude", routes: ["Claude sign-in"], instructionTokens: 420, notes: [], skipped: [], subagents: [], skills: [], instructions: [{ path: "CLAUDE.md", source: "project", tokens: 420, scope: { kind: "always" } }] },
    { convention: "codex", routes: [], instructionTokens: 0, notes: [], skipped: [], instructions: [], subagents: [], skills: [] },
    { convention: "gemini", routes: [], instructionTokens: 0, notes: [], skipped: [], instructions: [], subagents: [], skills: [] },
    { convention: "agents", routes: [], instructionTokens: 0, notes: [], skipped: [], instructions: [], subagents: [], skills: [] },
  ],
};

/** What each GET answers; anything else is a 404, and every write a 409. */
function answer(method: string, url: URL): unknown {
  const p = url.pathname;
  if (method !== "GET") return undefined;
  const s = scenario.session;
  const routes: Array<[RegExp, () => unknown]> = [
    [/^\/v1\/health$/, () => HEALTH],
    [/^\/v1\/ext\/studio\/settings$/, () => SETTINGS],
    [/^\/v1\/ext\/studio\/sessions$/, () => ({ sessions: s ? [s] : [] })],
    [/^\/v1\/ext\/studio\/sessions\/[^/]+$/, () => s],
    [/^\/v1\/ext\/studio\/qa\/playtests$/, () => scenario.index],
    [/^\/v1\/ext\/studio\/qa\/runs$/, () => ({ runs: [] })],
    [/^\/v1\/ext\/studio\/forms$/, () => ({ forms: [] })],
    [/^\/v1\/ext\/studio\/dialogs$/, () => ({ dialogs: [], now: Date.now(), supported: true })],
    [/^\/v1\/ext\/studio\/busy$/, () => ({ now: Date.now(), calls: [] })],
    [/^\/v1\/ext\/studio\/vcs$/, () => ({ vcs: null })],
    [/^\/v1\/ext\/studio\/review\/status$/, () => ({ available: true, reason: null })],
    [/^\/v1\/ext\/studio\/models$/, () => ({
      signedIn: { claude: true, chatgpt: false, studio: false },
      routeOrder: "signins-first",
      providers: [
        { id: "anthropic", name: "Anthropic", connected: false, source: "default", models: [{ id: "claude-sonnet-5-5", name: "Sonnet 5.5", signIns: ["claude"] }] },
        ...(Array.isArray(scenario.endpoints) ? scenario.endpoints : []).map((e) => ({ id: `endpoint:${e.id}`, name: e.name, connected: true, source: "live", endpoint: { id: e.id }, models: e.models.map((m) => ({ id: m.id, name: m.id, signIns: [] })) })),
      ],
    })],
    [/^\/v1\/ext\/studio\/endpoints$/, () => (Array.isArray(scenario.endpoints) ? { endpoints: scenario.endpoints } : undefined)],
    [/^\/v1\/flows$/, () => ({ flows: [] })],
    [/^\/v1\/ext\/studio\/context-strategy\/agent$/, () => scenario.agentContext],
    [/^\/v1\/ext\/studio\/native$/, () => NATIVE],
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
  if (url.pathname === "/v1/events") return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } });
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
  focus: scenario.focus ?? null,
  fullPage: scenario.fullPage ?? false,
};

void import("../App").then(({ App }) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
