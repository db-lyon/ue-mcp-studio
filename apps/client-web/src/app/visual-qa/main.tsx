/**
 * The UE-MCP app's visual QA page: the real app with window.ue.app answered
 * from a scenario in fixtures.ts. Opened as
 * app-visual-qa.html?scenario=<name>&scheme=<light|dark> by
 * `node scripts/visual-qa.mjs --app`.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "../../styles.css";
import "../app.css";
import { App } from "../App";
import { appSlot, type AppHost, type Live } from "../native";
import { followScheme } from "../scheme";
import { APP_SCENARIOS, BASE_STATE } from "./fixtures";

const params = new URLSearchParams(location.search);
const name = params.get("scenario") ?? "app-projects-states";
const s = APP_SCENARIOS[name] ?? APP_SCENARIOS["app-projects-states"];
const state = { ...BASE_STATE, ...s.state, node: { ...BASE_STATE.node, ...s.state?.node } };
const never = <T,>() => new Promise<T>(() => {});
const parsed = s.report?.ok && s.report.report ? (JSON.parse(s.report.report) as { daemons: Array<{ key: string; pid: number; port: number; version: string }> }) : null;
const live: Record<string, Live> = {};
for (const k of s.live ?? []) {
  const d = parsed?.daemons.find((x) => x.key === k);
  live[k] = { pid: d?.pid ?? 1, port: d?.port ?? 1, version: d?.version ?? "1.4.13" };
}
const started = { ok: true, job: 1 };

const fake: AppHost = {
  getstate: async () => state,
  refreshnode: async () => state,
  report: () => (s.report ? Promise.resolve(s.report) : never()),
  cachedreport: async () => null,
  job: async () => s.job ?? { running: true, ok: false, lines: [] },
  daemon: async ({ key, path }) => s.daemon?.[`${key} ${path.split("?")[0]}`] ?? { error: "ue-mcp is not running for this project" },
  live: async () => live,
  install: async () => started,
  startdaemon: async () => started,
  stopdaemon: async () => started,
  updatebridge: async () => started,
  installnode: async () => started,
  openstudio: async () => ({ ok: true }),
  launcheditor: async () => ({ ok: true }),
  addproject: async () => ({ ok: false, cancelled: true }),
  removeproject: async () => ({ ok: true }),
  readlog: async () => s.log ?? "",
  openlog: async () => true,
  openfolder: async () => true,
  openurl: async () => true,
  appupdate: async () => s.appUpdate ?? { ok: true, version: state.version, newer: false },
  setup: () => (s.setup === "hold" ? never() : Promise.resolve(s.setup === "fail" ? { ok: false, error: "UE-MCP could not be copied to C:\\Users\\dana\\AppData\\Local\\Programs\\UE-MCP (error 5)." } : { ok: true })),
  launch: async () => true,
  close: async () => true,
};
appSlot().ue = { app: fake as unknown as Record<string, (arg?: unknown) => Promise<unknown>> };
(window as unknown as { __appQa: unknown }).__appQa = {
  scenarios: Object.fromEntries(Object.entries(APP_SCENARIOS).map(([k, v]) => [k, v.title])),
  clicks: s.clicks ?? [],
  setup: state.mode === "setup",
};

followScheme(params.get("scheme") === "light" ? "light" : "dark");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App initial={s.screen ?? "projects"} />
  </StrictMode>,
);
