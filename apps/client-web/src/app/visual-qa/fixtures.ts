/**
 * The UE-MCP app's visual QA scenarios: the host's answers for each state,
 * drawn by app-visual-qa.html and shot by `node scripts/visual-qa.mjs --app`.
 * No ue-mcp, daemon or editor is involved.
 */
import type { Screen } from "../App";
import type { AppUpdate, DaemonAnswer, HostState, IdeInfo, JobState, Live, Newest, OpenIde, ReportAnswer } from "../native";
import type { MachineDaemon, MachineProject, MachineReport } from "../model";

export interface AppScenario {
  title: string;
  screen?: Screen;
  state?: Partial<HostState>;
  report?: ReportAnswer;
  /** Which project keys have a daemon running. */
  live?: string[];
  /** The job every started command reports, forever: running, or how it ended. */
  job?: JobState;
  /** A daemon route's answer by path. */
  daemon?: Record<string, DaemonAnswer>;
  appUpdate?: AppUpdate;
  /** The newest release of each part on the channel; the default has nothing newer than the fixtures. */
  newest?: Newest;
  log?: string;
  /** The IDEs found and the project's files; the default has Visual Studio and VS Code, and a solution beside each .uproject. */
  ides?: IdeInfo;
  /** What Open in IDE answers. */
  openide?: OpenIde;
  /** setup: hold, or end with this. */
  setup?: "hold" | "ok" | "fail";
  /** Pressed before the shot, by CSS selector, in order. */
  clicks?: string[];
}

const ROOT = "C:\\Users\\dana\\Documents\\Unreal Projects";
const DAEMONS = "C:\\Users\\dana\\.ue-mcp\\daemons";

const key = (n: number): string => n.toString(16).padStart(16, "a");

function project(n: number, name: string, o: Omit<Partial<MachineProject>, "engine"> & { studio?: string; plugin?: string; engine?: string } = {}): MachineProject {
  const { studio, plugin, engine, ...rest } = o;
  const dir = `${ROOT}\\${name}`;
  return {
    name,
    uproject: `${dir}\\${name}.uproject`,
    dir,
    key: key(n),
    source: "recent",
    lastOpened: "2026.11.07-10.00.00",
    engine: { association: engine ?? "5.7", version: engine ?? "5.7" },
    editor: { running: false, pids: [] },
    ueMcp: { setUp: true, bridge: { version: "1.4.13", kind: "binary" }, config: true },
    extensions: studio ? { studio } : {},
    plugins: [{ name: "UE_MCP_Bridge", version: "1.4.13" }, ...(studio || plugin ? [{ name: "UE_MCP_Studio", version: plugin ?? "0.1.8" }] : [])],
    daemon: { discovery: `${DAEMONS}\\${key(n)}.json`, log: `${DAEMONS}\\${key(n)}.log`, running: null },
    ...rest,
  };
}

const notSetUp = (n: number, name: string, engine = "5.8"): MachineProject =>
  project(n, name, { engine, ueMcp: { setUp: false, bridge: null, config: false }, plugins: [] });

function daemon(p: MachineProject, version = "1.4.13", minutes = 42): MachineDaemon {
  return {
    key: p.key,
    projectRoot: p.dir.replace(/\\/g, "/").toLowerCase(),
    uproject: p.uproject,
    pid: 18000 + parseInt(p.key.slice(-2), 16),
    port: 41000 + parseInt(p.key.slice(-2), 16),
    version,
    startedAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    discovery: p.daemon.discovery,
    log: p.daemon.log,
  };
}

function report(projects: MachineProject[], daemons: MachineDaemon[] = []): ReportAnswer {
  const r: MachineReport = { version: 1, ueMcp: "1.4.13", daemonDir: DAEMONS, projects, daemons };
  return { ok: true, report: JSON.stringify(r), ueMcp: "ue-mcp@1.4.13" };
}

const vale = project(1, "Vale", { studio: "0.1.35", engine: "5.8", editor: { running: true, pids: [21444] } });
const harbor = project(2, "HarborTown", { studio: "0.1.34" });
const arena = project(3, "ArenaPrototype", { engine: "5.8" });
const forest = notSetUp(4, "ForestWalk");
const bridgeOnly = project(5, "CityBlockout", { engine: "5.6", ueMcp: { setUp: true, bridge: { version: "1.4.11", kind: "source" }, config: true } });
const states = [vale, harbor, arena, forest];
const stateDaemons = [daemon(vale), daemon(harbor, "1.4.13", 7)];

const MANY_NAMES = ["Vale", "HarborTown", "ArenaPrototype", "ForestWalk", "CityBlockout", "SkyIslands", "DesertRun", "Lighthouse", "MechYard", "NightMarket", "OrbitalLab", "RiverDelta", "SnowPass", "TempleRuins"];
const many = MANY_NAMES.map((name, i) =>
  i === 0 ? vale : i === 1 ? harbor : i === 2 ? arena : i === 3 ? forest : i === 4 ? bridgeOnly : i % 3 === 0 ? notSetUp(10 + i, name, i % 2 ? "5.7" : "5.5") : project(10 + i, name, { studio: i % 2 ? "0.1.35" : undefined, engine: i % 4 ? "5.7" : "5.8" }),
);

/** The default IDEs: Visual Studio 2022 and VS Code, the project opening in Visual Studio. */
export const IDES: IdeInfo = {
  ok: true,
  ides: [
    { id: "vs:afb8a0c3", kind: "vs", name: "Visual Studio Community 2022" },
    { id: "vscode", kind: "vscode", name: "Visual Studio Code" },
  ],
  chosen: "vs:afb8a0c3",
  remembered: "",
  preferred: "",
  solution: null,
  workspace: null,
  source: true,
  generate: true,
};

/** The default: nothing newer than the fixtures have, on Stable. */
export const CURRENT: Newest = { channel: "stable", ueMcp: "1.4.13", studio: "0.1.35", plugin: "0.1.8", errors: {} };
/** Beta with ue-mcp 1.4.14 and Studio 0.1.36-beta.1: HarborTown's Studio and every bridge are behind. */
const NEWER: Newest = { channel: "beta", ueMcp: "1.4.14", studio: "0.1.36-beta.1", plugin: "0.1.8", errors: {} };
const twinA = project(6, "ue_mcp", { studio: "0.1.35", engine: "5.7", dir: "C:\\work\\ue-mcp\\tests\\ue_mcp", uproject: "C:\\work\\ue-mcp\\tests\\ue_mcp\\ue_mcp.uproject" });
const twinB = project(7, "ue_mcp", { engine: "5.7", dir: "C:\\work\\ue-mcp-release\\tests\\ue_mcp", uproject: "C:\\work\\ue-mcp-release\\tests\\ue_mcp\\ue_mcp.uproject" });
const LOG = [
  "2026-11-08T09:12:03.114Z [ue-mcp] info daemon: listening on 127.0.0.1:41001",
  "2026-11-08T09:12:03.520Z [ue-mcp] info extension: loaded studio 0.1.35",
  "2026-11-08T09:12:09.002Z [ue-mcp] info bridge: connected to Vale (UE 5.8)",
  "2026-11-08T09:40:51.877Z [ue-mcp] info session: claude-code connected",
].join("\n");

export const APP_SCENARIOS: Record<string, AppScenario> = {
  "app-projects-states": {
    title: "Projects: Studio installed with the editor open, Studio installed and running, Studio missing, and a project not set up for ue-mcp.",
    report: report(states, stateDaemons),
    live: [vale.key, harbor.key],
  },
  "app-projects-many": {
    title: "Projects: fourteen projects, with the filter that appears for a long list.",
    report: report(many, [daemon(vale), daemon(harbor)]),
    live: [vale.key, harbor.key],
  },
  "app-projects-empty": {
    title: "Projects: Unreal has opened no project on this computer yet.",
    report: report([]),
  },
  "app-projects-loading": {
    title: "Projects: the first read of the report, still running.",
    report: undefined,
  },
  "app-install-running": {
    title: "Projects: Add Studio running, with ue-mcp's output as it goes.",
    report: report(states, stateDaemons),
    live: [vale.key, harbor.key],
    job: { running: true, ok: false, lines: ["set up ue-mcp in ArenaPrototype", "installed Studio 0.1.35", "Downloading the Studio editor plugin for UE 5.8"] },
    clicks: [".app-row:nth-child(3) .app-row-actions button.primary"],
  },
  "app-install-failed": {
    title: "Projects: Add Studio failed, with what ue-mcp said and a way to try again.",
    report: report(states, stateDaemons),
    live: [vale.key, harbor.key],
    job: { running: false, ok: false, lines: ["set up ue-mcp in ArenaPrototype", "no editor plugin build for UE 5.8 (builds exist for 5.6, 5.7)"], error: "no editor plugin build for UE 5.8 (builds exist for 5.6, 5.7)" },
    clicks: [".app-row:nth-child(3) .app-row-actions button.primary"],
  },
  "app-install-done": {
    title: "Projects: Add Studio finished.",
    report: report(states, stateDaemons),
    live: [vale.key, harbor.key],
    job: { running: false, ok: true, lines: ["set up ue-mcp in ArenaPrototype", "installed Studio 0.1.35", "installed the UE-MCP Studio editor plugin 0.1.8", "Open ArenaPrototype in Unreal to finish."] },
    clicks: [".app-row:nth-child(3) .app-row-actions button.primary"],
  },
  "app-node-missing": {
    title: "Node.js is not installed: what it is for, and installing it with consent, unticked.",
    state: { node: { found: false, version: "", ok: false, min: 20 } },
    report: { ok: false, reason: "node" },
  },
  "app-node-old": {
    title: "Node.js is older than ue-mcp needs, and winget is not on this computer.",
    state: { node: { found: true, version: "v18.19.0", ok: false, min: 20 }, winget: false },
    report: { ok: false, reason: "node" },
  },
  "app-ue-mcp-old": {
    title: "The ue-mcp release on npm has no projects command yet.",
    report: { ok: false, reason: "unsupported", ueMcp: "ue-mcp@1.4.11" },
  },
  "app-report-offline": {
    title: "The report could not be read (offline), so the last one is shown, marked with when it was read.",
    report: { ...report(states, stateDaemons), ok: false, reason: "failed", error: "npm error code ENOTFOUND", report: undefined, cached: report(states, stateDaemons).report, cachedAt: "2026-11-08T09:41:00Z" },
  },
  "app-projects-updates": {
    title: "Projects on Beta with newer releases: update badges from installed versions against the channel's newest, with no daemon asked, including a project whose daemon is stopped.",
    report: report([vale, harbor, bridgeOnly, arena], [daemon(vale)]),
    live: [vale.key],
    newest: NEWER,
  },
  "app-projects-twins": {
    title: "Projects: two projects named ue_mcp, told apart by the folders that differ.",
    report: report([twinA, twinB, vale], [daemon(twinA)]),
    live: [twinA.key],
  },
  "app-project-detail": {
    title: "A project's detail: versions against Beta's newest, what Update installs through Studio, the running daemon with what is connected and its log, and the editor.",
    report: report([vale, harbor, arena], [daemon(vale), daemon(harbor)]),
    live: [vale.key, harbor.key],
    newest: NEWER,
    daemon: {
      [`${harbor.key} /v1/health`]: { status: 200, body: JSON.stringify({ editors: [], clients: 1 }) },
    },
    log: LOG,
    clicks: [".app-row:nth-child(2) .app-row-open"],
  },
  "app-project-detail-bridge": {
    title: "A project without Studio: its bridge update runs by ue-mcp update, with the daemon stopped and no log yet.",
    report: report([bridgeOnly, vale], [daemon(vale)]),
    live: [vale.key],
    newest: NEWER,
    clicks: [".app-row:nth-child(1) .app-row-open"],
  },
  "app-project-open-with": {
    title: "A project's detail with Open with... open: the IDEs found here, the one the project opens in ticked, beside Show in Explorer.",
    report: report([vale, harbor], [daemon(vale)]),
    live: [vale.key],
    log: LOG,
    clicks: [".app-row:nth-child(1) .app-row-open", ".app-split-more"],
  },
  "app-project-needs-files": {
    title: "Open in Visual Studio on a C++ project without a solution offers to generate its project files, or to open the folder in VS Code.",
    report: report([vale, harbor], [daemon(vale)]),
    live: [vale.key],
    ides: { ...IDES, solution: null },
    openide: { ok: false, needsProjectFiles: true, ide: "vs:afb8a0c3", name: "Visual Studio Community 2022", error: "Vale has no Visual Studio solution yet." },
    clicks: [".app-row:nth-child(1) .app-menu-button", ".app-menu-list button[role=menuitem]"],
  },
  "app-daemon-stop-confirm": {
    title: "Stop on a daemon with an editor and clients connected asks again.",
    report: report(states, stateDaemons),
    live: [vale.key, harbor.key],
    daemon: {
      [`${vale.key} /v1/health`]: { status: 200, body: JSON.stringify({ editors: [{ name: "Vale", connected: true }], clients: 2 }) },
    },
    clicks: [".app-row:nth-child(1) .app-chip-action"],
  },
  "app-settings": {
    title: "Settings: UE-MCP on Beta has an update, Node.js, and Add project.",
    screen: "settings",
    report: report(states, stateDaemons),
    appUpdate: { ok: true, channel: "beta", version: "0.1.36-beta.1", newer: true },
  },
  "app-settings-current": {
    title: "Settings: UE-MCP is the newest on Stable.",
    screen: "settings",
    report: report(states, stateDaemons),
    appUpdate: { ok: true, channel: "stable", version: "0.1.35", newer: false },
  },
  "setup-welcome": {
    title: "Setup: the welcome, with Node.js found.",
    state: { mode: "setup", installed: null, compare: undefined },
  },
  "setup-node-missing": {
    title: "Setup: Node.js is missing, with the winget box unticked.",
    state: { mode: "setup", installed: null, compare: undefined, node: { found: false, version: "", ok: false, min: 20 } },
  },
  "setup-upgrade": {
    title: "Setup: an older UE-MCP is installed, so setup offers the update.",
    state: { mode: "setup", installed: { version: "0.1.34", dir: "C:\\Users\\dana\\AppData\\Local\\Programs\\UE-MCP" }, compare: "newer" },
  },
  "setup-installed": {
    title: "Setup: this version is already installed.",
    state: { mode: "setup", installed: { version: "0.1.35", dir: "C:\\Users\\dana\\AppData\\Local\\Programs\\UE-MCP" }, compare: "same" },
  },
  "setup-installing": {
    title: "Setup: installing.",
    state: { mode: "setup", installed: null, compare: undefined },
    setup: "hold",
    clicks: [".setup-foot button.primary"],
  },
  "setup-done": {
    title: "Setup: done, with Open UE-MCP ticked.",
    state: { mode: "setup", installed: null, compare: undefined },
    setup: "ok",
    clicks: [".setup-foot button.primary"],
  },
  "setup-failed": {
    title: "Setup: the install failed, with why.",
    state: { mode: "setup", installed: null, compare: undefined },
    setup: "fail",
    clicks: [".setup-foot button.primary"],
  },
};

export const BASE_STATE: HostState = {
  mode: "app",
  version: "0.1.35",
  node: { found: true, version: "v22.11.0", ok: true, min: 20 },
  winget: true,
  channel: "latest",
  installDir: "C:\\Users\\dana\\AppData\\Local\\Programs\\UE-MCP",
  installed: { version: "0.1.35", dir: "C:\\Users\\dana\\AppData\\Local\\Programs\\UE-MCP" },
  compare: "same",
};

export type { Live };
