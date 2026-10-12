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

describe("asking before changes", () => {
  it("is on until the user turns it off, and kept apart from the model settings", () => {
    const s = store();
    expect(s.askBeforeChanges()).toBe(true);
    s.update({ model: "claude-sonnet-5-5" });
    expect(s.askBeforeChanges()).toBe(true);
    s.update({ askBeforeChanges: false });
    expect(s.view()).toMatchObject({ askBeforeChanges: false, model: "claude-sonnet-5-5" });
    expect(() => s.update({ askBeforeChanges: "no" as never })).toThrow(/must be a boolean/);
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

  it("keeps a chosen OpenAI or Google model", () => {
    const s = store();
    s.update({ provider: "google", model: "gemini-3.8-flash" });
    expect(s.view()).toMatchObject({ provider: "google", model: "gemini-3.8-flash" });
  });

  it("keeps the signed-in login and forgets it on sign-out", () => {
    const s = store();
    s.signIn("uemcp_tok", "octo");
    expect([s.accountToken(), s.accountLogin()]).toEqual(["uemcp_tok", "octo"]);
    s.update({ signOut: "studio" });
    expect([s.accountToken(), s.accountLogin()]).toEqual([null, null]);
  });
});

describe("Claude subscription login", () => {
  it("reads the login from Studio's own Claude folder, never the user's Claude Code", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "studio-claude-"));
    process.env.STUDIO_CLAUDE_HOME = home;
    try {
      const { claudeLogin, claudeHome } = await import("../src/subscription.js");
      expect(claudeHome()).toBe(home);
      expect(claudeLogin()).toBeNull();
      fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x", subscriptionType: "max" } }));
      expect(claudeLogin()).toEqual({ subscription: "max" });
    } finally {
      delete process.env.STUDIO_CLAUDE_HOME;
    }
  });
});

describe("the dialog policy", () => {
  it("defaults to asking, then letting the agent decide after 2 minutes", () => {
    expect(store().dialogPolicy()).toEqual({ kind: "agent", minutes: 2 });
  });

  it("keeps each policy for the project", () => {
    const s = store();
    s.update({ dialogPolicy: { kind: "safe", minutes: 5 } });
    expect(s.view().dialogPolicy).toEqual({ kind: "safe", minutes: 5 });
    s.update({ dialogPolicy: { kind: "wait" } });
    expect(s.dialogPolicy()).toEqual({ kind: "wait" });
  });

  it("refuses a policy it cannot run", () => {
    expect(() => store().update({ dialogPolicy: { kind: "agent", minutes: 0 } })).toThrow(/dialogPolicy/);
    expect(() => store().update({ dialogPolicy: { kind: "soon" } as never })).toThrow(/dialogPolicy/);
  });
});
