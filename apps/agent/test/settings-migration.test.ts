/**
 * Settings written by older Studios: approvals come from what they held,
 * nothing still used is lost, and the old fields keep being written.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/settings.js";
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
    stores(d).settings.update({ approvals: { shell: "ask" } });
    const after = JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf-8"));
    for (const [k, v] of Object.entries(before)) if (k !== "askBeforeChanges") {
      // Nothing the old file held is lost; a field added since, such as contextStrategy, may join it at its default.
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
