import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/settings.js";

const store = () => new SettingsStore(fs.mkdtempSync(path.join(os.tmpdir(), "studio-settings-")));

describe("theme setting", () => {
  it("defaults to the ue-mcp look", () => {
    expect(store().view().theme).toBe("ue-mcp");
  });

  it("keeps a chosen theme without touching the model settings", () => {
    const s = store();
    s.update({ model: "claude-sonnet-5-5" });
    s.update({ theme: "editor" });
    expect(s.view()).toMatchObject({ theme: "editor", model: "claude-sonnet-5-5" });
  });

  it("refuses an unknown theme", () => {
    expect(() => store().update({ theme: "neon" as never })).toThrow(/theme must be one of/);
  });
});

describe("providers", () => {
  it("defaults to the Studio subscription", () => {
    expect(store().view()).toMatchObject({ provider: "studio", model: "claude-opus-5-5" });
  });

  it("reads settings written before providers were named", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-settings-"));
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ provider: "byok", model: "claude-sonnet-5-5" }));
    fs.writeFileSync(path.join(dir, "anthropic.key"), "sk-ant-old");
    const s = new SettingsStore(dir);
    expect(s.view()).toMatchObject({ provider: "anthropic", keys: { anthropic: true } });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ provider: "gateway" }));
    expect(s.provider()).toBe("studio");
    // byok was the old default, saved with the theme by people who never added a key.
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ provider: "byok", theme: "light" }));
    fs.rmSync(path.join(dir, "anthropic.key"));
    expect(s.provider()).toBe("studio");
  });

  it("keeps the signed-in login and forgets it on sign-out", () => {
    const s = store();
    s.signIn("uemcp_tok", "octo");
    expect([s.accountToken(), s.accountLogin()]).toEqual(["uemcp_tok", "octo"]);
    s.update({ accountToken: "" });
    expect([s.accountToken(), s.accountLogin()]).toEqual([null, null]);
  });
});
