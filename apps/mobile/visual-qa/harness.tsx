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
            await new Promise((r) => setTimeout(r, 850));
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
    if (m !== "GET") {
      const written = scenario.post?.(url.pathname, options.json);
      return written ? json(written.status, written.body) : json(409, { error: `visual QA harness: ${m} ${url.pathname} is not answered` });
    }
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
