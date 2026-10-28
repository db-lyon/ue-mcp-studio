import { describe, expect, it } from "vitest";
import { agentSettingsOf, catalogOf, contextOf, healthOf, installOf, nativeOf, settingsOf } from "./normalize";
import { sectionOf } from "./views/settings/sections";
import { planOf } from "./views/ProjectSetup";
import { studioUpdatesOf, ueMcpUpdateOf } from "./views/Updates";

describe("settings as earlier Studios sent them", () => {
  it("fills what 0.1.23 did not send: usage, approvals, review, route order", () => {
    const s = settingsOf({ provider: "anthropic", model: "claude-opus-5-5", route: "claude", askBeforeChanges: false, connected: { claude: true } });
    expect(s.usage).toEqual({ subagents: "asked", subagentModel: null, subagentEffort: null, subagentsPerTurn: 4, projectInstructions: true, imageSize: "standard" });
    expect(s.approvals).toEqual({ shell: "allow", files: "allow", editorRestart: "allow", destructive: "allow" });
    expect(s.reviewTurns).toBe(true);
    expect(s.routeOrder).toBe("signins-first");
    expect(s.connected.claude).toBe(true);
    expect(s.connected.openai).toBe(false);
  });

  it("drops usage fields an earlier Studio kept, such as contextStrategy and budgets", () => {
    const s = settingsOf({ usage: { contextStrategy: "full", budgets: { turn: 100000, session: 1 }, maxTurns: 40, imageSize: "small" } });
    expect(s.usage).not.toHaveProperty("contextStrategy");
    expect(s.usage).not.toHaveProperty("budgets");
    expect(s.usage.imageSize).toBe("small");
  });

  it("reads an old subagents: off as When you ask", () => {
    expect(settingsOf({ usage: { subagents: "off" } }).usage.subagents).toBe("asked");
  });

  it("reads the old approvals shapes: none, a list, booleans, a rule a kind does not take", () => {
    expect(settingsOf({ askBeforeChanges: true }).approvals).toEqual({ shell: "ask", files: "ask", editorRestart: "allow", destructive: "allow" });
    expect(settingsOf({ askBeforeChanges: true, approvals: ["shell"] }).approvals.shell).toBe("ask");
    expect(settingsOf({ askBeforeChanges: false, approvals: { shell: true, files: "never", editorRestart: "project", destructive: "ask" } }).approvals)
      .toEqual({ shell: "allow", files: "allow", editorRestart: "allow", destructive: "ask" });
  });

  it("an empty, null or wrong-typed answer is the defaults", () => {
    for (const raw of [undefined, null, {}, [], "settings", 3]) {
      const s = settingsOf(raw);
      expect(s.route).toBeNull();
      expect(s.dialogPolicy).toEqual({ kind: "agent", minutes: 2 });
      expect(s.theme).toBe("ue-mcp");
      expect(s.account).toBeNull();
    }
  });
});

describe("the agent's other answers", () => {
  it("agent settings without playtestRuns, dialogMode or feedbackMode", () => {
    expect(agentSettingsOf({ feedbackTool: false })).toEqual({
      feedbackTool: false,
      feedbackMode: { mode: "interactive", project: false },
      dialogMode: { mode: null, project: false },
      playtestRuns: "manual",
    });
  });

  it("a catalog without signedIn, providers without models, models without signIns", () => {
    const c = catalogOf({ providers: [{ id: "anthropic", name: "Anthropic" }, { id: "openai", models: [{ id: "gpt" }] }, { id: 7 }, null] });
    expect(c.signedIn).toEqual({ chatgpt: false, claude: false, studio: false });
    expect(c.providers.map((p) => p.id)).toEqual(["anthropic", "openai"]);
    expect(c.providers[0].models).toEqual([]);
    expect(c.providers[1].models).toEqual([{ id: "gpt", name: "gpt", signIns: [] }]);
  });

  it("a context strategy this panel does not know, and seeds left unmeasured", () => {
    expect(contextOf({ strategy: "minimal", envOverride: "LEAN", seeds: { micro: 2000, lean: "a lot" } })).toEqual({ strategy: "micro", fromFile: false, envOverride: "lean", seeds: { micro: 2000 } });
  });

  it("a native overview with a convention this panel does not know and lists missing", () => {
    const n = nativeOf({ main: "cursor", conventions: [{ convention: "claude", subagents: [{ path: "a.md", model: "haiku" }] }, { convention: "cursor" }] });
    expect(n.main).toBeNull();
    expect(n.conventions).toHaveLength(1);
    expect(n.conventions[0]).toMatchObject({ routes: [], instructions: [], skills: [], notes: [], skipped: [] });
    expect(n.conventions[0].subagents[0]).toMatchObject({ name: "a.md", runs: { model: "haiku" }, problems: [] });
    expect(n.worker).toEqual({ model: null, effort: null, starts: "asked" });
  });
});

describe("an older daemon's answers", () => {
  it("an install report without problems, clients, project, toolchain or node", () => {
    const r = installOf({ ok: false, plugin: { deployed: true } });
    expect(r.problems).toEqual([]);
    expect(r.clients).toEqual([]);
    expect(r.project.engine).toBeNull();
    expect(r.toolchain.present).toBe(false);
    expect(r.node.version).toBe("?");
  });

  it("health without editors or extensions", () => {
    const h = healthOf({ version: "1.4.0" });
    expect(h.editors).toEqual([]);
    expect(h.extensions).toEqual([]);
  });

  it("update checks without installed, or without the plugin part", () => {
    expect(ueMcpUpdateOf({ server: "1.4.0", target: "1.4.11" })).toMatchObject({ installed: { version: null }, server: "1.4.0", target: "1.4.11", binaries: null });
    expect(ueMcpUpdateOf(null)).toBeNull();
    expect(studioUpdatesOf({ studio: { installed: "0.1.23", available: true } })).toMatchObject({ channel: "stable", studio: { installed: "0.1.23", latest: null, available: true }, plugin: { installed: null, available: false, location: "none" } });
  });

  it("a setup plan without nativeTools or clients, and output that is not JSON", () => {
    expect(planOf(JSON.stringify({ plan: { project: {}, contextStrategy: "lean" } }))).toEqual({ project: { engine: null }, clients: [], nativeTools: { enabled: true }, contextStrategy: "lean", feedback: false, skills: false });
    expect(planOf("npx: command not found")).toBeNull();
    expect(planOf("")).toBeNull();
  });
});

describe("Settings section ids from older versions", () => {
  it("maps each name an earlier version used to a section", () => {
    expect(sectionOf("agent")).toBe("agents");
    expect(sectionOf("usage")).toBe("agents");
    expect(sectionOf("account")).toBe("models");
    expect(sectionOf("update")).toBe("general");
    expect(sectionOf("updates")).toBe("general");
    expect(sectionOf("config")).toBe("project");
    expect(sectionOf("status")).toBe("diagnostics");
    expect(sectionOf("Approvals")).toBe("approvals");
  });

  it("opens General for a name no version used, and nothing for no name", () => {
    expect(sectionOf("billing")).toBe("general");
    expect(sectionOf("")).toBeNull();
    expect(sectionOf(null)).toBeNull();
  });
});
