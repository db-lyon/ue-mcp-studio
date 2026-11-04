/**
 * A project for a parity scene: the web client's visual QA scenario (its
 * fixtures, as apps/client-web/src/visual-qa answers them) behind a Transport,
 * so the app's screens read the same daemon the web shot read.
 */
import type { ReactNode } from "react";
import { View } from "react-native";
import { createLock, studioApi, type StreamEvent, type Transport } from "@ue-mcp-studio/client-core";
import { SCENARIOS, type Scenario } from "../../../client-web/src/visual-qa/fixtures";
import type { Project } from "../../src/connection";
import { ProjectContext, type ProjectNav } from "../../src/nav";

export const HEALTH = {
  ok: true, pid: 1, version: "1.4.11-beta.4", apiVersion: 1, projectRoot: "c:/projects/studioe2e", startedAt: new Date().toISOString(),
  editors: [{ name: "StudioE2E", connected: true, port: 1, pid: 1, lastDisconnect: null }],
  clients: 1, inflight: 0, lastEventId: 0, extensions: [{ name: "studio", version: "dev" }], ui: "dev", features: ["checkpoints"],
};

export function scenario(name: string): Scenario {
  const s = SCENARIOS[name];
  if (!s) throw new Error(`no web scenario ${name}`);
  return s;
}

/** What the web harness answers a GET with, for the routes the app's screens read. */
function answer(s: Scenario, url: URL, extra?: (p: string, url: URL) => unknown): unknown {
  const p = url.pathname;
  const mine = extra?.(p, url);
  if (mine !== undefined) return mine;
  if (s.missing?.includes(p)) return undefined;
  const own = s.get?.(p, url);
  if (own !== undefined) return own;
  const routes: Array<[RegExp, () => unknown]> = [
    [/^\/v1\/health$/, () => HEALTH],
    [/^\/v1\/ext\/studio\/sessions$/, () => ({ sessions: s.session ? [s.session] : [] })],
    [/^\/v1\/ext\/studio\/sessions\/[^/]+$/, () => s.session],
    [/^\/v1\/ext\/studio\/qa\/playtests$/, () => s.index],
    [/^\/v1\/ext\/studio\/qa\/playtests\/script$/, () => {
      const e = s.index.playtests.find((x) => x.script === url.searchParams.get("script"));
      const r = e?.draft ?? e?.card ?? e?.last;
      return r ? { run: r } : undefined;
    }],
    [/^\/v1\/ext\/studio\/qa\/runs$/, () => ({ runs: [] })],
    [/^\/v1\/ext\/studio\/forms$/, () => ({ forms: [] })],
    [/^\/v1\/ext\/studio\/dialogs$/, () => ({ dialogs: [], now: Date.now() })],
    [/^\/v1\/ext\/studio\/busy$/, () => ({ now: Date.now(), calls: [] })],
    [/^\/v1\/ext\/studio\/vcs$/, () => ({ vcs: null })],
    [/^\/v1\/flows$/, () => ({ flows: [] })],
  ];
  for (const [re, f] of routes) if (re.test(p)) return f();
  return undefined;
}

const reply = (status: number, body: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: (async function* () {
    yield new TextEncoder().encode(JSON.stringify(body));
  })(),
});

/**
 * The scenario as a transport. Pictures (captures, thumbnails) are fetched
 * from the page's server, which draws them as the web harness does; writes
 * are refused as the web harness refuses them.
 */
export function scenarioTransport(s: Scenario, extra?: (p: string, url: URL) => unknown): Transport {
  return async (method, path, options) => {
    const url = new URL(path, location.href);
    if (/\/captures\/\d+$|\/review\/(thumbnails|images)\//.test(url.pathname)) {
      const r = await fetch(url.href);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "" }, body: (async function* () { yield bytes; })() };
    }
    if (method !== "GET") {
      const written = s.post?.(url.pathname, options?.json);
      return written ? reply(written.status, written.body) : reply(409, { error: `visual QA harness: ${method} ${url.pathname} is not answered` });
    }
    const body = answer(s, url, extra);
    return body === undefined ? reply(404, { error: `visual QA harness: GET ${url.pathname} is not answered` }) : reply(200, body);
  };
}

export function scenarioProject(s: Scenario, extra?: (p: string, url: URL) => unknown): Project {
  const transport = scenarioTransport(s, extra);
  return {
    device: { id: "dev1", name: "StudioE2E", online: true, computerKey: "keyA", lastSeen: new Date().toISOString() },
    transport,
    lock: createLock(transport),
    live: "live",
    dropCause: null,
    onEvent: (_l: (e: StreamEvent) => void) => () => undefined,
  };
}

/** A screen in a scenario's project, on the web client's page, 390 points wide. */
export function InScenario({ name, extra, children }: { name: string; extra?: (p: string, url: URL) => unknown; children: ReactNode }) {
  const project = scenarioProject(scenario(name), extra);
  const nav: ProjectNav = { project, api: studioApi(project.transport), push: () => undefined, pop: () => undefined };
  return (
    <ProjectContext.Provider value={nav}>
      <View style={{ flex: 1, minHeight: "100%" as unknown as number }}>{children}</View>
    </ProjectContext.Provider>
  );
}
