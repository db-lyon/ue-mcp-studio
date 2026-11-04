/**
 * The mobile app inside the visual QA page: a paired project whose daemon is a
 * scenario of the web client's fixtures (apps/client-web/src/visual-qa), so the
 * app and the web client draw the same state and scripts/parity-mobile.mjs can
 * compare them pixel by pixel. Writes are answered as the web harness answers
 * them: the scenario's own, else 409.
 */
import { useMemo } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { parseLocation, type Reply, type Transport } from "@ue-mcp-studio/client-core";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { remoteBodyAllowed, remotePath } from "@ue-mcp-studio/remote";
import { daemonFor, SCENARIOS } from "../../client-web/src/visual-qa/daemon";
import type { Scenario } from "../../client-web/src/visual-qa/fixtures";
import { ProjectScreen } from "../src/screens/Project";
import { THEMES, ThemeProvider, useStudioFonts } from "../src/ui";

export { SCENARIOS };

const enc = new TextEncoder();

function json(status: number, body: unknown): Reply {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: (async function* () {
      yield enc.encode(JSON.stringify(body));
    })(),
  };
}

/** The scenario's daemon as a Transport: its GETs, its writes, and an event stream that stays open. */
export function scenarioTransport(scenario: Scenario, theme: StudioTheme): Transport {
  let arrived = false;
  let streamed = false;
  const daemon = daemonFor(scenario, theme, () => arrived);
  return async (method, path, options = {}) => {
    const url = new URL(path, "http://daemon.invalid");
    const m = method.toUpperCase();
    // The phone is a paired client: the computer refuses it what it refuses a paired browser.
    const sent = options.json !== undefined ? enc.encode(JSON.stringify(options.json)) : undefined;
    if (!remotePath(m, path) || !remoteBodyAllowed(m, url.pathname, sent)) return json(403, { error: "Not available remotely." });
    // Pictures (a playtest capture, a review image or thumbnail) come from the page's server, which draws them as the web harness does.
    if (/\/captures\/\d+$|\/review\/(thumbnails|images)\//.test(url.pathname)) {
      const r = await fetch(url.pathname);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "" }, body: (async function* () { yield bytes; })() };
    }
    if (scenario.remoteOffline && (url.pathname === "/v1/events" || url.pathname === "/v1/health")) return json(503, { error: "The project is offline." });
    if (url.pathname === "/v1/events") {
      const first = !streamed;
      streamed = true;
      const signal = options.signal;
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: (async function* () {
          if (first) for (const [n, e] of (scenario.events ?? []).entries()) yield enc.encode(`id: ${n + 1}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e.data, at: e.at })}\n\n`);
          if (first && scenario.arrives && scenario.session) {
            // The reader scrolls up, then a line arrives below them, as the web harness does it.
            // Once the conversation is drawn: the app may take longer to start than the web page.
            for (let i = 0; i < 50 && !document.getElementById("transcript")?.scrollHeight; i++) await new Promise((r) => setTimeout(r, 100));
            await new Promise((r) => setTimeout(r, 700));
            const list = document.getElementById("transcript");
            if (list) list.scrollTop = 0;
            await new Promise((r) => setTimeout(r, 150));
            arrived = true;
            yield enc.encode(`id: 1\nevent: studio.transcript.added\ndata: ${JSON.stringify({ sessionId: scenario.session.id, at: new Date().toISOString() })}\n\n`);
          }
          // Open and quiet until the app lets go of it.
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
      };
    }
    // Pictures as scripts/visual-qa.mjs draws them: a shaded sphere whose hue comes from the path; "unreadable" is lost.
    if (m === "GET" && /^\/v1\/ext\/studio\/review\/(?:thumbnails|images)\/[^/?]+/.test(url.pathname)) {
      if (/unreadable/.test(path)) return json(404, { error: "lost" });
      const hue = [...path].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><radialGradient id="g" cx="0.38" cy="0.34" r="0.7"><stop offset="0" stop-color="hsl(${hue},55%,78%)"/><stop offset="0.55" stop-color="hsl(${hue},45%,42%)"/><stop offset="1" stop-color="hsl(${hue},40%,14%)"/></radialGradient></defs><rect width="256" height="256" fill="#1d1f24"/><ellipse cx="128" cy="214" rx="78" ry="12" fill="#000" opacity="0.45"/><circle cx="128" cy="124" r="86" fill="url(#g)"/></svg>`;
      return { status: 200, headers: { "content-type": "image/svg+xml" }, body: (async function* () { yield enc.encode(svg); })() };
    }
    if (m !== "GET") {
      const written = scenario.post?.(url.pathname, options.json);
      return written ? json(written.status, written.body) : json(409, { error: `visual QA harness: ${m} ${url.pathname} is not answered` });
    }
    // The endpoints scenario that fails says what a broken agent would, as the web harness answers it.
    if (url.pathname === "/v1/ext/studio/endpoints" && scenario.endpoints === "error") return json(500, { error: "could not read ~/.ue-mcp/studio/endpoints.json: permission denied" });
    const body = daemon.answer(m, url);
    return body === undefined ? json(404, { error: `visual QA harness: GET ${url.pathname} is not answered` }) : json(200, body);
  };
}

export function Harness({ name, theme }: { name: string; theme: StudioTheme }) {
  const scenario = SCENARIOS[name] ?? SCENARIOS["session-empty"];
  const transport = useMemo(() => scenarioTransport(scenario, theme), [scenario, theme]);
  const location = parseLocation(scenario.hash ?? "");
  const fonts = useStudioFonts();
  return (
    <ThemeProvider name={theme}>
      <SafeAreaProvider style={{ flex: 1, backgroundColor: THEMES[theme].c.bg }}>
        <View style={{ flex: 1 }}>{fonts ? <ProjectScreen device={{ id: "visual-qa", name: "StudioE2E", online: true, computerKey: "k", lastSeen: new Date().toISOString() }} transport={transport} initial={location} onBack={() => undefined} onUnpaired={() => undefined} /> : null}</View>
      </SafeAreaProvider>
    </ThemeProvider>
  );
}
