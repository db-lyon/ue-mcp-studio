/**
 * Parity harness: the app's Settings, Plugins, Diagnostics, Feedback and update
 * screens rendered with react-native-web from client-web's own visual QA
 * scenarios (apps/client-web/src/visual-qa/answers.ts), as a paired client
 * reaches them: every request goes through the computer's remotePath and
 * remoteBodyAllowed rules first. scripts/visual-qa-parity.mjs shoots each
 * scenario here and compares it pixel by pixel with client-web's shot of it.
 *
 * Above the screen sits a stand-in for the web page's 50 pixel top bar, which
 * the app's shell draws, so the content starts where the web page's does; the
 * comparison leaves that band out.
 */
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-700.css";
import { createRoot } from "react-dom/client";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { createLock, type StreamEvent, type Transport } from "@ue-mcp-studio/client-core";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { remoteBodyAllowed, remotePath } from "@ue-mcp-studio/remote";
import { SCENARIOS, answersFor } from "../../client-web/src/visual-qa/answers";
import type { Project } from "../src/connection";
import { ProjectContext, type ProjectNav } from "../src/nav";
import { StudioThemeProvider, tokensOf } from "../src/ui/studio-theme";
import { PARITY } from "./parity-scenes";

const params = new URLSearchParams(location.search);
const name = params.get("scenario") ?? "";
const scenario = SCENARIOS[name];
const theme = (params.get("theme") ?? "ue-mcp") as StudioTheme;
const scene = PARITY[name];
const { answer } = answersFor(scenario, theme);

const json = (status: number, body: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return { status, headers: { "content-type": "application/json" }, body: (async function* () { yield bytes; })() };
};

/** The computer's answer to a paired client: refused routes 403, everything else from the scenario. */
const transport: Transport = async (method, path, options) => {
  const url = new URL(path, "http://daemon.invalid");
  const body = options?.json !== undefined ? new TextEncoder().encode(JSON.stringify(options.json)) : undefined;
  if (!remotePath(method, path) || !remoteBodyAllowed(method, url.pathname, body)) return json(403, { error: "Not available remotely." });
  const sent = options?.json;
  const written = method === "GET" ? undefined : scenario.post?.(url.pathname, sent);
  if (written) return json(written.status, written.body);
  const answered = answer(method, url);
  if (answered === undefined) return json(method === "GET" ? 404 : 409, { error: `visual QA harness: ${method} ${url.pathname} is not answered` });
  return json(200, answered);
};

const listeners = new Set<(e: StreamEvent) => void>();
const project: Project = {
  device: { id: "dev1", name: "StudioE2E", online: true, computerKey: "k", lastSeen: new Date().toISOString() },
  transport,
  lock: createLock(transport),
  live: "live",
  dropCause: null,
  onEvent: (l) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};
/** The scenario's events, sent once a screen listens, as the web harness sends them when its stream opens. */
const events: StreamEvent[] = (scenario?.events ?? []).map((e, n) => ({ id: n + 1, type: e.type, at: e.at, data: e.data }));
export const pastEvents = (): StreamEvent[] => events;

function Root() {
  const [current, setCurrent] = useState<StudioTheme>(theme);
  const onTheme = useCallback((t: StudioTheme) => setCurrent(t), []);
  const nav = useMemo<ProjectNav>(() => ({ project, api: null as never, push: () => undefined, pop: () => undefined }), []);
  const t = tokensOf(current);
  return (
    <StudioThemeProvider theme={current} onTheme={onTheme}>
      <ProjectContext.Provider value={nav}>
        <View style={{ flex: 1, backgroundColor: "transparent" }}>
          <View style={{ height: 50, backgroundColor: t.barBg, borderBottomWidth: 1, borderBottomColor: t.line }} />
          <View style={{ flex: 1, minHeight: 0 }}>{scene ? scene.render() : null}</View>
        </View>
      </ProjectContext.Provider>
    </StudioThemeProvider>
  );
}

document.documentElement.dataset.theme = theme;
(window as unknown as { __parity: unknown }).__parity = {
  scenes: Object.fromEntries(Object.entries(PARITY).map(([k, v]) => [k, { clicks: v.clicks ?? [], scroll: v.scroll ?? null, type: v.type ?? null }])),
  events: events.length,
};
createRoot(document.getElementById("root")!).render(<Root />);
