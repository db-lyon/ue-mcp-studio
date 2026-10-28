// @vitest-environment jsdom
/**
 * Settings against what an older agent, an older daemon or an earlier
 * Studio's settings file answers (#151). The daemon serves the newest UI
 * bundle installed on the machine whatever agent runs, so this client reads
 * responses that lack fields it assumes. Every section must render them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SettingsHub, type SettingsSection } from "../SettingsHub";
import type { DaemonState } from "../../state";
import { api } from "../../api";

type Routes = Record<string, unknown>;

/** What Studio 0.1.23, the last stable before the regrouped Settings, answers. */
const AGENT_0_1_23: Routes = {
  "/v1/ext/studio/settings": {
    provider: "anthropic",
    model: "claude-opus-5-5",
    route: "claude",
    effort: "high",
    gatewayUrl: "https://gateway.ue-mcp.com",
    theme: "editor",
    askBeforeChanges: true,
    composerHeight: null,
    dialogPolicy: { kind: "wait" },
    connected: { claude: true, chatgpt: false, studio: false, anthropic: false, openai: false, google: false },
    account: null,
  },
  // No playtestRuns: it came with 0.1.24-beta.5.
  "/v1/ext/studio/agent-settings": { feedbackTool: true, feedbackMode: { mode: "interactive", project: false }, dialogMode: { mode: null, project: false } },
  "/v1/ext/studio/models": {
    signedIn: { claude: true, chatgpt: false, studio: false },
    providers: [{ id: "anthropic", name: "Anthropic", connected: false, source: "default", models: [{ id: "claude-opus-5-5", name: "Opus 5.5", signIns: ["claude"] }] }],
  },
  "/v1/ext/studio/config": { path: "C:/P/ue-mcp.yml", exists: false, text: "" },
  "/v1/ext/studio/updates": { channel: "stable", studio: { installed: "0.1.23", latest: "0.1.23", available: false }, plugin: { installed: "0.1.4", latest: "0.1.4", available: false, location: "project", engine: "5.7", newer: false, required: false, source: "github" } },
};

const INSTALL = {
  ok: true,
  problems: [],
  project: { engine: "5.7", name: "P" },
  plugin: { deployed: true, installedVersion: "1.4.11", installKind: "source", packagedVersion: "1.4.11", enabledInUproject: true, pluginDir: "C:/P/Plugins/UE_MCP_Bridge" },
  toolchain: { present: true, name: "MSVC" },
  node: { version: "v22" },
  clients: [],
};

let routes: Routes = {};

function stub(r: Routes): void {
  routes = r;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const pathOnly = String(url).split("?")[0];
    if (!(pathOnly in routes)) return new Response(JSON.stringify({ error: "no such route on this agent" }), { status: 404 });
    const body = routes[pathOnly];
    return new Response(body === undefined ? "" : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const health = { version: "1.4.11", apiVersion: 2, pid: 1, startedAt: "2026-10-28T00:00:00Z", clients: 0, inflight: 0, extensions: [], editors: [], projectRoot: "C:/P" };
const daemonWith = (h: unknown): DaemonState => ({ health: h as DaemonState["health"], error: null, streaming: true, events: [], refresh: () => undefined });

async function open(section: SettingsSection, daemon: DaemonState = daemonWith(health)): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    container = render(<SettingsHub daemon={daemon} section={section} onSection={vi.fn()} onTheme={vi.fn()} />).container;
  });
  // Every read in flight lands.
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
  return container;
}

/** The section rendered: its heading is up and no part fell back to the crash message. */
function rendered(container: HTMLElement, title: string): void {
  expect(container.querySelector(".cfg-head h1")?.textContent).toBe(title);
  expect(screen.queryByText(/could not be shown/)).toBeNull();
  // A route the older agent does not have leaves its part out rather than reporting a failure.
  expect(screen.queryByText(/no such route/)).toBeNull();
}

describe("Settings with an older agent's answers", () => {
  it("Agents: settings without usage", async () => {
    stub(AGENT_0_1_23);
    rendered(await open("agents"), "Agents");
  });

  it("Approvals: agent settings without playtestRuns", async () => {
    stub(AGENT_0_1_23);
    rendered(await open("approvals"), "Approvals & review");
  });

  it("Approvals: agent settings without dialogMode or feedbackMode, settings without dialogPolicy", async () => {
    const s = { ...(AGENT_0_1_23["/v1/ext/studio/settings"] as object), dialogPolicy: undefined };
    stub({ ...AGENT_0_1_23, "/v1/ext/studio/settings": s, "/v1/ext/studio/agent-settings": { feedbackTool: true } });
    rendered(await open("approvals"), "Approvals & review");
  });

  it("Models: settings without connected, a catalog without signedIn, a provider without models", async () => {
    stub({
      ...AGENT_0_1_23,
      "/v1/ext/studio/settings": { provider: "anthropic", model: "claude-opus-5-5", route: null, theme: "ue-mcp" },
      "/v1/ext/studio/models": { providers: [{ id: "anthropic", name: "Anthropic", connected: false, source: "default" }, { id: "openai", name: "OpenAI", connected: false, source: "default", models: [{ id: "gpt", name: "GPT" }] }] },
    });
    rendered(await open("models"), "Models & accounts");
  });

  it("the rail's status lines: a catalog without providers", async () => {
    stub({ ...AGENT_0_1_23, "/v1/ext/studio/models": { signedIn: {} } });
    rendered(await open("general"), "General");
  });

  it("the rail's status lines: a provider without models", async () => {
    stub({ ...AGENT_0_1_23, "/v1/ext/studio/models": { signedIn: {}, providers: [{ id: "anthropic", name: "Anthropic" }] } });
    rendered(await open("general"), "General");
  });

  it("Agents: a native overview without its lists", async () => {
    const settings = { ...(AGENT_0_1_23["/v1/ext/studio/settings"] as object), usage: { projectInstructions: true } };
    stub({ ...AGENT_0_1_23, "/v1/ext/studio/settings": settings, "/v1/ext/studio/native": { enabled: true, main: "claude", conventions: [{ convention: "claude" }] } });
    rendered(await open("agents"), "Agents");
  });

  it("every section with an empty settings answer", async () => {
    for (const [section, title] of [["general", "General"], ["agents", "Agents"], ["models", "Models & accounts"], ["approvals", "Approvals & review"]] as const) {
      stub({ ...AGENT_0_1_23, "/v1/ext/studio/settings": {}, "/v1/ext/studio/agent-settings": {}, "/v1/ext/studio/models": {} });
      rendered(await open(section), title);
      cleanup();
    }
  });
});

describe("Settings with an older daemon's answers", () => {
  it("Project: an install report without problems, clients, project, toolchain or node", async () => {
    stub({ ...AGENT_0_1_23, "/v1/install": { ok: false, plugin: { deployed: true, installedVersion: "1.4.0" } }, "/v1/ext/studio/context-strategy": { strategy: "micro", fromFile: false, envOverride: null } });
    rendered(await open("project"), "Project");
  });

  it("Project: a context strategy without seeds, or one this client does not know", async () => {
    stub({ ...AGENT_0_1_23, "/v1/install": INSTALL, "/v1/ext/studio/context-strategy": { strategy: "minimal", envOverride: "tiny" } });
    rendered(await open("project"), "Project");
  });

  it("Project: an install problem without a project block", async () => {
    stub({ ...AGENT_0_1_23, "/v1/install": { ...INSTALL, ok: false, project: undefined, problems: [{ code: "no_engine", what: "No engine." }] } });
    rendered(await open("project"), "Project");
  });

  it("General: an update check without installed", async () => {
    stub({ ...AGENT_0_1_23, "/v1/update": { server: "1.4.0", latest: "1.4.11", target: "1.4.11" } });
    rendered(await open("general"), "General");
  });

  it("General: a Studio update check without plugin", async () => {
    stub({ ...AGENT_0_1_23, "/v1/ext/studio/updates": { studio: { installed: "0.1.23", latest: "0.1.24", available: true } } });
    rendered(await open("general"), "General");
  });

  it("Diagnostics: health without editors or extensions", async () => {
    // Health reaches the views through api.health, as useDaemon reads it.
    stub({ ...AGENT_0_1_23, "/v1/health": { version: "1.4.0", apiVersion: 1, pid: 1, startedAt: "2026-10-28T00:00:00Z", clients: 0, projectRoot: "C:/P" } });
    rendered(await open("diagnostics", daemonWith(await api.health())), "Diagnostics");
  });
});

describe("Settings before anything has answered", () => {
  it("renders every section while every read is still in flight", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    for (const [section, title] of [["general", "General"], ["project", "Project"], ["diagnostics", "Diagnostics"]] as const) {
      rendered(await open(section, daemonWith(null)), title);
      cleanup();
    }
    for (const section of ["agents", "models", "approvals"] as const) {
      await open(section, daemonWith(null));
      expect(screen.getByText("Loading")).toBeTruthy();
      cleanup();
    }
  });
});
