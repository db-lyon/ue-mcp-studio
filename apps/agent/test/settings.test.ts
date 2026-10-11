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
  it("starts on a Claude model", () => {
    expect(store().view()).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
  });

  it("reads settings written before vendors were named as Claude, which is all they ran", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-settings-"));
    const s = new SettingsStore(dir);
    for (const provider of ["byok", "gateway", "studio"]) {
      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ provider, model: "claude-sonnet-5-5" }));
      expect(s.view()).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
    }
  });

  it("forgets an OpenRouter sign-in on sign-out", () => {
    const s = store();
    s.saveOpenRouterKey("sk-or-1");
    expect(s.openRouterKey()).toBe("sk-or-1");
    s.update({ signOut: "openrouter" });
    expect(s.openRouterKey()).toBeNull();
  });

  it("keeps the signed-in login and forgets it on sign-out", () => {
    const s = store();
    s.signIn("uemcp_tok", "octo");
    expect([s.accountToken(), s.accountLogin()]).toEqual(["uemcp_tok", "octo"]);
    s.update({ signOut: "studio" });
    expect([s.accountToken(), s.accountLogin()]).toEqual([null, null]);
  });
});
