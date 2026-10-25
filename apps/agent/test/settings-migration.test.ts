/**
 * Settings written by older Studios: approvals and budgets come from what
 * they held, nothing is lost, and the old fields keep being written.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/settings.js";
import { PlaytestStore } from "../src/playtest-store.js";
import { BudgetStore } from "../src/budgets.js";
import { DEFAULT_APPROVALS, MAIN_AGENT_ID, PLAYTEST_RUNNER_ID } from "@ue-mcp-studio/shared";

const FIXTURES = path.join(__dirname, "fixtures", "old-settings");

/** A data dir holding an old Studio's files. */
function oldDir(settings: string, playtests?: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "studio-migrate-"));
  fs.copyFileSync(path.join(FIXTURES, settings), path.join(d, "settings.json"));
  if (playtests) fs.copyFileSync(path.join(FIXTURES, playtests), path.join(d, "playtests.json"));
  return d;
}

function stores(dir: string) {
  const settings = new SettingsStore(dir, path.join(dir, "keys"));
  const playtests = new PlaytestStore(dir);
  const budgets = new BudgetStore(dir, {
    turnTokenLimit: () => settings.usage().turnTokenLimit,
    setTurnTokenLimit: (n) => settings.update({ usage: { turnTokenLimit: n } }),
    playtestBudget: () => playtests.budget(),
    setPlaytestBudget: (b) => playtests.setBudget(b),
  });
  return { settings, playtests, budgets };
}

describe("approvals from an older Studio", () => {
  it("keep what askBeforeChanges did, and never ask about what it never asked about", () => {
    const { settings } = stores(oldDir("settings-0.1.24.json"));
    expect(settings.approvals()).toEqual({ shell: "allow", files: "allow", editorRestart: "allow", destructive: "allow" });
  });

  it("ask before commands and files when askBeforeChanges was on or absent", () => {
    const { settings } = stores(oldDir("settings-0.1.10.json"));
    expect(settings.approvals()).toEqual({ shell: "ask", files: "ask", editorRestart: "allow", destructive: "allow" });
  });

  it("ask about every kind on a new install", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "studio-new-"));
    expect(new SettingsStore(d, path.join(d, "keys")).approvals()).toEqual(DEFAULT_APPROVALS);
  });

  it("write askBeforeChanges beside the rows for an older Studio, and take it from one", () => {
    const d = oldDir("settings-0.1.24.json");
    const { settings } = stores(d);
    settings.update({ approvals: { files: "ask" } });
    let raw = JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf-8"));
    expect(raw.askBeforeChanges).toBe(true);
    expect(raw.approvals).toEqual({ shell: "allow", files: "ask", editorRestart: "allow", destructive: "allow" });
    settings.update({ askBeforeChanges: false });
    raw = JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf-8"));
    expect(raw.approvals.files).toBe("allow");
    expect(() => settings.update({ approvals: { files: "maybe" as never } })).toThrow(/ask or allow/);
    expect(() => settings.update({ approvals: { network: "ask" } as never })).toThrow(/no approval network/);
  });

  it("lose nothing else the old file held", () => {
    const d = oldDir("settings-0.1.24.json");
    const before = JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf-8"));
    stores(d).settings.update({ approvals: { shell: "ask" } });
    const after = JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf-8"));
    for (const [k, v] of Object.entries(before)) if (k !== "askBeforeChanges") expect(after[k]).toEqual(v);
  });

  it("keep fields a newer Studio wrote", () => {
    const d = oldDir("settings-0.1.24.json");
    const raw = JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf-8"));
    fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ ...raw, schema: 9, future: { x: 1 } }));
    stores(d).settings.update({ theme: "editor" });
    expect(JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf-8"))).toMatchObject({ schema: 9, future: { x: 1 }, theme: "editor" });
  });
});

describe("budgets from an older Studio", () => {
  it("move the turn token limit and the playtest budget into their rows on first read", () => {
    const d = oldDir("settings-0.1.24.json", "playtests-0.1.24.json");
    const { budgets } = stores(d);
    const b = budgets.get();
    expect(b.agents[MAIN_AGENT_ID]).toEqual({ perRunTokens: 750000, perRunMinutes: null, perDayTokens: null, onLimit: "stop-and-report" });
    expect(b.agents[PLAYTEST_RUNNER_ID]).toEqual({ perRunTokens: 3000000, perRunMinutes: 45, perDayTokens: null, onLimit: "ask" });
    expect(b.team).toEqual({ perDayTokens: null, perMonthTokens: null, onLimit: "ask" });
    expect(fs.existsSync(path.join(d, "budgets.json"))).toBe(true);
    expect(budgets.playtestBudget()).toEqual({ minutes: 45, tokens: 3000000 });
  });

  it("migrate to no main limit and the default playtest budget when the old files had none", () => {
    const { budgets } = stores(oldDir("settings-0.1.10.json"));
    expect(budgets.agent(MAIN_AGENT_ID).perRunTokens).toBeNull();
    expect(budgets.playtestBudget()).toEqual({ minutes: 60, tokens: 2000000 });
  });

  it("write a changed limit back to the old places, so an older Studio stops at the same point", () => {
    const d = oldDir("settings-0.1.24.json", "playtests-0.1.24.json");
    const { budgets, settings, playtests } = stores(d);
    budgets.update({ agents: { [MAIN_AGENT_ID]: { perRunTokens: 200000 }, [PLAYTEST_RUNNER_ID]: { perRunMinutes: 30 } } });
    expect(settings.usage().turnTokenLimit).toBe(200000);
    expect(playtests.budget()).toEqual({ minutes: 30, tokens: 3000000 });
    budgets.update({ agents: { [MAIN_AGENT_ID]: { perRunTokens: null } } });
    expect(settings.usage().turnTokenLimit).toBeNull();
  });

  it("keep the old playtest players and runs untouched", () => {
    const d = oldDir("settings-0.1.24.json", "playtests-0.1.24.json");
    const { budgets, playtests } = stores(d);
    budgets.get();
    expect(playtests.runs()).toBe("automatic");
    expect(playtests.players("/Game/Tests/Sprint")).toEqual({ 0: "host", 2: "client 1" });
  });

  it("check every field, and keep the Playtest runner's loop bounded", () => {
    const { budgets } = stores(oldDir("settings-0.1.24.json", "playtests-0.1.24.json"));
    expect(() => budgets.update({ agents: { [MAIN_AGENT_ID]: { perRunTokens: 5 } } })).toThrow(/perRunTokens must be null or a whole number/);
    expect(() => budgets.update({ agents: { [MAIN_AGENT_ID]: { perRunMinutes: 2000 } } })).toThrow(/perRunMinutes/);
    expect(() => budgets.update({ agents: { [MAIN_AGENT_ID]: { onLimit: "explode" as never } } })).toThrow(/onLimit/);
    expect(() => budgets.update({ agents: { [PLAYTEST_RUNNER_ID]: { perRunTokens: null } } })).toThrow(/always stops/);
    expect(() => budgets.update({ warnAt: 0.2 })).toThrow(/warnAt/);
    expect(() => budgets.update({ team: { onLimit: "later" as never } })).toThrow(/team.onLimit/);
    expect(() => budgets.update({ agents: { "Bad Id": {} } })).toThrow(/no agent/);
    budgets.update({ warnAt: 0.7, team: { perDayTokens: 12_000_000, perMonthTokens: 250_000_000, onLimit: "stop" } });
    expect(budgets.get()).toMatchObject({ warnAt: 0.7, team: { perDayTokens: 12_000_000, perMonthTokens: 250_000_000, onLimit: "stop" } });
  });

  it("read a damaged file field by field instead of failing", () => {
    const d = oldDir("settings-0.1.24.json");
    fs.writeFileSync(path.join(d, "budgets.json"), JSON.stringify({ team: { perDayTokens: "lots" }, agents: { main: { perRunTokens: 300000, onLimit: "x" } }, warnAt: 3 }));
    const b = stores(d).budgets.get();
    expect(b.team.perDayTokens).toBeNull();
    expect(b.agents.main).toEqual({ perRunTokens: 300000, perRunMinutes: null, perDayTokens: null, onLimit: "stop-and-report" });
    expect(b.warnAt).toBe(0.8);
  });
});
