/**
 * Settings written by older Studios: approvals come from what they held,
 * nothing still used is lost, and the old fields keep being written.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/settings.js";
import { projectStrategy } from "../src/composer-routes.js";
import { PlaytestStore } from "../src/playtest-store.js";
import { DEFAULT_APPROVALS } from "@ue-mcp-studio/shared";

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
  return { settings, playtests };
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
    expect(() => settings.update({ approvals: { files: "maybe" as never } })).toThrow(/files must be ask, project or allow/);
    settings.update({ approvals: { shell: "project" } });
    expect(settings.approvals().shell).toBe("project");
    expect(() => settings.update({ approvals: { destructive: "project" } })).toThrow(/destructive must be ask or allow/);
    expect(() => settings.update({ approvals: { network: "ask" } as never })).toThrow(/no approval network/);
  });

  it("lose nothing else the old file held", () => {
    const d = oldDir("settings-0.1.24.json");
    const before = JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf-8"));
    // The turn token limit is gone with budgets: dropped, not kept.
    delete before.usage.turnTokenLimit;
    // The old default hosted service URL moves to the new one.
    before.gatewayUrl = "https://api.ue-mcp.com";
    stores(d).settings.update({ approvals: { shell: "ask" } });
    const after = JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf-8"));
    for (const [k, v] of Object.entries(before)) if (k !== "askBeforeChanges") {
      // Nothing the old file held is lost; a field added since may join it at its default.
      if (v && typeof v === "object" && !Array.isArray(v)) expect(after[k]).toMatchObject(v as object);
      else expect(after[k]).toEqual(v);
    }
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
  it("load without error and drop the old limits", () => {
    const d = oldDir("settings-0.1.24.json", "playtests-0.1.24.json");
    const { settings, playtests } = stores(d);
    expect(settings.usage()).not.toHaveProperty("turnTokenLimit");
    settings.update({ theme: "editor" });
    expect(JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf-8")).usage).not.toHaveProperty("turnTokenLimit");
    expect(playtests.runs()).toBe("automatic");
    expect(playtests.players("/Game/Tests/Sprint")).toEqual({ 0: "host", 2: "client 1" });
  });
});

describe("the Auto context strategy from an older Studio", () => {
  it("runs the agent on Micro and drops the stored choice", () => {
    const d = oldDir("settings-0.1.24.json");
    const raw = JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf-8"));
    fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ ...raw, usage: { ...raw.usage, contextStrategy: "auto" } }));
    const { settings } = stores(d);
    expect(settings.usage()).not.toHaveProperty("contextStrategy");
    // No measurement ever shipped, so Auto always resolved to Micro, the project's default.
    expect(projectStrategy(d, {})).toBe("micro");
    settings.update({ theme: "editor" });
    expect(JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf-8")).usage).not.toHaveProperty("contextStrategy");
  });
});

describe("the hosted service URL from an older Studio", () => {
  const saved = (d: string) => JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf-8"));

  for (const file of ["settings-0.1.10.json", "settings-0.1.24.json"]) {
    it(`${file}: the old default moves to api.ue-mcp.com and is saved`, () => {
      const d = oldDir(file);
      const before = saved(d);
      expect(before.gatewayUrl).toBe("https://gateway.ue-mcp.com");
      expect(stores(d).settings.gatewayUrl()).toBe("https://api.ue-mcp.com");
      const after = saved(d);
      expect(after).toEqual({ ...before, gatewayUrl: "https://api.ue-mcp.com" });
    });
  }

  it("the old default with a trailing slash moves too", () => {
    const d = oldDir("settings-0.1.24.json");
    fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ ...saved(d), gatewayUrl: "https://gateway.ue-mcp.com/" }));
    expect(stores(d).settings.gatewayUrl()).toBe("https://api.ue-mcp.com");
    expect(saved(d).gatewayUrl).toBe("https://api.ue-mcp.com");
  });

  it("a custom URL is kept and the file is not rewritten", () => {
    const d = oldDir("settings-0.1.24.json");
    const text = JSON.stringify({ ...saved(d), gatewayUrl: "https://gateway.ue-mcp.com.example.net" });
    fs.writeFileSync(path.join(d, "settings.json"), text);
    expect(stores(d).settings.gatewayUrl()).toBe("https://gateway.ue-mcp.com.example.net");
    expect(fs.readFileSync(path.join(d, "settings.json"), "utf-8")).toBe(text);
    const custom = JSON.stringify({ ...saved(d), gatewayUrl: "http://localhost:8787" });
    fs.writeFileSync(path.join(d, "settings.json"), custom);
    expect(stores(d).settings.gatewayUrl()).toBe("http://localhost:8787");
    expect(fs.readFileSync(path.join(d, "settings.json"), "utf-8")).toBe(custom);
  });

  it("a new install uses api.ue-mcp.com", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "studio-new-"));
    expect(new SettingsStore(d, path.join(d, "keys")).gatewayUrl()).toBe("https://api.ue-mcp.com");
  });
});
