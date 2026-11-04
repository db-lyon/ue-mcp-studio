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
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { SCENARIOS, answersFor } from "./answers";
// The computer's own rule for what a paired browser may reach, so ?remote=1 shoots any scenario as one sees it.
import { remoteBodyAllowed, remotePath } from "../../../../packages/remote/src/index.js";

const params = new URLSearchParams(location.search);
const scenario = SCENARIOS[params.get("scenario") ?? ""] ?? SCENARIOS["session-empty"];
const theme = (params.get("theme") ?? "ue-mcp") as StudioTheme;
/** ?remote=1: every scenario as a paired browser sees it, the computer refusing what it refuses one. */
const remote = params.get("remote") === "1";

const { answer, arrive } = answersFor(scenario, theme);

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.startsWith("/v1/")) return realFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  if (remote) {
    const path = remotePath(method, `${url.pathname}${url.search}`);
    const body = typeof init?.body === "string" ? new TextEncoder().encode(init.body) : undefined;
    if (!path || !remoteBodyAllowed(method, url.pathname, body)) return new Response(JSON.stringify({ error: "Not available remotely." }), { status: 403, headers: { "content-type": "application/json" } });
  }
  // ue-mcp away: the stream and health refuse, as the relay does while the computer's daemon is down.
  if (scenario.remoteOffline && (url.pathname === "/v1/events" || url.pathname === "/v1/health")) {
    return new Response(JSON.stringify({ error: "The project is offline." }), { status: 503, headers: { "content-type": "application/json" } });
  }
  // The event stream stays open and quiet: the page is streaming, and nothing changes under it.
  if (url.pathname === "/v1/events") {
    const eventsSent = sentEvents;
    sentEvents = true;
    return new Response(new ReadableStream({
      start(controller) {
        // Events the scenario sends as soon as the stream opens, for the Diagnostics log; once, though a dev
        // double mount opens the stream twice.
        if (!eventsSent) (scenario.events ?? []).forEach((e, n) => {
          controller.enqueue(new TextEncoder().encode(`id: ${n + 1}
event: ${e.type}
data: ${JSON.stringify({ ...e.data, at: e.at })}

`));
        });
        if (!scenario.arrives || !scenario.session) return;
        // The reader scrolls up, then a line arrives below them.
        setTimeout(() => {
          document.querySelector(".thread-stage .transcript")?.scrollTo({ top: 0 });
          setTimeout(() => {
            arrive();
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
// A paired browser's page, though the harness is served from this computer.
let sentEvents = false;
if (remote || scenario.remoteOffline || scenario.remotePage) (window as unknown as { __studioRemotePage?: boolean }).__studioRemotePage = true;
if (scenario.wake) {
  // Away, then back: the page reconnects under its quiet line.
  const show = (state: "hidden" | "visible"): void => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  setTimeout(() => show("hidden"), 1500);
  setTimeout(() => show("visible"), 2500);
}
// A checkout or docs link opens nothing: a popup would take the page out of the foreground and stall the shot.
window.open = () => null;
// The runner reads the scenarios and what each shows from here, and what to click once the page settles.
(window as unknown as { __visualQa: unknown }).__visualQa = {
  scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([name, s]) => [name, s.title])),
  click: scenario.click ?? null,
  clicks: scenario.clicks ?? [],
  narrowClicks: scenario.narrowClicks ?? null,
  scroll: scenario.scroll ?? null,
  heights: Object.fromEntries(Object.entries(SCENARIOS).flatMap(([name, s]) => (s.height ? [[name, s.height]] : []))),
  focus: scenario.focus ?? null,
  type: scenario.type ?? null,
  afterType: scenario.afterType ?? null,
  fullPage: scenario.fullPage ?? false,
  waitFor: scenario.waitFor ?? null,
};

void import("../App").then(({ App }) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
